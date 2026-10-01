from contextlib import asynccontextmanager
from fastapi import FastAPI, Depends, HTTPException, Header, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
import uvicorn
import os
import re
import time
import secrets
from collections import defaultdict
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

# ===== 課金トラップの構造的ブロック =====
# ANTHROPIC_API_KEY が環境にあると Claude Code が Max プラン枠ではなく
# API 課金で動き、想定外の請求が来る（Issue #37686: 2日で $1,800 の事例）。
# エンジンは subprocess env から除去するが、ここで起動自体を止めて
# 「知らずに設定する」事故を構造的に不可能にする。
if os.environ.get("ANTHROPIC_API_KEY"):
    raise SystemExit(
        "\n================================================================\n"
        " 起動を中止しました: ANTHROPIC_API_KEY が設定されています。\n"
        "----------------------------------------------------------------\n"
        " このシステムは Claude の Max/Pro プラン枠で動かす前提です。\n"
        " API キーがあると Claude Code が API 課金で動き、高額請求の恐れ。\n"
        " 対処: 環境変数 / agent/.env から ANTHROPIC_API_KEY を削除して再起動。\n"
        " （他ツール用に必要なら、このエージェント用の起動シェルだけで unset）\n"
        "================================================================\n"
    )

# ===== SYSTEM 起動の構造的ブロック =====
# 中継AIが Windows の SYSTEM(LocalSystem)で上がると、claude のログイン(Max枠)も
# claude.cmd 本体もユーザープロファイル側にあって見えず、全ジョブが即死する
# （スマホには「SYSTEM 権限で実行できません」が出続ける）。ここで起動自体を止め、
# 壊れた SYSTEM インスタンスがポート(8766)を奪ってスマホに応答するのを防ぐ。
# こうすれば通常ユーザーの正しいインスタンスが同ポートを握れる。
# 判定: USERPROFILE が systemprofile を指す / USERNAME が末尾 `$`（マシンアカウント）。
_up = (os.environ.get("USERPROFILE") or "").lower()
_un = os.environ.get("USERNAME") or ""
if "systemprofile" in _up or _un.endswith("$"):
    raise SystemExit(
        "\n================================================================\n"
        " 起動を中止しました: SYSTEM(LocalSystem)権限で動いています。\n"
        "----------------------------------------------------------------\n"
        " SYSTEM からは claude のログイン(Max枠)もコマンドも見えず、全ジョブが\n"
        " 即死します。start-all.ps1 を、通常ユーザーで\n"
        " （管理者でも SYSTEM スケジュールタスクでもなく）起動し直してください。\n"
        "================================================================\n"
    )

from routers import projects, command, context, jobs_api, processes_api, uploads, auth_api, push_api
import auth as _auth
import security_log as _seclog

API_TOKEN = os.getenv("AGENT_TOKEN", "")
if not API_TOKEN or API_TOKEN in ("change-me-now", "changeme", "default", "test"):
    raise SystemExit(
        "AGENT_TOKEN が未設定 or デフォルト値です。agent/.env にランダム値を設定してください。"
        " 例: AGENT_TOKEN=$(python -c \"import secrets; print(secrets.token_urlsafe(32))\")"
    )

for _k in ("AGENT_TOKEN", "CLOUDFLARE_TUNNEL_TOKEN", "CF_TOKEN"):
    os.environ.pop(_k, None)  # 読み取り済み。子プロセスへ継承させない


def _token_eq(candidate: str) -> bool:
    """AGENT_TOKEN の定数時間比較（タイミング攻撃で総当たりを助けないため）。"""
    return secrets.compare_digest(candidate or "", API_TOKEN)

