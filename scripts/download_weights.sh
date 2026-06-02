#!/bin/bash
# One-shot script: download model weights into monai-label/checkpoints/
# Run once before `docker compose up`: bash scripts/download_weights.sh
set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHECKPOINTS_DIR="$REPO_ROOT/monai-label/checkpoints"
mkdir -p "$CHECKPOINTS_DIR"

SAM2_URL="https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_tiny.pt"
MEDSAM2_URL="https://huggingface.co/wanglab/MedSAM2/resolve/main/MedSAM2_latest.pt"

echo "Downloading SAM2.1 weights to $CHECKPOINTS_DIR ..."
wget --no-clobber --directory-prefix "$CHECKPOINTS_DIR" "$SAM2_URL"

echo "Downloading MedSAM2 weights to $CHECKPOINTS_DIR ..."
wget --no-clobber --directory-prefix "$CHECKPOINTS_DIR" "$MEDSAM2_URL"

echo "Done. Weights are in $CHECKPOINTS_DIR"
