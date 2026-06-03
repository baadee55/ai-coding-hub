"""金庫 engine 統合テスト — 実 Job オブジェクト経由で漏洩しないか検証。

vault.py の純関数テスト（test_vault.py）に対し、こちらは claude_code._wrap_emit_with_vault
が「実際の Job の emit / events / ログファイル」に値を残さないことを確認する。
不変条件1（events/logs に実値なし）と不変条件2（逆マスク）の結合検証。

実行: cd agent && python -m unittest engines.test_vault_integration -v
"""
import json
import unittest

from jobs import Job
from engines import claude_code


# ダミー機密は連結で組み立てる（ソース上に sk-/ghp_ の生形を残すと pre-push の
# secret-scan が正しく反応するため）。値は本物でなくマスク検証用の作り物。
SECRET = "sk-" + "super-secret-abcdef1234567890"
PAT = "ghp_" + "realtoken1234567890abcdefABCDEFxy"


class TestEmitWrapNoLeak(unittest.TestCase):
    def setUp(self):
        self.job = Job(engine="claude_code", instruction="use {{API_KEY}}")
        claude_code._wrap_emit_with_vault(self.job, {"API_KEY": SECRET})

    def _all_event_text(self) -> str:
        return json.dumps(self.job.events, ensure_ascii=False)

    def _logfile_text(self) -> str:
        if not self.job._log_path.exists():
            return ""
        return self.job._log_path.read_text(encoding="utf-8")

    def tearDown(self):
        try:
            self.job._log_path.unlink()
        except Exception:
            pass

    def test_token_echo_no_leak_in_events(self):
        # Claude が token で値を復唱 → token は丸ごと捨てられ events に残らない
        self.job.emit({"type": "token", "text": f"using {SECRET} now"})
        self.assertNotIn(SECRET, self._all_event_text())

    def test_token_echo_no_leak_in_logfile(self):
        # ⚠️ 最重要: ディスクログ（logs/jobs/*.jsonl）に平文が残らない
        self.job.emit({"type": "token", "text": f"using {SECRET} now"})
        self.assertNotIn(SECRET, self._logfile_text())

    def test_done_summary_no_leak(self):
        self.job.emit({
            "type": "done",
            "result": f"完了。{SECRET} を使いました",
            "summary": f"{SECRET} で実行",
        })
        blob = self._all_event_text() + self._logfile_text()
        self.assertNotIn(SECRET, blob)

    def test_tool_use_input_no_leak(self):
        # Bash の command に値が乗るケース
        self.job.emit({
            "type": "tool_use",
            "name": "Bash",
            "input": {"command": f"curl -H 'auth: {SECRET}' x"},
            "summary": f"Bash curl -H auth {SECRET}",
        })
        blob = self._all_event_text() + self._logfile_text()
        self.assertNotIn(SECRET, blob)

    def test_tool_result_no_leak(self):
        self.job.emit({
            "type": "tool_result",
            "content": f"output contains {SECRET} oops",
        })
        blob = self._all_event_text() + self._logfile_text()
        self.assertNotIn(SECRET, blob)

    def test_token_dropped_to_prevent_split_leak(self):
        # ⚠️ ストリーミング分割漏洩対策: secrets ジョブでは token を丸ごと捨てる。
        # 値が複数 token に割れても断片が events/ログに残らない。
        half1, half2 = SECRET[:10], SECRET[10:]
        self.job.emit({"type": "token", "text": f"using {half1}"})
        self.job.emit({"type": "token", "text": f"{half2} now"})
        blob = self._all_event_text() + self._logfile_text()
        # 断片すら残らない（token イベント自体が無い）
        self.assertNotIn(half1, blob)
        self.assertNotIn(half2, blob)
        # token イベントは1件も記録されない
        self.assertEqual([e for e in self.job.events if e.get("type") == "token"], [])

    def test_done_result_still_masked_after_token_dropped(self):
        # token を捨てても、done の result（確定全文）で逆マスクされ表示は保たれる
        self.job.emit({"type": "token", "text": f"streaming {SECRET}"})
        self.job.emit({"type": "done", "result": f"完了。{SECRET} を使った", "summary": "ok"})
        blob = self._all_event_text() + self._logfile_text()
        self.assertNotIn(SECRET, blob)
        self.assertIn("{{API_KEY}}", self._all_event_text())

    def test_unknown_token_in_result_auto_masked(self):
        # secrets に無い未知トークンも done result で自動マスクされる
        self.job.emit({"type": "done", "result": f"leaked {PAT} here", "summary": "x"})
        blob = self._all_event_text() + self._logfile_text()
        self.assertNotIn(PAT, blob)
        self.assertIn("***MASKED***", self._all_event_text())

    def test_nested_tool_input_masked(self):
        # input 値が辞書/配列でも再帰サニタイズで漏れない
        self.job.emit({
            "type": "tool_use",
            "name": "X",
            "input": {"nested": {"deep": f"key={SECRET}"}, "arr": [f"v={SECRET}"]},
        })
        blob = self._all_event_text() + self._logfile_text()
        self.assertNotIn(SECRET, blob)

    def test_structured_tokens_auto_masked_but_short_values_are_accepted_limit(self):
        # 漏洩チェック3周目で確定した境界（CLAUDE.md「受け入れたリスク」の裏取り）:
        #   B方向で Claude が規約を破り [[secret:]] で囲まず地の文にベタ書きした場合、
        #   構造のあるトークン（sk-/ghp_/AKIA/40+hex）は自動パターンマスクが拾うが、
        #   "hunter2" のような短い任意文字列は拾えない（＝仕様上の既知の穴）。
        structured = {
            "sk":     "sk-" + "deadbeefdeadbeefdeadbeef12",
            "github": "ghp_" + "a" * 36,
            "aws":    "AKIA" + "IOSFODNN7EXAMPLE",
            "hex":    "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
        }
        for label, tok in structured.items():
            j = Job(engine="claude_code", instruction="x")
            claude_code._wrap_emit_with_vault(j, {"_d": "z"})
            # 規約を破ってベタ書き（[[secret:]] で囲まない）
            j.emit({"type": "done", "result": f"raw {tok} here", "summary": "x"})
            blob = json.dumps(j.events, ensure_ascii=False)
            log = j._log_path.read_text(encoding="utf-8") if j._log_path.exists() else ""
            try:
                j._log_path.unlink()
            except Exception:
                pass
            self.assertNotIn(tok, blob + log, f"structured token {label} must be auto-masked")

        # 短い任意値は自動マスクを通り抜ける（防げない＝受け入れたリスク）。
        # この assertNotIn は意図的に省く。穴を埋めたと誤認しないよう記録だけ残す。
        short_pw = "hunter2"
        j = Job(engine="claude_code", instruction="x")
        claude_code._wrap_emit_with_vault(j, {"_d": "z"})
        j.emit({"type": "done", "result": f"password is {short_pw}", "summary": "x"})
        leaked = short_pw in json.dumps(j.events, ensure_ascii=False)
        try:
            j._log_path.unlink()
        except Exception:
            pass
        # 既知の穴であることを明示（True = 漏れる、が現状の仕様）。
        self.assertTrue(leaked, "short arbitrary values are a documented accepted limit")


