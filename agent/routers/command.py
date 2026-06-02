"""指示実行ルータ。

`/command/`        同期（古いUI互換用、80秒上限）
`/command/stream`  SSE（UI のメイン経路）

内部で Claude Code ヘッドレス（`engines/claude_code.py`）をジョブ化して起動する。
Max プラン枠で動くため `ANTHROPIC_API_KEY` を環境変数に**入れてはいけない**。

`is_dangerous` は `routers/processes_api.py` から参照されるためここに残す。
"""
from __future__ import annotations

import asyncio
import json
import time
from typing import Optional

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from jobs import manager
from engines import claude_code as engine_cc
from routers.projects import ensure_allowed_path


router = APIRouter()


# ===== 危険コマンドブラックリスト（processes_api 用） =====
BLOCKED = [
    # ファイル削除・破壊
    "rm -rf", "rm -r /", "rmdir /s", "rd /s",
    "del /f /s", "del /f /q", "del /s", "mkfs",
    "dd if=/dev/zero",
    # フォーマット・パーティション
    "format c:", "format d:", "format e:", "fdisk", "diskpart",
    # システム停止
    "shutdown /r", "shutdown /s", "shutdown -r", "shutdown -h",
    # 権限・アカウント操作
    "net user", "net localgroup", "reg delete", "reg add",
    "bcdedit", "icacls", "takeown", "cacls",
    # プロセス・サービス強制停止
    "taskkill /f", "sc delete", "sc stop",
    # フォーク爆弾
    ":(){:|:&};:",
    # PowerShell 経由の破壊
    "remove-item -recurse", "remove-item -r",
]


def is_dangerous(cmd: str) -> bool:
    lower = cmd.lower().strip()
    normalized = " ".join(lower.split())
    return any(b in normalized for b in BLOCKED)


# ===== リクエスト/レスポンス =====

class CommandRequest(BaseModel):
    instruction: str
    project_path: Optional[str] = None
    extra_context: Optional[str] = None
    # Claude Code のモデルエイリアス (haiku / sonnet / opus)。省略時は Claude Code のデフォルト。
    model_override: Optional[str] = None


class CommandResponse(BaseModel):
    result: str
    summary: str
    actions_taken: list[str]
    model_used: str


# ===== 内部ヘルパ =====

def _build_instruction(req: CommandRequest) -> str:
    inst = req.instruction
    if req.extra_context:
        inst = f"<context>\n{req.extra_context}\n</context>\n\n{inst}"
    return inst


def _spawn_job(req: CommandRequest):
    ensure_allowed_path(req.project_path)
    instruction = _build_instruction(req)

    async def runner(job):
        await engine_cc.run(
            job,
            instruction=instruction,
            project_path=req.project_path,
            permission_mode="bypassPermissions",
            model=req.model_override,
        )

    return manager.create(
        engine="claude_code",
        instruction=instruction,
        runner=runner,
        project_path=req.project_path,
        model=req.model_override,
    )


# ===== 同期エンドポイント（互換UI） =====

@router.post("/", response_model=CommandResponse)
async def execute_command(req: CommandRequest):
    job = _spawn_job(req)
    start = time.time()

    # Cloudflare の 100 秒制限を超える前に切る
    while job.status in ("queued", "running"):
        if time.time() - start > 80:
            await job.cancel()
            return CommandResponse(
                result="処理に時間がかかりすぎました。重い指示はスマホUIの「ジョブ」経由で実行してください。",
                summary="タイムアウト",
                actions_taken=job.actions[:10],
                model_used=job.model or "claude_code",
            )
        await asyncio.sleep(0.3)

    # done / error / canceled
    result_text = ""
    for ev in reversed(job.events):
        t = ev.get("type")
        if t == "done":
            result_text = ev.get("result") or ""
            break
        if t == "error":
            result_text = f"エラー: {ev.get('text') or ''}"
            break

    if not result_text:
        # 念のため token 連結
        result_text = "".join(
            ev.get("text", "") for ev in job.events if ev.get("type") == "token"
        ) or "(出力なし)"

    return CommandResponse(
        result=result_text,
        summary=job.summary or "",
        actions_taken=job.actions[:20],
        model_used=job.model or "claude_code",
    )


# ===== SSE ストリーミング（UI メイン経路） =====

@router.post("/stream")
async def execute_stream(req: CommandRequest):
    job = _spawn_job(req)

    async def generate():
        try:
            async for ev in job.stream(from_seq=0):
                t = ev.get("type")
                if t == "token":
                    yield f"data: {json.dumps({'type': 'token', 'text': ev.get('text')}, ensure_ascii=False)}\n\n"
                elif t == "action":
                    yield f"data: {json.dumps({'type': 'action', 'text': ev.get('text')}, ensure_ascii=False)}\n\n"
                elif t == "tool_use":
                    yield f"data: {json.dumps({'type': 'action', 'text': ev.get('summary') or ev.get('name')}, ensure_ascii=False)}\n\n"
                elif t == "done":
                    yield (
                        "data: "
                        + json.dumps(
                            {
                                "type": "done",
                                "summary": ev.get("summary") or "",
                                "actions": job.actions,
                                "model": job.model or "claude_code",
                            },
                            ensure_ascii=False,
                        )
                        + "\n\n"
                    )
                    return
                elif t == "error":
                    yield f"data: {json.dumps({'type': 'error', 'text': ev.get('text')}, ensure_ascii=False)}\n\n"
                    return
        except asyncio.CancelledError:
            return

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
