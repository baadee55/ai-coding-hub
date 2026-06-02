from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
import json
from pathlib import Path
from typing import Optional
import uuid

router = APIRouter()

CONFIG_PATH = Path(__file__).parent.parent / "config.json"


def load_config() -> dict:
    if not CONFIG_PATH.exists():
        return {"projects": []}
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


def save_config(config: dict):
    CONFIG_PATH.write_text(json.dumps(config, indent=2, ensure_ascii=False), encoding="utf-8")


def _registered_roots() -> list[Path]:
    out: list[Path] = []
    for p in load_config().get("projects") or []:
        try:
            out.append(Path(p["path"]).resolve())
        except Exception:
            continue
    return out


def is_allowed_path(raw: Optional[str]) -> bool:
    """与えられたパスが登録済みプロジェクトのいずれかと同一または配下なら True。

    None / 空文字は許容 (project_path を渡さない呼び出しは従来通り)。
    .. やシンボリックリンク経由の脱出は Path.resolve() で防ぐ。
    """
    if not raw:
        return True
    try:
        target = Path(raw).resolve()
    except Exception:
        return False
    for root in _registered_roots():
        try:
            target.relative_to(root)
            return True
        except ValueError:
            continue
    return False


def ensure_allowed_path(raw: Optional[str]) -> None:
    """許可外なら 403。command/jobs/context/processes から呼ぶ。"""
    if not is_allowed_path(raw):
        raise HTTPException(
            status_code=403,
            detail=f"許可外のパスです: {raw} (登録済みプロジェクト配下のみ実行可)",
        )


class ProjectCreate(BaseModel):
    name: str
    path: str
    description: str = ""


@router.get("/")
async def list_projects():
    return load_config()["projects"]


@router.post("/")
async def add_project(project: ProjectCreate):
    config = load_config()
    new_project = {"id": str(uuid.uuid4())[:8], **project.model_dump()}
    config["projects"].append(new_project)
    save_config(config)
    return new_project


@router.delete("/{project_id}")
async def delete_project(project_id: str):
    config = load_config()
    before = len(config["projects"])
    config["projects"] = [p for p in config["projects"] if p["id"] != project_id]
    if len(config["projects"]) == before:
        raise HTTPException(status_code=404, detail="Project not found")
    save_config(config)
    return {"deleted": project_id}
