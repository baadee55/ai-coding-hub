"""プロセス寿命にまつわる後始末・自己防衛。

ここの目的は「黙って止まって、記録も残らない」事故を構造的に潰すこと。

1. reconcile_orphan_jobs():
   agent が前回クラッシュ／スリープ落ち／強制 kill されると、走っていた
   ジョブは done/error を書く前に消える。logs/jobs/*.jsonl は「未完了」のまま
   残り、スマホからは「いつまでも終わらない／記録が無い」に見える。
   起動時にこれを走査し、終端イベントの無いログへ "interrupted" を追記して
   締める。これで最低でも「落ちました」が必ず残る。

2. keep_awake():
   agent 稼働中は Windows をスリープさせない（SetThreadExecutionState）。
   スマホで指示→画面を離れて放置→PC がスリープ→ジョブが途中で止まる、を防ぐ。
"""
from __future__ import annotations

import ctypes
import json
import time
from pathlib import Path

LOG_DIR = Path(__file__).parent.parent / "logs" / "jobs"

_TERMINAL = {"done", "error", "canceled", "interrupted"}

# 直近に書き込まれたログは「今まさに走っているジョブ」かもしれない。
# 起動時の reconcile が現役ジョブを誤って締めないよう、この秒数より新しい
# ログには触らない。起動直後の reconcile は前回プロセスの遺物だけが対象なので
# 数十秒の猶予で十分安全。
_FRESH_SECS = 90


def reconcile_orphan_jobs() -> int:
    """終端イベントの無い（かつ古い）ジョブログを 'interrupted' で締める。締めた件数を返す。"""
    if not LOG_DIR.exists():
        return 0
    now = time.time()
    fixed = 0
    for path in LOG_DIR.glob("*.jsonl"):
        try:
            # 現役で書き込み中かもしれないログには触らない
            if now - path.stat().st_mtime < _FRESH_SECS:
                continue
            last_type = None
            last_seq = -1
            with path.open("r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        ev = json.loads(line)
                    except Exception:
                        continue
                    last_type = ev.get("type")
                    if isinstance(ev.get("_seq"), int):
                        last_seq = ev["_seq"]
            # 空ログ or 既に終端していれば触らない
            if last_type is None or last_type in _TERMINAL:
                continue
            ev = {
                "type": "interrupted",
                "text": "前回 agent が停止したため、このジョブは中断扱いにしました（スリープ/クラッシュ/再起動）。",
                "_seq": last_seq + 1,
                "_t": time.time(),
            }
            with path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(ev, ensure_ascii=False) + "\n")
            fixed += 1
        except Exception:
            # 1 件の不整合で起動を止めない
            continue
    return fixed


# ===== スリープ抑止 =====
# https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-setthreadexecutionstate
_ES_CONTINUOUS = 0x80000000
_ES_SYSTEM_REQUIRED = 0x00000001
# 画面は消えてよい（AWAYMODE/DISPLAY は要求しない）。システムが寝なければ十分。


def keep_awake() -> bool:
    """OS にスリープしないよう要求する。成功なら True。Windows 以外では何もしない。"""
    try:
        ctypes.windll.kernel32.SetThreadExecutionState(
            _ES_CONTINUOUS | _ES_SYSTEM_REQUIRED
        )
        return True
    except Exception:
        return False


def allow_sleep() -> None:
    """スリープ抑止を解除する（通常はプロセス終了で勝手に戻る）。"""
    try:
        ctypes.windll.kernel32.SetThreadExecutionState(_ES_CONTINUOUS)
    except Exception:
        pass
