#!/bin/bash
set -e

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
HASH_DIR="$REPO_ROOT/.build-hashes"
mkdir -p "$HASH_DIR"

# ── Optional-model boot loading ───────────────────────────────────────────────
# nnInteractive (the primary model) always loads at boot. These optional models
# can either load at boot ("eager", first use instant) or on first use ("lazy",
# faster boot, no GPU until requested). By default start.sh ASKS about each one;
# flags below skip the prompts (conventions borrowed from apt-get -y):
#   -y, --yes    load ALL optional models at boot (eager), no prompts
#   -n, --no     load NO optional models at boot (all lazy), no prompts
#   -h, --help   show this help and exit
# An already-set LOAD_<MODEL> env var is always honored and never prompted, so
# `LOAD_SAM2=eager bash start.sh -n` still loads SAM2. Non-interactive shells
# (no TTY, e.g. CI) default to lazy instead of hanging on a prompt.
OPTIONAL_MODELS=(SAM2 SAM3 MEDSAM2 VOXTELL)
ASSUME=""  # "", "yes", or "no"

while [ $# -gt 0 ]; do
    case "$1" in
        -y|--yes) ASSUME="yes" ;;
        -n|--no)  ASSUME="no" ;;
        -h|--help)
            echo "Usage: bash start.sh [-y|--yes | -n|--no]"
            echo "  (no flag)   prompt whether to load each optional model at boot"
            echo "  -y, --yes   load ALL optional models at boot (eager)"
            echo "  -n, --no    load NO optional models at boot (all lazy)"
            echo "Optional models: ${OPTIONAL_MODELS[*]} (nnInteractive always loads)."
            exit 0 ;;
        *) echo "[start.sh] Unknown option: $1 (try --help)" >&2; exit 1 ;;
    esac
    shift
done

_resolve_model_load() {
    local name="$1"
    local var="LOAD_${name}"
    # 1. Explicit env override wins — never prompt.
    if [ -n "${!var}" ]; then
        echo "[start.sh] ${name}: ${!var} (from environment)"
    # 2. Non-interactive assume flags.
    elif [ "$ASSUME" = "yes" ]; then
        export "$var=eager"; echo "[start.sh] ${name}: eager (-y)"
    elif [ "$ASSUME" = "no" ]; then
        export "$var=lazy";  echo "[start.sh] ${name}: lazy (-n)"
    # 3. No TTY (piped / CI) — default lazy rather than hang.
    elif [ ! -t 0 ]; then
        export "$var=lazy";  echo "[start.sh] ${name}: lazy (no TTY, default)"
    # 4. Interactive prompt, default No (lazy) on bare Enter.
    else
        local ans
        read -r -p "[start.sh] Load ${name} at startup? [y/N] " ans
        case "$ans" in
            [Yy]*) export "$var=eager"; echo "[start.sh]   -> ${name}: eager" ;;
            *)     export "$var=lazy";  echo "[start.sh]   -> ${name}: lazy" ;;
        esac
    fi
}

for _m in "${OPTIONAL_MODELS[@]}"; do
    _resolve_model_load "$_m"
done

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
    # ls-tree lists every committed file with its blob SHA1 (content-addressed).
    # Unlike `git log -1 -- $paths`, this changes whenever any file's content changes,
    # and it differs across branches even after a fast-forward merge because the
    # tree objects are distinct once any file diverges.
    # We combine it with the diff of any uncommitted changes.
    {
        git -C "$REPO_ROOT" ls-tree -r HEAD -- $paths 2>/dev/null
        git -C "$REPO_ROOT" diff HEAD -- $paths 2>/dev/null
    } | md5sum | cut -d' ' -f1
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
