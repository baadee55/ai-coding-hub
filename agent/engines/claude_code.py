"""Claude Code ヘッドレスエンジン。

`claude -p --output-format stream-json` をサブプロセスで起動し、
stream-json を解釈して統一イベント形式に変換する。
セッション継続には `--resume <session_id>` を使う。
"""
from __future__ import annotations

import asyncio
import json
import os
import subprocess as _sp
from pathlib import Path
from typing import Optional

from jobs import Job
from engines import vault


# Claude CLI のフルパス（PATH 解決もできるが、明示が確実）
def _resolve_claude_cmd() -> str:
    candidates = [
        os.getenv("CLAUDE_CLI"),
        str(Path(os.getenv("APPDATA", "")) / "npm" / "claude.cmd"),
        str(Path(os.getenv("APPDATA", "")) / "npm" / "claude.ps1"),
        "claude",
    ]
    for c in candidates:
        if not c:
            continue
        if c == "claude":
            return c  # PATH 解決
        if Path(c).exists():
            return c
    return "claude"


CLAUDE_CMD = _resolve_claude_cmd()


# CLI が受け付ける --effort の段階は、クラウド側の CLI 更新で増減しうる。
# ハードコードせず `claude --help` から実際の候補を毎回拾う（UI もこれを描画）。
# 取得できない時だけ既知の候補にフォールバックする。プロセス起動は重いので
# 数分キャッシュ。CLI が更新されても放っておけば次回キャッシュ失効時に反映される。
import re as _re
import time as _time
import threading as _threading

_EFFORT_FALLBACK = ["low", "medium", "high", "xhigh", "max"]
_effort_cache: dict = {"levels": None, "at": 0.0}
_EFFORT_TTL = 600.0  # 秒


def get_effort_levels() -> list[str]:
    """`claude --help` を parse して --effort の候補を返す。失敗時はフォールバック。"""
    now = _time.time()
    if _effort_cache["levels"] is not None and (now - _effort_cache["at"]) < _EFFORT_TTL:
        return _effort_cache["levels"]
    levels = None
    try:
        out = _sp.run(
            [CLAUDE_CMD, "--help"],
            capture_output=True, text=True, timeout=15,
            encoding="utf-8", errors="replace",
            shell=(CLAUDE_CMD.endswith(".cmd") or CLAUDE_CMD.endswith(".ps1")),
        ).stdout or ""
        # 例: "--effort <level>   Effort level for the current session (low, medium, high, xhigh, max)"
        m = _re.search(r"--effort\b.*?\(([^)]*)\)", out, _re.DOTALL)
        if m:
            parsed = [x.strip() for x in m.group(1).split(",") if x.strip()]
            # 英数字系の妥当な短い識別子だけ採用（説明文の混入を弾く）
            parsed = [x for x in parsed if _re.fullmatch(r"[a-z][a-z0-9_-]{0,15}", x)]
            if parsed:
                levels = parsed
    except Exception:
        levels = None
    if not levels:
        levels = _EFFORT_FALLBACK
    _effort_cache["levels"] = levels
    _effort_cache["at"] = now
    return levels


# ── 作業モデルの解決（常に「最新 Opus」に自動追随）────────────────────────────
# CLI エイリアス "opus" は新しい Opus 公開後しばらく旧版へ遅延解決される
# （実測: `--model opus`→claude-opus-4-8 のままだが、`--model claude-opus-5`
#  は API で受理・稼働する）。そこで「エイリアスの実解決先」と「既知の最新明示ID
#  (_OPUS_PIN)」を比べ、新しい方を使う。エイリアスが _OPUS_PIN に追い付く/追い越したら
#  以後はエイリアスを使う＝将来のメジャー更新は CLI 更新だけで自動追随（コード変更不要）。
# 判定は 24h キャッシュ＋バックグラウンド更新でジョブ起動を一切遅らせない。
# 何が失敗しても最終的に "opus"（＝CLI 既定の最新）へフォールバックする。
# 実測: `--model claude-opus-5-5` は受理・稼働（modelUsage=claude-opus-5-5）。
_OPUS_PIN = "claude-opus-5-5"   # 現時点の最新 Opus 明示ID。エイリアスが追い付けば自然に無効化。
_work_model_cache: dict = {"id": _OPUS_PIN, "at": 0.0}
_WORK_MODEL_TTL = 86400.0     # 秒（24h）
_work_refresh_lock = _threading.Lock()


def _opus_version_key(model_id: Optional[str]) -> tuple:
    """opus 系モデルIDを比較可能なタプルに。
    例: claude-opus-4-8→(4,8) / claude-opus-5→(5,0) / claude-opus-5-5→(5,5)。opus以外は(-1,0)。

    実モデルIDは日付付きで返ることがある（claude-opus-5-20260401）。末尾の8桁日付を
    先に剥がさないと minor=20260401 と読めてしまい、新しい PIN（例 5.5）より
    「エイリアスの方が新しい」と誤判定して旧版へ落ちる。
    """
    s = _re.sub(r"-\d{8}$", "", (model_id or "").lower().strip())
    m = _re.search(r"opus-(\d+)(?:-(\d+))?", s)
    if not m:
        return (-1, 0)
    return (int(m.group(1)), int(m.group(2)) if m.group(2) else 0)


