#!/usr/bin/env bash
# Host-side perf sampler. Runs OUTSIDE the containers so it keeps recording even
# if the browser or the MONAI server dies mid-soak.
# Usage: tools/perf/sample_host.sh [output.jsonl] [interval_seconds]
#
# Produces JSONL with records:
#   heartbeat  — one per tick, always; lets the analyzer detect sampler death
#   container  — memMB, memLimitMB, cpuPct per container per tick
#   gpu        — gpuMB, gpuUtil per GPU per tick
#   disk       — diskMB for each watched directory per tick
#
# Missing containers, GPUs, or paths yield either no record (container down) or
# explicit -1 values — never a fake 0 that looks healthy.
set -uo pipefail

OUT="${1:-tools/perf/runs/host-$(date +%Y%m%d-%H%M%S).jsonl}"
INTERVAL="${2:-2}"
CONTAINERS="ohif_viewer ohif_orthanc monai_server"

# Derive repo root from script location so paths work from any working directory
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ORTHANC_DB="$REPO_ROOT/Viewers/platform/app/.recipes/Nginx-Orthanc/volumes/orthanc-db"
IMG_CACHE="$REPO_ROOT/monai-label/img_cache"

mkdir -p "$(dirname "$OUT")"
echo "sampling to $OUT every ${INTERVAL}s; Ctrl-C to stop" >&2

# Warn at startup if any watched path does not exist
for p in "$ORTHANC_DB" "$IMG_CACHE"; do
  if [ ! -d "$p" ]; then
    echo "WARNING: watched path does not exist: $p" >&2
  fi
done

# ---------------------------------------------------------------------------
# to_mb: convert docker memory strings (e.g. "1.5GiB", "900MiB", "12.3MB")
# to a numeric MB value.  Returns -1 on any unparseable input — never 0,
# never empty, so a broken reading can be distinguished from a healthy zero.
# Must be defined before first use (called inline in the main loop below).
# ---------------------------------------------------------------------------
to_mb() {
  echo "$1" | awk '
    /TiB/ {gsub(/TiB/,""); printf "%.1f", $1*1024*1024; exit}
    /GiB/ {gsub(/GiB/,""); printf "%.1f", $1*1024;      exit}
    /MiB/ {gsub(/MiB/,""); printf "%.1f", $1;           exit}
    /KiB/ {gsub(/KiB/,""); printf "%.3f", $1/1024;      exit}
    /TB/  {gsub(/TB/,"");  printf "%.1f", $1*1000*1000; exit}
    /GB/  {gsub(/GB/,"");  printf "%.1f", $1*1000;      exit}
    /MB/  {gsub(/MB/,"");  printf "%.1f", $1;           exit}
    /kB/  {gsub(/kB/,"");  printf "%.3f", $1/1000;      exit}
    {printf "-1"}'
}
export -f to_mb

# ---------------------------------------------------------------------------
# to_num: emit a numeric string unchanged, or -1 if it is not a bare number
# (handles nvidia-smi's "[N/A]" for MIG-mode GPUs).
# ---------------------------------------------------------------------------
to_num() {
  echo "$1" | awk '$1+0==$1 {print $1+0; exit} {print -1}'
}

# ---------------------------------------------------------------------------
# Main sampling loop
# ---------------------------------------------------------------------------
while true; do
  TS=$(date +%s.%N)

  # --- heartbeat (always first; must succeed even if everything else fails) ---
  echo "{\"t\":$TS,\"kind\":\"heartbeat\"}" >>"$OUT"

  # --- container stats ---
  # Use process substitution instead of pipe to avoid running to_mb in a
  # subshell that might not inherit the exported function on some bash builds.
  while IFS=$'\t' read -r name mem cpu; do
    used=$(echo "$mem" | awk -F' / ' '{print $1}')
    lim=$(echo "$mem"  | awk -F' / ' '{print $2}')
    # Strip trailing '%' from cpu; route through to_num to ensure numeric value
    cpuval="${cpu%\%}"
    cpunum=$(to_num "$cpuval")
    echo "{\"t\":$TS,\"kind\":\"container\",\"container\":\"$name\",\"memMB\":$(to_mb "$used"),\"memLimitMB\":$(to_mb "$lim"),\"cpuPct\":$cpunum}"
  done < <(docker stats --no-stream \
               --format '{{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}' \
               $CONTAINERS 2>/dev/null) >>"$OUT"

  # --- GPU stats (nvidia-smi may be absent or fail — tolerate both) ---
  if command -v nvidia-smi >/dev/null 2>&1; then
    while IFS=', ' read -r idx used util; do
      # Trim whitespace that nvidia-smi sometimes adds after the comma
      idx="${idx// /}"; used="${used// /}"; util="${util// /}"
      echo "{\"t\":$TS,\"kind\":\"gpu\",\"gpu\":$(to_num "$idx"),\"gpuMB\":$(to_num "$used"),\"gpuUtil\":$(to_num "$util")}"
    done < <(nvidia-smi --query-gpu=index,memory.used,utilization.gpu \
                        --format=csv,noheader,nounits 2>/dev/null) >>"$OUT"
  fi

  # --- disk usage ---
  # du -s on large directories can be slow.  Run each du in the background,
  # collect results, and cap the wait so a slow du cannot stall the cadence.
  declare -A du_pids du_files
  for p in "$ORTHANC_DB" "$IMG_CACHE"; do
    if [ -d "$p" ]; then
      tmpf=$(mktemp)
      du -sm "$p" >"$tmpf" 2>/dev/null &
      du_pids["$p"]=$!
      du_files["$p"]=$tmpf
    fi
  done
  # Wait up to (INTERVAL - 0.5) seconds for du results; skip if still running
  du_deadline=$(awk "BEGIN{print $INTERVAL - 0.5}")
  for p in "${!du_pids[@]}"; do
    pid=${du_pids[$p]}
    tmpf=${du_files[$p]}
    if kill -0 "$pid" 2>/dev/null; then
      # Poll briefly rather than blocking indefinitely
      waited=0
      while kill -0 "$pid" 2>/dev/null && awk "BEGIN{exit ($waited >= $du_deadline)}"; do
        sleep 0.1
        waited=$(awk "BEGIN{print $waited + 0.1}")
      done
    fi
    if kill -0 "$pid" 2>/dev/null; then
      # Still running — skip this tick, do not block
      kill "$pid" 2>/dev/null
      rm -f "$tmpf"
    else
      mb=$(cut -f1 <"$tmpf" 2>/dev/null)
      [ -z "$mb" ] && mb="-1"
      echo "{\"t\":$TS,\"kind\":\"disk\",\"path\":\"$p\",\"diskMB\":$mb}" >>"$OUT"
      rm -f "$tmpf"
    fi
  done
  unset du_pids du_files

  sleep "$INTERVAL"
done
