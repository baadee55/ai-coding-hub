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
        # 「受けたが終わっていない指示」の控え。終端で消す。落ちても起動時に拾える。
        self._task_path = LOG_DIR / f"{self.id}.task.json"

    def save_task(self, *, effort: Optional[str] = None):
        """受けた指示をディスクへ控える。⚠️ 金庫 secrets は絶対に含めない。"""
        rec = {
            "id": self.id,
            "instruction": self.instruction,
            "project_path": self.project_path,
            "session_id": self.new_session_id or self.session_id,
            "model": self.model,
            "effort": effort,
            "created_at": self.created_at,
            # 金庫A方向（{{名前}}）が本文に残っていれば、再実行には機密の再投入が要る印。
            "needs_secret": "{{" in (self.instruction or ""),
        }
        try:
            tmp = self._task_path.with_suffix(".task.tmp")
            tmp.write_text(json.dumps(rec, ensure_ascii=False), encoding="utf-8")
            tmp.replace(self._task_path)
        except Exception:
            pass

    def clear_task(self):
        """終端したので控えを消す（これが残っている＝未完了の指示）。"""
        try:
            self._task_path.unlink(missing_ok=True)
        except Exception:
            pass

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
            # `_` 始まりは内部専用（_cancel_cb=コールバック, _vault_b_secrets=実機密 等）。
            # シリアライズに混ぜると機密が API レスポンス/ログに漏れる＆callable で壊れるため除外。
            "meta": {k: v for k, v in self.meta.items() if not k.startswith("_")},
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
        elif et == "model":
            # 実モデル同期（engine が assistant メッセージから検出した実際のモデル）
            self.model = event.get("model") or self.model
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
            self._notify_push()
        elif et == "error":
            self.error = str(event.get("text") or "")
            self.status = "error"
            self.finished_at = time.time()
            self._notify_push()
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

    def _notify_push(self):
        """完了/エラーを Web Push で通知（購読者がいなければ何もしない・失敗しても無害）。
        キャンセルはユーザー自身の操作なので通知しない。"""
        try:
            import push as _push
            _push.notify_job_finished(self)
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
        effort: Optional[str] = None,
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
        # 受けた指示をディスクへ控える（終端で消す）。落ちても起動時に拾える。
        job.save_task(effort=effort)
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
                # 継続用 session_id を保存。ただし次の場合は継続対象から外す
                # （resume すると壊れた履歴を継いで「ツール呼び出しがテキスト化して
                # 途中で止まる」死のループに入るため）。次回コマンドはクリーン起動で自己修復する:
                #   - _session_poisoned: thinking-400 / tool 呼び出しのテキスト化を engine が検知
                #   - canceled: 割り込み等でターン途中に claude を kill した transcript は
                #     tool_use に対応する tool_result を欠く等で不完全になり、resume が壊れる
                sid = job.new_session_id or job.session_id
                drop_session = job.meta.get("_session_poisoned") or job.status == "canceled"
                if drop_session and job.project_path:
                    self._last_session.pop(job.project_path, None)
                elif sid and job.project_path:
                    self._last_session[job.project_path] = sid
                # ここを通れた＝終端した（done/error/canceled）。控えは不要なので消す。
                # 逆に agent がクラッシュ/kill されるとここを通れず控えが残る＝未完了の印。
                job.clear_task()

        job._task = asyncio.create_task(wrapper())
        return job

    def get(self, job_id: str) -> Optional[Job]:
        j = self._jobs.get(job_id)
        if j is not None:
            return j
        # メモリに無い＝再起動前のジョブ。ログから読み戻して「見つからない」を防ぐ。
        return self._load_from_log(job_id)

    def _load_from_log(self, job_id: str) -> Optional[Job]:
        if not job_id or not job_id.isalnum():
            return None
        path = LOG_DIR / f"{job_id}.jsonl"
        if not path.exists():
            return None
        events: list[dict] = []
        try:
            with path.open("r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        events.append(json.loads(line))
                    except Exception:
                        continue
        except Exception:
            return None
        if not events:
            return None
        job = Job(engine="claude_code", instruction="")
        job.id = job_id
        job._log_path = path
        for ev in events:
            et = ev.get("type")
            if et == "started":
                job.new_session_id = ev.get("session_id") or job.new_session_id
                job.model = ev.get("model") or job.model
                job.started_at = job.started_at or ev.get("_t")
                # started イベントの cwd がプロジェクトパス。復元ジョブの絞り込みに使う。
                if ev.get("cwd"):
                    job.project_path = ev["cwd"]
            elif et == "model":
                job.model = ev.get("model") or job.model
            elif et == "action":
                txt = str(ev.get("text") or "")
                if txt:
                    job.actions.append(txt)
            elif et == "done":
                job.summary = ev.get("summary") or ""
                job.cost_usd = float(ev.get("cost_usd") or 0.0)
                job.new_session_id = ev.get("session_id") or job.new_session_id
                job.status = "done"
                job.finished_at = ev.get("_t")
            elif et == "error":
                job.error = str(ev.get("text") or "")
                job.status = "error"
                job.finished_at = ev.get("_t")
            elif et == "canceled":
                job.status = "canceled"
                job.finished_at = ev.get("_t")
            elif et == "interrupted":
                job.error = str(ev.get("text") or "中断されました")
                job.status = "error"
                job.finished_at = ev.get("_t")
        job.events = events
        if job.status == "queued":
            # 終端イベントが無いのに復元された＝起動時 reconcile 前の取りこぼし。安全側で締める。
            job.status = "error"
            job.error = job.error or "agent 再起動により中断されました"
        return job

    def list(self, project_path: Optional[str] = None, limit: int = 50) -> list[dict]:
        items = list(self._jobs.values())
        if project_path:
            items = [j for j in items if j.project_path == project_path]
        items.sort(key=lambda j: j.created_at, reverse=True)
        return [j.to_dict() for j in items[:limit]]

    def list_unfinished(self, project_path: Optional[str] = None, limit: int = 20) -> list[dict]:
        """未完了（running/queued）＋中断（error/interrupted/canceled）を新しい順で返す。

        メモリ上のジョブを優先し、足りない分をディスクのログから補う。
        再起動で消えた中断ジョブも JSONL から復元して拾える。
        """
        seen: set[str] = set()
        out: list[dict] = []

        # 1) メモリ上の現役・直近ジョブ
        for j in self._jobs.values():
            if project_path and j.project_path != project_path:
                continue
            if j.status in ("running", "queued", "error", "canceled"):
                out.append(j.to_dict())
                seen.add(j.id)

        # 2) ディスクのログから「終端が done でない」ものを補完
        try:
            for path in LOG_DIR.glob("*.jsonl"):
                jid = path.stem
                if jid in seen:
                    continue
                j = self._load_from_log(jid)
                if j is None:
                    continue
                if project_path and j.project_path != project_path:
                    continue
                # done は完了済みなので未完了一覧には出さない
                if j.status == "done":
                    continue
                out.append(j.to_dict())
                seen.add(jid)
        except Exception:
            pass

        # 3) task 控えだけ残ったケース（ログが消えた/ほぼ書かれず落ちた）も拾う。
        #    さらに各エントリに再実行用の情報（instruction 全文・needs_secret）を載せる。
        try:
            for path in LOG_DIR.glob("*.task.json"):
                jid = path.stem.replace(".task", "")
                try:
                    task = json.loads(path.read_text(encoding="utf-8"))
                except Exception:
                    continue
                if project_path and task.get("project_path") != project_path:
                    continue
                existing = next((d for d in out if d.get("id") == jid), None)
                if existing is not None:
                    # ⚠️ task.json は実行中も存在する（終端で消す設計）。running/queued を
                    # resumable にすると「送った直後の指示が中断扱いで再開表示される」誤表示になる。
                    if existing.get("status") in ("running", "queued"):
                        continue
                    existing["resumable"] = True
                    existing["full_instruction"] = task.get("instruction")
                    existing["needs_secret"] = task.get("needs_secret", False)
                    existing["resume_session_id"] = task.get("session_id")
                    existing["effort"] = task.get("effort")
                elif jid not in seen:
                    out.append({
                        "id": jid,
                        "status": "interrupted",
                        "project_path": task.get("project_path"),
                        "instruction": (task.get("instruction") or "")[:200],
                        "full_instruction": task.get("instruction"),
                        "needs_secret": task.get("needs_secret", False),
                        "resume_session_id": task.get("session_id"),
                        "model": task.get("model"),
                        "effort": task.get("effort"),
                        "created_at": task.get("created_at"),
                        "resumable": True,
                    })
                    seen.add(jid)
        except Exception:
            pass

        out.sort(key=lambda d: d.get("finished_at") or d.get("started_at") or d.get("created_at") or 0, reverse=True)
        return out[:limit]

    def get_task(self, job_id: str) -> Optional[dict]:
        """未完了タスクの控えを読む。無ければ None。"""
        if not job_id or not job_id.isalnum():
            return None
        path = LOG_DIR / f"{job_id}.task.json"
        if not path.exists():
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return None

    def dismiss_task(self, job_id: str) -> None:
        """未完了タスクの控えを破棄する。"""
        if not job_id or not job_id.isalnum():
            return
        try:
            (LOG_DIR / f"{job_id}.task.json").unlink(missing_ok=True)
        except Exception:
            pass

    def last_session(self, project_path: str) -> Optional[str]:
        return self._last_session.get(project_path)

    def set_last_session(self, project_path: str, session_id: str):
        self._last_session[project_path] = session_id

    def clear_session(self, project_path: str):
        self._last_session.pop(project_path, None)


# シングルトン
manager = JobManager()
