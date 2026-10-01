"""Web Push（VAPID）— アプリを閉じていても・スマホがスリープでも届く能動通知。

- 鍵と購読情報は agent/config/ に保存（.gitignore 済み・チャットにも出さない）。
- 送信は pywebpush（同期・ブロッキング）なのでデーモンスレッドで投げる。
  ジョブ完了処理を通知の失敗で止めない（通知は常にベストエフォート）。
- 404/410（購読失効）は自動で購読を削除する。
"""
import base64
import json
import threading
import time
from pathlib import Path
from typing import Optional

CONFIG_DIR = Path(__file__).parent / "config"
CONFIG_DIR.mkdir(parents=True, exist_ok=True)
VAPID_PEM_PATH = CONFIG_DIR / "vapid_private.pem"
VAPID_PUB_PATH = CONFIG_DIR / "vapid_public.txt"
SUBS_PATH = CONFIG_DIR / "push_subs.json"

# 購読ファイルの読み書き＋鍵生成の排他
_lock = threading.Lock()

# push サービスへの JWT 用。実在アドレスである必要はないが mailto: 形式が必須。
_VAPID_SUB = "mailto:aihub@example.com"


def get_public_key() -> str:
    """VAPID 公開鍵（applicationServerKey 用の base64url）。無ければ生成して永続化。"""
    with _lock:
        if VAPID_PUB_PATH.exists() and VAPID_PEM_PATH.exists():
            return VAPID_PUB_PATH.read_text(encoding="utf-8").strip()
        from py_vapid import Vapid
        from cryptography.hazmat.primitives import serialization
        v = Vapid()
        v.generate_keys()
        v.save_key(str(VAPID_PEM_PATH))
        raw = v.public_key.public_bytes(
            serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
        )
        pub = base64.urlsafe_b64encode(raw).rstrip(b"=").decode()
        VAPID_PUB_PATH.write_text(pub, encoding="utf-8")
        return pub


def _load_subs() -> dict:
    try:
        return json.loads(SUBS_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_subs(subs: dict) -> None:
    SUBS_PATH.write_text(json.dumps(subs, indent=2, ensure_ascii=False), encoding="utf-8")


def add_subscription(subscription: dict, device_id: Optional[str] = None) -> int:
    """購読を保存（endpoint をキーに上書き）。戻り値は購読総数。"""
    endpoint = (subscription or {}).get("endpoint") or ""
    if not endpoint or not isinstance(subscription.get("keys"), dict):
        raise ValueError("invalid subscription")
    with _lock:
        subs = _load_subs()
        subs[endpoint] = {
            "sub": subscription,
            "device_id": device_id,
            "added": time.time(),
        }
        _save_subs(subs)
        return len(subs)


def remove_subscription(endpoint: str) -> int:
    with _lock:
        subs = _load_subs()
        subs.pop(endpoint or "", None)
        _save_subs(subs)
        return len(subs)


def count() -> int:
    with _lock:
        return len(_load_subs())


def _send_all_sync(title: str, body: str, tag: str = "aihub", url: str = "/ui/") -> None:
    from pywebpush import webpush, WebPushException
    with _lock:
        subs = _load_subs()
    if not subs:
        return
    payload = json.dumps(
        {"title": title, "body": body, "tag": tag, "url": url}, ensure_ascii=False
    )
    dead: list[str] = []
    for endpoint, rec in subs.items():
        try:
            webpush(
                subscription_info=rec["sub"],
                data=payload,
                vapid_private_key=str(VAPID_PEM_PATH),
                # claims は pywebpush 側で exp を書き足すため毎回新しい dict を渡す
                vapid_claims={"sub": _VAPID_SUB},
                ttl=3600,
            )
        except WebPushException as e:
            code = getattr(getattr(e, "response", None), "status_code", None)
            if code in (404, 410):
                dead.append(endpoint)  # 購読失効（アプリ削除・購読解除）
            # それ以外は一時障害としてスキップ（通知はベストエフォート）
        except Exception:
            pass
    if dead:
        with _lock:
            cur = _load_subs()
            for ep in dead:
                cur.pop(ep, None)
            _save_subs(cur)


def notify(title: str, body: str, tag: str = "aihub", url: str = "/ui/") -> None:
    """全購読端末へ通知（非同期・失敗しても呼び出し元に影響しない）。"""
    if not SUBS_PATH.exists():
        return  # 誰も購読していなければスレッドすら立てない
    threading.Thread(
        target=_send_all_sync, args=(title, body, tag, url), daemon=True
    ).start()


def notify_job_finished(job) -> None:
    """ジョブ完了/失敗の通知。本文は要約の先頭だけ（長文・機密全文は載せない）。"""
    try:
        proj = Path(job.project_path).name if getattr(job, "project_path", None) else ""
        if job.status == "done":
            title = f"✅ {proj or 'AI hub'} 完了"
            body = (job.summary or "").strip().splitlines()[0][:100] if job.summary else "作業が終わりました"
        else:
            title = f"⚠ {proj or 'AI hub'} エラー"
            body = (job.error or "エラーで停止しました").strip().splitlines()[0][:100]
        notify(title, body, tag=f"job-{job.id}")
    except Exception:
        pass
