"""Passkey 認証 API。

PC ローカル (127.0.0.1) からのみ可能:
  POST /auth/register/token       新規端末追加用の短期トークンを発行 → QR/URL

誰でも可能（トークンや challenge で検証）:
  POST /auth/register/begin       WebAuthn 登録 challenge
  POST /auth/register/finish      WebAuthn 登録完了 → JWT
  POST /auth/login/begin          WebAuthn 認証 challenge
  POST /auth/login/finish         WebAuthn 認証完了 → JWT
  GET  /auth/status               passkey 登録済みか + RP 情報

JWT 必須:
  GET  /auth/devices              登録済みデバイス一覧
  DELETE /auth/devices/{short_id} デバイス削除
"""
from __future__ import annotations

import logging
import os
import socket

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

import auth as A


_log = logging.getLogger("auth_api")


router = APIRouter()


def _is_local(request: Request) -> bool:
    # watchdog 経由 (= 公開口経由) を「ローカル」扱いしない。
    # 詳細は auth.is_truly_local 参照。
    return A.is_truly_local(request)


@router.get("/status")
async def status():
    return {
        "passkey_registered": A.has_any_credentials(),
        "rp_id": A.RP_ID,
        "expected_origins": A.EXPECTED_ORIGINS,
    }


# ===== 端末追加トークン（PC ローカルのみ） =====

@router.post("/register/token")
async def register_token(request: Request):
    if not _is_local(request):
        raise HTTPException(403, "PC のローカル (127.0.0.1) からのみ実行できます")
    info = A.issue_register_token()
    public_url = os.getenv("PUBLIC_URL", f"https://{A.RP_ID}")
    info["register_url"] = f"{public_url.rstrip('/')}/ui/?register_token={info['token']}"
    return info


# ===== WebAuthn 登録 =====

class RegisterBeginReq(BaseModel):
    register_token: str


@router.post("/register/begin")
async def register_begin(req: RegisterBeginReq):
    try:
        return A.registration_begin(req.register_token)
    except PermissionError as e:
        raise HTTPException(403, str(e))


class RegisterFinishReq(BaseModel):
    session_id: str
    credential: dict
    device_name: str = ""


@router.post("/register/finish")
async def register_finish(req: RegisterFinishReq):
    try:
        return A.registration_finish(req.session_id, req.credential, req.device_name)
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except Exception:
        # スタックトレースや内部型名を返さない (情報漏洩防止)。詳細はサーバログへ。
        _log.exception("registration_finish failed")
        raise HTTPException(400, "登録に失敗しました")


# ===== WebAuthn 認証 =====

@router.post("/login/begin")
async def login_begin():
    try:
        return A.authentication_begin()
    except LookupError as e:
        raise HTTPException(404, str(e))


class LoginFinishReq(BaseModel):
    session_id: str
    credential: dict


@router.post("/login/finish")
async def login_finish(req: LoginFinishReq):
    try:
        return A.authentication_finish(req.session_id, req.credential)
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except Exception:
        _log.exception("authentication_finish failed")
        raise HTTPException(400, "認証に失敗しました")


# ===== デバイス管理（JWT 必須は main.py の middleware で担保） =====

@router.get("/devices")
async def list_devices():
    return A.list_devices()


@router.delete("/devices/{short_id}")
async def delete_device(short_id: str):
    if not A.delete_device(short_id):
        raise HTTPException(404, "デバイスが見つかりません")
    return {"deleted": short_id}
