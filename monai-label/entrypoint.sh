#!/bin/bash
set -e

# The radiology app is vendored in the repo (monai-label/sample-apps/radiology) and
# baked into the image at /code/sample-apps/radiology. The compose file also mounts
# ./monai-label/apps at /code/apps — seed it on first start if empty.
if [ ! -d /code/apps/radiology ] && [ -d /code/sample-apps/radiology ]; then
  mkdir -p /code/apps
  cp -a /code/sample-apps/radiology /code/apps/radiology
fi

exec "$@"
