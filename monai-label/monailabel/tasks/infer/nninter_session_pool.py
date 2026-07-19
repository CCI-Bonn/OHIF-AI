"""In-process session pool for nnInteractive multi-user support.

Replicates the coordination pattern of nnInteractive's own server
(nnInteractive/inference/server/app.py) without its FastAPI layer:
one copy of the model weights shared by reference across N real
nnInteractiveInferenceSession instances, a per-session lock, a global
GPU lock, lease tokens, LRU eviction, and idle reaping.

Lock order is ALWAYS entry.lock -> gpu_lock, never reversed.
Stdlib-only on purpose: unit-testable without torch or a GPU.
"""

import logging
import os
import threading
import time
import uuid
from typing import Callable, Dict, Optional

logger = logging.getLogger(__name__)

_USED_INTERACTION_KEYS = (
    "pos_points",
    "neg_points",
    "pos_boxes",
    "neg_boxes",
    "pos_lassos",
    "neg_lassos",
    "pos_scribbles",
    "neg_scribbles",
)


class SessionEntry:
    """Per-client nnInteractive state: one real inference session plus the
    image cache and used-interaction sets that used to be process-global."""

    def __init__(self, token: str, session):
        self.token = token
        self.session = session
        self.lock = threading.Lock()
        self.last_active = time.time()
        self.image_cache = {
            "dicom_dir": None,
            "seriesInstanceUID": None,
            "img_np": None,
            "instanceNumber": None,
            "instanceNumber2": None,
        }
        self.used_interactions = {k: set() for k in _USED_INTERACTION_KEYS}

    def touch(self):
        self.last_active = time.time()


class SessionPool:
    def __init__(
        self,
        factory: Callable[[], object],
        max_sessions: Optional[int] = None,
        idle_timeout: Optional[float] = None,
        reap_interval: float = 60.0,
        start_reaper: bool = True,
    ):
        self._factory = factory
        self.max_sessions = int(
            max_sessions if max_sessions is not None else os.environ.get("NNINTER_MAX_SESSIONS", 3)
        )
        self.idle_timeout = float(
            idle_timeout if idle_timeout is not None else os.environ.get("NNINTER_SESSION_IDLE_TIMEOUT", 600)
        )
        self.gpu_lock = threading.Lock()
        self._entries: Dict[str, SessionEntry] = {}
        self._dict_lock = threading.Lock()
        self._reap_interval = reap_interval
        if start_reaper:
            threading.Thread(
                target=self._reaper_loop, name="nninter-session-reaper", daemon=True
            ).start()

    def claim(self) -> SessionEntry:
        token = uuid.uuid4().hex
        with self._dict_lock:
            while len(self._entries) >= self.max_sessions:
                lru = min(self._entries.values(), key=lambda e: e.last_active)
                self._drop_locked(lru.token, reason="lru-evicted")
            entry = SessionEntry(token, self._factory())
            self._entries[token] = entry
        logger.info(f"nninter session claimed: {token[:8]} (pool {self.size()}/{self.max_sessions})")
        return entry

    def get(self, token: Optional[str]) -> Optional[SessionEntry]:
        if not token:
            return None
        with self._dict_lock:
            entry = self._entries.get(token)
        if entry is not None:
            entry.touch()
        return entry

    def release(self, token: Optional[str]):
        with self._dict_lock:
            self._drop_locked(token, reason="released")

    def size(self) -> int:
        with self._dict_lock:
            return len(self._entries)

    def sweep(self):
        now = time.time()
        with self._dict_lock:
            idle = [t for t, e in self._entries.items() if now - e.last_active > self.idle_timeout]
            for t in idle:
                self._drop_locked(t, reason="idle-reaped")

    def _drop_locked(self, token: Optional[str], reason: str = ""):
        # Caller must hold self._dict_lock. An in-flight request holding a
        # reference to the dropped entry finishes harmlessly on the detached
        # entry; its tensors are freed when the last reference drops.
        entry = self._entries.pop(token, None) if token else None
        if entry is None:
            return
        try:
            entry.session.executor.shutdown(wait=False, cancel_futures=True)
        except Exception:
            pass
        logger.info(f"nninter session dropped ({reason}): {entry.token[:8]}")

    def _reaper_loop(self):
        while True:
            time.sleep(self._reap_interval)
            try:
                self.sweep()
            except Exception:
                logger.exception("nninter session reaper sweep failed")


# Process-wide singleton, published by basic_infer at startup.
POOL: Optional[SessionPool] = None


def set_pool(pool: SessionPool):
    global POOL
    POOL = pool


def get_pool() -> SessionPool:
    if POOL is None:
        raise RuntimeError("nnInteractive session pool is not initialised")
    return POOL
