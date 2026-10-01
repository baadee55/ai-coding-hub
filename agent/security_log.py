"""不正アクセスの痕跡を軽量に記録する。

能動プッシュ基盤（Web Push/VAPID）は未実装なので、まずは「開けば分かる」方式:
ログイン失敗・認証拒否・レート超過を JSONL に追記し、スマホから直近を読める。
⚠️ 機密は残さない（トークン値・PII は記録しない。IP と経路と理由コードだけ）。
"""
from __future__ import annotations

import json
import time
from pathlib import Path
from threading import Lock

_LOG_DIR = Path(__file__).parent.parent / "logs"
_LOG_DIR.mkdir(parents=True, exist_ok=True)
_LOG_PATH = _LOG_DIR / "security.jsonl"
_MAX_LINES = 500  # 肥大防止。超えたら古い行を捨てる。
_lock = Lock()


def _client_ip(request) -> str:
    # CF エッジが必ず付ける実クライアント IP を優先（偽装不可）。無ければ接続元。
    ip = (request.headers.get("cf-connecting-ip") or "").strip()
    if ip:
        return ip
    return (request.client.host if request.client else "") or "unknown"


def record(request, event: str, detail: str = "") -> None:
    """1 件の不審イベントを追記する。値は残さず、経路・理由・IP のみ。"""
    rec = {
        "ts": time.time(),
        "event": event,          # 例: login_fail / auth_denied / rate_limited
        "ip": _client_ip(request),
        "path": request.url.path,
        "method": request.method,
        "detail": detail,        # 理由コード等（機密を入れないこと）
    }
    line = json.dumps(rec, ensure_ascii=False)
    with _lock:
        try:
            existing = []
            if _LOG_PATH.exists():
                existing = _LOG_PATH.read_text(encoding="utf-8").splitlines()
            existing.append(line)
            if len(existing) > _MAX_LINES:
                existing = existing[-_MAX_LINES:]
            _LOG_PATH.write_text("\n".join(existing) + "\n", encoding="utf-8")
        except Exception:
            pass  # ログ失敗で本処理を止めない


def recent(limit: int = 50) -> list[dict]:
    """直近の不審イベントを新しい順で返す（スマホ表示用）。"""
    if not _LOG_PATH.exists():
        return []
    try:
        lines = _LOG_PATH.read_text(encoding="utf-8").splitlines()
    except Exception:
        return []
    out = []
    for ln in reversed(lines):
        ln = ln.strip()
        if not ln:
            continue
        try:
            out.append(json.loads(ln))
        except Exception:
            continue
        if len(out) >= limit:
            break
    return out


def summary(window_sec: float = 3600.0) -> dict:
    """直近 window 内の件数サマリ（バッジ表示用）。"""
    now = time.time()
    events = [e for e in recent(_MAX_LINES) if now - e.get("ts", 0) < window_sec]
    by_event: dict = {}
    ips: set = set()
    for e in events:
        by_event[e["event"]] = by_event.get(e["event"], 0) + 1
        ips.add(e.get("ip"))
    return {"total": len(events), "by_event": by_event, "unique_ips": len(ips), "window_sec": window_sec}