class TestBDirectionSeparation(unittest.TestCase):
    def setUp(self):
        self.job = Job(engine="claude_code", instruction="generate a token")
        # B方向は secrets 無しでも動く（emit ラップは secrets 有無に関わらず B 規約を処理）
        claude_code._wrap_emit_with_vault(self.job, {"_dummy": "zzz"})

    def tearDown(self):
        try:
            self.job._log_path.unlink()
        except Exception:
            pass

    def test_b_secret_separated_from_events(self):
        bval = "tok_generated_9988776655"
        self.job.emit({
            "type": "done",
            "result": f"作成しました: [[secret:NEW_TOKEN]]{bval}[[/secret]]",
            "summary": "トークン作成完了",
        })
        blob = json.dumps(self.job.events, ensure_ascii=False)
        log = self.job._log_path.read_text(encoding="utf-8") if self.job._log_path.exists() else ""
        # events/ログには実値が無く、プレースホルダだけ残る
        self.assertNotIn(bval, blob)
        self.assertNotIn(bval, log)
        self.assertIn("[[secret:NEW_TOKEN]]", blob)
        # 実値は別チャネル（meta bucket）に分離されている
        self.assertEqual(self.job.meta["_vault_b_secrets"].get("NEW_TOKEN"), bval)


class TestNoSecretsPassthrough(unittest.TestCase):
    """secrets 無しの通常ジョブは一切変化しない（既存動作を壊さない）。"""

    def test_normal_job_unchanged(self):
        token_like = "sk-" + "not-a-real-secret-here-xyz"
        job = Job(engine="claude_code", instruction="hello")
        # _wrap_emit_with_vault を呼ばない＝通常の emit
        job.emit({"type": "token", "text": token_like})
        # ラップしていないので素通り（自動マスクも掛からない）
        self.assertIn(token_like, json.dumps(job.events, ensure_ascii=False))
        try:
            job._log_path.unlink()
        except Exception:
            pass


if __name__ == "__main__":
    unittest.main()
