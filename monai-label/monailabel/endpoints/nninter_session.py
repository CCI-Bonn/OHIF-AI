"""Claim/release endpoints for the in-process nnInteractive session pool.

Plain `def` (not `async def`) so FastAPI runs them in its threadpool:
claim() constructs a GPU-backed session and must not block the event loop.
Release is POST (not DELETE) because navigator.sendBeacon can only POST.
"""

import logging

from fastapi import APIRouter

from monailabel.tasks.infer import nninter_session_pool
from monailabel.utils.others import progress_registry

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/nninter/session",
    tags=["Infer"],
    responses={404: {"description": "Not found"}},
)


@router.post("/", summary="Claim an nnInteractive session (evicts the LRU session when full)")
def claim_session():
    pool = nninter_session_pool.get_pool()
    entry = pool.claim()
    return {"token": entry.token, "idle_timeout": pool.idle_timeout}


@router.post("/{token}/release", summary="Release an nnInteractive session (idempotent)")
def release_session(token: str):
    nninter_session_pool.get_pool().release(token)
    return {"released": True}


@router.get("/progress", summary="Read-only download/preprocess progress for a series (display only)")
def get_progress(image: str):
    entry = progress_registry.get(image)
    return entry if entry is not None else {"phase": "unknown"}