# ===== 認証 =====
# 経由パターン:
#   1) JWT (Passkey ログイン後発行) → middleware で検証 → 既存ルータの verify_token を通すため
#      Authorization ヘッダを AGENT_TOKEN に書き換える
#   2) AGENT_TOKEN: passkey 未登録時の bootstrap、または 127.0.0.1 ローカルからの操作
#   3) /auth/*, /health, /ui/*: 認証なし通過
PUBLIC_PATHS = ("/health", "/openapi.json", "/docs", "/redoc", "/favicon.ico")
# 認証不要で通す /auth/* のサブパス（passkey 登録/ログインのフロー本体）
PUBLIC_AUTH_PATHS = (
    "/auth/status",
    "/auth/register/token",   # 内部で localhost チェック
    "/auth/register/begin",
    "/auth/register/finish",
    "/auth/login/begin",
    "/auth/login/finish",
)


def verify_token(authorization: str = Header(None)):
    # middleware 通過後はヘッダが AGENT_TOKEN に書き換わってる
    token = authorization[7:] if authorization and authorization.startswith("Bearer ") else ""
    if not _token_eq(token):
        raise HTTPException(status_code=401, detail="Unauthorized")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 起動時: 前回 agent が落ちて「未完了のまま」になったジョブログを締める。
    # これで「黙って止まって記録も無い」を解消し、最低でも中断が必ず残る。
    import lifecycle
    try:
        n = lifecycle.reconcile_orphan_jobs()
        if n:
            print(f"[lifecycle] 中断扱いにした未完了ジョブ: {n} 件")
    except Exception as e:
        print(f"[lifecycle] reconcile 失敗: {e}")
    # 稼働中はスリープ抑止（画面は消えてよい）。スマホで指示→放置→PC がスリープで
    # ジョブが止まる、を防ぐ。
    if lifecycle.keep_awake():
        print("[lifecycle] スリープ抑止 ON")
    try:
        yield
    finally:
        lifecycle.allow_sleep()


app = FastAPI(title="AI Hub", version="2.0.0", lifespan=lifespan)

_UNSET = object()


def _jwt_payload(request: Request, token: str):
    """JWT 検証結果を 1 リクエスト内でメモ化する。
    auth_middleware と rate_limit が同じトークンを二重に署名検証するのを防ぐ
    （署名検証は安くないので、ヘッダは1リクエスト内で不変＝結果も不変）。"""
    cached = getattr(request.state, "_jwt_payload_cache", _UNSET)
    if cached is not _UNSET:
        return cached
    payload = _auth.verify_jwt(token) if token else None
    request.state._jwt_payload_cache = payload
    return payload


# ===== Passkey / JWT 認証ミドルウェア =====
@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    path = request.url.path
    # /auth/* のうち、登録/ログインに必要なエンドポイントだけ素通し。
    # /auth/devices などその他は通常の認証フローを通す。
    if path in PUBLIC_PATHS or path.startswith("/ui/") or path in PUBLIC_AUTH_PATHS:
        return await call_next(request)

    is_local = _auth.is_truly_local(request)

    auth_hdr = request.headers.get("authorization", "")
    token = auth_hdr[7:] if auth_hdr.startswith("Bearer ") else ""

    accepted = False

    # 1) JWT (Passkey ログイン後)
    if token and _jwt_payload(request, token):
        accepted = True

    # 2) AGENT_TOKEN
    if not accepted and _token_eq(token):
        # passkey 登録済み + リモートからの場合は拒否
        if _auth.has_any_credentials() and not is_local:
            return JSONResponse(
                {"detail": "Passkey 登録済みです。Passkey でログインしてください。", "need_passkey": True},
                status_code=401,
            )
        accepted = True

    # 3) PC ローカルは passkey 不要（端末追加・設定用）
    if not accepted and is_local:
        accepted = True

    if not accepted:
        _seclog.record(request, "auth_denied", "no valid jwt/token, not local")
        return JSONResponse({"detail": "認証が必要です"}, status_code=401)

    # 既存ルータの verify_token を通すためヘッダを AGENT_TOKEN に正規化
    if not _token_eq(token):
        new_headers = [(k, v) for k, v in request.scope["headers"] if k != b"authorization"]
        new_headers.append((b"authorization", f"Bearer {API_TOKEN}".encode()))
        request.scope["headers"] = new_headers

    return await call_next(request)


