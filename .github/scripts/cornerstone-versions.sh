#!/usr/bin/env bash
# Print every @cornerstonejs/* package RESOLVED in Viewers/yarn.lock, as "name@range => version".
#
# Used by .github/workflows/weekly-security-fix.yml to prove a security fix did not move
# cornerstone. The resolved version is what actually gets installed, and therefore what the
# ~21 hand-patched ESM overrides in Viewers/backup/esm/ are written against -- a package.json
# range like ^5.0.13 can silently resolve to a different 5.x, so comparing ranges alone would
# miss a move that breaks rendering at runtime.
#
# yarn v1 lockfile shape:
#     "@cornerstonejs/core@^5.0.13":
#       version "5.0.13"
#       resolved "https://..."
#
# A key line is unindented and may list several comma-separated specs; the fields under it are
# indented. Output is sorted so it can be diffed directly.
set -euo pipefail

# Accept an explicit path. Falling back, try both the repo root and Viewers/ -- the workflow
# invokes this with `working-directory: Viewers`, so a default of "Viewers/yarn.lock" would
# resolve to Viewers/Viewers/yarn.lock and fail.
LOCKFILE="${1:-}"

if [ -z "$LOCKFILE" ]; then
  for candidate in yarn.lock Viewers/yarn.lock ../Viewers/yarn.lock; do
    if [ -f "$candidate" ]; then
      LOCKFILE="$candidate"
      break
    fi
  done
fi

if [ -z "$LOCKFILE" ] || [ ! -f "$LOCKFILE" ]; then
  echo "cornerstone-versions.sh: no yarn.lock found (looked for '${1:-yarn.lock, Viewers/yarn.lock, ../Viewers/yarn.lock}' from $(pwd))" >&2
  exit 1
fi

awk '
  # Unindented, non-comment, non-blank line = the start of a new entry.
  /^[^[:space:]#]/ {
    key = $0
    sub(/:[[:space:]]*$/, "", key)
    gsub(/"/, "", key)
    interesting = (key ~ /@cornerstonejs\//)
    next
  }
  # First version field inside an entry we care about.
  interesting && /^[[:space:]]+version[[:space:]]/ {
    v = $2
    gsub(/"/, "", v)
    print key " => " v
    interesting = 0
  }
' "$LOCKFILE" | sort -u