def _probe_model(model_id: str, timeout: float = 25.0) -> Optional[str]:
    """model_id が実際に受理され応答するか軽く確認。受理なら実モデルID、不可/失敗なら None。
    受理されない ID はほぼ即エラー（推論前）で返るため安価。stdin は Windows の都合で
    一時ファイル `<` リダイレクト（run_oneshot と同じ流儀）。
    """
    import tempfile as _tf
    import os as _os2
    fd, p = _tf.mkstemp(prefix="claude_probe_", suffix=".txt")
    try:
        with _os2.fdopen(fd, "w", encoding="utf-8") as f:
            f.write("ok")
        args = [CLAUDE_CMD, "-p", "--output-format", "json",
                "--input-format", "text", "--model", model_id]
        cmd = _sp.list2cmdline(args) + f' < "{p}"'
        # CLI 出力は UTF-8。text=True 既定のロケール(cp932 等)で復号すると日本語混じりで
        # UnicodeDecodeError になるため UTF-8 を明示する。
        out = _sp.run(cmd, capture_output=True, text=True, encoding="utf-8",
                      errors="replace", timeout=timeout, shell=True).stdout or ""
        d = json.loads(out)
        if d.get("is_error"):
            return None
        mu = d.get("modelUsage") or {}
        return next(iter(mu.keys()), None)
    except Exception:
        return None
    finally:
        try:
            _os2.unlink(p)
        except Exception:
            pass


def _refresh_work_model() -> None:
    """エイリアス解決先と _OPUS_PIN を比べ、新しい方をキャッシュに入れる。バックグラウンド実行。"""
    if not _work_refresh_lock.acquire(blocking=False):
        return  # 既に別スレッドが更新中
    try:
        alias_actual = _probe_model("opus")            # 例: claude-opus-4-8
        best_id = "opus"                               # 既定はエイリアス（将来更新に自動追随）
        # エイリアスが PIN より古い（＝新版公開直後の遅延窓）間だけ、明示 PIN を使う。
        if _opus_version_key(_OPUS_PIN) > _opus_version_key(alias_actual):
            if _probe_model(_OPUS_PIN):
                best_id = _OPUS_PIN
        _work_model_cache["id"] = best_id
        _work_model_cache["at"] = _time.time()
    finally:
        _work_refresh_lock.release()


def get_work_model() -> str:
    """既定の作業モデル（最新 Opus）。キャッシュを即返し、失効時のみ裏で更新（ジョブは待たせない）。"""
    now = _time.time()
    if (now - _work_model_cache["at"]) > _WORK_MODEL_TTL:
        _threading.Thread(target=_refresh_work_model, daemon=True).start()
    return _work_model_cache["id"]


# 中継AI（作業を実行する Claude Code 本体）へ常駐で渡すシステム説明。
# --append-system-prompt で毎回付与する＝指示文・events・logs には載らないので
# 機密も履歴も汚さない。--resume でセッションを継いでも毎回付与される。
# 別プロジェクト配下で動くと、この hub 独自の作法（特に🔒金庫）が未知語のまま届き
# 「金庫でトークンを教えろ」が無視される／「暗証番号を金庫で渡す」が伝わらない
# 事故が起きるため、AI 側に hub の前提を最初から分からせておく。
# 金庫の書式は engines/vault.py の正規表現と一致させること。
AIHUB_SYSTEM_BRIEFING = """\
あなたはスマホアプリ「AI Coding Hub」から呼ばれている作業AIです。次の前提を常に守ってください。

# この環境について
- 指示者はスマホからあなたを操作しています。あなたのターミナル画面は見えません。
  結果は小さいスマホ画面で読まれます。専門用語を避け、要点を短く、人間語で返してください。
- **指示文と同じ言語で返答してください**（日本語の指示には日本語、英語には英語、
  他の言語も同様）。
- 登録されたプロジェクト配下でのみ動けます。

# 🔒 金庫(Vault) — 機密値をチャット履歴・画面・ログに残さず受け渡す仕組み
この hub には「金庫」があり、APIキー・パスワード・暗証番号・ニーモニック・トークン・
接続文字列・アドレス等の機密値を、平文で会話に残さずやり取りできます。次の作法を厳守:

【受け取り（ユーザー→あなた）】
  ユーザーが「金庫で暗証番号を渡す」「金庫の値を使え」等と言ったとき、その値は
  あなたの指示文の中に `{{名前}}`（二重波括弧）のプレースホルダとして **既に実値が
  注入された状態** で届いています。`{{名前}}` をそのまま使えば実値として機能します。
  ⚠️ 「値が見当たらない」「チャットに貼って」と言わないこと。値は既に入っています。

【返却（あなた→ユーザー）】
  ユーザーが機密値を「教えて」「表示して」「返して」等と求めたら（口語的な
  「トークン教えて」でも）、**必ず**次の囲みで包んで返してください:
      [[secret:名前]]実際の値[[/secret]]
  例: 生成したトークンを返す → `[[secret:token]]0xABC...123[[/secret]]`
  名前は英数字・_・- のみ(1〜64字)。囲んだ実値は hub が金庫チャネルへ自動分離し、
  本文には `[[secret:名前]]` だけ残り、スマホで開錠した時だけ実値が見えます。
  ⚠️ 機密を求められて拒否したり、地の文にベタ書きしてはいけません。
     **囲んで返すことが、安全に「教える」方法です。** 機密でない通常の回答は地の文でOK。
"""


def _running_as_system() -> bool:
    """中継AIが Windows の SYSTEM(LocalSystem)アカウントで動いていないか判定。

    SYSTEM だと `claude login`（Max プラン枠）の認証情報も claude.cmd 本体も
    ユーザープロファイル側にあって見えず、claude がコマンド不在/未認証で即死する
    （実測: ジョブ作成 0.03 秒で "claude プロセスが応答しませんでした"）。
    ネット断後にエージェントを SYSTEM 権限の経路で再起動すると起きる。
    USERPROFILE が systemprofile を指す / ユーザー名が末尾 `$`（マシンアカウント）で検出。
    """
    up = (os.getenv("USERPROFILE") or "").lower()
    un = os.getenv("USERNAME") or ""
    return ("systemprofile" in up) or un.endswith("$")


