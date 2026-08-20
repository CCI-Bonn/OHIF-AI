"""Opt-in perf/leak counters appended to the existing [timing] log line.

Everything here is gated on MONAI_PERF_TRACE=1. When unset, no counter is
evaluated -- torch.cuda.memory_allocated() forces a device sync and must not
run on the hot path by default.
"""

import logging
import os
import threading
import time

logger = logging.getLogger(__name__)

_MB = 1024 * 1024


def perf_enabled() -> bool:
    return os.environ.get("MONAI_PERF_TRACE", "0") == "1"


def leak_enabled() -> bool:
    return os.environ.get("MONAI_PERF_LEAK", "0") == "1"


def _rss_mb() -> float:
    # /proc/self/statm field 2 is resident pages; avoids a psutil dependency.
    with open("/proc/self/statm", "r") as f:
        return int(f.read().split()[1]) * os.sysconf("SC_PAGE_SIZE") / _MB


def _safe(fn, fallback=-1):
    try:
        return fn()
    except Exception:
        return fallback


def counters(session=None) -> dict:
    """Counter snapshot. Every field degrades to -1 rather than raising."""
    if not perf_enabled():
        return {}

    def _vram(kind):
        import torch

        if not torch.cuda.is_available():
            return -1
        fn = torch.cuda.memory_allocated if kind == "alloc" else torch.cuda.memory_reserved
        return fn() / _MB

    def _sessions():
        from monailabel.tasks.infer.nninter_session_pool import get_pool

        return get_pool().size()

    return {
        "rss": _safe(_rss_mb),
        "vram_alloc": _safe(lambda: _vram("alloc")),
        "vram_reserved": _safe(lambda: _vram("reserved")),
        "sessions": _safe(_sessions),
        "threads": _safe(threading.active_count),
        # Per-session executor backlog -- the PR #69 preprocess-backlog signal.
        # CAVEAT: qsize() counts only QUEUED tasks; work already running on a worker has
        # been dequeued and is not counted. A saturated pool with an empty queue reports 0,
        # so this detects a growing BACKLOG, not worker saturation.
        "queue_depth": _safe(lambda: session.executor._work_queue.qsize()) if session is not None else -1,
    }


def counters_suffix(session=None) -> str:
    c = counters(session)
    if not c:
        return ""
    # wallT is the join key for the analyzer: epoch milliseconds, emitted first so
    # the field is always present for logs produced after this change ships.
    wall_ms = int(time.time() * 1000)
    parts = f"wallT={wall_ms} " + " ".join(
        f"{k}={v:.1f}MB" if k in ("rss", "vram_alloc", "vram_reserved") else f"{k}={v}"
        for k, v in c.items()
    )
    return f" | {parts}"
