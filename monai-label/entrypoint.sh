#!/bin/bash
set -e

# The radiology app is vendored in the repo (monai-label/sample-apps/radiology) and
# baked into the image at /code/sample-apps/radiology, so there is no runtime download.
# The server CMD points --app at that bundled copy.

exec "$@"