def _subprocess_env(thinking: bool = True) -> dict:
    """claude サブプロセスに渡す環境変数。

    `thinking` で拡張思考（extended thinking）のオン/オフを切替える。既定オン。
    UI 設定から `thinking`(bool) が届く。既定はオン。

    ⚠️ 400 の既知リスク: 拡張思考をオンのまま `--resume` で履歴を再生したり、
    長セッションで自動コンパクションが走ると、thinking ブロックの署名が
    再生時に食い違い、Anthropic API が
      400 messages.N.content.M: `thinking` or `redacted_thinking` blocks in the
      latest assistant message cannot be modified.
    を返してジョブごと落ちうる（過去実測: resume 直後 1 turn 即死／35-42 turn の長尺中）。
    → 対策は 2 段構え: ①ユーザーがオフを選べば DISABLE_THINKING=1 で根絶。
    ②オンでも run 側が 400 を検知したら、その 1 回だけ thinking 無しで自動リトライ（下記参照）。
    thinking=False 時は「改変できないブロック」自体が存在しないので resume/コンパクションで 400 は起きない。
    なお `ANTHROPIC_API_KEY` は絶対に追加しないこと（Max プラン枠を外れて課金される）。
    """
    env = dict(os.environ)
    if thinking:
        # 拡張思考オン。DISABLE は立てない（外部から渡っても無効化して事故を防ぐ）。
        env.pop("CLAUDE_CODE_DISABLE_THINKING", None)
    else:
        # 拡張思考オフ。thinking ブロックを一切生成させない＝resume/コンパクションでも 400 が起きない。
        env["CLAUDE_CODE_DISABLE_THINKING"] = "1"
    env.pop("ANTHROPIC_API_KEY", None)  # 念のため。Max プラン枠を死守
    for _k in ("AGENT_TOKEN", "CLOUDFLARE_TUNNEL_TOKEN", "CF_TOKEN"):
        env.pop(_k, None)  # hub 自身の秘密は子プロセスに渡さない
    return env


def _model_family_matches(requested: Optional[str], actual: str) -> bool:
    """指定モデルと実モデルが同系統か。

    実モデルIDは日付付きフルID（例 claude-opus-4-8-20260220）で返るため、
    前方一致 or 包含（エイリアス "sonnet" 等）で判定する。
    クラウド側の強制フォールバック（仕様）で別系統に切替わった時だけ False。
    """
    if not requested or not actual:
        return True
    r = requested.lower().strip()
    a = actual.lower()
    return a.startswith(r) or r in a


_UNSAFE_PATH = _re.compile(r'[&|<>^%"!\r\n]')
_SAFE_ARG = _re.compile(r"[A-Za-z0-9._:\-\[\]]+")


def _check_safe_arg(name: str, value: Optional[str]) -> None:
    """cmd.exe を経由して起動するため、& | ^ % 等のメタ文字を含む値は拒否する（コマンド注入防止）。"""
    if value and not _SAFE_ARG.fullmatch(value):
        raise ValueError(f"invalid {name}")


async def run_oneshot(
    prompt: str,
    *,
    cwd: Optional[str] = None,
    model: Optional[str] = None,
    effort: Optional[str] = None,
    system_prompt: Optional[str] = None,
    timeout: float = 60.0,
) -> str:
    """tools 不要の単発生成（要約・整形用）。
    stream-json ではなく text 出力をそのまま返す。Max プラン枠で動く。

    `system_prompt` を渡すと Claude Code のデフォルト system prompt
    （コーディングアシスタント role）を上書きするので、要約・翻訳タスクに向く。

    実装注: Windows の cmd.exe では (a) `-p "..."` 長文引数のクオートが壊れる
    (b) asyncio の PIPE stdin が claude.cmd まで届かないことがあるため、
    プロンプトを一時ファイルに書いてシェル `<` リダイレクトで流し込む。
    """
    import tempfile
    import os as _os
    args: list[str] = [CLAUDE_CMD, "-p", "--output-format", "text", "--input-format", "text"]
    _check_safe_arg("model", model)
    if model:
        # "opus" 系を指定されたら遅延エイリアスでなく最新 Opus 実IDへ解決（run() と整合）。
        if model.lower() in ("opus", "opus-4.8", "claude-opus-4.8", "claude-opus-4-8"):
            model = get_work_model()
        args += ["--model", model]
    # 中継（要約・整形）にも --effort を効かせる。廃止された段階は無視して CLI 既定に任せる。
    if effort and effort in get_effort_levels():
        args += ["--effort", effort]
    if system_prompt is not None:
        args += ["--system-prompt", system_prompt]
    cmd_str = _sp.list2cmdline(args)

    fd, prompt_path = tempfile.mkstemp(prefix="claude_prompt_", suffix=".txt")
    try:
        with _os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(prompt)
        # シェルリダイレクト経由で stdin に流す
        cmd_str = f'{cmd_str} < "{prompt_path}"'
        try:
            proc = await asyncio.create_subprocess_shell(
                cmd_str,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=cwd,
                env=_subprocess_env(),
                limit=16 * 1024 * 1024,
            )
        except FileNotFoundError:
            return f"(claude CLI が見つかりません: {CLAUDE_CMD})"
        try:
            stdout_b, stderr_b = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            try:
                proc.kill()
            except Exception:
                pass
            return "(処理に時間がかかりすぎました)"
        if proc.returncode and proc.returncode != 0:
            err = stderr_b.decode("utf-8", errors="replace")[-400:]
            return f"(エラー rc={proc.returncode}: {err})"
        return stdout_b.decode("utf-8", errors="replace").strip()
    finally:
        try:
            _os.unlink(prompt_path)
        except Exception:
            pass


