"""Passkey 認証 API。

PC ローカル (127.0.0.1) または認証済み（パスワード=AGENT_TOKEN / JWT）から可能:
  POST /auth/register/token       新規端末追加用の短期トークンを発行 → QR/URL
                                  （パスワードで接続したスマホが自分に Passkey 登録するのにも使う）

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
import secrets
import socket

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

import auth as A
import security_log as _seclog


_log = logging.getLogger("auth_api")

_AGENT_TOKEN = os.getenv("AGENT_TOKEN", "")


router = APIRouter()


def _is_local(request: Request) -> bool:
    # watchdog 経由 (= 公開口経由) を「ローカル」扱いしない。
    # 詳細は auth.is_truly_local 参照。
    return A.is_truly_local(request)


def _is_authenticated(request: Request) -> bool:
    """既に認証済み（パスワード=AGENT_TOKEN もしくは有効な JWT）か。
    パスワードで接続したスマホが、自分自身に Passkey を登録できるようにするため
    （QR で別端末から発行する手間を無くす）。
    ⚠️ AGENT_TOKEN を認めるのは Passkey 未登録の bootstrap 期間だけ。登録後は
    main.py の middleware と同じ拒否条件に揃える＝パスワード漏洩だけではリモートから
    端末追加トークンを発行できない。PC ローカルからの発行は呼び出し側の _is_local が
    別途許可するので、スマホ紛失時の復旧路（PC の前で QR 発行）は残る。"""
    hdr = request.headers.get("authorization", "")
    token = hdr[7:] if hdr.startswith("Bearer ") else ""
    if not token:
        return False
    if A.verify_jwt(token):
        return True
    if (
        _AGENT_TOKEN
        and secrets.compare_digest(token, _AGENT_TOKEN)
        and not A.has_any_credentials()
    ):
        return True
    return False


@router.get("/status")
async def status():
    return {
        "passkey_registered": A.has_any_credentials(),
        "rp_id": A.RP_ID,
        "expected_origins": A.EXPECTED_ORIGINS,
    }


# ===== 端末追加トークン（PC ローカル or 認証済み端末） =====

@router.post("/register/token")
async def register_token(request: Request):
    # PC ローカル、または既にログイン済み（パスワード/JWT）なら発行可。
    # 後者により「固定URL→パスワードで接続→そのまま自分に Passkey 登録」が QR 無しで完結する。
    if not (_is_local(request) or _is_authenticated(request)):
        raise HTTPException(403, "PC のローカル、またはログイン済みでのみ実行できます")
    info = A.issue_register_token()
    public_url = os.getenv("PUBLIC_URL", f"https://{A.RP_ID}")
    url = f"{public_url.rstrip('/')}/ui/?register_token={info['token']}"
    info["register_url"] = url
    # QR をサーバ側で生成して data URI で返す。ブラウザの QR ライブラリ(CDN)に依存せず、
    # オフライン/CDN ブロック環境でも「スマホを追加」が必ず画面に QR を出せる。
    try:
        import io as _io
        import base64 as _b64
        import qrcode as _qr
        _buf = _io.BytesIO()
        _qr.make(url).save(_buf, format="PNG")
        info["qr_data_uri"] = "data:image/png;base64," + _b64.b64encode(_buf.getvalue()).decode("ascii")
    except Exception:
        pass  # 失敗時はフロントが register_url からのフォールバックで対応
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
async def login_finish(req: LoginFinishReq, request: Request):
    try:
        return A.authentication_finish(req.session_id, req.credential)
    except PermissionError as e:
        _seclog.record(request, "login_fail", "credential rejected")
        raise HTTPException(403, str(e))
    except Exception:
        _log.exception("authentication_finish failed")
        _seclog.record(request, "login_fail", "verify error")
        raise HTTPException(400, "認証に失敗しました")


# ===== 金庫「指紋で開錠」のラップ鍵（JWT 必須は middleware で担保） =====

class VaultKeyReq(BaseModel):
    key: str


@router.post("/vault-key")
async def set_vault_key(req: VaultKeyReq, request: Request):
    """スマホが PIN をラップしたランダム鍵を、ログイン中の端末(credential)へ紐づけ保存。
    鍵の返却は /auth/login/finish（WebAuthn 認証成功）の応答のみ＝生体確認とセット。
    device_id は JWT payload から取る（パスワード認証のみでは端末を特定できないので拒否）。"""
    payload = getattr(request.state, "_jwt_payload_cache", None)
    did = (payload or {}).get("device_id") or ""
    if not did:
        raise HTTPException(403, "Passkey ログイン中の端末でのみ設定できます")
    if not A.set_vault_wrap_key(did, req.key):
        raise HTTPException(400, "保存に失敗しました")
    return {"ok": True}


# ===== デバイス管理（JWT 必須は main.py の middleware で担保） =====

@router.get("/devices")
async def list_devices():
    return A.list_devices()


@router.delete("/devices/{short_id}")
async def delete_device(short_id: str):
    if not A.delete_device(short_id):
        raise HTTPException(404, "デバイスが見つかりません")
    return {"deleted": short_id}


# ===== 不正アクセス痕跡（JWT 必須は middleware で担保） =====

@router.get("/security/recent")
async def security_recent(limit: int = 50):
    """直近の不審イベント（ログイン失敗・認証拒否・レート超過）を新しい順で返す。"""
    return _seclog.recent(limit=min(max(limit, 1), 200))


@router.get("/security/summary")
async def security_summary():
    """直近 1 時間の件数サマリ（スマホのバッジ用）。"""
    return _seclog.summary()
