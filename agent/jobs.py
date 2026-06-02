"""バックグラウンドジョブ管理。

UI からの長時間タスクを Cloudflare の 100 秒制限から切り離す。
ジョブは asyncio.Task として走り、イベントは asyncio.Queue 経由で
SSE エンドポイントが配信する。再接続にも耐える（リプレイ可能）。
"""
from __future__ import annotations

import asyncio
import json
import time
import uuid
from pathlib import Path
from typing import Any, AsyncIterator, Awaitable, Callable, Optional


LOG_DIR = Path(__file__).parent.parent / "logs" / "jobs"
LOG_DIR.mkdir(parents=True, exist_ok=True)

MAX_JOBS_IN_MEMORY = 200
MAX_EVENTS_PER_JOB = 5000  # SSE 再接続用に保持する最大イベント数


class Job:
    """1 つのバックグラウンドジョブ。"""

    def __init__(
        self,
        engine: str,
        instruction: str,
        project_path: Optional[str] = None,
        session_id: Optional[str] = None,
        model: Optional[str] = None,
        meta: Optional[dict] = None,
    ):
        self.id: str = uuid.uuid4().hex[:12]
        self.engine = engine
        self.instruction = instruction
        self.project_path = project_path
        self.session_id = session_id  # 開始時の resume 元
        self.new_session_id: Optional[str] = None  # 実行後に判明する継続用 ID
        self.model = model
        self.meta = meta or {}
        self.status = "queued"  # queued | running | done | error | canceled
        self.created_at = time.time()
        self.started_at: Optional[float] = None
        self.finished_at: Optional[float] = None
        self.summary: str = ""
        self.cost_usd: float = 0.0
        self.error: Optional[str] = None
        self.actions: list[str] = []
        self.events: list[dict] = []  # 全イベント（リプレイ用）
        self._queue: asyncio.Queue = asyncio.Queue(maxsize=MAX_EVENTS_PER_JOB)
        self._task: Optional[asyncio.Task] = None
        self._cancel_event = asyncio.Event()
        self._log_path = LOG_DIR / f"{self.id}.jsonl"

    def to_dict(self, *, include_events: bool = False) -> dict:
        d = {
            "id": self.id,
            "engine": self.engine,
            "instruction": (self.instruction[:200] + "…") if len(self.instruction) > 200 else self.instruction,
            "project_path": self.project_path,
            "session_id": self.new_session_id or self.session_id,
            "model": self.model,
            "status": self.status,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "summary": self.summary,
            "cost_usd": self.cost_usd,
            "error": self.error,
            "actions_count": len(self.actions),
            "actions_tail": self.actions[-5:],
            "meta": self.meta,
        }
        if include_events:
            d["events"] = self.events
        return d

    def emit(self, event: dict):
        """イベントを 1 件配信。SSE 購読者と履歴の両方に流す。"""
        event = {**event, "_seq": len(self.events), "_t": time.time()}
        # session_id / cost を Job 状態に反映
        et = event.get("type")
        if et == "started":
            self.new_session_id = event.get("session_id") or self.new_session_id
            self.model = event.get("model") or self.model
            self.status = "running"
            self.started_at = time.time()
        elif et == "action":
            txt = str(event.get("text") or "")
            if txt:
                self.actions.append(txt)
        elif et == "done":
            self.summary = event.get("summary") or ""
            self.cost_usd = float(event.get("cost_usd") or 0.0)
            self.new_session_id = event.get("session_id") or self.new_session_id
            self.status = "done"
            self.finished_at = time.time()
        elif et == "error":
            self.error = str(event.get("text") or "")
            self.status = "error"
            self.finished_at = time.time()
        elif et == "canceled":
            self.status = "canceled"
            self.finished_at = time.time()

        self.events.append(event)
        if len(self.events) > MAX_EVENTS_PER_JOB:
            self.events = self.events[-MAX_EVENTS_PER_JOB:]
        # ログファイルへ追記（ベストエフォート）
        try:
            with self._log_path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(event, ensure_ascii=False) + "\n")
        except Exception:
            pass
        # SSE 購読者へ
        try:
            self._queue.put_nowait(event)
        except asyncio.QueueFull:
            # 購読者が居ない/遅い間にイベントが無制限に溜まるのを防ぐ。
            # 古い 1 件を捨てて最新を入れる。取りこぼしは events[] からの
            # from_seq リプレイ（stream）で吸収できるので致命的ではない。
            try:
                self._queue.get_nowait()
            except Exception:
                pass
            try:
                self._queue.put_nowait(event)
            except Exception:
                pass

    async def cancel(self):
        """ジョブをキャンセル。実行中のサブプロセスがあれば停止。"""
        self._cancel_event.set()
        if self._task and not self._task.done():
            self._task.cancel()
        cancel_cb = self.meta.get("_cancel_cb")
        if callable(cancel_cb):
            try:
                cancel_cb()
            except Exception:
                pass

    def cancel_requested(self) -> bool:
        return self._cancel_event.is_set()

    async def stream(self, from_seq: int = 0) -> AsyncIterator[dict]:
        """イベントを SSE 形式で配信。途中再接続は from_seq=N で先頭から N 件をリプレイ。"""
        # まずバッファ済みイベントをリプレイ
        for ev in self.events:
            if ev.get("_seq", 0) >= from_seq:
                yield ev
        # 終わってたらそこで終了
        if self.status in ("done", "error", "canceled"):
            return
        # ライブ追加分を流す
        seen = len(self.events)
        while True:
            try:
                ev = await asyncio.wait_for(self._queue.get(), timeout=30.0)
            except asyncio.TimeoutError:
                # keep-alive ping
                yield {"type": "ping", "_seq": -1, "_t": time.time()}
                if self.status in ("done", "error", "canceled"):
                    return
                continue
            # 古いイベントが Queue に残っていた場合はスキップ
            if ev.get("_seq", 0) < seen:
                continue
            seen = ev.get("_seq", 0) + 1
            yield ev
            if ev.get("type") in ("done", "error", "canceled"):
                return


