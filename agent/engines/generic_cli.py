"""設定駆動の汎用 CLI エンジン。

Claude Code 以外の任意のコーディング CLI を **コードを書かずに config.json だけ**で
追加するためのアダプタ。`engines/claude_code.py` の `run()` と同じ契約
（job.emit でイベント、job.meta["_cancel_cb"] でキャンセル）を満たす。

config.json の例:
  "engines": {
    "gemini": { "cmd": "gemini", "args": ["-p", "{prompt}"], "prompt_via": "arg",
                "strip_env": ["GEMINI_API_KEY"] },
    "codex":  { "cmd": "codex", "args": ["exec"], "prompt_via": "stdin",
                "strip_env": ["OPENAI_API_KEY"] }
  }

config フィールド:
  cmd        : 実行コマンド（PATH 解決。Windows の .cmd/.bat も which で解決）
  args       : 引数リスト。"{prompt}"/"{cwd}" を置換
  prompt_via : "stdin"(既定) = 指示文を標準入力へ / "arg" = {prompt} 引数へ
  strip_env  : サブプロセス env から除去する環境変数（API キー課金回避をエンジン別に）

リッチ表示（ツール呼び出しの構造化）はしない。出力は素のテキストとして
token イベントで流し、最後に done イベントでまとめる（＝二級だが「指示→結果」は成立）。
"""
from __future__ import annotations

import asyncio
import os
import shutil
from typing import Optional


def _resolve_cmd(cmd: str) -> Optional[str]:
    if os.path.isabs(cmd) and os.path.exists(cmd):
        return cmd
    return shutil.which(cmd)


async def run(
    job,
    *,
    instruction: str,
    project_path: Optional[str] = None,
    session_id: Optional[str] = None,          # 汎用版は resume 非対応（無視）
    permission_mode: str = "bypassPermissions",  # 同上（無視）
    model: Optional[str] = None,                # config 側で扱うなら {model} 置換も可
    extra_args: Optional[list[str]] = None,
    config: Optional[dict] = None,
) -> None:
    config = config or {}
    raw_cmd = config.get("cmd")
    if not raw_cmd:
        job.emit({"type": "error", "text": "engine config に 'cmd' がありません"})
        return
    resolved = _resolve_cmd(raw_cmd)
    if not resolved:
        job.emit({"type": "error", "text": f"コマンドが見つかりません: {raw_cmd}（インストール/PATHを確認）"})
        return

    def _sub(s: str) -> str:
        return (s.replace("{prompt}", instruction)
                 .replace("{cwd}", project_path or "")
                 .replace("{model}", model or ""))

    argv = [resolved] + [_sub(a) for a in (config.get("args") or [])]
    if extra_args:
        argv += extra_args

    prompt_via = config.get("prompt_via", "stdin")
    use_stdin = prompt_via == "stdin"

    # env コピーして strip_env を除去（エンジン別の「APIキー課金回避」柵）
    env = dict(os.environ)
    for k in (config.get("strip_env") or []):
        env.pop(k, None)

    cwd = project_path or None
    job.emit({
        "type": "started",
        "session_id": None,
        "model": config.get("name") or raw_cmd,
        "cwd": cwd,
        "tools": [],
    })

    try:
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdin=asyncio.subprocess.PIPE if use_stdin else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd,
            env=env,
            limit=16 * 1024 * 1024,  # claude_code と同じ理由で大きめ
        )
    except (FileNotFoundError, NotImplementedError) as e:
        job.emit({"type": "error", "text": f"起動に失敗: {e}"})
        return

    def _kill():
        try:
            if proc.returncode is None:
                proc.kill()
        except Exception:
            pass

    job.meta["_cancel_cb"] = _kill

    if use_stdin and proc.stdin is not None:
        try:
            proc.stdin.write(instruction.encode("utf-8"))
            await proc.stdin.drain()
            proc.stdin.close()
        except Exception:
            pass

    stderr_chunks = bytearray()

    async def _read_stderr():
        assert proc.stderr is not None
        while True:
            chunk = await proc.stderr.read(4096)
            if not chunk:
                break
            stderr_chunks.extend(chunk)
            if len(stderr_chunks) > 8000:
                del stderr_chunks[:-8000]

    stderr_task = asyncio.create_task(_read_stderr())

    out_parts: list[str] = []
    try:
        assert proc.stdout is not None
        async for raw in proc.stdout:
            if job.cancel_requested():
                _kill()
                break
            text = raw.decode("utf-8", errors="replace")
            if text:
                out_parts.append(text)
                job.emit({"type": "token", "text": text})
        await proc.wait()
    finally:
        try:
            await asyncio.wait_for(stderr_task, timeout=2.0)
        except Exception:
            stderr_task.cancel()

    full = "".join(out_parts).strip()
    err = bytes(stderr_chunks).decode("utf-8", errors="replace").strip()

    if (proc.returncode or 0) != 0 and not full:
        job.emit({"type": "error", "text": err or f"終了コード {proc.returncode}"})
        return
    if not full and err:
        full = err

    summary = ""
    for line in full.split("\n"):
        line = line.strip()
        if line:
            summary = line[:120]
            break

    job.emit({
        "type": "done",
        "result": full or "(出力なし)",
        "summary": summary,
        "is_error": (proc.returncode or 0) != 0,
        "session_id": None,
    })