def _short_tool_summary(name: str, inp: dict) -> str:
    """tool_use の input を 1 行サマリ化（UI 表示用）。"""
    try:
        if name in ("Read", "Edit", "Write", "NotebookEdit"):
            return f"{name} {inp.get('file_path', '')}"
        if name in ("Glob",):
            return f"Glob {inp.get('pattern', '')}"
        if name in ("Grep",):
            return f"Grep {inp.get('pattern', '')[:40]}"
        if name in ("Bash", "PowerShell"):
            cmd = (inp.get("command") or "")[:80]
            return f"{name} {cmd}"
        if name == "TodoWrite":
            todos = inp.get("todos") or []
            return f"TodoWrite ({len(todos)} 件)"
        if name == "Task":
            return f"Task → {inp.get('subagent_type', '?')}: {(inp.get('description') or '')[:40]}"
        keys = ",".join(list(inp.keys())[:3])
        return f"{name}({keys})"
    except Exception:
        return name


# 本文に「ツール名だけ」が異常反復する壊れ方の検知用。実 tool_use を伴わず
# `\n\nGrep\n\nGrep\n\n…` と延々出し続ける毒会話が実測された（1ジョブで 6158 反復）。
# `<invoke>` 形式ですらないので旧 _is_text_tool_call を素通りしていた。
_KNOWN_TOOL_NAMES = (
    "Read", "Edit", "Write", "NotebookEdit", "Glob", "Grep",
    "Bash", "PowerShell", "TodoWrite", "Task", "WebFetch", "WebSearch",
)
# 同一ツール名がこの回数以上、単独行として反復したら毒とみなす（通常の回答ではまず出ない）。
_BARE_TOOL_REPEAT_THRESHOLD = 8


def _bare_toolname_spam(s: str) -> bool:
    """実ツールを呼ばず、ツール名だけを本文に反復出力する壊れ方の判定。

    resume 履歴が壊れると、モデルが `Grep`（や他のツール名）を改行区切りで延々と
    書き続け、実 tool_use は一切発火しないまま時間切れまで走る＝「進まないのに
    止まらない」。同じツール名が単独行として閾値回数以上連なったら毒会話と判定する。
    """
    if not s:
        return False
    for tn in _KNOWN_TOOL_NAMES:
        # `\n\nGrep`（前後の空行に挟まれた単独ツール名）の反復回数を数える
        if s.count(f"\n\n{tn}") >= _BARE_TOOL_REPEAT_THRESHOLD:
            return True
    return False


def _is_text_tool_call(s: str) -> bool:
    """tool 呼び出しが実 tool_use ではなく「本文テキスト」として出力された壊れ方の判定。

    resume した会話履歴が壊れると（割り込み等でターン途中に claude を kill した
    transcript を継ぐと起きる）、モデルが `<invoke name="…">…</invoke>` という
    tool 呼び出しの生マークアップを本文に書き出し、ツールが一切実行されないまま
    end_turn で空振りする＝「応答は来るが修正が途中で止まる」。
    `<invoke name="` と（`<parameter name="` または `</invoke>`）が本文に揃って
    現れるのは、この壊れ方に固有のパターン（通常の回答ではまず出ない）。
    ツール名だけの反復（`\n\nGrep\n\nGrep…`）も同種の毒会話なので合わせて拾う。
    """
    if _bare_toolname_spam(s):
        return True
    if '<invoke name="' not in s:
        return False
    return ('<parameter name="' in s) or ('</invoke>' in s)