class JobManager:
    def __init__(self):
        self._jobs: dict[str, Job] = {}
        # プロジェクトパスごとの最終 session_id（resume 用）
        self._last_session: dict[str, str] = {}

    def create(
        self,
        engine: str,
        instruction: str,
        runner: Callable[[Job], Awaitable[None]],
        project_path: Optional[str] = None,
        session_id: Optional[str] = None,
        model: Optional[str] = None,
        meta: Optional[dict] = None,
    ) -> Job:
        job = Job(
            engine=engine,
            instruction=instruction,
            project_path=project_path,
            session_id=session_id,
            model=model,
            meta=meta,
        )
        self._jobs[job.id] = job
        # 古いジョブを掃除
        if len(self._jobs) > MAX_JOBS_IN_MEMORY:
            # 終わっているものから古い順に消す
            done = sorted(
                [j for j in self._jobs.values() if j.status in ("done", "error", "canceled")],
                key=lambda j: j.finished_at or 0,
            )
            for j in done[: len(self._jobs) - MAX_JOBS_IN_MEMORY]:
                self._jobs.pop(j.id, None)

        async def wrapper():
            try:
                await runner(job)
            except asyncio.CancelledError:
                if job.status not in ("done", "error", "canceled"):
                    job.emit({"type": "canceled", "text": "ジョブを中断しました"})
                raise
            except Exception as e:
                if job.status not in ("done", "error", "canceled"):
                    job.emit({"type": "error", "text": f"{type(e).__name__}: {e}"})
            finally:
                # 継続用 session_id を保存。
                # ただし thinking ブロック 400 で汚染されたセッションは継続対象から外す
                # （engine が _session_poisoned を立てる）。次回コマンドはクリーン起動になり自己修復する。
                sid = job.new_session_id or job.session_id
                if job.meta.get("_session_poisoned") and job.project_path:
                    self._last_session.pop(job.project_path, None)
                elif sid and job.project_path:
                    self._last_session[job.project_path] = sid

        job._task = asyncio.create_task(wrapper())
        return job

    def get(self, job_id: str) -> Optional[Job]:
        return self._jobs.get(job_id)

    def list(self, project_path: Optional[str] = None, limit: int = 50) -> list[dict]:
        items = list(self._jobs.values())
        if project_path:
            items = [j for j in items if j.project_path == project_path]
        items.sort(key=lambda j: j.created_at, reverse=True)
        return [j.to_dict() for j in items[:limit]]

    def last_session(self, project_path: str) -> Optional[str]:
        return self._last_session.get(project_path)

    def set_last_session(self, project_path: str, session_id: str):
        self._last_session[project_path] = session_id

    def clear_session(self, project_path: str):
        self._last_session.pop(project_path, None)


# シングルトン
manager = JobManager()
