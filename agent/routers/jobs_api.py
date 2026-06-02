"""ジョブ API: バックグラウンドで Claude Code を実行。

POST /jobs/                  ジョブ作成 → job_id 即返却
GET  /jobs/{id}/stream       SSE で進捗配信（再接続可能）
GET  /jobs/{id}              ジョブ状態取得
POST /jobs/{id}/cancel       キャンセル
GET  /jobs/                  ジョブ一覧（project_path で絞り込み可）
GET  /jobs/sessions/last     プロジェクトの最終 session_id を取得
POST /jobs/sessions/clear    プロジェクトの session_id をクリア
"""
from __future__ import annotations

import asyncio
import json
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from jobs import manager
from engines import claude_code as engine_cc
from routers.projects import ensure_allowed_path


router = APIRouter()


class CreateJobRequest(BaseModel):
    # 互換のため engine フィールドは残すが、Claude Code 一本化済み。
    engine: str = "claude_code"
    instruction: str
    project_path: Optional[str] = None
    session_id: Optional[str] = None  # 明示指定（None ならプロジェクトの last を使用）
    new_session: bool = False         # True なら session_id を無視して新規開始
    model: Optional[str] = None       # Claude Code モデルエイリアス (haiku/sonnet/opus)
    permission_mode: str = "bypassPermissions"
    meta: Optional[dict] = None


@router.post("/")
async def create_job(req: CreateJobRequest):
    inst = (req.instruction or "").strip()
    if not inst:
        raise HTTPException(400, "instruction is required")
    ensure_allowed_path(req.project_path)

    # セッション継続: 明示 > プロジェクトの last。new_session 時は無視
    sid = req.session_id
    if req.new_session:
        sid = None
        if req.project_path:
            manager.clear_session(req.project_path)
    elif sid is None and req.project_path:
        sid = manager.last_session(req.project_path)

    async def runner(job):
        await engine_cc.run(
            job,
            instruction=inst,
            project_path=req.project_path,
            session_id=sid,
            permission_mode=req.permission_mode,
            model=req.model,
        )

    job = manager.create(
        engine="claude_code",
        instruction=inst,
        runner=runner,
        project_path=req.project_path,
        session_id=sid,
        model=req.model,
        meta=req.meta,
    )
    return job.to_dict()


@router.get("/{job_id}")
async def get_job(job_id: str, include_events: bool = False):
    j = manager.get(job_id)
    if not j:
        raise HTTPException(404, "job not found")
    return j.to_dict(include_events=include_events)


@router.post("/{job_id}/cancel")
async def cancel_job(job_id: str):
    j = manager.get(job_id)
    if not j:
        raise HTTPException(404, "job not found")
    await j.cancel()
    return {"status": j.status}


@router.get("/")
async def list_jobs(project_path: Optional[str] = None, limit: int = 30):
    ensure_allowed_path(project_path)
    return manager.list(project_path=project_path, limit=limit)


@router.get("/sessions/last")
async def get_last_session(project_path: str = Query(...)):
    ensure_allowed_path(project_path)
    return {"project_path": project_path, "session_id": manager.last_session(project_path)}


class ClearSessionRequest(BaseModel):
    project_path: str


@router.post("/sessions/clear")
async def clear_session(req: ClearSessionRequest):
    ensure_allowed_path(req.project_path)
    manager.clear_session(req.project_path)
    return {"project_path": req.project_path, "session_id": None}


# ===== SSE ストリーム =====


@router.get("/{job_id}/stream")
async def stream_job(job_id: str, request: Request, from_seq: int = 0):
    j = manager.get(job_id)
    if not j:
        raise HTTPException(404, "job not found")

    async def gen():
        try:
            async for ev in j.stream(from_seq=from_seq):
                if await request.is_disconnected():
                    return
                # 重い payload (input 全体や tool_result の長文) はそのまま流す
                yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
        except asyncio.CancelledError:
            return

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
