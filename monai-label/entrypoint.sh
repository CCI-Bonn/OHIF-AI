#!/bin/bash
set -e

# Download the radiology app on first run (avoids baking it into the image layer)
if [ ! -d "/code/apps/radiology" ]; then
    echo "[entrypoint] Downloading MONAI Label radiology app..."
    python -m monailabel.main apps --download --name radiology --output /code/apps
fi

exec "$@"