def _wrap_emit_with_vault(job: Job, secrets: Optional[dict]):
    """🔒金庫: job.emit を逆マスク/分離付きに差し替える（不変条件2の本丸）。

    emit を通る全イベントの文字列フィールド（token/result/summary/tool input/
    tool_result/action/error）を配信前にサニタイズする:
      - B方向: [[secret:名前]]値[[/secret]] → 値を分離、本文は [[secret:名前]] だけ。
               **secrets の有無に関わらず常時**有効（明示囲みなので誤検出ゼロ）。
               これで /command 経路や secrets 無しジョブでも、Claude が囲んで返した
               機密が events/ログ/画面に残らない。
      - A方向: 既知の実値 → {{名前}}（mask_known_secrets）。secrets ありのみ。
      - 自動: トークンらしき未知文字列 → ***MASKED***（mask_patterns）。secrets ありのみ
               （git SHA(40hex) 等を誤爆するので通常出力には掛けない）。
    これで token 復唱・done サマリ・tool コマンド文字列・ログ追記の全経路で
    実値が残らない。B方向で分離した値は job.meta["_vault_b_secrets"] に溜める
    （後で SSE 配信時に別チャネルとして UI へ渡せるが、ログ/events には乗らない）。
    """
    orig_emit = job.emit
    b_bucket: dict = job.meta.setdefault("_vault_b_secrets", {})
    has_secrets = bool(secrets)
    # B方向の囲みが token を跨いで流れる時の抑止状態（secrets 無し経路でのみ使用）。
    _b_stream = {"suppress": False}

    def _san(text):
        if not isinstance(text, str) or not text:
            return text
        # B方向: 囲み規約の実値を分離（本文はプレースホルダだけ残る）。常時。
        masked, found = vault.extract_b_secrets(text)
        if found:
            b_bucket.update(found)
        # A方向 + 自動: 既知値を名前へ、未知トークンを ***MASKED*** へ。secrets ありのみ。
        if has_secrets:
            return vault.sanitize_outbound(masked, secrets)
        return masked

    def _token_event(event: dict) -> Optional[dict]:
        # ⚠️ ストリーミング分割対策（取りこぼしの本丸）:
        # token は1イベント＝数文字のことがあり、機密値が複数 token に割れると
        # 各断片が逆マスクをすり抜け、繋げば復元できる（実質漏洩）。
        # secrets ありジョブでは token（部分表示）を**丸ごと捨てる**。done の result
        # （全文確定後）でまとめて逆マスクするので表示は失われない。
        if has_secrets:
            return None
        # secrets 無し: B方向の囲みが token を跨いで流れると、閉じる前の値断片が
        # token として漏れる。`[[secret:` 出現〜`[[/secret]]` までを抑止する
        # （最終文は done.result が B 分離済みで運ぶので表示は保たれる）。
        text = event.get("text") or ""
        out = text
        if _b_stream["suppress"]:
            idx = out.find("[[/secret]]")
            if idx == -1:
                return None  # まだ囲み内: 全部伏せる
            out = out[idx + len("[[/secret]]"):]
            _b_stream["suppress"] = False
        if "[[secret:" in out:
            head, _sep, rest = out.partition("[[secret:")
            _b_stream["suppress"] = "[[/secret]]" not in rest
            out = head  # 囲み開始より前だけ出す（中身=値は出さない）
        if not out:
            return None
        ev = dict(event)
        ev["text"] = out
        return ev

    def _sanitize_event(event: dict) -> Optional[dict]:
        # 値が乗りうるフィールドだけ選んでサニタイズ（イベント型ごと）。
        if event.get("type") == "token":
            return _token_event(event)
        ev = dict(event)
        for k in ("text", "result", "summary", "content", "name"):
            if k in ev:
                ev[k] = _san(ev[k])
        # tool_use の input は辞書。中身の文字列値を再帰的にサニタイズ。
        if isinstance(ev.get("input"), dict):
            ev["input"] = {k: _san_deep(v) for k, v in ev["input"].items()}
        # B方向: done 時点で分離済みの機密件数を UI に知らせる（実値は乗せない）。
        # 実値は vault.stash_pending の受け渡し置き場（メモリのみ）へ移し、
        # スマホ UI が金庫を開錠した時に GET /jobs/vault/pending（JWT 必須・
        # 一回きり）で取得して端末内の暗号化金庫へ保存する。SSE/events/ログには
        # 引き続き実値を一切乗せない。
        if ev.get("type") == "done":
            ev["vault_received"] = len(b_bucket)
            if b_bucket:
                vault.stash_pending(b_bucket)
        return ev

    def _san_deep(v):
        # input 値が文字列/辞書/配列いずれでも再帰的にサニタイズ（取りこぼし防止）。
        if isinstance(v, str):
            return _san(v)
        if isinstance(v, dict):
            return {k: _san_deep(x) for k, x in v.items()}
        if isinstance(v, list):
            return [_san_deep(x) for x in v]
        return v

    def emit(event: dict):
        sanitized = _sanitize_event(event)
        if sanitized is not None:  # token は捨てる/抑止する場合あり
            orig_emit(sanitized)

    job.emit = emit  # type: ignore[method-assign]


