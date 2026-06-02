"""プロジェクト状況・IDE リンク・要約。

要約系（/summary, /daily）は Claude Code の単発呼び出しで生成する。
Max プラン枠で動くので追加課金なし（`ANTHROPIC_API_KEY` を環境変数に入れないこと）。
"""
from __future__ import annotations

import os
import subprocess
from pathlib import Path

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from engines import claude_code as engine_cc
from routers.projects import ensure_allowed_path


router = APIRouter()


# 要約・整形タスク用のシステムプロンプト。
# Claude Code のデフォルト（コーディングアシスタント役）を上書きする。
SUMMARIZER_SYSTEM = (
    "あなたは日本語の要約・整形の専門家です。コーディングはしません。"
    "ツールも使いません。入力された情報を、ユーザーが指定したフォーマットに"
    "厳密に従って整形・要約して出力するだけが仕事です。"
    "前置きや「了解しました」などは絶対に書かず、本文だけを返してください。"
)


# ===== IDE トンネル情報 =====
@router.get("/ide-links")
async def ide_links():
    vscode_name = os.getenv("VSCODE_TUNNEL_NAME", "aihub-pc")
    cursor_name = os.getenv("CURSOR_TUNNEL_NAME", "aihub-cursor")
    pc_name = os.getenv("PC_NAME", "PC")
    return {
        "vscode":      f"https://vscode.dev/tunnel/{vscode_name}",
        "cursor":      f"https://cursor.com/tunnel/{cursor_name}",
        "vscode_name": vscode_name,
        "cursor_name": cursor_name,
        "pc_name":     pc_name,
    }


# ===== Git クイックアクション =====
class GitRequest(BaseModel):
    project_path: str
    message: str = ""


@router.post("/git-pull")
async def git_pull(req: GitRequest):
    ensure_allowed_path(req.project_path)
    if not Path(req.project_path).exists():
        return JSONResponse({"error": f"Path not found: {req.project_path}"}, status_code=404)
    return {"result": _run("git pull", cwd=req.project_path)}


@router.post("/git-commit")
async def git_commit(req: GitRequest):
    ensure_allowed_path(req.project_path)
    if not Path(req.project_path).exists():
        return JSONResponse({"error": f"Path not found: {req.project_path}"}, status_code=404)
    msg = req.message or "Update"
    add_out = _run_args(["git", "add", "-A"], cwd=req.project_path)
    commit_out = _run_args(["git", "commit", "-m", msg], cwd=req.project_path)
    return {"result": (add_out + "\n" + commit_out).strip()}


@router.post("/git-push")
async def git_push(req: GitRequest):
    ensure_allowed_path(req.project_path)
    if not Path(req.project_path).exists():
        return JSONResponse({"error": f"Path not found: {req.project_path}"}, status_code=404)
    return {"result": _run("git push", cwd=req.project_path)}


def _run(cmd: str, cwd: str | None = None) -> str:
    try:
        r = subprocess.run(
            cmd, shell=True, capture_output=True, text=True,
            cwd=cwd, timeout=10, encoding="utf-8", errors="replace",
        )
        return (r.stdout + r.stderr).strip()
    except Exception as e:
        return f"Error: {e}"


def _run_args(args: list[str], cwd: str | None = None) -> str:
    try:
        r = subprocess.run(
            args, shell=False, capture_output=True, text=True,
            cwd=cwd, timeout=10, encoding="utf-8", errors="replace",
        )
        return (r.stdout + r.stderr).strip()
    except Exception as e:
        return f"Error: {e}"


@router.get("/")
async def get_context(project_path: str = Query(...)):
    ensure_allowed_path(project_path)
    p = Path(project_path)
    if not p.exists():
        return {"error": f"パスが見つかりません: {project_path}"}
    return {
        "project_path":   project_path,
        "git_status":     _run("git status --short", cwd=project_path),
        "git_diff_stat":  _run("git diff HEAD --stat", cwd=project_path),
        "recent_commits": _run("git log --oneline -10", cwd=project_path),
        "branch":         _run("git branch --show-current", cwd=project_path),
    }


# ===== AI が人間向けに翻訳した状況サマリー =====
@router.get("/summary")
async def get_summary(project_path: str = Query(...)):
    ensure_allowed_path(project_path)
    ctx = await get_context(project_path)
    if "error" in ctx:
        return ctx

    prompt = f"""以下はソフトウェアプロジェクトの現在の状態です。
開発者ではない人にもわかるように、やさしい日本語で要約してください。

プロジェクト: {project_path}
ブランチ: {ctx['branch'] or '不明'}
変更中のファイル:
{ctx['git_status'] or 'なし'}
最近の作業履歴:
{ctx['recent_commits'] or 'なし'}

以下の形式で答えてください:
📌 今どこにいるか: [ブランチや作業の説明]
✏️ 変更中のもの: [変更ファイルを人間語で]
📅 最近やったこと: [コミット内容を3行以内で]
💡 ひとこと: [全体の状況を1文で]"""

    # 要約は Sonnet で生成（Max プラン枠で動く。日本語の整形精度を優先）
    summary = await engine_cc.run_oneshot(
        prompt, cwd=project_path, model="sonnet",
        system_prompt=SUMMARIZER_SYSTEM, timeout=45,
    )
    return {"summary": summary, "raw": ctx}


# ===== 今日の作業まとめ =====
@router.get("/daily")
async def get_daily(project_path: str = Query(...)):
    ensure_allowed_path(project_path)
    p = Path(project_path)
    if not p.exists():
        return {"error": f"パスが見つかりません: {project_path}"}

    today_log = _run('git log --oneline --since="00:00" --format="%h %s"', cwd=project_path)
    week_log  = _run('git log --oneline --since="7 days ago" --format="%h %s"', cwd=project_path)
    diff_stat = _run("git diff HEAD --stat", cwd=project_path)

    if not today_log and not week_log:
        return {"report": "今日はまだコミットがありません。"}

    prompt = f"""以下はプロジェクト「{project_path}」の作業記録です。
開発者でない人にも伝わる、わかりやすい日本語のレポートを作成してください。

今日の作業:
{today_log or 'なし'}

今週の作業:
{week_log or 'なし'}

変更の概要:
{diff_stat or 'なし'}

以下の形式でレポートを書いてください:
# 今日の作業レポート

## 今日やったこと
[箇条書きで]

## 今週の進捗
[まとめ]

## 現在の状況
[全体感を1〜2文で]"""

    # 日報生成も Sonnet（Max プラン枠で動く）
    report = await engine_cc.run_oneshot(
        prompt, cwd=project_path, model="sonnet",
        system_prompt=SUMMARIZER_SYSTEM, timeout=60,
    )
    return {"report": report}


@router.get("/diff")
async def get_diff(project_path: str = Query(...)):
    ensure_allowed_path(project_path)
    diff = _run("git diff HEAD", cwd=project_path)
    return {"diff": diff[:8000] if diff else "(変更なし)"}
