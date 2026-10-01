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
    effort: Optional[str] = None      # がんばり度 (low/medium/high/xhigh/max)。CLI の --effort
    thinking: bool = True             # 拡張思考 on/off（UI設定）。既定オン。off で thinking-400 回避
    permission_mode: str = "bypassPermissions"
    meta: Optional[dict] = None
    # 🔒金庫A方向: {名前: 実値}。本文の {{名前}} を engine が一時ファイル書き込み直前に
    # 注入する。⚠️ これは job にも events にもログにも保存しない（runner クロージャのみ）。
    secrets: Optional[dict] = None


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

    # 🔒金庫: secrets は runner クロージャ変数としてのみ保持。
    # job/meta/instruction には絶対に入れない（不変条件1）。req.secrets はこの関数
    # スコープを抜けたら GC される。manager.create には渡さない。
    _secrets = req.secrets

    async def runner(job):
        await engine_cc.run(
            job,
            instruction=inst,
            project_path=req.project_path,
            session_id=sid,
            permission_mode=req.permission_mode,
            model=req.model,
            effort=req.effort,
            thinking=req.thinking,
            secrets=_secrets,
        )

    job = manager.create(
        engine="claude_code",
        instruction=inst,
        runner=runner,
        project_path=req.project_path,
        session_id=sid,
        model=req.model,
        effort=req.effort,
        meta=req.meta,
    )
    return job.to_dict()


@router.get("/capabilities")
async def capabilities():
    """CLI が今受け付ける選択肢を返す（UI が動的に描画）。

    effort の段階はクラウド側の CLI 更新で増減しうるので、ハードコードせず
    `claude --help` から拾って返す。UI はこれを見て設定のセレクトを組む。
    ⚠️ ルート順: /{job_id} より前に置く（後ろだと job_id 扱いされる）。
    """
    return {"effortLevels": engine_cc.get_effort_levels()}


@router.get("/vault/pending")
async def vault_pending():
    """🔒金庫B方向: 分離済み機密の受け渡し口（JWT 必須・一回きり）。

    Claude が [[secret:名前]] で返した実値は engine が本文から分離して
    メモリ上の受け渡し置き場に溜めてある。スマホ UI は金庫を**開錠した
    タイミングだけ**ここを呼び、受け取った値を端末内の暗号化金庫へ保存する。
    返した瞬間に PC 側から消える（メモリのみ・ログ/events に実値は乗らない）。
    2セグメントパスなので /{job_id} とは衝突しない。
    """
    from engines import vault
    return {"secrets": vault.take_pending()}


@router.get("/unfinished")
async def list_unfinished(project_path: Optional[str] = None, limit: int = 20):
    """終わっていない / 中断されたタスクを返す（再起動を跨いでも拾える）。

    中継 AI として「スマホが離れている間に止まった仕事」をスマホに見せる入口。
    メモリ上のジョブ（running/queued）＋ディスクのログから復元した中断ジョブを
    マージして、新しい順で返す。
    ⚠️ ルート順: /{job_id} より前に置く。後ろだと "unfinished" が job_id 扱いされ 404。
    """
    ensure_allowed_path(project_path)
    return manager.list_unfinished(project_path=project_path, limit=limit)


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


@router.get("/{job_id}/task")
async def get_task(job_id: str):
    """未完了タスクの控え（再実行に必要な instruction 全文等）を返す。
    スマホはこれを入力欄に戻して普通に送信すれば再開できる（金庫の {{名前}} 再注入もそのまま効く）。"""
    if not job_id.isalnum():
        raise HTTPException(404, "not found")
    task = manager.get_task(job_id)
    if task is None:
        raise HTTPException(404, "task not found")
    return task


@router.post("/{job_id}/dismiss")
async def dismiss_task(job_id: str):
    """未完了タスクの控えを破棄する（再開しないと決めた時の消し忘れ防止）。"""
    if not job_id.isalnum():
        raise HTTPException(404, "not found")
    manager.dismiss_task(job_id)
    return {"status": "dismissed", "id": job_id}


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