# ===== レート制限（1分間に30リクエストまで） =====
# CF Tunnel 経由は全部 127.0.0.1 になるので、IP だけだと全攻撃者で 1 プールに
# なってしまう。JWT があれば device_id ベース、無ければ IP ベース。
# 未認証は厳しめ (10/min)、認証済みは緩め (30/min)。
_rate_store: dict = defaultdict(list)
_RATE_LIMIT_AUTH = 30
_RATE_LIMIT_ANON = 10

# 重要経路の専用上限（全体枠とは別カウント。厳しい方が先に効く）。
#   - ジョブ作成(POST /jobs) は AI 実行＝Max枠を消費。連打で枠を溶かされないよう絞る。
#   - ログイン試行(/auth/login/*) は総当たりの的。認証前なので特に厳しく。
# window 秒あたり max 回。key は既存 _rate_key_and_limit と同じ主体で分離する。
_RATE_RULES = [
    # (判定, ラベル, window秒, 上限)
    ("job_create", 60, 8),      # POST /jobs：1分に8ジョブまで
    ("login", 300, 10),         # /auth/login/*：5分に10回まで
]


def _critical_rule(request: Request):
    """このリクエストが重要経路なら (ラベル, window, max) を返す。該当なしは None。"""
    p = request.url.path
    if request.method == "POST" and (p == "/jobs" or p == "/jobs/"):
        return ("job_create", 60, 8)
    if p.startswith("/auth/login/"):
        return ("login", 300, 10)
    return None


def _rate_key_and_limit(request: Request) -> tuple[str, int]:
    auth_hdr = request.headers.get("authorization", "")
    if auth_hdr.startswith("Bearer "):
        token = auth_hdr[7:]
        if _token_eq(token):
            return ("agent_token", _RATE_LIMIT_AUTH)
        payload = _jwt_payload(request, token)
        if payload:
            return ("jwt:" + (payload.get("device_id") or "?"), _RATE_LIMIT_AUTH)
    # CF Tunnel 経由は request.client が全部 127.0.0.1 になり、全攻撃者が 1 プールに
    # 潰れて正規ユーザーが巻き添え 429 になる。CF エッジが必ず付ける実クライアント IP
    # (cf-connecting-ip、偽装不可) があればそれを主体にして攻撃者ごとに分離する。
    real_ip = request.headers.get("cf-connecting-ip", "").strip()
    client = real_ip or (request.client.host if request.client else "unknown") or "unknown"
    return ("anon:" + client, _RATE_LIMIT_ANON)


@app.middleware("http")
async def rate_limit(request: Request, call_next):
    if request.url.path.startswith("/ui") or request.url.path == "/health":
        return await call_next(request)
    # PC ローカル（管理用・watchdog 経由でない直 127.0.0.1）は信頼。レート制限しない。
    # 初期設定で /auth/status・/projects を何度も叩く＆リロードする局面で 429 にしないため。
    if _auth.is_truly_local(request):
        return await call_next(request)
    key, limit = _rate_key_and_limit(request)
    now = time.time()
    # 重要経路（ジョブ作成/ログイン試行）は別カウントで厳しく先に判定する。
    rule = _critical_rule(request)
    if rule:
        label, window, cap = rule
        ckey = f"crit:{label}:{key}"
        _rate_store[ckey] = [t for t in _rate_store[ckey] if now - t < window]
        if len(_rate_store[ckey]) >= cap:
            _seclog.record(request, "rate_limited", f"critical:{label}")
            return JSONResponse(
                {"detail": "Too many requests", "scope": label}, status_code=429
            )
        _rate_store[ckey].append(now)
    _rate_store[key] = [t for t in _rate_store[key] if now - t < 60]
    if len(_rate_store[key]) >= limit:
        return JSONResponse({"detail": "Too many requests"}, status_code=429)
    _rate_store[key].append(now)
    # 古いキーの掃除 (長期稼働でメモリ溜まらないように、たまに)
    if len(_rate_store) > 256:
        for k in [k for k, v in _rate_store.items() if not v or now - v[-1] > 300]:
            _rate_store.pop(k, None)
    return await call_next(request)


