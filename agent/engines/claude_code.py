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


async def run(
    job: Job,
    *,
    instruction: str,
    project_path: Optional[str] = None,
    session_id: Optional[str] = None,
    permission_mode: str = "bypassPermissions",
    model: Optional[str] = None,
    extra_args: Optional[list[str]] = None,
) -> None:
    """Claude Code をヘッドレスで起動し、ジョブにイベントを emit する。"""

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
    if extra_args:
        args += extra_args

    # Windows 用に list2cmdline で文字列化（quote 適切に処理される）
    cmd_str = _sp.list2cmdline(args)
    cwd = project_path or None

    # 指示文はシェル引数に載せず、一時ファイル → stdin リダイレクトで渡す。
    # create_subprocess_shell は cmd.exe を経由するため、instruction を `-p "..."`
    # で渡すと cmd.exe のメタ文字（% 展開・" の扱い）と list2cmdline のクオートが
    # ズレて壊れる/誤展開する。run_oneshot と同じく stdin 経由にして遮断する。
    import tempfile
    import os as _os
    fd, prompt_path = tempfile.mkstemp(prefix="claude_job_", suffix=".txt")
    with _os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(instruction)
    cmd_str = f'{cmd_str} < "{prompt_path}"'

    def _cleanup_prompt():
        try:
            _os.unlink(prompt_path)
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
