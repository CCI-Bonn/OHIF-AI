"""In-memory per-series download/preprocess progress for the nnInteractive init path.

Single-process by design: monailabel runs one uvicorn worker (the in-memory
session pool already relies on this), so the infer path and the progress
endpoint share this module's state. Entries are advisory/display-only — a
registry problem must never fail a download or an infer.
"""

import threading
import time
from typing import Optional

STALE_AFTER_S = 600  # a crashed request must not look "downloading" forever

_lock = threading.Lock()
_entries: dict = {}


def set_download_progress(series_uid: str, fetched: int, total: int) -> None:
    with _lock:
        _entries[series_uid] = {
            "phase": "downloading",
            "fetched": fetched,
            "total": total,
            "updated": time.time(),
        }


def set_phase(series_uid: str, phase: str) -> None:
    with _lock:
        entry = _entries.get(series_uid, {"fetched": 0, "total": 0})
        entry["phase"] = phase
        entry["updated"] = time.time()
        _entries[series_uid] = entry


def get(series_uid: str) -> Optional[dict]:
    with _lock:
        entry = _entries.get(series_uid)
        if entry is None or time.time() - entry["updated"] > STALE_AFTER_S:
            return None
        return {"phase": entry["phase"], "fetched": entry["fetched"], "total": entry["total"]}


def clear(series_uid: str) -> None:
    with _lock:
        _entries.pop(series_uid, None)
