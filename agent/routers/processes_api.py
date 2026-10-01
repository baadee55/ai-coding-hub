"""長時間プロセス API。

POST /processes/run         { name, command, cwd } → pid
GET  /processes/            一覧
GET  /processes/{id}        詳細
GET  /processes/{id}/stream SSE で stdout/stderr を tail
POST /processes/{id}/stop   停止
"""
from __future__ import annotations

import asyncio
import json
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from processes import manager
from routers.projects import ensure_allowed_path


router = APIRouter()


class RunRequest(BaseModel):
    name: str
    command: str
    cwd: Optional[str] = None


@router.post("/run")
async def run_proc(req: RunRequest):
    cmd = (req.command or "").strip()
    if not cmd:
        raise HTTPException(400, "command is required")
    # cwd は登録済みプロジェクト配下のみ。
    # 任意 cwd を許すと、認証突破後に任意ディレクトリで `tar -czf x` のような
    # 情報窃取コマンドが回せてしまうので必須。cwd 未指定もエラーにする
    # (ユーザの意図しない agent ディレクトリで動かないように)。
    if not req.cwd:
        raise HTTPException(400, "cwd is required (登録済みプロジェクトのパス)")
    ensure_allowed_path(req.cwd)
    # 危険コマンドは引き継いでブロック (※ ブラックリストは保険。真の防御は認証 + cwd 制限)
    from routers.command import is_dangerous
    if is_dangerous(cmd):
        raise HTTPException(400, f"危険なコマンド: {cmd}")
    p = await manager.run(name=req.name or cmd[:40], command=cmd, cwd=req.cwd)
    return p.to_dict()


@router.get("/")
async def list_procs():
    return manager.list()


@router.get("/{pid}")
async def get_proc(pid: str):
    p = manager.get(pid)
    if not p:
        raise HTTPException(404, "process not found")
    return p.to_dict()


@router.post("/{pid}/stop")
async def stop_proc(pid: str):
    ok = await manager.stop(pid)
    if not ok:
        raise HTTPException(404, "process not found")
    return {"status": "stopped"}


@router.get("/{pid}/stream")
async def stream_proc(pid: str, request: Request, from_line: int = 0):
    p = manager.get(pid)
    if not p:
        raise HTTPException(404, "process not found")

    async def gen():
        try:
            async for line in p.tail(from_line=from_line):
                if await request.is_disconnected():
                    return
                if line == "__PING__":
                    yield f"data: {json.dumps({'type': 'ping'})}\n\n"
                else:
                    yield f"data: {json.dumps({'type': 'line', 'text': line}, ensure_ascii=False)}\n\n"
        except asyncio.CancelledError:
            return

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
