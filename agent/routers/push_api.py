"""Web Push API: スリープ中のスマホにも届く完了通知の購読管理。

GET  /push/pubkey        VAPID 公開鍵（applicationServerKey）
POST /push/subscribe     購読を登録（ブラウザの PushSubscription をそのまま）
POST /push/unsubscribe   購読を解除
POST /push/test          テスト通知を全購読端末へ送信
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import push

router = APIRouter()


class SubscribeRequest(BaseModel):
    subscription: dict
    device_id: Optional[str] = None


class UnsubscribeRequest(BaseModel):
    endpoint: str


@router.get("/pubkey")
def pubkey():
    return {"key": push.get_public_key()}


@router.post("/subscribe")
def subscribe(req: SubscribeRequest):
    try:
        n = push.add_subscription(req.subscription, req.device_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid subscription")
    return {"ok": True, "count": n}


@router.post("/unsubscribe")
def unsubscribe(req: UnsubscribeRequest):
    n = push.remove_subscription(req.endpoint)
    return {"ok": True, "count": n}


@router.post("/test")
def test():
    if push.count() == 0:
        raise HTTPException(status_code=400, detail="no subscriptions")
    push.notify("🔔 AI hub テスト", "この通知が見えれば Web Push は有効です")
    return {"ok": True}
