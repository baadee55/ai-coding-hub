"""Passkey (WebAuthn) 認証 + JWT 発行。

- agent 全体に 1 ユーザー（PC オーナー）の Passkey 群を管理
- 認証成功で短期 JWT を発行（既存 AGENT_TOKEN 認証の上に乗る）
- 初回は 127.0.0.1 (PC ローカル) からの「端末追加」で
  短期登録トークンを発行 → スマホで開いて登録
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import time
from pathlib import Path
from typing import Optional

import jwt as pyjwt
from webauthn import (
    generate_authentication_options,
    generate_registration_options,
    options_to_json,
    verify_authentication_response,
    verify_registration_response,
)
from webauthn.helpers.cose import COSEAlgorithmIdentifier
from webauthn.helpers.structs import (
    AuthenticatorSelectionCriteria,
    PublicKeyCredentialDescriptor,
    ResidentKeyRequirement,
    UserVerificationRequirement,
)


# ===== ローカル判定 =====
_LOCAL_HOSTS = {"127.0.0.1", "::1", "localhost"}


def is_truly_local(request) -> bool:
    """watchdog 経由でない、agent に直接来た 127.0.0.1 接続だけを真のローカルとみなす。

    watchdog (公開口 8765) を経由したリクエストは agent から見ると 127.0.0.1
    に見えるが、その実体は Cloudflare Tunnel 越しのインターネット越し攻撃者
    かもしれない。watchdog 側で X-Via-Watchdog ヘッダを強制付与しているので、
    それで識別する。

    127.0.0.1 ローカル特権 (passkey/AGENT_TOKEN を要求しない経路) は、
    PC 上で直接 agent (8766) を叩いた場合のみに与える。
    """
    if request.headers.get("x-via-watchdog"):
        return False
    client = (request.client.host if request.client else "") or ""
    return client in _LOCAL_HOSTS


# ===== 設定 =====
def _default_rp_id() -> str:
    """PASSKEY_RP_ID 未設定なら PUBLIC_URL のホスト名から導出、無ければ localhost。
    個人ドメインをコードに焼かないための既定（フォーク先は各自の .env で上書き）。"""
    pub = os.getenv("PUBLIC_URL", "").strip()
    if pub:
        from urllib.parse import urlparse
        host = urlparse(pub).hostname
        if host:
            return host
    return "localhost"


RP_ID = os.getenv("PASSKEY_RP_ID", "").strip() or _default_rp_id()
RP_NAME = os.getenv("PASSKEY_RP_NAME", "AI Coding Hub")
# 複数の origin を許可（PC ローカル + Cloudflare URL）
EXPECTED_ORIGINS = [
    o.strip() for o in os.getenv(
        "PASSKEY_ORIGINS",
        f"https://{RP_ID},http://localhost:8765,http://127.0.0.1:8765"
    ).split(",") if o.strip()
]
USER_HANDLE = b"ai-hub-owner-01"  # 単一ユーザー固定
USER_NAME = os.getenv("PASSKEY_USER", "owner")
USER_DISPLAY = os.getenv("PASSKEY_DISPLAY", "AI Hub Owner")

CONFIG_DIR = Path(__file__).parent / "config"
CONFIG_DIR.mkdir(parents=True, exist_ok=True)
CREDS_PATH = CONFIG_DIR / "credentials.json"
JWT_SECRET_PATH = CONFIG_DIR / "jwt_secret.txt"


# ===== JWT secret =====
def _get_jwt_secret() -> str:
    if JWT_SECRET_PATH.exists():
        return JWT_SECRET_PATH.read_text(encoding="utf-8").strip()
    s = secrets.token_urlsafe(48)
    JWT_SECRET_PATH.write_text(s, encoding="utf-8")
    return s


JWT_SECRET = _get_jwt_secret()
JWT_ALGO = "HS256"
JWT_TTL = int(os.getenv("JWT_TTL_SEC", str(7 * 86400)))  # 7d


def create_jwt(device_id: str, name: str) -> str:
    payload = {
        "device_id": device_id,
        "name": name,
        "iat": int(time.time()),
        "exp": int(time.time()) + JWT_TTL,
    }
    return pyjwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGO)


def _device_id_for_cred_bytes(cred_id_b: bytes) -> str:
    return hashlib.sha256(cred_id_b).hexdigest()[:16]


def _known_device_ids() -> set[str]:
    out: set[str] = set()
    for c in load_creds():
        b = c.get("credential_id_bytes")
        if b:
            out.add(_device_id_for_cred_bytes(b))
    return out


def verify_jwt(token: str) -> Optional[dict]:
    try:
        payload = pyjwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGO])
    except Exception:
        return None
    # デバイス削除済みなら即座に拒否 (JWT 失効リストの代わり)。
    # /auth/devices からスマホを「ログアウト」させたら、攻撃者が握っている
    # JWT も同時に死ぬ。device_id 不在 = 削除済み。
    did = payload.get("device_id") or ""
    if did and did not in _known_device_ids():
        return None
    return payload


# ===== Credential store =====
def _b64u_encode(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode("ascii")


def _b64u_decode(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def load_creds() -> list[dict]:
    if not CREDS_PATH.exists():
        return []
    try:
        raw = json.loads(CREDS_PATH.read_text(encoding="utf-8"))
        # bytes フィールドをデコード
        for c in raw:
            if isinstance(c.get("credential_id"), str):
                c["credential_id_bytes"] = _b64u_decode(c["credential_id"])
            if isinstance(c.get("public_key"), str):
                c["public_key_bytes"] = _b64u_decode(c["public_key"])
        return raw
    except Exception:
        return []


def save_creds(creds: list[dict]):
    out = []
    for c in creds:
        c2 = dict(c)
        # bytes は保存しない（base64 のみ）
        c2.pop("credential_id_bytes", None)
        c2.pop("public_key_bytes", None)
        out.append(c2)
    CREDS_PATH.write_text(json.dumps(out, indent=2, ensure_ascii=False), encoding="utf-8")


def has_any_credentials() -> bool:
    return len(load_creds()) > 0


def list_devices() -> list[dict]:
    return [
        {
            "id": c["credential_id"][:12],
            "name": c.get("name") or "デバイス",
            "registered_at": c.get("registered_at"),
            "last_used": c.get("last_used"),
            "sign_count": c.get("sign_count", 0),
        }
        for c in load_creds()
    ]


def delete_device(short_id: str) -> bool:
    creds = load_creds()
    new = [c for c in creds if not c["credential_id"].startswith(short_id)]
    if len(new) == len(creds):
        return False
    save_creds(new)
    return True


# ===== 一時状態（challenge / register token） =====
_challenges: dict[str, dict] = {}
_register_tokens: dict[str, dict] = {}
_CHALLENGE_TTL = 300  # 5 min
_REGISTER_TOKEN_TTL = 600  # 10 min


def _purge_expired():
    now = time.time()
    for k in [k for k, v in _challenges.items() if v.get("exp", 0) < now]:
        _challenges.pop(k, None)
    for k in [k for k, v in _register_tokens.items() if v.get("exp", 0) < now]:
        _register_tokens.pop(k, None)


def issue_register_token() -> dict:
    _purge_expired()
    tok = secrets.token_urlsafe(24)
    _register_tokens[tok] = {"exp": time.time() + _REGISTER_TOKEN_TTL, "used": False}
    return {
        "token": tok,
        "expires_in_sec": _REGISTER_TOKEN_TTL,
    }


def check_register_token(tok: str) -> bool:
    _purge_expired()
    e = _register_tokens.get(tok)
    if not e or e.get("used"):
        return False
    return e["exp"] > time.time()


def consume_register_token(tok: str):
    _register_tokens.pop(tok, None)


# ===== WebAuthn 登録 =====
def registration_begin(register_token: str) -> dict:
    if not check_register_token(register_token):
        raise PermissionError("登録トークンが無効か期限切れです")
    creds = load_creds()
    options = generate_registration_options(
        rp_id=RP_ID,
        rp_name=RP_NAME,
        user_id=USER_HANDLE,
        user_name=USER_NAME,
        user_display_name=USER_DISPLAY,
        exclude_credentials=[
            PublicKeyCredentialDescriptor(id=c["credential_id_bytes"]) for c in creds
        ],
        authenticator_selection=AuthenticatorSelectionCriteria(
            user_verification=UserVerificationRequirement.PREFERRED,
            resident_key=ResidentKeyRequirement.PREFERRED,
        ),
        supported_pub_key_algs=[
            COSEAlgorithmIdentifier.ECDSA_SHA_256,
            COSEAlgorithmIdentifier.RSASSA_PKCS1_v1_5_SHA_256,
        ],
        timeout=120000,
    )
    sid = secrets.token_urlsafe(16)
    _challenges[sid] = {
        "challenge": options.challenge,
        "exp": time.time() + _CHALLENGE_TTL,
        "type": "register",
        "register_token": register_token,
    }
    opts = json.loads(options_to_json(options))
    return {"session_id": sid, "options": opts}


def registration_finish(session_id: str, credential: dict, device_name: str = "") -> dict:
    _purge_expired()
    ch = _challenges.pop(session_id, None)
    if not ch or ch.get("type") != "register":
        raise PermissionError("チャレンジが見つかりません")
    register_token = ch.get("register_token") or ""
    if not check_register_token(register_token):
        raise PermissionError("登録トークンが無効です")

    verification = verify_registration_response(
        credential=credential,
        expected_challenge=ch["challenge"],
        expected_origin=EXPECTED_ORIGINS,
        expected_rp_id=RP_ID,
        require_user_verification=False,
    )
    creds = load_creds()
    cred_id_b = verification.credential_id
    creds.append({
        "credential_id": _b64u_encode(cred_id_b),
        "public_key": _b64u_encode(verification.credential_public_key),
        "sign_count": verification.sign_count,
        "name": device_name or "デバイス",
        "registered_at": time.time(),
        "last_used": time.time(),
    })
    save_creds(creds)
    consume_register_token(register_token)

    device_id = _device_id_for_cred_bytes(cred_id_b)
    jwt_token = create_jwt(device_id=device_id, name=device_name or "デバイス")
    return {"ok": True, "jwt": jwt_token, "ttl_sec": JWT_TTL}


# ===== WebAuthn 認証 =====
def authentication_begin() -> dict:
    creds = load_creds()
    if not creds:
        raise LookupError("登録済みデバイスがありません")
    options = generate_authentication_options(
        rp_id=RP_ID,
        allow_credentials=[
            PublicKeyCredentialDescriptor(id=c["credential_id_bytes"]) for c in creds
        ],
        user_verification=UserVerificationRequirement.PREFERRED,
        timeout=120000,
    )
    sid = secrets.token_urlsafe(16)
    _challenges[sid] = {
        "challenge": options.challenge,
        "exp": time.time() + _CHALLENGE_TTL,
        "type": "login",
    }
    return {"session_id": sid, "options": json.loads(options_to_json(options))}


def authentication_finish(session_id: str, credential: dict) -> dict:
    _purge_expired()
    ch = _challenges.pop(session_id, None)
    if not ch or ch.get("type") != "login":
        raise PermissionError("チャレンジが見つかりません")
    creds = load_creds()
    cred_id_b = _b64u_decode(credential["id"])
    found = next((c for c in creds if c["credential_id_bytes"] == cred_id_b), None)
    if not found:
        raise PermissionError("未登録のデバイスです")
    verification = verify_authentication_response(
        credential=credential,
        expected_challenge=ch["challenge"],
        expected_origin=EXPECTED_ORIGINS,
        expected_rp_id=RP_ID,
        credential_public_key=found["public_key_bytes"],
        credential_current_sign_count=found["sign_count"],
        require_user_verification=False,
    )
    found["sign_count"] = verification.new_sign_count
    found["last_used"] = time.time()
    save_creds(creds)

    device_id = _device_id_for_cred_bytes(cred_id_b)
    jwt_token = create_jwt(device_id=device_id, name=found.get("name") or "デバイス")
    return {"ok": True, "jwt": jwt_token, "ttl_sec": JWT_TTL, "name": found.get("name")}
