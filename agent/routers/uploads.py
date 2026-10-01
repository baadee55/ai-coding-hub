"""画像/ファイルのアップロードエンドポイント。

UI から添付されたファイルを一時保存し、Claude Code の指示プロンプトに
パスを埋め込んで使う。
"""
from __future__ import annotations

import base64
import re
import time
import uuid
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel


UPLOAD_DIR = Path(__file__).parent.parent.parent / "logs" / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


router = APIRouter()


class UploadRequest(BaseModel):
    filename: str
    content_base64: str  # data:image/png;base64,... または生 base64


def _cleanup_old(max_age_sec: int = 7 * 24 * 3600):
    """古いアップロードを掃除。"""
    now = time.time()
    for f in UPLOAD_DIR.iterdir():
        try:
            if now - f.stat().st_mtime > max_age_sec:
                f.unlink()
        except Exception:
            pass


@router.post("/")
async def upload(req: UploadRequest):
    raw = req.content_base64
    if "," in raw and raw.startswith("data:"):
        raw = raw.split(",", 1)[1]
    try:
        data = base64.b64decode(raw)
    except Exception:
        raise HTTPException(400, "invalid base64")
    if len(data) > 20 * 1024 * 1024:
        raise HTTPException(413, "ファイルが大きすぎます（20MB上限）")

    # 拡張子はファイル名から取るが、英数字のみに限定する。
    # （"." や "/" "\" ".." を含む細工された filename で UPLOAD_DIR の外に
    #  書き出される（パストラバーサル）のを防ぐ。保存名は uuid 固定で、
    #  ユーザ入力の filename はパス組み立てに一切使わない。）
    suffix = ""
    if "." in req.filename:
        ext = re.sub(r"[^A-Za-z0-9]", "", req.filename.rsplit(".", 1)[-1])[:8].lower()
        if ext:
            suffix = "." + ext
    name = f"{uuid.uuid4().hex[:10]}{suffix}"
    path = (UPLOAD_DIR / name).resolve()
    # 念のため UPLOAD_DIR 配下であることを保証（多層防御）
    if UPLOAD_DIR.resolve() not in path.parents:
        raise HTTPException(400, "invalid filename")
    path.write_bytes(data)
    _cleanup_old()
    return {
        "path": str(path),
        "filename": req.filename,
        "size": len(data),
    }
