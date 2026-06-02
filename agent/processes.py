"""長時間プロセス（dev server, test runner 等）の管理。

UI から「npm run dev」のような常駐プロセスを起動して
スマホでログを tail できる。
"""
from __future__ import annotations

import asyncio
import os
import signal
import subprocess as _sp
import time
import uuid
from collections import deque
from pathlib import Path
from typing import Optional


LOG_DIR = Path(__file__).parent.parent / "logs" / "processes"
LOG_DIR.mkdir(parents=True, exist_ok=True)

MAX_LINES_PER_PROC = 5000


class ManagedProcess:
    def __init__(self, name: str, command: str, cwd: Optional[str] = None):
        self.id: str = uuid.uuid4().hex[:10]
        self.name = name
        self.command = command
        self.cwd = cwd
        self.created_at = time.time()
        self.started_at: Optional[float] = None
        self.finished_at: Optional[float] = None
        self.status = "queued"  # queued | running | stopped | exited | error
        self.exit_code: Optional[int] = None
        self.lines: deque[str] = deque(maxlen=MAX_LINES_PER_PROC)
        self.subscribers: list[asyncio.Queue[str]] = []
        self._proc: Optional[asyncio.subprocess.Process] = None
        self._task: Optional[asyncio.Task] = None
        self._log_path = LOG_DIR / f"{self.id}.log"

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "command": self.command,
            "cwd": self.cwd,
            "status": self.status,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "exit_code": self.exit_code,
            "lines_count": len(self.lines),
            "lines_tail": list(self.lines)[-10:],
        }

    def _emit_line(self, line: str):
        self.lines.append(line)
        try:
            with self._log_path.open("a", encoding="utf-8") as f:
                f.write(line + "\n")
        except Exception:
            pass
        for q in list(self.subscribers):
            try:
                q.put_nowait(line)
            except asyncio.QueueFull:
                pass

    async def start(self):
        try:
            self._proc = await asyncio.create_subprocess_shell(
                self.command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                cwd=self.cwd,
            )
            self.status = "running"
            self.started_at = time.time()
        except Exception as e:
            self.status = "error"
            self.finished_at = time.time()
            self._emit_line(f"[起動失敗] {type(e).__name__}: {e}")
            return

        async def reader():
            assert self._proc is not None and self._proc.stdout is not None
            try:
                async for raw in self._proc.stdout:
                    self._emit_line(raw.decode("utf-8", errors="replace").rstrip())
                await self._proc.wait()
            finally:
                self.exit_code = self._proc.returncode if self._proc else None
                self.finished_at = time.time()
                if self.status == "running":
                    self.status = "exited"
                self._emit_line(f"[終了] exit_code={self.exit_code}")
                for q in list(self.subscribers):
                    try:
                        q.put_nowait("__EOF__")
                    except Exception:
                        pass

        self._task = asyncio.create_task(reader())

    async def stop(self):
        if self._proc and self._proc.returncode is None:
            try:
                self._proc.terminate()
            except Exception:
                pass
            try:
                await asyncio.wait_for(self._proc.wait(), timeout=5.0)
            except asyncio.TimeoutError:
                try:
                    self._proc.kill()
                except Exception:
                    pass
        self.status = "stopped"
        self.finished_at = time.time()

    async def tail(self, *, from_line: int = 0):
        """指定行以降をリプレイ → ライブ tail。"""
        snapshot = list(self.lines)
        for i, line in enumerate(snapshot):
            if i >= from_line:
                yield line
        if self.status in ("exited", "stopped", "error"):
            return
        q: asyncio.Queue[str] = asyncio.Queue()
        self.subscribers.append(q)
        try:
            while True:
                try:
                    line = await asyncio.wait_for(q.get(), timeout=20.0)
                except asyncio.TimeoutError:
                    yield "__PING__"
                    if self.status in ("exited", "stopped", "error"):
                        return
                    continue
                if line == "__EOF__":
                    return
                yield line
        finally:
            try:
                self.subscribers.remove(q)
            except ValueError:
                pass


class ProcessManager:
    def __init__(self):
        self.procs: dict[str, ManagedProcess] = {}

    async def run(self, name: str, command: str, cwd: Optional[str] = None) -> ManagedProcess:
        p = ManagedProcess(name=name, command=command, cwd=cwd)
        self.procs[p.id] = p
        await p.start()
        return p

    def get(self, pid: str) -> Optional[ManagedProcess]:
        return self.procs.get(pid)

    def list(self) -> list[dict]:
        items = list(self.procs.values())
        items.sort(key=lambda p: p.created_at, reverse=True)
        return [p.to_dict() for p in items[:50]]

    async def stop(self, pid: str) -> bool:
        p = self.procs.get(pid)
        if not p:
            return False
        await p.stop()
        return True


manager = ProcessManager()
