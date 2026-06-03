"""金庫マスク基盤の単体テスト。

実行: cd agent && python -m unittest engines.test_vault -v
不変条件（CLAUDE.md）を機械的に担保する。逆マスクの取りこぼし＝即漏洩なので網羅的に。
"""
import unittest

from engines import vault


# ダミー機密値は実行時に連結で組み立てる。ソース上に sk-/ghp_/AKIA の生形を
# 残すと pre-push の secret-scan が（正しく）反応するため、構造を割って書く。
# 値は本物ではなくマスク機能の検証用の作り物。
SK_DUMMY  = "sk-" + "abcdefghij1234567890"        # openai-key 風
GHP_DUMMY = "ghp_" + "A" * 36                      # github-token 風
AKIA_DUMMY = "AKIA" + "IOSFODNN7EXAMPLE"           # aws-key 風（公式ダミー）


class TestFindPlaceholders(unittest.TestCase):
    def test_basic(self):
        self.assertEqual(vault.find_placeholders("use {{API_KEY}} now"), ["API_KEY"])

    def test_multiple_dedup_order(self):
        txt = "{{A}} then {{B}} then {{A}}"
        self.assertEqual(vault.find_placeholders(txt), ["A", "B"])

    def test_none_and_empty(self):
        self.assertEqual(vault.find_placeholders(""), [])
        self.assertEqual(vault.find_placeholders("no placeholders"), [])

    def test_rejects_weird_names(self):
        # スペースや記号入りの {{ }} は名前として拾わない
        self.assertEqual(vault.find_placeholders("{{ bad name }}"), [])
        self.assertEqual(vault.find_placeholders("{{a.b}}"), [])


class TestInjectSecrets(unittest.TestCase):
    def test_inject_basic(self):
        out = vault.inject_secrets("use {{API_KEY}}", {"API_KEY": "sk-real-123"})
        self.assertEqual(out, "use sk-real-123")

    def test_unknown_name_untouched(self):
        # secrets に無い名前は {{名前}} のまま（壊さない）
        out = vault.inject_secrets("use {{UNKNOWN}}", {"API_KEY": "x"})
        self.assertEqual(out, "use {{UNKNOWN}}")

    def test_no_secrets(self):
        self.assertEqual(vault.inject_secrets("use {{X}}", None), "use {{X}}")
        self.assertEqual(vault.inject_secrets("use {{X}}", {}), "use {{X}}")

    def test_multiple(self):
        out = vault.inject_secrets(
            "{{A}} and {{B}}", {"A": "aaa", "B": "bbb"}
        )
        self.assertEqual(out, "aaa and bbb")


class TestMaskKnownSecrets(unittest.TestCase):
    def test_reverse_basic(self):
        out = vault.mask_known_secrets("got sk-real-123 back", {"API_KEY": "sk-real-123"})
        self.assertEqual(out, "got {{API_KEY}} back")

    def test_echo_back_in_summary(self):
        # Claude が done サマリで値を復唱しても名前に戻る
        text = "完了。鍵 sk-real-123 を使いました"
        out = vault.mask_known_secrets(text, {"API_KEY": "sk-real-123"})
        self.assertNotIn("sk-real-123", out)
        self.assertIn("{{API_KEY}}", out)

    def test_longest_value_first(self):
        # 短い値が長い値の部分文字列でも、長い方を先に置換して壊さない
        secrets = {"SHORT": "abc", "LONG": "abc-def-ghi"}
        out = vault.mask_known_secrets("here abc-def-ghi end", secrets)
        self.assertEqual(out, "here {{LONG}} end")

    def test_empty_value_skipped(self):
        # 空の値で全置換される事故を防ぐ
        out = vault.mask_known_secrets("hello world", {"EMPTY": ""})
        self.assertEqual(out, "hello world")

    def test_none_value_skipped(self):
        out = vault.mask_known_secrets("hello", {"N": None})
        self.assertEqual(out, "hello")

    def test_multiple_occurrences(self):
        out = vault.mask_known_secrets("sk-x and sk-x again", {"K": "sk-x"})
        self.assertEqual(out, "{{K}} and {{K}} again")


