#!/bin/bash
set -e

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
HASH_DIR="$REPO_ROOT/.build-hashes"
mkdir -p "$HASH_DIR"

# ── Model weights ─────────────────────────────────────────────────────────────
CHECKPOINTS_DIR="$REPO_ROOT/monai-label/checkpoints"
SAM2_WEIGHTS="$CHECKPOINTS_DIR/sam2.1_hiera_tiny.pt"
MEDSAM2_WEIGHTS="$CHECKPOINTS_DIR/MedSAM2_latest.pt"

if [ ! -f "$SAM2_WEIGHTS" ] || [ ! -f "$MEDSAM2_WEIGHTS" ]; then
    echo "[start.sh] Model weights missing, downloading..."
    bash "$REPO_ROOT/scripts/download_weights.sh"
else
    echo "[start.sh] Model weights present, skipping download."
fi

# ── Per-service change detection ──────────────────────────────────────────────
# Hash = last commit touching the service's paths + hash of any uncommitted diff.
# This is fast (git is O(log n)) and captures both committed and dirty changes.

_service_hash() {
    local paths="$@"
    local commit diff_hash
    commit=$(git -C "$REPO_ROOT" log -1 --format="%H" -- $paths 2>/dev/null || echo "nogit")
    diff_hash=$(git -C "$REPO_ROOT" diff HEAD -- $paths 2>/dev/null | md5sum | cut -d' ' -f1)
    echo "${commit}_${diff_hash}"
}

OHIF_HASH=$(_service_hash Viewers/)
MONAI_HASH=$(_service_hash monai-label/ sam2/ sam3/)

STORED_OHIF=$(cat "$HASH_DIR/ohif" 2>/dev/null || echo "")
STORED_MONAI=$(cat "$HASH_DIR/monai" 2>/dev/null || echo "")

BUILD_SERVICES=()
if [ "$OHIF_HASH" != "$STORED_OHIF" ]; then
    echo "[start.sh] OHIF viewer changed — will rebuild ohif_viewer."
    BUILD_SERVICES+=(ohif_viewer)
else
    echo "[start.sh] OHIF viewer unchanged — skipping ohif_viewer rebuild."
fi

if [ "$MONAI_HASH" != "$STORED_MONAI" ]; then
    echo "[start.sh] MONAI source changed — will rebuild monai_server."
    BUILD_SERVICES+=(monai_server)
else
    echo "[start.sh] MONAI source unchanged — skipping monai_server rebuild."
fi

# ── Build only what changed ───────────────────────────────────────────────────
if [ ${#BUILD_SERVICES[@]} -gt 0 ]; then
    echo "[start.sh] Building: ${BUILD_SERVICES[*]}"
    docker compose -f "$REPO_ROOT/docker-compose.yml" build "${BUILD_SERVICES[@]}"

    # Store hashes only after a successful build
    [ "$OHIF_HASH" != "$STORED_OHIF" ] && echo "$OHIF_HASH" > "$HASH_DIR/ohif"
    [ "$MONAI_HASH" != "$STORED_MONAI" ] && echo "$MONAI_HASH" > "$HASH_DIR/monai"
else
    echo "[start.sh] Nothing changed — starting existing images."
fi

docker compose -f "$REPO_ROOT/docker-compose.yml" up