async def run(
    job: Job,
    *,
    instruction: str,
    project_path: Optional[str] = None,
    session_id: Optional[str] = None,
    permission_mode: str = "bypassPermissions",
    model: Optional[str] = None,
    effort: Optional[str] = None,
    thinking: bool = True,
    extra_args: Optional[list[str]] = None,
    secrets: Optional[dict] = None,
    _thinking_retry: bool = False,
) -> None:
    """Claude Code をヘッドレスで起動し、ジョブにイベントを emit する。

    🔒金庫:
      - 逆マスク/分離: emit を _wrap_emit_with_vault で**常時**ラップ（不変条件2）。
        B方向（[[secret:名前]]値[[/secret]] の分離）は secrets 無しでも有効。
      - A方向（secrets ありのみ）: stdin に流すプロンプトの {{名前}} を実値に置換
        （一時ファイルのみ）。job.instruction には {{名前}} のまま残る（不変条件1）。
        既知値の逆マスク＋自動パターンマスクも secrets ありジョブ限定。
    secrets は引数（runner クロージャ）でのみ受け取り、job オブジェクトには保存しない。
    """
    # 🔒 逆マスク/分離を最優先で常時仕掛ける（以降の emit は全てサニタイズ経由）。
    # secrets が無くても B方向（[[secret:名前]]値[[/secret]]）の分離は常に有効化する。
    # これで /command 経路や secrets 無しジョブでも、Claude が囲んで返した機密が
    # events/ログ/画面に残らない。既知値の逆マスク＋自動パターンは secrets ありジョブ限定。
    _wrap_emit_with_vault(job, secrets)

    for _n, _v in (("permission_mode", permission_mode), ("session_id", session_id), ("model", model)):
        _check_safe_arg(_n, _v)

    if project_path and _UNSAFE_PATH.search(project_path):
        raise ValueError("invalid project_path")

    args: list[str] = [
        CLAUDE_CMD,
        "-p",
        "--input-format", "text",
        "--output-format", "stream-json",
        "--include-partial-messages",
        "--verbose",  # stream-json は --verbose が必須
        "--permission-mode", permission_mode,
    ]
    if project_path:
        args += ["--add-dir", project_path]
    if session_id:
        args += ["--resume", session_id]
    # 実際の作業（コーディング）は既定で「最新 Opus」。
    # モデル無指定 or "opus" 系選択のときは get_work_model() が最新 Opus を解決する
    # （エイリアスが遅延している間は明示 _OPUS_PIN=claude-opus-5-5 を使い、追い付いたら
    #  エイリアス＝将来のメジャー更新に自動追随。詳細は get_work_model 上部コメント参照）。
    # UI で haiku/sonnet やフルモデルID を明示選択した場合はそれを尊重する。
    # 実際に応答したモデルIDは各 assistant message.model で検出・job.model に同期（下記）。
    _model = model or "opus"
    if _model.lower() in ("opus", "opus-4.8", "claude-opus-4.8", "claude-opus-4-8"):
        _model = get_work_model()
    args += ["--model", _model]

    # がんばり度（effort）。CLI ネイティブの --effort（low/medium/high/xhigh/max）。
    # 軽い指示は low で速く・難しい作業は high+ でじっくり考えさせる。DISABLE_THINKING とは
    # 独立に効くので thinking-400 の心配はない。未指定なら CLI 既定に任せる。
    if effort and effort in get_effort_levels():
        args += ["--effort", effort]

    # hub のシステム説明を常駐付与（金庫の作法・スマホ越し前提など）。指示文・events・
    # logs には載らない＝機密も履歴も汚さない。改行を含む長文なので引数直書きは cmd.exe で
    # 崩れる → 一時ファイルに書いて --append-system-prompt-file で渡す（prompt と同じ流儀）。
    import tempfile
    import os as _os
    sys_fd, sysprompt_path = tempfile.mkstemp(prefix="claude_sys_", suffix=".txt")
    with _os.fdopen(sys_fd, "w", encoding="utf-8") as f:
        f.write(AIHUB_SYSTEM_BRIEFING)
    args += ["--append-system-prompt-file", sysprompt_path]

    if extra_args:
        args += extra_args

    # Windows 用に list2cmdline で文字列化（quote 適切に処理される）
    cmd_str = _sp.list2cmdline(args)
    cwd = project_path or None

    # 指示文はシェル引数に載せず、一時ファイル → stdin リダイレクトで渡す。
    # create_subprocess_shell は cmd.exe を経由するため、instruction を `-p "..."`
    # で渡すと cmd.exe のメタ文字（% 展開・" の扱い）と list2cmdline のクオートが
    # ズレて壊れる/誤展開する。run_oneshot と同じく stdin 経由にして遮断する。
    fd, prompt_path = tempfile.mkstemp(prefix="claude_job_", suffix=".txt")

    def _cleanup_prompt():
        for p in (prompt_path, sysprompt_path):
            try:
                _os.unlink(p)
            except Exception:
                pass

    # 🔒金庫A方向: 一時ファイルに書く瞬間だけ {{名前}} を実値に置換する。
    # この置換後の文字列は job にも events にも戻さない（不変条件1）。
    # secrets が無ければ instruction はそのまま（通常動作）。
    # 置換 or 書き込みで例外が出ても一時ファイル（sys/prompt 両方）を必ず消す。
    try:
        prompt_to_write = vault.inject_secrets(instruction, secrets) if secrets else instruction
        with _os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(prompt_to_write)
        del prompt_to_write  # 実値入り文字列を早めに手放す
    except Exception:
        _cleanup_prompt()
        raise
    cmd_str = f'{cmd_str} < "{prompt_path}"'

    try:
        proc = await asyncio.create_subprocess_shell(
            cmd_str,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd,
            # thinking-400 リトライ時は必ず thinking を切る。それ以外は UI 由来の値（既定オン）。
            env=_subprocess_env(thinking=False if _thinking_retry else thinking),
            # stream-json は大きいファイル内容を 1 行に載せてくる（例: app.js 78KB）。
            # asyncio の既定行バッファ上限 64KB を超えると Windows Proactor では
            # 読取りが破綻してジョブごと中断扱いになる。十分大きくして防ぐ。
            limit=16 * 1024 * 1024,
        )
    except FileNotFoundError:
        _cleanup_prompt()
        job.emit({"type": "error", "text": f"claude CLI が見つかりません: {CLAUDE_CMD}"})
        return

    # キャンセル時にサブプロセスを kill
    def _kill():
        try:
            if proc.returncode is None:
                proc.kill()
        except Exception:
            pass

    job.meta["_cancel_cb"] = _kill

    # 安定動作のため最初のイベント（init 待ち）
    started_emitted = False

    # 🩹 汚染セッション検知用。実 tool_use が一度も出ないまま、本文に tool 呼び出しの
    # 生マークアップ（`<invoke name="…">`）が現れたら、resume 元の会話履歴が壊れている。
    # その場合 _session_poisoned を立て、jobs.py に session を破棄させて次回をクリーン起動
    # ＝自己修復させる（_subprocess_env の thinking-400 対策と同じ復旧経路）。
    real_tool_use_count = 0
    # 🤖 実モデル同期: クラウド側は負荷等で指定モデルを別モデルに強制切替することがある
    # （仕様）。init の model は「指定値のエコー」でしかなく、実際に応答を生成したモデルは
    # 各 assistant メッセージの message.model にだけ載る。ここを毎回見て同期する。
    actual_model: Optional[str] = None
    assistant_text_tail = ""  # assistant のテキスト出力末尾（検知用・上限付き）
    runaway_killed = False    # ツール名反復の暴走を検知して自分から打ち切ったか
    # 空 result(num_turns=0) をスキップした場合の控え。本物の result が来ないまま
    # ストリームが終わったら、これで done を確定させる（実行中バッジを残さない）。
    empty_result_pending: Optional[dict] = None

    # stderr は最後まで貯めておき、失敗時の原因表示に使う。
    # 以前はこの中で emit していたが、finally で即 cancel されると emit 前に消えて
    # 本当のエラー（'claude' is not recognized 等）を取りこぼし、"応答しませんでした"
    # という無情報なメッセージだけが残っていた。バッファに集めて末尾でまとめて判断する。
    stderr_chunks = bytearray()

    async def _read_stderr():
        while True:
            chunk = await proc.stderr.read(4096)
            if not chunk:
                break
            stderr_chunks.extend(chunk)
            if len(stderr_chunks) > 8000:
                del stderr_chunks[:-8000]

    stderr_task = asyncio.create_task(_read_stderr())

    try:
        assert proc.stdout is not None
        async for raw in proc.stdout:
            if job.cancel_requested():
                _kill()
                break
            line = raw.decode("utf-8", errors="replace").strip()
            if not line:
                continue
            try:
                data = json.loads(line)
            except json.JSONDecodeError:
                # 非 JSON 行は無視（claude が出すバナー等）
                continue

            t = data.get("type")
            sid = data.get("session_id")

            if t == "system" and data.get("subtype") == "init":
                job.emit({
                    "type": "started",
                    "session_id": sid,
                    "model": data.get("model"),
                    "cwd": data.get("cwd"),
                    "tools": data.get("tools", [])[:50],
                })
                started_emitted = True

            elif t == "stream_event":
                ev = data.get("event") or {}
                et = ev.get("type")
                if et == "content_block_delta":
                    delta = ev.get("delta") or {}
                    if delta.get("type") == "text_delta":
                        text = delta.get("text") or ""
                        if text:
                            job.emit({"type": "token", "text": text})
                            # 検知用に末尾だけ保持（マークアップは近接して出るので 8KB で十分）
                            assistant_text_tail = (assistant_text_tail + text)[-8000:]
                            # 🩹 暴走の即時停止: 実ツールを呼ばずツール名だけを本文に
                            # 延々反復する毒会話（`\n\nGrep\n\nGrep…`）を、result を待たず
                            # ストリーム途中で打ち切る。放置すると誰かが cancel するまで
                            # 2 分近く無意味に token を吐き続け「進まないのに止まらない」。
                            if _bare_toolname_spam(assistant_text_tail):
                                runaway_killed = True
                                job.meta["_session_poisoned"] = True
                                job.emit({"type": "action", "text": (
                                    "⚠ 会話履歴が壊れて堂々巡りになっていたため打ち切りました。"
                                    "次の指示は新しい会話で自動的に開始し直します。"
                                )})
                                _kill()
                                break
                    elif delta.get("type") == "input_json_delta":
                        # tool 入力の途中（無視。完成版は assistant メッセージで来る）
                        pass
                elif et == "content_block_start":
                    block = ev.get("content_block") or {}
                    if block.get("type") == "tool_use":
                        # 完全な input がまだ来ていないので開始だけ通知
                        name = block.get("name") or ""
                        job.emit({
                            "type": "tool_start",
                            "name": name,
                            "tool_use_id": block.get("id"),
                        })

            elif t == "assistant":
                msg = data.get("message") or {}
                _m = msg.get("model") or ""
                if _m and _m != actual_model:
                    prev = actual_model
                    actual_model = _m
                    # job.model を実モデルに同期（jobs.py が拾って状態・履歴に反映）
                    job.emit({"type": "model", "model": _m, "requested": _model})
                    if prev is None:
                        if not _model_family_matches(_model, _m):
                            job.emit({"type": "action", "text": (
                                f"⚠ クラウド側でモデル切替: 指定 {_model} → 実際 {_m}"
                            )})
                    else:
                        job.emit({"type": "action", "text": (
                            f"⚠ モデルが途中で切替わりました: {prev} → {_m}"
                        )})
                for content in msg.get("content") or []:
                    if content.get("type") == "tool_use":
                        real_tool_use_count += 1
                        name = content.get("name") or ""
                        inp = content.get("input") or {}
                        summary = _short_tool_summary(name, inp)
                        job.emit({
                            "type": "tool_use",
                            "name": name,
                            "input": inp,
                            "tool_use_id": content.get("id"),
                            "summary": summary,
                        })
                        job.emit({"type": "action", "text": summary})

            elif t == "user":
                msg = data.get("message") or {}
                for content in msg.get("content") or []:
                    if content.get("type") == "tool_result":
                        body = content.get("content")
                        # content は文字列 or 配列。文字列化
                        if isinstance(body, list):
                            body = "".join(
                                (b.get("text") or "") for b in body if isinstance(b, dict)
                            )
                        body = (body or "")
                        is_err = bool(content.get("is_error"))
                        job.emit({
                            "type": "tool_result",
                            "tool_use_id": content.get("tool_use_id"),
                            "content": body[:4000],
                            "truncated": len(body) > 4000,
                            "is_error": is_err,
                        })

            elif t == "result":
                # 最終結果
                summary = ""
                result_text = data.get("result") or ""
                is_api_error = bool(data.get("is_error")) or result_text.startswith("API Error")
                # 🩹 空 result の早漏（=「出力なし」の真因）: 前ジョブがバックグラウンド
                # タスクを残したセッションを resume すると、CLI が溜まった通知/キューを
                # 処理する前に num_turns=0・空文字の result を即吐くことがある（実測:
                # 112ms で done → 本物の応答は 2 分後にセッションへ書かれるが誰も読ま
                # ない）。これを最終結果とみなさず読み続け、本物の result を待つ。
                # 本物が来ないまま EOF になったら従来どおり空で確定させる（下の
                # empty_result_pending フォールバック）。エラー付きは従来どおり即確定。
                if not result_text and not is_api_error and not data.get("num_turns"):
                    empty_result_pending = data
                    continue
                # thinking ブロック署名崩れ 400（resume / コンパクションで稀に発生）。
                # _subprocess_env() の CLAUDE_CODE_DISABLE_THINKING=1 で新規発生は止めているが、
                # 万一（修正前に汚染済みのセッションを resume した等）検出したら、その
                # session を継続対象から外して次回をクリーン起動させる（jobs.py で破棄）。
                _is_thinking_400 = (
                    is_api_error and "thinking" in result_text
                    and "cannot be modified" in result_text
                )
                if _is_thinking_400:
                    job.meta["_session_poisoned"] = True
                    # 同ジョブ内で 1 回だけ thinking 無し・新規会話で自動リトライ。
                    # 署名崩れは resume 履歴に残った thinking ブロックが原因なので、
                    # session を継がず（session_id=None）新規に立て直す。二重リトライは防ぐ。
                    if not _thinking_retry:
                        await proc.wait()
                        try:
                            await asyncio.wait_for(stderr_task, timeout=2.0)
                        except Exception:
                            stderr_task.cancel()
                        _cleanup_prompt()
                        job.emit({"type": "action", "text": (
                            "拡張思考の不整合を検出。思考オフで自動的にやり直します。"
                        )})
                        await run(
                            job,
                            instruction=instruction,
                            project_path=project_path,
                            session_id=None,
                            permission_mode=permission_mode,
                            model=model,
                            effort=effort,
                            thinking=False,
                            extra_args=extra_args,
                            secrets=secrets,
                            _thinking_retry=True,
                        )
                        return
                # 🩹 tool 呼び出しのテキスト化（resume 履歴破損）。本文に tool 呼び出しの
                # 生マークアップ（<invoke name="…">）が現れていたら会話履歴が壊れている。
                # ⚠️ 実 tool_use が 1 回以上動く「混在型」でも壊れは起きる（同じ応答内で
                # 一部だけテキスト化する）。real_tool_use_count==0 に限定していた旧条件では
                # この混在型を取りこぼし、毒セッションが破棄されず resume され続けて
                # 「何度指示しても途中で止まる」ループが延々再発した。実 tool_use の有無に
                # 関わらず、生マークアップを検出したら session を破棄し次回クリーン起動する。
                if _is_text_tool_call(
                    assistant_text_tail + "\n" + result_text
                ):
                    job.meta["_session_poisoned"] = True
                    job.emit({"type": "action", "text": (
                        "⚠ 会話履歴が壊れていたためこの会話を破棄しました。"
                        "次の指示は新しい会話で自動的に開始し直します。"
                    )})
                # summary は通知タイトル等に使う短い見出し。
                # 以前は本文から「つまり:」以降を機械抽出していたが、Claude が文中で
                # 「つまり」と書くたびに後ろを切り取ってしまい、文が途中で切れた断片や
                # 文脈と無関係な行が「要約」として表示され、日本語として壊れていた。
                # → 抽出はやめ、本文の意味のある最初の1行をそのまま短く使う。
                if result_text:
                    for line in result_text.split("\n"):
                        line = line.strip()
                        if line:
                            summary = line[:120]
                            break
                empty_result_pending = None  # 本物の result で確定＝控えの空 done は不要
                job.emit({
                    "type": "done",
                    "result": result_text,
                    "summary": summary,
                    "is_error": is_api_error,
                    "session_id": sid,
                    "cost_usd": data.get("total_cost_usd") or 0.0,
                    "duration_ms": data.get("duration_ms"),
                    "num_turns": data.get("num_turns"),
                    "stop_reason": data.get("stop_reason"),
                })
                # 続きの行は気にしない
                break

            elif t == "rate_limit_event":
                rli = data.get("rate_limit_info") or {}
                status = rli.get("status")
                if status not in (None, "allowed"):
                    job.emit({"type": "action", "text": f"⚠ レート制限: {status}"})

            elif t == "system" and data.get("subtype") == "status":
                # status: requesting / executing 等。詳細は出さない
                pass

        # プロセス終了を待つ
        await proc.wait()
        # 暴走を途中 kill した場合は result イベントを受けていないので、ここで
        # done を出して UI を確定させる（出さないと実行中バッジがぶら下がる）。
        if runaway_killed:
            job.emit({
                "type": "done",
                "result": "会話履歴が壊れて堂々巡りになったため中断しました。もう一度指示すると新しい会話でやり直します。",
                "summary": "会話が壊れていたためやり直しが必要です",
                "is_error": True,
                "session_id": None,
                "cost_usd": 0.0,
            })
        elif empty_result_pending is not None and not job.cancel_requested():
            # 空 result をスキップしたが本物が来ないまま CLI が終了した。
            # 従来どおり（空のまま）確定させる＝失敗は失敗として見せる。
            d = empty_result_pending
            job.emit({
                "type": "done",
                "result": "",
                "summary": "",
                "is_error": bool(d.get("is_error")),
                "session_id": d.get("session_id"),
                "cost_usd": d.get("total_cost_usd") or 0.0,
                "duration_ms": d.get("duration_ms"),
                "num_turns": d.get("num_turns"),
                "stop_reason": d.get("stop_reason"),
            })
    finally:
        # プロセスは終了済みなので stderr は EOF まで読み切れるはず。
        # cancel 前に少し待って取りこぼしを防ぐ（原因表示に使うため）。
        try:
            await asyncio.wait_for(stderr_task, timeout=2.0)
        except Exception:
            stderr_task.cancel()
        _cleanup_prompt()

    _stderr_text = bytes(stderr_chunks).decode("utf-8", errors="replace").strip()
    if not started_emitted and job.status == "queued":
        if _running_as_system():
            # 最頻の原因。cryptic な "応答しませんでした" の代わりに復旧手順を案内する。
            job.emit({"type": "error", "text": (
                "中継AIが Windows の SYSTEM 権限で起動しているため Claude Code を実行できません。"
                "claude のログイン（Max プラン枠）とコマンドはあなたのユーザープロファイルにあり、"
                "SYSTEM からは見えません。PC 上の start-all.ps1 を"
                "（管理者ではなく通常起動で）起動し直してください。"
            )})
        else:
            detail = f"（rc={proc.returncode}） {_stderr_text[-600:]}" if _stderr_text else f"（rc={proc.returncode}）"
            job.emit({"type": "error", "text": f"claude プロセスが応答しませんでした {detail}"})
    elif proc.returncode and proc.returncode != 0 and job.status == "running":
        detail = f" {_stderr_text[-600:]}" if _stderr_text else ""
        job.emit({"type": "error", "text": f"claude が異常終了しました (rc={proc.returncode}){detail}"})