class TestMaskPatterns(unittest.TestCase):
    def test_sk_key(self):
        out = vault.mask_patterns(f"key is {SK_DUMMY} done")
        self.assertNotIn(SK_DUMMY, out)
        self.assertIn("***MASKED***", out)

    def test_github_pat(self):
        out = vault.mask_patterns(GHP_DUMMY)
        self.assertNotIn(GHP_DUMMY, out)

    def test_aws_key(self):
        out = vault.mask_patterns(f"{AKIA_DUMMY} here")
        self.assertNotIn(AKIA_DUMMY, out)

    def test_long_token(self):
        tok = "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0"  # 40 chars
        out = vault.mask_patterns(f"token={tok}")
        self.assertNotIn(tok, out)

    def test_normal_text_untouched(self):
        # 普通の短い単語は隠さない
        out = vault.mask_patterns("the quick brown fox jumps")
        self.assertEqual(out, "the quick brown fox jumps")


class TestSanitizeOutbound(unittest.TestCase):
    def test_known_then_auto(self):
        # 既知値は名前へ、未知トークンは ***MASKED*** へ
        known = "sk-" + "known-value-aaaaaaaaaaaa"
        unknown = "sk-" + "unknown-bbbbbbbbbbbbbbbb"
        secrets = {"API_KEY": known}
        text = f"used {known} and {unknown}"
        out = vault.sanitize_outbound(text, secrets)
        self.assertIn("{{API_KEY}}", out)
        self.assertNotIn(known, out)
        self.assertNotIn(unknown, out)

    def test_placeholder_survives_auto_mask(self):
        # 逆マスクで作った {{NAME}} が自動マスクで潰れない
        val = "sk-" + "real-aaaaaaaaaaaaaaaa"
        secrets = {"K": val}
        out = vault.sanitize_outbound(f"got {val}", secrets)
        self.assertIn("{{K}}", out)

    def test_auto_mask_can_be_disabled(self):
        out = vault.sanitize_outbound(SK_DUMMY, None, auto_mask=False)
        # 既知値なし・自動オフなら素通り
        self.assertEqual(out, SK_DUMMY)


class TestExtractBSecrets(unittest.TestCase):
    def test_basic(self):
        text = "token is [[secret:TOKEN]]abc123[[/secret]] ok"
        masked, found = vault.extract_b_secrets(text)
        self.assertEqual(masked, "token is [[secret:TOKEN]] ok")
        self.assertEqual(found, {"TOKEN": "abc123"})
        self.assertNotIn("abc123", masked)

    def test_multiline_value(self):
        text = "[[secret:SEED]]word1 word2\nword3[[/secret]]"
        masked, found = vault.extract_b_secrets(text)
        self.assertEqual(found, {"SEED": "word1 word2\nword3"})
        self.assertNotIn("word1", masked)

    def test_multiple(self):
        text = "[[secret:A]]va[[/secret]] and [[secret:B]]vb[[/secret]]"
        masked, found = vault.extract_b_secrets(text)
        self.assertEqual(found, {"A": "va", "B": "vb"})
        self.assertNotIn("va", masked)
        self.assertNotIn("vb", masked)

    def test_no_secret(self):
        masked, found = vault.extract_b_secrets("plain text")
        self.assertEqual(masked, "plain text")
        self.assertEqual(found, {})


class TestLeakInvariants(unittest.TestCase):
    """漏洩チェック: 値が絶対に通過後の文字列に残らないことを直接検査。"""

    def test_a_direction_reverse_mask_no_leak(self):
        secret_val = "sk-" + "super-secret-value-xyz123"
        secrets = {"API_KEY": secret_val}
        # Claude の各種出力で値が復唱されるケースを総当たり
        for tmpl in [
            "I will use {v} for the request",
            "result: {v}",
            "つまり {v} を使った",
            "```\nexport KEY={v}\n```",
            "{v}{v}{v}",
        ]:
            text = tmpl.format(v=secret_val)
            out = vault.sanitize_outbound(text, secrets)
            self.assertNotIn(secret_val, out, f"LEAK in: {tmpl}")

    def test_b_direction_no_leak_after_extract(self):
        secret_val = "ghp_" + "realtoken1234567890abcdefABCDEF"
        text = f"created [[secret:PAT]]{secret_val}[[/secret]]"
        masked, found = vault.extract_b_secrets(text)
        self.assertNotIn(secret_val, masked)
        self.assertEqual(found["PAT"], secret_val)


if __name__ == "__main__":
    unittest.main()
