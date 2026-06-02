from fastapi import FastAPI, Request, Header, HTTPException, Depends
from fastapi.responses import JSONResponse, Response, StreamingResponse
import httpx
import subprocess
import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")

API_TOKEN = os.getenv("AGENT_TOKEN", "")
if not API_TOKEN or API_TOKEN in ("change-me-now", "changeme", "default", "test"):
    raise SystemExit(
        "AGENT_TOKEN が未設定 or デフォルト値です。agent/.env にランダム値を設定してください。"
    )
AGENT_URL = "http://127.0.0.1:8766"
START_SCRIPT = str(Path(__file__).parent.parent / "start-all.ps1")

app = FastAPI(title="AI Hub Watchdog", docs_url=None, redoc_url=None)


def verify_token(authorization: str = Header(None)):
    if not authorization or authorization != f"Bearer {API_TOKEN}":
        raise HTTPException(status_code=401, detail="Unauthorized")


import time as _time
_health_cache: dict = {"data": None, "exp": 0.0}


async def _agent_health(*, max_age: float = 3.0) -> dict | None:
    """agent の /health を 3 秒キャッシュして連射の遅延を防ぐ。"""
    now = _time.time()
    if _health_cache["data"] is not None and _health_cache["exp"] > now:
        return _health_cache["data"]
    try:
        async with httpx.AsyncClient(timeout=2.0) as c:
            r = await c.get(f"{AGENT_URL}/health")
            if r.status_code == 200:
                data = r.json()
                _health_cache["data"] = data
                _health_cache["exp"] = now + max_age
                return data
    except Exception:
        pass
    _health_cache["data"] = None
    _health_cache["exp"] = now + 1.0  # ダウン時は短めに再試行
    return None


def _launch():
    subprocess.Popen(
        ["powershell.exe", "-ExecutionPolicy", "Bypass", "-File", START_SCRIPT],
        creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP,
    )


# ===== Watchdog 専用エンドポイント =====
# /health は agent 側に丸投げする（proxy 経由で）。watchdog 側で agent 健康
# 状態を確認するための httpx 呼び出しが Windows で重く、PWA の health check
# がエッジ（cloudflared）でタイムアウトしてしまうため。
# agent が落ちている場合は proxy() の ConnectError ハンドラが 503 を返す。


@app.post("/start", dependencies=[Depends(verify_token)])
async def start():
    _launch()
    return {"status": "starting"}


@app.post("/restart", dependencies=[Depends(verify_token)])
async def restart():
    _launch()
    return {"status": "restarting"}


# ===== 全リクエストをメインエージェントへ転送 =====
# 共有 httpx クライアント（接続プール再利用で CLOSE_WAIT 蓄積を防ぐ）
_proxy_client: httpx.AsyncClient | None = None


@app.on_event("startup")
async def _startup():
    global _proxy_client
    _proxy_client = httpx.AsyncClient(timeout=90.0, limits=httpx.Limits(max_keepalive_connections=20, max_connections=40))


@app.on_event("shutdown")
async def _shutdown():
    global _proxy_client
    if _proxy_client is not None:
        await _proxy_client.aclose()


@app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
async def proxy(path: str, request: Request):
    url = f"{AGENT_URL}/{path}"
    body = await request.body()
    # 公開口（watchdog）経由のリクエストには X-Via-Watchdog マーカを付ける。
    # agent 側はこのヘッダがあるリクエストを「真のローカル」とみなさない。
    #
    # ただし「PC ローカルブラウザ→watchdog」も watchdog 経由ではあるが、
    # 端末追加(/auth/register/token)などのローカル特権が必要なため区別する。
    # 区別方法: cloudflared が中継したリクエストには cf-connecting-ip が付く
    # (CF エッジで設定され攻撃者が偽装不可)。watchdog は 127.0.0.1 でしか
    # listen していないので、cf-connecting-ip が無い = ローカル直接接続。
    is_via_cf = "cf-connecting-ip" in {k.lower() for k in request.headers.keys()}
    # 攻撃者が偽装できないよう、入ってきた x-via-watchdog は剥がしてから付け直す
    headers = {
        k: v for k, v in request.headers.items()
        if k.lower() not in ("host", "content-length", "transfer-encoding", "x-via-watchdog")
    }
    if is_via_cf:
        headers["X-Via-Watchdog"] = "1"
    # ローカル直 (PC ブラウザから 127.0.0.1:8765) はヘッダを付けない →
    # agent は普通の 127.0.0.1 として扱う = ローカル特権あり
    params = dict(request.query_params)

    # SSE ストリーミングは別処理（バッファリングしない）
    if path.endswith("/stream"):
        async def sse_gen():
            async with httpx.AsyncClient(timeout=None) as c:
                async with c.stream(request.method, url, headers=headers, content=body, params=params) as r:
                    async for chunk in r.aiter_bytes():
                        yield chunk
        return StreamingResponse(
            sse_gen(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    try:
        assert _proxy_client is not None
        r = await _proxy_client.request(
            method=request.method,
            url=url,
            headers=headers,
            content=body,
            params=params,
            follow_redirects=True,
        )
        # agent が付けたレスポンスヘッダ（特に Cache-Control）を素通しする。
        # これを落とすと /ui/*.js の no-store が消え、Cloudflare エッジが古い app.js を
        # 長期キャッシュして「何バージョン上げてもスマホに新 UI が届かない」核心の不具合に
        # なる（agent は no-store を付けているのに watchdog が捨てていた）。
        # content-length / transfer-encoding / content-encoding は Response が本文から
        # 再計算するので転送しない（二重指定でボディ破損を防ぐ）。
        _hop = {"content-length", "transfer-encoding", "content-encoding", "connection"}
        passthru = {
            k: v for k, v in r.headers.items()
            if k.lower() not in _hop and k.lower() != "content-type"
        }
        return Response(
            content=r.content,
            status_code=r.status_code,
            media_type=r.headers.get("content-type"),
            headers=passthru,
        )
    except httpx.ConnectError:
        return JSONResponse(
            {"detail": "PCのエージェントが停止しています。設定の「エージェントを再起動」を押してください。", "agent": "down"},
            status_code=503,
        )
    except Exception as e:
        return JSONResponse({"detail": f"プロキシエラー: {e}"}, status_code=502)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("watchdog:app", host="127.0.0.1", port=8765, reload=False, log_level="info")
