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


# 中継AI（作業を実行する Claude Code 本体）へ常駐で渡すシステム説明。
# --append-system-prompt で毎回付与する＝指示文・events・logs には載らないので
# 機密も履歴も汚さない。--resume でセッションを継いでも毎回付与される。
# 別プロジェクト配下で動くと、この hub 独自の作法（特に🔒金庫）が未知語のまま届き
# 「金庫でトークンを教えろ」が無視される／「暗証番号を金庫で渡す」が伝わらない
# 事故が起きるため、AI 側に hub の前提を最初から分からせておく。
# 金庫の書式は engines/vault.py の正規表現と一致させること。
AIHUB_SYSTEM_BRIEFING = """\
あなたはスマホアプリ「PC作業のAI」(AI hub)から呼ばれている作業AIです。次の前提を常に守ってください。

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


def _subprocess_env() -> dict:
    """claude サブプロセスに渡す環境変数。

    ⚠️ 重要: `CLAUDE_CODE_DISABLE_THINKING=1` を必ず立てる。
    拡張思考（extended thinking）を有効にしたまま `--resume` で履歴を再生したり、
    長セッションで自動コンパクションが走ると、thinking ブロックの署名が
    再生時に食い違い、Anthropic API が
      400 messages.N.content.M: `thinking` or `redacted_thinking` blocks in the
      latest assistant message cannot be modified.
    を返してジョブごと落ちる（実測: resume 直後 1 turn 即死／35-42 turn の長尺中の両方で再現）。
    thinking ブロックを一切生成しなければ「改変できないブロック」自体が存在せず、
    resume・コンパクションのどちらでも 400 が起きない（CLI 2.1.141 / Opus 4.8 で実測検証済み）。
    Opus 4.8 の内部推論自体は無効化されず、応答品質は落ちない（出力に思考が混じらないだけ）。
    なお `ANTHROPIC_API_KEY` は絶対に追加しないこと（Max プラン枠を外れて課金される）。
    """
    env = dict(os.environ)
    env["CLAUDE_CODE_DISABLE_THINKING"] = "1"
    env.pop("ANTHROPIC_API_KEY", None)  # 念のため。Max プラン枠を死守
    return env


async def run_oneshot(
    prompt: str,
    *,
    cwd: Optional[str] = None,
    model: Optional[str] = None,
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
    if model:
        args += ["--model", model]
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


def _wrap_emit_with_vault(job: Job, secrets: Optional[dict]):
    """🔒金庫: job.emit を逆マスク付きに差し替える（不変条件2の本丸）。

    emit を通る全イベントの文字列フィールド（token/result/summary/tool input/
    tool_result/action/error）を配信前にサニタイズする:
      - A方向: 既知の実値 → {{名前}}（mask_known_secrets）
      - 自動: トークンらしき未知文字列 → ***MASKED***（mask_patterns）
      - B方向: [[secret:名前]]値[[/secret]] → 値を分離、本文は [[secret:名前]] だけ
    これで token 復唱・done サマリ・tool コマンド文字列・ログ追記の全経路で
    実値が残らない。B方向で分離した値は job.meta["_vault_b_secrets"] に溜める
    （後で SSE 配信時に別チャネルとして UI へ渡せるが、ログ/events には乗らない）。
    """
    orig_emit = job.emit
    b_bucket: dict = job.meta.setdefault("_vault_b_secrets", {})

    def _san(text):
        if not isinstance(text, str) or not text:
            return text
        # B方向: 囲み規約の実値を分離（本文はプレースホルダだけ残る）
        masked, found = vault.extract_b_secrets(text)
        if found:
            b_bucket.update(found)
        # A方向 + 自動: 既知値を名前へ、未知トークンを ***MASKED*** へ
        return vault.sanitize_outbound(masked, secrets)

    def _sanitize_event(event: dict) -> Optional[dict]:
        # 値が乗りうるフィールドだけ選んでサニタイズ（イベント型ごと）。
        ev = dict(event)
        # ⚠️ ストリーミング分割対策（取りこぼしの本丸）:
        # token は1イベント＝数文字のことがあり、機密値が複数 token に割れると
        # 各断片が逆マスクをすり抜け、繋げば復元できる（実質漏洩）。
        # secrets/B方向を使うジョブでは token（部分表示）を**丸ごと捨てる**。
        # done の result（全文確定後）でまとめて逆マスクするので表示は失われない。
        if ev.get("type") == "token":
            return None
        for k in ("text", "result", "summary", "content", "name"):
            if k in ev:
                ev[k] = _san(ev[k])
        # tool_use の input は辞書。中身の文字列値を再帰的にサニタイズ。
        if isinstance(ev.get("input"), dict):
            ev["input"] = {k: _san_deep(v) for k, v in ev["input"].items()}
        # B方向: done 時点で分離済みの機密件数を UI に知らせる（実値は乗せない）。
        # UI は件数だけ見て「金庫が受け取った」通知を出す。値は別配信しない（漏洩面を作らない）。
        if ev.get("type") == "done":
            ev["vault_received"] = len(b_bucket)
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
        if sanitized is not None:  # token は捨てる（分割漏洩防止）
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
    extra_args: Optional[list[str]] = None,
    secrets: Optional[dict] = None,
) -> None:
    """Claude Code をヘッドレスで起動し、ジョブにイベントを emit する。

    🔒金庫: `secrets`（{名前: 実値}）が渡されたら:
      - A方向: stdin に流すプロンプトの {{名前}} を実値に置換（一時ファイルのみ）。
        job.instruction には {{名前}} のまま残る（不変条件1）。
      - 逆マスク: emit を _wrap_emit_with_vault でラップ（不変条件2）。
    secrets は引数（runner クロージャ）でのみ受け取り、job オブジェクトには保存しない。
    """
    # 🔒 逆マスクを最優先で仕掛ける（以降の emit は全てサニタイズ経由）。
    if secrets:
        _wrap_emit_with_vault(job, secrets)

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
    # 実際の作業（コーディング）は既定で Opus 4.8。
    # UI で haiku/sonnet を明示選択した場合のみそれを使う。
    # 要約・翻訳系は run_oneshot 側で Sonnet を明示指定しているのでここは通らない。
    #
    # 注意: CLI のエイリアス "opus" は現行 CLI では旧 claude-opus-4-7 に解決される
    # （実測 2026-05）。作業既定の 4.8 を確実に使うため明示 ID に正規化する。
    _model = model or "opus"
    if _model in ("opus", "opus-4.8", "claude-opus-4.8"):
        _model = "claude-opus-4-8"
    args += ["--model", _model]

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
    # 🔒金庫A方向: 一時ファイルに書く瞬間だけ {{名前}} を実値に置換する。
    # この置換後の文字列は job にも events にも戻さない（不変条件1）。
    # secrets が無ければ instruction はそのまま（通常動作）。
    prompt_to_write = vault.inject_secrets(instruction, secrets) if secrets else instruction
    with _os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(prompt_to_write)
    del prompt_to_write  # 実値入り文字列を早めに手放す
    cmd_str = f'{cmd_str} < "{prompt_path}"'

    def _cleanup_prompt():
        for p in (prompt_path, sysprompt_path):
            try:
                _os.unlink(p)
            except Exception:
                pass

    try:
        proc = await asyncio.create_subprocess_shell(
            cmd_str,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd,
            env=_subprocess_env(),
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
                for content in msg.get("content") or []:
                    if content.get("type") == "tool_use":
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
                # thinking ブロック署名崩れ 400（resume / コンパクションで稀に発生）。
                # _subprocess_env() の CLAUDE_CODE_DISABLE_THINKING=1 で新規発生は止めているが、
                # 万一（修正前に汚染済みのセッションを resume した等）検出したら、その
                # session を継続対象から外して次回をクリーン起動させる（jobs.py で破棄）。
                if (is_api_error and "thinking" in result_text
                        and "cannot be modified" in result_text):
                    job.meta["_session_poisoned"] = True
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
                "SYSTEM からは見えません。PC のデスクトップの『PC作業のAI』アイコンから"
                "（管理者ではなく通常起動で）起動し直してください。"
            )})
        else:
            detail = f"（rc={proc.returncode}） {_stderr_text[-600:]}" if _stderr_text else f"（rc={proc.returncode}）"
            job.emit({"type": "error", "text": f"claude プロセスが応答しませんでした {detail}"})
    elif proc.returncode and proc.returncode != 0 and job.status == "running":
        detail = f" {_stderr_text[-600:]}" if _stderr_text else ""
        job.emit({"type": "error", "text": f"claude が異常終了しました (rc={proc.returncode}){detail}"})