# ===== ダブルスラッシュ修正 =====
@app.middleware("http")
async def normalize_path(request: Request, call_next):
    if "//" in request.url.path:
        clean = re.sub(r"/+", "/", request.url.path)
        url = request.url.replace(path=clean)
        return RedirectResponse(url=str(url), status_code=307)
    return await call_next(request)


_allowed_origins = [o.strip() for o in os.getenv("CORS_ORIGINS", os.getenv("PUBLIC_URL", "")).split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(projects.router, prefix="/projects", tags=["projects"], dependencies=[Depends(verify_token)])
app.include_router(command.router,  prefix="/command",  tags=["command"],  dependencies=[Depends(verify_token)])
app.include_router(context.router,  prefix="/context",  tags=["context"],  dependencies=[Depends(verify_token)])
app.include_router(jobs_api.router, prefix="/jobs",     tags=["jobs"],     dependencies=[Depends(verify_token)])
app.include_router(processes_api.router, prefix="/processes", tags=["processes"], dependencies=[Depends(verify_token)])
app.include_router(uploads.router,  prefix="/uploads",  tags=["uploads"],  dependencies=[Depends(verify_token)])
app.include_router(push_api.router, prefix="/push",     tags=["push"],     dependencies=[Depends(verify_token)])
# auth は認証不要（middleware で素通し）— 内部で別チェック
app.include_router(auth_api.router, prefix="/auth",     tags=["auth"])


_paused = False


@app.get("/health", tags=["system"])
async def health():
    return {"status": "ok", "pc": os.getenv("PC_NAME", "unknown"), "version": "2.0.0", "paused": _paused}


@app.post("/pause", tags=["system"], dependencies=[Depends(verify_token)])
async def pause_agent():
    global _paused
    _paused = True
    return {"status": "paused"}


@app.post("/resume", tags=["system"], dependencies=[Depends(verify_token)])
async def resume_agent():
    global _paused
    _paused = False
    return {"status": "active"}


@app.middleware("http")
async def check_paused(request: Request, call_next):
    if _paused and request.url.path.startswith("/command"):
        return JSONResponse({"detail": "休止中です。スマホから「再開」を押してください。"}, status_code=503)
    return await call_next(request)


@app.post("/shutdown", tags=["system"], dependencies=[Depends(verify_token)])
async def shutdown():
    import threading
    threading.Thread(target=lambda: (__import__("time").sleep(1), __import__("os")._exit(0))).start()
    return {"status": "shutting down"}


@app.post("/restart", tags=["system"], dependencies=[Depends(verify_token)])
async def restart_agent():
    import threading
    import subprocess
    def do_restart():
        import time
        time.sleep(1)
        script = str(Path(__file__).resolve().parent.parent / "start-all.ps1")
        subprocess.Popen(
            ["powershell.exe", "-ExecutionPolicy", "Bypass", "-File", script],
            creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP,
        )
    threading.Thread(target=do_restart).start()
    return {"status": "restarting"}


ui_path = Path(__file__).parent.parent / "ui"
if ui_path.exists():
    app.mount("/ui", StaticFiles(directory=str(ui_path), html=True), name="ui")


# Cloudflare CDN が /ui/sw.js や /ui/app.js を勝手にキャッシュしないようにする。
# PWA の SW 更新がエッジで止まると、ユーザは古い UI を握り続ける。
_NO_CACHE_SUFFIXES = (".js", ".html", "/sw.js", "manifest.json")


@app.middleware("http")
async def ui_no_cache(request: Request, call_next):
    response = await call_next(request)
    p = request.url.path
    if p.startswith("/ui/") and (p.endswith(_NO_CACHE_SUFFIXES) or p == "/ui/"):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response


if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host="127.0.0.1",
        port=int(os.getenv("PORT", 8766)),
        reload=False,
        log_level="info",
    )
