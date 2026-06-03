"""金庫（Vault）マスク基盤 — A/B 双方向の機密マスキング純関数群。

CLAUDE.md「🔒 金庫（Vault）機能 — 設計と不変条件」の実装。
ここは**副作用のない純関数だけ**を置く（ブラウザ不要・単体テスト可能、
ui/mic-dictation.js と同じ流儀）。engine（claude_code.py）から呼ぶ。

不変条件（CLAUDE.md より）:
  1. 実値を job.instruction / events / logs に入れない
  2. 逆マスク: emit を通る全文字列を実値→プレースホルダに戻す（本丸）
  3. 自動パターンマスク: 囲み規約の取りこぼしを正規表現で拾う

用語:
  - secrets: {名前: 実値} の辞書（スマホ→PC で送られ、メモリ上のみ。job に保存しない）
  - A方向: 本文の {{名前}} を実値に置換（inject_secrets）。注入は一時ファイル直前のみ。
  - 逆マスク: 実値 → {{名前}} に戻す（mask_known_secrets）。emit 直前に必ず通す。
  - B方向: Claude が [[secret:名前]]値[[/secret]] で囲んだ実値を分離（extract_b_secrets）。
  - 自動: sk-... 等のトークンらしき文字列を ***MASKED*** に（mask_patterns）。
"""
from __future__ import annotations

import re
from typing import Optional


# A方向プレースホルダ: {{NAME}}（NAME は英数字・_・- のみ。誤爆を避け厳格に）
_PLACEHOLDER_RE = re.compile(r"\{\{([A-Za-z0-9_\-]{1,64})\}\}")

# B方向の囲み規約: [[secret:NAME]]値[[/secret]]
_B_SECRET_RE = re.compile(
    r"\[\[secret:([A-Za-z0-9_\-]{1,64})\]\](.*?)\[\[/secret\]\]",
    re.DOTALL,
)

# 自動パターンマスク（取りこぼし対策）。誤検出は許容、漏らすよりマシ。
#   - sk-... / sk-ant-... 等の API キー風
#   - 32文字以上の連続英数字（hex トークン・base64 風）
#   - AKIA... (AWS), ghp_/gho_ (GitHub PAT), xox[bp]- (Slack)
_AUTO_PATTERNS = [
    re.compile(r"\bsk-[A-Za-z0-9_\-]{16,}\b"),
    re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b"),
    re.compile(r"\bxox[baprs]-[A-Za-z0-9\-]{10,}\b"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\b[A-Za-z0-9_\-]{40,}\b"),  # 40+ 連続: 長いトークン全般（誤検出許容）
]

_MASK_TOKEN = "***MASKED***"


def find_placeholders(text: str) -> list[str]:
    """本文に含まれる {{名前}} の名前一覧（重複除去・出現順）。"""
    if not text:
        return []
    seen: list[str] = []
    for m in _PLACEHOLDER_RE.finditer(text):
        name = m.group(1)
        if name not in seen:
            seen.append(name)
    return seen


def inject_secrets(text: str, secrets: Optional[dict]) -> str:
    """A方向: 本文の {{名前}} を実値に置換。

    ⚠️ 戻り値（実値入り）は一時ファイル書き込みにのみ使い、job に戻さないこと。
    secrets に無い名前はそのまま {{名前}} を残す（壊さない／誤注入しない）。
    """
    if not text or not secrets:
        return text

    def _sub(m: re.Match) -> str:
        name = m.group(1)
        if name in secrets and secrets[name] is not None:
            return str(secrets[name])
        return m.group(0)  # 未知の名前は触らない

    return _PLACEHOLDER_RE.sub(_sub, text)


def mask_known_secrets(text: str, secrets: Optional[dict]) -> str:
    """逆マスク（本丸）: 既知の実値を {{名前}} に戻す。

    emit を通る全文字列に適用する。Claude が注入値を復唱したり done サマリに
    出してもここで名前へ戻る。長い値から先に置換（部分一致で短い値が先に食う事故を防ぐ）。
    """
    if not text or not secrets:
        return text
    # 値の長い順。空文字・None はスキップ（空マッチで全置換される事故を防ぐ）。
    items = sorted(
        ((n, str(v)) for n, v in secrets.items() if v not in (None, "")),
        key=lambda kv: len(kv[1]),
        reverse=True,
    )
    out = text
    for name, val in items:
        if val and val in out:
            out = out.replace(val, "{{" + name + "}}")
    return out


def mask_patterns(text: str) -> str:
    """自動パターンマスク: トークンらしき文字列を ***MASKED*** に。

    既知の値の逆マスク（mask_known_secrets）をすり抜けた未知のトークンを拾う。
    誤検出（普通の長い文字列を隠す）は許容。漏らすよりマシ。
    """
    if not text:
        return text
    out = text
    for pat in _AUTO_PATTERNS:
        out = pat.sub(_MASK_TOKEN, out)
    return out


def sanitize_outbound(text: str, secrets: Optional[dict], *, auto_mask: bool = True) -> str:
    """emit 直前の総合サニタイズ。既知値の逆マスク → 自動パターンマスクの順。

    既知値を先に名前へ戻すことで、{{NAME}} 自体が自動マスクで ***MASKED*** に
    潰れるのを防ぐ（プレースホルダは英数字32未満・記号付きなので _AUTO_PATTERNS に
    引っかからない設計だが、順序を明示して保証する）。
    """
    if not text:
        return text
    out = mask_known_secrets(text, secrets)
    if auto_mask:
        out = mask_patterns(out)
    return out


def extract_b_secrets(text: str) -> tuple[str, dict]:
    """B方向: [[secret:名前]]値[[/secret]] を検出し、(マスク後本文, {名前:値}) を返す。

    本文には [[secret:名前]] プレースホルダだけ残し、実値は辞書で分離して
    金庫チャネルへ。実値は events/ログに乗せないこと。
    同じ名前が複数回出たら最後の値を採用（辞書の自然な挙動）。
    """
    if not text:
        return text, {}
    found: dict[str, str] = {}

    def _sub(m: re.Match) -> str:
        name = m.group(1)
        val = m.group(2)
        found[name] = val
        return "[[secret:" + name + "]]"

    masked = _B_SECRET_RE.sub(_sub, text)
    return masked, found
