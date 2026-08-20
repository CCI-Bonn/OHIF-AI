#!/usr/bin/env bash
# Measures the three rebuild scenarios that matter, and records a fingerprint of the
# built bundle so we can prove the output did not change.
# Usage: bash tools/perf/build-bench.sh <label>
set -uo pipefail
cd "$(dirname "$0")/../.."          # repo root
LABEL="${1:?usage: build-bench.sh <label>}"
OUT=tools/perf/runs/build-bench.tsv
mkdir -p "$(dirname "$OUT")"
[ -s "$OUT" ] || printf 'label\tscenario\tseconds\tbundle_sha\n' > "$OUT"

SRC=Viewers/extensions/default/src/utils/perfTrace.ts

# Fingerprint = sorted list of served asset FILENAMES (JS is chunkhashed by webpack, so a
# content change moves the name). If the source tree is unchanged, this MUST be identical
# across builds. Caveat: CSS is emitted as the unhashed [name].bundle.css, so a CSS-only
# output change does not move this hash — see tools/perf/README.md.
#
# Failing loudly matters here: if `docker run` errors and we swallow it, sha256sum hashes
# empty input and returns the constant e3b0c44298fc1c14 on every row, which reads exactly
# like "the output never changed" — the opposite of the truth.
bundle_sha() {
  local listing
  if ! listing=$(docker run --rm --entrypoint sh webapp:latest -c 'ls /var/www/html'); then
    echo "bundle_sha: 'docker run webapp:latest' failed — cannot fingerprint the bundle" >&2
    exit 1
  fi
  if [ -z "$listing" ]; then
    echo "bundle_sha: /var/www/html is empty in webapp:latest" >&2
    exit 1
  fi
  printf '%s\n' "$listing" | sort | sha256sum | cut -c1-16
}

run() {                              # run <scenario>
  local scenario="$1" start end secs sha
  start=$(date +%s)
  docker compose build ohif_viewer > /tmp/bench-build.log 2>&1
  local rc=$?
  end=$(date +%s); secs=$((end-start))
  if [ $rc -ne 0 ]; then
    echo "BUILD FAILED — see /tmp/bench-build.log"; tail -5 /tmp/bench-build.log; exit 1
  fi
  # bundle_sha's `exit 1` would only kill the command-substitution subshell, so check
  # the status here in the parent shell and abort rather than record a bogus row.
  sha=$(bundle_sha) || { echo "ABORT: could not fingerprint the bundle"; exit 1; }
  printf '%s\t%s\t%s\t%s\n' "$LABEL" "$scenario" "$secs" "$sha" >> "$OUT"
  echo "  $scenario: ${secs}s"
}

echo "[$LABEL] warming (ensures a cached starting point)..."
docker compose build ohif_viewer > /dev/null 2>&1

echo "[$LABEL] scenario 1/3: no-op rebuild"
run noop

echo "[$LABEL] scenario 2/3: rebuild after a Playwright artifact changes"
mkdir -p Viewers/test-results
date +%s%N > Viewers/test-results/.last-run.json
run after_playwright

echo "[$LABEL] scenario 3/3: rebuild after a real source edit"
printf '\n// bench %s\n' "$(date +%s)" >> "$SRC"
run after_source_edit
git checkout -- "$SRC" 2>/dev/null || true

echo
column -t -s $'\t' "$OUT"
