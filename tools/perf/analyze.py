#!/usr/bin/env python3
"""Merge client/host/server traces and emit a three-tier leak verdict.

Tier 1 -- counts of live objects fully under our control. Must return to the
         post-warmup baseline. Any monotonic growth is a leak, no statistics.
         Most counters are fitted on phase='cycleEnd' (canonical at-rest state
         after the study is closed and GC has run). EXCEPTION: segCount,
         blockCount, and blockSlices are fitted on phase='studyOpen' — OHIF's
         onModeExit calls removeAllSegmentations() before cycleEnd is sampled,
         so those three counters return -1 at cycleEnd and are only observable
         while the study is still open. See COUNTER_PHASE for the full mapping.

Tier 2 -- byte-valued counters. Slope must be indistinguishable from zero;
         reported as MB/cycle WITH a confidence interval. Also includes
         per-container memMB from the host stream (bucketed into cycles by
         wallT overlap) and server rss/vram_alloc from --server [timing] lines.
         All streams fitted on cycleEnd samples / their wallT-bucketed equivalent.

Tier 3 -- per-action wall times. Catches leaks that degrade performance without
         growing unboundedly (GC pressure, cache thrash) -- invisible to 1 and 2.

Host bucketing strategy
-----------------------
Host records carry an epoch timestamp `t` (float seconds since epoch).
Client samples tagged phase='cycleEnd' carry `wallT` (epoch ms).  For each
cycle N the script finds the cycleEnd wallT[N] and wallT[N+1] (the next cycle's
cycleEnd, or +inf for the last cycle) and assigns every host record with
`t` in [wallT[N]/1000, wallT[N+1]/1000) to cycle N.  This is an exact,
causal assignment with no interpolation; gaps already flagged by check_gaps()
make the window trustworthy.

Host record kinds emitted by sample_host.sh
--------------------------------------------
- ``heartbeat`` — no metrics, used for gap detection only
- ``container`` — per-container CPU/memory; keyed by the ``container`` field
- ``gpu``        — per-GPU VRAM; keyed by the ``gpu`` index (int)
- ``disk``       — per-path disk usage; keyed by the ``path`` field

Each kind is consumed separately so that different containers / GPUs / paths
are tracked as independent Tier-2 series, never merged.

Server [timing] lines
---------------------
Format: `... total_request=0.224s | rss=5559.3MB vram_alloc=855.0MB sessions=2 threads=41 queue_depth=0`
`rss` and `vram_alloc` are extracted and treated as Tier-2 counters.
They carry no cycle number so they are bucketed like host records: by the
wallT range of each cycle's cycleEnd sample.
"""

import argparse
import calendar
import datetime
import glob
import json
import math
import os
import re

TIER1 = ["volCount", "volUnsized", "segCount", "blockCount", "blockSlices", "listenerCount", "viewportCount"]
TIER2 = ["heapMB", "cacheMB", "volMB"]

# ---------------------------------------------------------------------------
# Expected series that sample_host.sh watches.  If any of these produce ZERO
# rows (container absent from docker stats, nvidia-smi missing, path not
# mounted, compose-project rename, etc.) parse_host_stream emits an explicit
# NO_DATA sentinel row naming the missing series so the overall verdict is
# INCONCLUSIVE rather than silently clean.
#
# SOURCE OF TRUTH: tools/perf/sample_host.sh
#   Containers: CONTAINERS="ohif_viewer ohif_orthanc monai_server"
#   Disks:      $ORTHANC_DB → last component "orthanc-db"
#               $IMG_CACHE  → last component "img_cache"
#   GPUs:       all indices reported by nvidia-smi (at least one expected)
# ---------------------------------------------------------------------------
HOST_EXPECTED_CONTAINERS = frozenset({"ohif_viewer", "ohif_orthanc", "monai_server"})
HOST_EXPECTED_DISK_SHORTS = frozenset({"orthanc-db", "img_cache"})  # last path component
# At least one GPU is expected (nvidia-smi present).  The actual index set is
# determined at runtime; we just require the set to be non-empty.
HOST_EXPECTED_AT_LEAST_ONE_GPU = True

# ---------------------------------------------------------------------------
# Informational-only series: these appear in the report with their slopes but
# MUST NOT contribute to the LEAK/DEGRADED verdict.
#
# WHY EACH IS EXCLUDED:
#   host.diskMB[orthanc-db]  — the soak itself writes ~10 DICOM SEG series into
#                               this directory per run, so the disk grows monoton-
#                               ically by design.  Flagging it LEAK on every clean
#                               run destroys trust in the verdict.
#   host.gpuMB[*] (ALL GPUs) — nvidia-smi --query-gpu=memory.used reports the
#                               WHOLE DEVICE, not our process.  On the shared DGX
#                               measured 2026-08-11: GPU 7 total used = 26,929 MiB
#                               but monai_server's share = only 826 MiB (~3%); the
#                               remaining 97% belongs to unrelated tenants.  A
#                               neighbouring job allocating or releasing a few GB
#                               would either swamp a genuine VRAM leak in our server
#                               or manufacture a false LEAK — the row CANNOT support
#                               a verdict.  This applies to ALL GPU indices, including
#                               the index pinned to monai_server (--pinned-gpu, default 7).
#
#                               The correct process-scoped VRAM signal is
#                               server.vram_alloc (from torch.cuda.memory_allocated()
#                               inside our own process), which is Tier-2 VERDICT-BEARING
#                               when --server is supplied.
#
# The --pinned-gpu flag is retained as a LABELLING / ANNOTATION aid so the report
# can identify which GPU row corresponds to our server — it no longer controls
# whether a row is verdict-bearing.
# ---------------------------------------------------------------------------
INFORMATIONAL_DISK_SHORTS = frozenset({"orthanc-db"})

# ---------------------------------------------------------------------------
# Phase routing: which phase each Tier-1 counter must be fitted on.
#
# WHY THREE COUNTERS DIFFER:
#   OHIF's onModeExit calls segmentationService.removeAllSegmentations() when the
#   route changes away from the viewer. This fires BEFORE the cycleEnd sample is
#   taken (which is after closeStudy + GC). Consequently, at cycleEnd the block-
#   stats provider sees an empty segmentation service and returns {segCount:-1,
#   blockCount:-1, blockSlices:-1}. Those -1 sentinels are excluded from every
#   statistic, so the three counters would be permanently NO_DATA on every run if
#   fitted on cycleEnd — making the overall verdict permanently INCONCLUSIVE.
#
#   The 'studyOpen' sample is taken while the study is STILL OPEN (after the
#   MPR→stack toggle + GC), so block/segment counters ARE observable there.
#   It is the ONLY phase at which these three counters can be measured.
#
#   All other Tier-1 counters measure objects that survive route changes (volumes,
#   listeners, viewports) and must be measured at the canonical at-rest state
#   (cycleEnd) so that "return to baseline" is meaningful.
# ---------------------------------------------------------------------------
BLOCK_COUNTERS = frozenset({"segCount", "blockCount", "blockSlices"})

# Maps each Tier-1 counter to the phase its data points must be drawn from.
COUNTER_PHASE: dict = {
    "volCount":       "cycleEnd",
    # volUnsized counts volumes without a computed sizeInBytes (still-loading streaming
    # volumes, geometry/labelmap volumes). It is a Tier-1 counter because a GROWING
    # volUnsized means the volMB partial sum is measuring a shifting subset and cannot
    # be trusted; a STABLE volUnsized means the undercount is constant and the volMB
    # slope is still meaningful. Measured at cycleEnd (at-rest baseline).
    "volUnsized":     "cycleEnd",
    "segCount":       "studyOpen",   # only observable while study is open
    "blockCount":     "studyOpen",   # only observable while study is open
    "blockSlices":    "studyOpen",   # only observable while study is open
    "listenerCount":  "cycleEnd",
    "viewportCount":  "cycleEnd",
}
# NOTE (settled during Task 3): only nninter / sam2 / segReset / nninterRecovered are actually
# emitted by the client today. segAdd / segDelete / segExport / segLoad live in the cornerstone
# extension and are NOT instrumented, so they will report NO_DATA — that is expected, not a bug.
# `nninterRecovered` is the full wall time of a refine that needed a session-pool recovery; it is
# kept SEPARATE from `nninter` on purpose, because folding a rare pathological event into the main
# population would add variance that could itself mask a real regression.
# `sam2` and `segReset` are only exercised if the soak includes those workflow steps; a soak that
# omits them produces NO_DATA by design, not failure.
TIER3 = ["nninter", "nninterRecovered", "sam2", "segAdd", "segDelete", "segExport", "segLoad", "segReset"]
DEGRADE_PCT = 20.0

# Actions/counters that are expected to produce NO_DATA — their absence must not block a CLEAN
# verdict. These are NOT instrumented in the standard soak (cornerstone extension actions, rare
# recovery path, and workflow-optional steps).
EXPECTED_MISSING = {
    "segAdd", "segDelete", "segExport", "segLoad",  # cornerstone extension, uninstrumented (Task 3)
    "nninterRecovered",  # only fires on rare session-pool recovery, by design
    "sam2",    # only exercised if soak includes sam2 workflow steps
    "segReset",  # only exercised if soak includes segReset workflow steps
    # ---------------------------------------------------------------------------
    # volMB — always NO_DATA against cornerstone 5.x (live-probe finding, Task 10)
    #
    # Headless probe of the real viewer measured:
    #   STACK viewport: volCount=0, volMB=0, volUnsized=0  (correct — no volumes)
    #   MPR   viewport: volCount=1, volMB=-1, volUnsized=1  (one volume, no readable size)
    #
    # Root cause — getter chain in @cornerstonejs/core 5.0.13:
    #   ImageVolume.js:   get sizeInBytes() { return this.voxelManager.sizeInBytes; }
    #   VoxelManager.js:  get sizeInBytes() { return this.getScalarDataLength() * this.bytePerVoxel; }
    #   getScalarDataLength() throws for lazy/streaming managers: throw new Error('No scalar data')
    #
    # The client correctly degrades to volMB=-1 with volUnsized=1 when the getter throws.
    # Since _series() excludes values < 0, an all-(-1) volMB trace produces NO_DATA.
    #
    # WHY THIS DOES NOT LOSE LEAK COVERAGE:
    #   The historic MPR volume leak was detected by volCount growing +1 per refine cycle
    #   WHILE cacheMB stayed flat (the image cache is blind to volume memory).  volCount is
    #   Tier-1 and works correctly: 0 in STACK, 1 in MPR (verified live).  It remains the
    #   load-bearing volume-leak signal.  volMB was always supplementary — a byte-level
    #   cross-check.  Allow-listing its absence does NOT remove detection of the historic leak.
    #
    # WHEN volMB IS PRESENT (some volumes do report a size):
    #   Allow-listing only suppresses the INCONCLUSIVE penalty for NO_DATA.  If volMB
    #   has real values they flow through tier2_verdict normally and a ramp is still LEAK.
    #
    # volUnsized (Tier-1) is the honest indicator of how much of volMB is unmeasurable.
    #   A GROWING volUnsized → more volumes accumulating without readable sizes → still LEAK.
    #   A STABLE volUnsized → undercount is constant → volMB slope is still meaningful.
    # ---------------------------------------------------------------------------
    "volMB",
}


_DEGENERATE = (None, None, None)  # sentinel: fit is meaningless, yield NO_DATA


def fit_slope(xs, ys):
    """Least-squares slope with a 95% CI. Returns (slope, ci_low, ci_high).

    Returns ``_DEGENERATE`` (None, None, None) when the fit is mathematically
    undefined (n < 3, sxx == 0, or infinite CI bounds) — callers must check for
    this and emit NO_DATA rather than CLEAN. A degenerate fit is reachable via
    timezone skew (all records land in one cycle → sxx == 0) and must never
    silently pass as CLEAN.
    """
    n = len(xs)
    if n < 3:
        return _DEGENERATE
    mx, my = sum(xs) / n, sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    if sxx == 0:
        return _DEGENERATE
    slope = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx
    intercept = my - slope * mx
    resid = [y - (slope * x + intercept) for x, y in zip(xs, ys)]
    if n <= 2:
        return _DEGENERATE
    se = math.sqrt(sum(r * r for r in resid) / (n - 2) / sxx)
    margin = 1.96 * se
    lo, hi = slope - margin, slope + margin
    if math.isinf(lo) or math.isinf(hi):
        return _DEGENERATE
    return (slope, lo, hi)


def _series(samples, counter, warmup, phase="cycleEnd"):
    """Extract (xs, ys) from samples.

    Filters on:
      - kind == 'sample'
      - phase == the requested phase (default 'cycleEnd')
      - cycle > warmup
      - value >= 0 (excludes -1 sentinel)

    If phase is not None (the default 'cycleEnd'), ONLY samples with that exact
    phase are used. This is the critical invariant: Tier 1 and Tier 2 verdicts
    must NEVER mix phases, because different phases represent different system
    states (study open vs. closed, post-GC vs. mid-load).
    """
    pts = [(s["cycle"], s[counter]) for s in samples
           if s.get("kind") == "sample" and counter in s
           and s["cycle"] > warmup and s[counter] >= 0
           and (phase is None or s.get("phase") == phase)]
    return [p[0] for p in pts], [p[1] for p in pts]


def _has_cycle_end(samples):
    """Return True if at least one sample has phase='cycleEnd'."""
    return any(s.get("kind") == "sample" and s.get("phase") == "cycleEnd"
               for s in samples)


def _has_phase(samples, phase):
    """Return True if at least one sample with the given phase exists."""
    return any(s.get("kind") == "sample" and s.get("phase") == phase
               for s in samples)


def tier1_verdict(samples, counter, warmup=2, phase=None):
    """Tier 1 verdict.

    Fitted on the phase specified by ``phase`` (default: look up COUNTER_PHASE,
    fall back to 'cycleEnd').  Block counters (segCount, blockCount, blockSlices)
    must pass phase='studyOpen' — they return -1 at cycleEnd because
    onModeExit removes all segmentations before that sample is taken.

    Contract:
    - If NO cycleEnd samples exist at all, returns NO_DATA (trace pre-dates
      the phase contract).
    - If the requested phase has no samples, returns NO_DATA.  Callers MUST
      NOT silently fall back to a different phase — that would reproduce the
      bug this function fixes.
    """
    if phase is None:
        phase = COUNTER_PHASE.get(counter, "cycleEnd")

    # Always require at least one cycleEnd sample as proof the trace honours
    # the phase contract (pre-contract traces have no phase at all).
    if not _has_cycle_end(samples):
        return {"counter": counter, "tier": 1, "verdict": "NO_DATA",
                "note": "no cycleEnd samples — trace pre-dates phase contract"}

    # For counters that live on a non-cycleEnd phase, verify that phase exists.
    # Do NOT fall back to cycleEnd — that would silently fit on -1 sentinels.
    if phase != "cycleEnd" and not _has_phase(samples, phase):
        return {"counter": counter, "tier": 1, "verdict": "NO_DATA",
                "note": f"no '{phase}' samples — trace pre-dates studyOpen phase; "
                        "block counters require studyOpen to be observable"}

    xs, ys = _series(samples, counter, warmup, phase=phase)
    # Require at least 3 usable post-warmup points before rendering a CLEAN/LEAK verdict.
    # With fewer points, growth = ys[-1] - baseline can be trivially 0 even on a crashed
    # soak, producing a false-CLEAN. Mirror the same floor tier2 uses.
    if len(ys) < 3:
        return {"counter": counter, "tier": 1, "verdict": "NO_DATA"}
    # Baseline is taken from the warmup window (the very first sample for the counter
    # in the target phase), so growth reflects how far the metric has moved from its
    # initial steady-state value.
    warmup_pts = [(s["cycle"], s[counter]) for s in samples
                  if s.get("kind") == "sample" and counter in s
                  and s.get("phase") == phase
                  and s["cycle"] <= warmup and s[counter] >= 0]
    baseline = warmup_pts[0][1] if warmup_pts else ys[0]
    growth = ys[-1] - baseline
    return {
        "counter": counter, "tier": 1, "phase": phase,
        "baseline": baseline,
        "final": ys[-1], "growth": growth, "n": len(ys),
        "verdict": "LEAK" if growth > 0 else "CLEAN",
    }


def tier2_verdict(samples, counter, warmup=2, min_slope=0.0):
    """Tier 2 verdict — uses ONLY cycleEnd samples.

    If no cycleEnd samples exist at all, returns NO_DATA.
    A degenerate fit (sxx==0 or infinite CI) also yields NO_DATA.

    ``min_slope``: minimum effect-size floor (MB/cycle).  See
    tier2_verdict_from_pairs for full documentation.
    """
    if not _has_cycle_end(samples):
        return {"counter": counter, "tier": 2, "verdict": "NO_DATA",
                "note": "no cycleEnd samples — trace pre-dates phase contract"}
    xs, ys = _series(samples, counter, warmup, phase="cycleEnd")
    if len(ys) < 3:
        return {"counter": counter, "tier": 2, "verdict": "NO_DATA"}
    slope, lo, hi = fit_slope(xs, ys)
    if slope is None:  # degenerate fit
        return {"counter": counter, "tier": 2, "verdict": "NO_DATA",
                "note": "degenerate fit (all points in one x-bucket — possible clock/timezone skew)"}
    if lo <= 0 <= hi:
        verdict = "CLEAN"
    elif slope > 0:
        # I-3: apply minimum effect-size floor before declaring LEAK.
        if min_slope > 0 and abs(slope) < min_slope:
            verdict = "CLEAN"
        else:
            verdict = "LEAK"
    else:
        verdict = "CLEAN"  # a tight NEGATIVE slope is memory being reclaimed
    row = {
        "counter": counter, "tier": 2, "slope_per_cycle": round(slope, 4),
        "ci": [round(lo, 4), round(hi, 4)], "n": len(ys), "verdict": verdict,
    }
    if min_slope > 0:
        row["min_slope_floor"] = min_slope
    return row


def tier3_verdict(measures, name, warmup=2):
    pts = [(m["cycle"], m["durMs"]) for m in measures
           if m.get("kind") == "measure" and m.get("name") == name
           and m["cycle"] > warmup and m["durMs"] >= 0]
    if len(pts) < 6:
        return {"action": name, "tier": 3, "verdict": "NO_DATA"}
    pts.sort()
    early = [d for _, d in pts[:5]]
    late = [d for _, d in pts[-5:]]
    e, l = sum(early) / len(early), sum(late) / len(late)
    pct = (l - e) / e * 100 if e else 0.0
    return {
        "action": name, "tier": 3, "early_ms": round(e, 1), "late_ms": round(l, 1),
        "pct_change": round(pct, 1), "n": len(pts),
        "verdict": "DEGRADED" if pct > DEGRADE_PCT else "CLEAN",
    }


def check_gaps(host_records, interval=2.0):
    """A dead sampler looks exactly like a plateaued counter. Report gaps, never
    interpolate across them."""
    ts = sorted(r["t"] for r in host_records if r.get("kind") == "heartbeat")
    return [(round(a, 1), round(b, 1)) for a, b in zip(ts, ts[1:]) if b - a > interval * 3]


def _cycle_windows(samples):
    """Return a list of (cycle, t_start_sec, t_end_sec) from cycleEnd samples.

    Each window covers [wallT_this / 1000, wallT_next / 1000).
    The last window's end is +inf.
    wallT is in epoch milliseconds (as emitted by the soak driver).
    """
    ce = sorted(
        [(s["cycle"], s["wallT"]) for s in samples
         if s.get("kind") == "sample" and s.get("phase") == "cycleEnd" and "wallT" in s],
        key=lambda x: x[0],
    )
    windows = []
    for i, (cycle, wallT) in enumerate(ce):
        t_start = wallT / 1000.0
        t_end = ce[i + 1][1] / 1000.0 if i + 1 < len(ce) else math.inf
        windows.append((cycle, t_start, t_end))
    return windows


def _bucket_by_cycle(records, windows, value_key, kind_filter=None):
    """Map records to cycle numbers using wallT windows.

    Returns a list of (cycle, value) pairs with value >= 0.
    Records with `t` outside all windows are dropped.
    """
    result = []
    for r in records:
        if kind_filter and r.get("kind") != kind_filter:
            continue
        t = r.get("t")
        v = r.get(value_key)
        if t is None or v is None or v < 0:
            continue
        for cycle, t_start, t_end in windows:
            if t_start <= t < t_end:
                result.append((cycle, v))
                break
    return result


def tier2_verdict_from_pairs(label, pairs, warmup=2, warn_single_cycle=False, min_slope=0.0):
    """Tier 2 verdict from (cycle, value) pairs (used for host/server streams).

    ``warn_single_cycle`` is set internally when ALL records mapped to one
    cycle window — the signature of a clock/timezone mismatch.  The result
    carries a ``note`` and verdict NO_DATA so the caller can surface it.
    A degenerate fit (sxx==0 or infinite CI) also yields NO_DATA.

    ``min_slope``: minimum effect-size floor (MB/cycle).  A slope whose
    magnitude is below this floor is reported as CLEAN even when the CI
    excludes zero — statistically tight but physically meaningless.  The floor
    value is recorded in the returned row so the report can state it.
    Do NOT apply to Tier-1 integer counters; only pass non-zero here for Tier-2.
    """
    pts = [(c, v) for c, v in pairs if c > warmup and v >= 0]
    if len(pts) < 3:
        return {"counter": label, "tier": 2, "verdict": "NO_DATA"}
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    # Detect single-cycle collapse (clock mismatch signature)
    if len(set(xs)) == 1:
        return {"counter": label, "tier": 2, "verdict": "NO_DATA",
                "note": f"all {len(pts)} records fell in one cycle window — "
                        "possible clock/timezone mismatch; rerun with --log-tz"}
    slope, lo, hi = fit_slope(xs, ys)
    if slope is None:  # degenerate fit
        return {"counter": label, "tier": 2, "verdict": "NO_DATA",
                "note": "degenerate fit (sxx==0 or infinite CI — possible clock/timezone skew)"}
    if lo <= 0 <= hi:
        verdict = "CLEAN"
    elif slope > 0:
        # I-3: apply minimum effect-size floor before declaring LEAK.
        # A tight CI on a physically negligible slope is noise, not a real leak.
        if min_slope > 0 and abs(slope) < min_slope:
            verdict = "CLEAN"
        else:
            verdict = "LEAK"
    else:
        verdict = "CLEAN"  # a tight NEGATIVE slope is memory being reclaimed
    row = {
        "counter": label, "tier": 2, "slope_per_cycle": round(slope, 4),
        "ci": [round(lo, 4), round(hi, 4)], "n": len(pts), "verdict": verdict,
    }
    if min_slope > 0:
        row["min_slope_floor"] = min_slope
    return row


# The set of record kinds that sample_host.sh emits and that this analyzer
# knows how to consume.  Used in tests to detect new kinds added to the sampler
# without a matching consumer here.
HOST_KNOWN_KINDS = frozenset({"heartbeat", "container", "gpu", "disk"})


def _aggregate_to_one_per_cycle(pairs):
    """Reduce multiple (cycle, value) pairs per cycle to one value per cycle.

    Host records arrive ~20 per cycle.  Fitting them as independent points
    underestimates the CI by ~sqrt(20), causing false LEAKs.  We aggregate to
    the last (most recent) record in each cycle window before fitting.

    Returns a deduplicated list of (cycle, value) pairs, one per cycle.
    """
    from collections import defaultdict
    by_cycle = defaultdict(list)
    for c, v in pairs:
        by_cycle[c].append(v)
    # Use the median value within each cycle window (robust to brief spikes)
    result = []
    for cycle in sorted(by_cycle):
        vals = sorted(by_cycle[cycle])
        mid = len(vals) // 2
        result.append((cycle, vals[mid]))
    return result


def parse_host_stream(host_recs, samples, warmup=2, pinned_gpu=7, min_slope=0.0):
    """Consume the host stream: emit Tier-2 rows for memMB per container,
    gpuMB per GPU index, and diskMB per path.

    Record kinds consumed (as emitted by sample_host.sh):
      - ``container``: keyed by ``container`` field → host.memMB[<name>]
      - ``gpu``:       keyed by ``gpu`` index      → host.gpuMB[<idx>]
      - ``disk``:      keyed by ``path`` field      → host.diskMB[<path>]
      - ``heartbeat``: used only by check_gaps(), ignored here

    Host records arrive ~20 per cycle.  Each series is aggregated to ONE value
    per cycle (median) before fitting, so the CI is not artificially narrowed
    by within-cycle replication.

    I-1 (missing-series sentinel): If an expected series (container, GPU, or
    disk) produces ZERO rows — because the container was absent from docker
    stats, nvidia-smi was missing, a compose-project rename changed the name, or
    a disk path was not mounted — an explicit NO_DATA sentinel row is emitted
    naming that series.  This forces INCONCLUSIVE rather than silently clean.
    The expected set is derived from HOST_EXPECTED_CONTAINERS,
    HOST_EXPECTED_DISK_SHORTS, and HOST_EXPECTED_AT_LEAST_ONE_GPU.

    I-2 (informational series): orthanc-db disk and ALL GPU indices are
    classified informational — they appear in the report but do NOT contribute
    to the LEAK/DEGRADED verdict.  ``pinned_gpu`` is used only as a labelling
    aid to mark which GPU index corresponds to our server in the report; it no
    longer controls verdict-bearing status.  nvidia-smi --query-gpu=memory.used
    reports the WHOLE DEVICE; on the shared DGX the pinned GPU (index 7) showed
    26,929 MiB total used while monai_server held only 826 MiB (~3%).  The
    process-scoped VRAM signal is server.vram_alloc (torch.cuda.memory_allocated()
    inside our process), which is the ONLY VRAM row that can support a verdict.
    Supply --server to make server.vram_alloc verdict-bearing.

    A non-empty host stream that produces ZERO total rows (e.g. because the
    sampler emits a kind the analyzer does not know about) is a
    misconfiguration, not a pass.  An INCONCLUSIVE sentinel row is returned.

    ``min_slope``: forwarded to tier2_verdict_from_pairs for verdict-bearing rows.
    """
    windows = _cycle_windows(samples)
    if not windows:
        if host_recs:
            # I9: cycle windows empty but host data was supplied → INCONCLUSIVE
            return [{"counter": "host._no_cycle_windows", "tier": 2,
                     "verdict": "NO_DATA",
                     "note": "host stream present but no cycleEnd wallT anchors — "
                             "client trace may be pre-contract; cannot bucket host records"}]
        return []

    rows = []
    informational_rows = []

    # --- kind=container: one series per container, tracking memMB ---
    containers: dict = {}
    for r in host_recs:
        if r.get("kind") != "container":
            continue
        container = r.get("container", "")
        mem = r.get("memMB")
        t = r.get("t")
        if t is None or mem is None or mem < 0:
            continue
        containers.setdefault(container, []).append({"t": t, "memMB": mem})

    seen_containers: set = set()
    for container, recs in containers.items():
        raw_pairs = _bucket_by_cycle(recs, windows, "memMB")
        pairs = _aggregate_to_one_per_cycle(raw_pairs)
        label = f"host.memMB[{container}]" if container else "host.memMB"
        rows.append(tier2_verdict_from_pairs(label, pairs, warmup, min_slope=min_slope))
        seen_containers.add(container)

    # I-1: emit NO_DATA sentinel for every expected container that produced no rows.
    for expected_container in sorted(HOST_EXPECTED_CONTAINERS):
        if expected_container not in seen_containers:
            rows.append({
                "counter": f"host.memMB[{expected_container}]", "tier": 2,
                "verdict": "NO_DATA",
                "note": f"series '{expected_container}' produced no records — "
                        "container may be absent from docker stats, down, or "
                        "renamed (e.g. compose-project prefix change). "
                        "Source: tools/perf/sample_host.sh CONTAINERS=",
            })

    # --- kind=gpu: one series per GPU index, tracking gpuMB ---
    gpus: dict = {}
    for r in host_recs:
        if r.get("kind") != "gpu":
            continue
        gpu_idx = r.get("gpu")
        vmb = r.get("gpuMB")
        t = r.get("t")
        if t is None or gpu_idx is None or vmb is None or vmb < 0:
            continue
        gpus.setdefault(gpu_idx, []).append({"t": t, "gpuMB": vmb})

    for gpu_idx in sorted(gpus):
        raw_pairs = _bucket_by_cycle(gpus[gpu_idx], windows, "gpuMB")
        pairs = _aggregate_to_one_per_cycle(raw_pairs)
        label = f"host.gpuMB[{gpu_idx}]"
        is_pinned = (gpu_idx == pinned_gpu)
        # I-2: ALL GPU rows are informational — nvidia-smi --query-gpu=memory.used
        # reports the WHOLE DEVICE, not our process.  On a shared DGX (measured
        # 2026-08-11): GPU 7 total used = 26,929 MiB; monai_server's share =
        # 826 MiB (~3%).  A neighbour job allocating a few GB would either swamp
        # a genuine VRAM leak or manufacture a false LEAK — cannot support a
        # verdict.  Use server.vram_alloc (torch.cuda.memory_allocated()) instead;
        # it is the ONLY VRAM signal that is process-scoped and verdict-bearing.
        # --pinned-gpu annotates which row is our server's GPU for readability.
        row = tier2_verdict_from_pairs(label, pairs, warmup, min_slope=0.0)
        row["informational"] = True
        if is_pinned:
            row["informational_reason"] = (
                "nvidia-smi --query-gpu=memory.used is per-DEVICE, not per-process. "
                f"This is the GPU pinned to monai_server (--pinned-gpu={pinned_gpu}). "
                "Measured 2026-08-11: 26,929 MiB total used, 826 MiB our process (~3%); "
                "a neighbour job would swamp or manufacture a LEAK signal. "
                "Process-scoped VRAM: server.vram_alloc (supply --server)."
            )
        else:
            row["informational_reason"] = (
                "nvidia-smi --query-gpu=memory.used is per-DEVICE, not per-process. "
                "GPU is shared with other tenants on a DGX; usage cannot be attributed "
                f"to this workload. Our server runs on GPU {pinned_gpu} (--pinned-gpu). "
                "Process-scoped VRAM: server.vram_alloc (supply --server)."
            )
        informational_rows.append(row)

    # I-1: if nvidia-smi was present (we expect at least one GPU) but produced
    # no GPU rows at all, emit a sentinel.
    if HOST_EXPECTED_AT_LEAST_ONE_GPU and not gpus:
        rows.append({
            "counter": "host.gpuMB[?]", "tier": 2,
            "verdict": "NO_DATA",
            "note": "no GPU records in host stream — nvidia-smi may be absent "
                    "from PATH or failed. Source: tools/perf/sample_host.sh",
        })

    # --- kind=disk: one series per path, tracking diskMB ---
    disks: dict = {}
    for r in host_recs:
        if r.get("kind") != "disk":
            continue
        path = r.get("path", "")
        dmb = r.get("diskMB")
        t = r.get("t")
        if t is None or dmb is None or dmb < 0:
            continue
        disks.setdefault(path, []).append({"t": t, "diskMB": dmb})

    seen_disk_shorts: set = set()
    for path, recs in disks.items():
        raw_pairs = _bucket_by_cycle(recs, windows, "diskMB")
        pairs = _aggregate_to_one_per_cycle(raw_pairs)
        # Use last path component as the label (keep it readable)
        short = path.split("/")[-1] or path
        seen_disk_shorts.add(short)
        if short in INFORMATIONAL_DISK_SHORTS:
            # I-2: self-written data directory → informational only.
            row = tier2_verdict_from_pairs(f"host.diskMB[{short}]", pairs, warmup, min_slope=0.0)
            row["informational"] = True
            row["informational_reason"] = (
                "soak writes ~10 DICOM SEG series into this directory per run — "
                "monotonic growth is by design, not a leak"
            )
            informational_rows.append(row)
        else:
            rows.append(tier2_verdict_from_pairs(
                f"host.diskMB[{short}]", pairs, warmup, min_slope=min_slope))

    # I-1: emit NO_DATA sentinel for every expected disk path that produced no rows.
    for expected_short in sorted(HOST_EXPECTED_DISK_SHORTS):
        if expected_short not in seen_disk_shorts:
            rows.append({
                "counter": f"host.diskMB[{expected_short}]", "tier": 2,
                "verdict": "NO_DATA",
                "note": f"disk path '{expected_short}' produced no records — "
                        "path may not exist or du may have timed out. "
                        "Source: tools/perf/sample_host.sh ORTHANC_DB / IMG_CACHE",
            })

    # Append informational rows (they appear in the report but are excluded from
    # verdict logic by the render_report and overall-verdict computation).
    rows.extend(informational_rows)

    # Guard: non-empty stream → zero rows means we consumed nothing useful.
    non_heartbeat = [r for r in host_recs if r.get("kind") != "heartbeat"]
    if non_heartbeat and not rows:
        return [{"counter": "host._zero_rows", "tier": 2,
                 "verdict": "NO_DATA",
                 "note": "host stream non-empty but produced zero series rows — "
                         "sampler may emit kinds the analyzer does not consume; "
                         f"known kinds: {sorted(HOST_KNOWN_KINDS)}"}]

    return rows


# Pattern matching [timing] lines from the server log.
# Format: `... total_request=0.224s | rss=5559.3MB vram_alloc=855.0MB sessions=2 threads=41 queue_depth=0`
_TIMING_RE = re.compile(
    r"\[timing\].*?"
    r"rss=(?P<rss>-?[\d.]+)MB"
    r".*?vram_alloc=(?P<vram>-?[\d.]+)MB",
    re.IGNORECASE,
)
_WALLTIME_RE = re.compile(r"wallT=(?P<wallT>\d+)")
# Python logger timestamp: [YYYY-MM-DD HH:MM:SS,mmm]
# Optionally preceded by a docker-compose prefix like "monai_server  | "
_LOGGER_TS_RE = re.compile(r"\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),(\d{3})\]")


def _parse_logger_timestamp(line, tz=None):
    """Extract epoch seconds (float) from the Python logger timestamp in *line*.

    Format: [YYYY-MM-DD HH:MM:SS,mmm]

    ``tz``: a ``datetime.timezone`` that the logger timestamp is assumed to be
    in.  Defaults to UTC (containers default to UTC).  Pass the analyzer host's
    local timezone when the log was written by a host process, or whatever the
    ``--log-tz`` option resolved to.

    Returns None if the timestamp is absent or unparseable.
    """
    if tz is None:
        tz = datetime.timezone.utc
    m = _LOGGER_TS_RE.search(line)
    if not m:
        return None
    try:
        dt = datetime.datetime.strptime(m.group(1), "%Y-%m-%d %H:%M:%S")
        millis = int(m.group(2))
        # Attach the caller-supplied timezone and convert to epoch seconds.
        dt_aware = dt.replace(tzinfo=tz)
        epoch_sec = dt_aware.timestamp() + millis / 1000.0
        return epoch_sec
    except Exception:
        return None


def parse_server_log(path, log_tz=None):
    """Parse [timing] lines and return a ``_ServerRecordList``.

    Each record is a dict with keys ``t`` (epoch sec) plus any of ``rss`` /
    ``vram_alloc`` that were present and non-sentinel (>= 0).

    Attributes on the returned list:
      - ``skipped_counter_no_timestamp`` — counter lines that had no usable
                                           timestamp (real problem, operator
                                           should see warning + --log-tz hint)
      - ``skipped_non_counter_lines``    — [timing] lines without counter values
                                           (expected & harmless sub-timing lines)
      - ``timing_lines``  — total [timing] lines seen in the file (C7 guard:
                            if this is > 0 and records is empty, the log exists
                            but carried no counters the analyzer understands)

    Primary timestamp source: ``wallT=<epoch_ms>`` (epoch ms, present in logs
    after Fix 1 / rebuild).
    Fallback: Python logger timestamp ``[YYYY-MM-DD HH:MM:SS,mmm]``.
      - ``log_tz``: a ``datetime.timezone`` used when interpreting the logger
        timestamp.  Defaults to UTC (containers default to UTC).
        Pass ``datetime.timezone.utc`` explicitly or the result of
        ``datetime.timezone(datetime.timedelta(hours=N))`` for a different zone.
        The ``--log-tz`` CLI option converts user input to a timezone object.
    If BOTH timestamp sources are absent, the line is counted as skipped.
    """
    records = []
    skipped_counter_no_timestamp = 0
    skipped_non_counter_lines = 0
    timing_lines = 0
    if log_tz is None:
        log_tz = datetime.timezone.utc
    with open(path) as f:
        for line in f:
            if "[timing]" not in line:
                continue
            timing_lines += 1
            m = _TIMING_RE.search(line)
            if not m:
                # [timing] line present but doesn't match our counter regex
                # (e.g. a sub-timing line like session reset, init, dicom_scan)
                # This is EXPECTED and NOT a problem.
                skipped_non_counter_lines += 1
                continue
            rss = float(m.group("rss"))
            vram = float(m.group("vram"))
            # Primary: wallT= (epoch ms, present in logs after Fix 1)
            wm = _WALLTIME_RE.search(line)
            if wm:
                t = int(wm.group("wallT")) / 1000.0
            else:
                # Fallback: Python logger timestamp, interpreted in log_tz
                t = _parse_logger_timestamp(line, log_tz)
            if t is None:
                # This line HAS counters but NO usable timestamp — real problem
                skipped_counter_no_timestamp += 1
                continue
            # Exclude -1 sentinels
            record = {"t": t}
            if rss >= 0:
                record["rss"] = rss
            if vram >= 0:
                record["vram_alloc"] = vram
            records.append(record)
    # Return an augmented list so existing callers (tier2_verdicts_from_server)
    # work unchanged, while metadata is accessible as attributes.
    result = _ServerRecordList(records)
    result.skipped_counter_no_timestamp = skipped_counter_no_timestamp
    result.skipped_non_counter_lines = skipped_non_counter_lines
    result.timing_lines = timing_lines
    return result


class _ServerRecordList(list):
    """A list subclass that carries a ``skipped`` counter alongside the records."""
    skipped = 0


def tier2_verdicts_from_server(server_recs, samples, warmup=2, min_slope=0.0):
    """Emit Tier-2 rows for server rss and vram_alloc, bucketed by cycleEnd windows.

    server.vram_alloc is the ONLY VRAM signal that can support a leak verdict.
    It comes from torch.cuda.memory_allocated() inside our own process, so it
    is process-scoped and unaffected by other GPU tenants.  host.gpuMB[*] from
    nvidia-smi reports per-DEVICE usage and is always informational (see
    parse_host_stream and INFORMATIONAL_DISK_SHORTS comment block).

    I9 guard: if cycle windows are empty but server records were supplied, return
    an INCONCLUSIVE sentinel row rather than silently dropping the stream.
    """
    windows = _cycle_windows(samples)
    if not server_recs:
        return []
    if not windows:
        # I9: server data present but no wallT anchors to bucket against
        return [{"counter": "server._no_cycle_windows", "tier": 2,
                 "verdict": "NO_DATA",
                 "note": "server stream present but no cycleEnd wallT anchors — "
                         "client trace may be pre-contract; cannot bucket server records"}]

    rows = []
    for key, label in [("rss", "server.rssMB"), ("vram_alloc", "server.vramMB")]:
        recs = [r for r in server_recs if key in r]
        pairs = _bucket_by_cycle(recs, windows, key)
        rows.append(tier2_verdict_from_pairs(label, pairs, warmup, min_slope=min_slope))
    return rows


def render_report(results):
    out = ["# Perf Soak Report", "", f"Generated: {results['generated']}", ""]
    if results.get("gaps"):
        out += ["> **WARNING** — host sampler gaps detected; plateaus in that window are not trustworthy:",
                "", *[f"> - {a} → {b}" for a, b in results["gaps"]], ""]
    # Skipped server lines: distinguish counter lines without timestamp (problem)
    # from non-counter sub-timing lines (expected)
    server_skipped_counter_no_timestamp = results.get("server_skipped_counter_no_timestamp", 0)
    server_skipped_non_counter_lines = results.get("server_skipped_non_counter_lines", 0)
    server_timing_lines = results.get("server_timing_lines", 0)
    log_tz_label = results.get("log_tz_label", "UTC")

    # Only warn if counter lines lacked timestamps (real problem)
    if server_skipped_counter_no_timestamp:
        msg = (f"> **WARNING** — {server_skipped_counter_no_timestamp} [timing] line(s) carried "
               f"counters (rss=/vram_alloc=) but had no usable timestamp "
               f"(no wallT= and no logger timestamp parseable as {log_tz_label}). "
               f"Those records were excluded from analysis. Try --log-tz if these are false positives.")
        out += [msg, ""]
        print(f"WARNING: {server_skipped_counter_no_timestamp} server [timing] counter line(s) skipped — no usable timestamp")

    # Report sub-timing lines neutrally (not as a warning)
    if server_skipped_non_counter_lines:
        msg = (f"> _{server_skipped_non_counter_lines} [timing] sub-timing lines seen "
               f"(session reset, init, dicom_scan, etc. without counters) — expected and excluded._")
        out += [msg, ""]

    if log_tz_label and log_tz_label != "UTC" and results.get("server_present"):
        out += [f"> _Logger timestamp assumed timezone: {log_tz_label} (set via --log-tz)_", ""]
    elif results.get("server_present"):
        out += ["> _Logger timestamp fallback assumes UTC (containers default to UTC; override with --log-tz)_", ""]

    # I-3: report min_slope floor if non-zero
    min_slope = results.get("min_slope", 0.0)
    if min_slope > 0:
        out += [f"> _Tier-2 minimum effect-size floor: {min_slope} MB/cycle (--min-slope). "
                "Slopes below this magnitude are reported CLEAN even when the CI excludes zero._", ""]

    # Stream presence summary
    host_count = results.get("host_count", None)
    server_present = results.get("server_present", None)
    server_inconclusive = results.get("server_inconclusive", False)
    if host_count is not None or server_present is not None:
        out.append("> **Stream summary:**")
        if host_count is not None:
            if host_count == 0:
                out.append("> - host stream: **absent** — INCONCLUSIVE on host metrics")
            else:
                out.append(f"> - host stream: {host_count} records")
        if server_present is not None:
            if server_inconclusive:
                out.append(f"> - server stream: **provided but ALL records were unusable** "
                           f"({server_timing_lines} [timing] line(s) seen, 0 usable) "
                           f"— INCONCLUSIVE on server metrics")
            elif server_present:
                out.append(f"> - server stream: present")
            else:
                out.append(f"> - server stream: **absent** — "
                           f"no process-scoped VRAM signal available. "
                           f"host.gpuMB[*] is per-device (nvidia-smi) and cannot be attributed "
                           f"to this workload on a shared GPU host. "
                           f"VRAM is effectively unmonitored for verdict purposes in this run; "
                           f"supply --server to enable server.vram_alloc (torch.cuda.memory_allocated()).")
        elif server_present is None:
            # --server was not supplied at all (None means option not given, vs False=given but absent)
            out.append("> - server stream: **not supplied (--server omitted)** — "
                       "no process-scoped VRAM signal available. "
                       "host.gpuMB[*] is per-device (nvidia-smi) and cannot be attributed "
                       "to this workload on a shared GPU host. "
                       "VRAM is effectively unmonitored for verdict purposes in this run; "
                       "supply --server to enable server.vram_alloc (torch.cuda.memory_allocated()).")
        out.append("")

    # Split rows into verdict-bearing and informational before rendering
    all_rows = results["rows"]
    verdict_rows = [r for r in all_rows if not r.get("informational")]
    info_rows = [r for r in all_rows if r.get("informational")]

    for tier, title in ((1, "Tier 1 — must return to baseline"),
                        (2, "Tier 2 — slope must span zero"),
                        (3, "Tier 3 — performance degradation")):
        rows = [r for r in verdict_rows if r["tier"] == tier]
        if not rows:
            continue
        out += [f"## {title}", ""]
        if tier == 1:
            out += ["| counter | phase | baseline | final | growth | verdict |", "|---|---|---|---|---|---|"]
            out += [f"| {r['counter']} | {r.get('phase', 'cycleEnd')} | {r.get('baseline','-')} | {r.get('final','-')} | {r.get('growth','-')} | **{r['verdict']}** |" for r in rows]
        elif tier == 2:
            out += ["| counter | MB/cycle | 95% CI | n | verdict |", "|---|---|---|---|---|"]
            # Collect volUnsized stats from Tier-1 rows so we can annotate volMB.
            # volMB is a PARTIAL sum whenever volUnsized > 0; a non-zero baseline
            # means the figure excludes some volumes, so we flag it for the reader.
            all_t1 = [r for r in all_rows if r["tier"] == 1]
            vu_row = next((r for r in all_t1 if r.get("counter") == "volUnsized"), None)
            vu_baseline = vu_row.get("baseline", 0) if vu_row else 0
            for r in rows:
                label = r['counter']
                if label == "volMB":
                    if r['verdict'] == "NO_DATA":
                        # Annotate the NO_DATA row so readers are not left guessing.
                        # cornerstone 5.x MPR volumes use a lazy/streaming voxel manager
                        # whose sizeInBytes getter throws; the client degrades to -1 sentinel.
                        label = f"{label} _(no readable volume size — cornerstone streaming voxel manager)_"
                    elif vu_baseline and vu_baseline > 0:
                        label = f"{label} _(partial: {int(vu_baseline)} volumes unsized)_"
                out.append(
                    f"| {label} | {r.get('slope_per_cycle','-')} | {r.get('ci','-')} | {r.get('n','-')} | **{r['verdict']}** |"
                )
        else:
            out += ["| action | early ms | late ms | change | verdict |", "|---|---|---|---|---|"]
            out += [f"| {r['action']} | {r.get('early_ms','-')} | {r.get('late_ms','-')} | {r.get('pct_change','-')}% | **{r['verdict']}** |" for r in rows]
        out.append("")

    # I-2: render informational rows in a clearly labelled separate section.
    if info_rows:
        out += ["## Informational (not verdict-bearing)", ""]
        out += ["> These series appear for diagnostic purposes only. They are excluded from",
                "> the LEAK/DEGRADED verdict for the reasons stated below.", ""]
        out += ["| counter | MB/cycle | 95% CI | n | verdict | reason |", "|---|---|---|---|---|---|"]
        for r in info_rows:
            reason = r.get("informational_reason", "excluded by policy")
            out.append(
                f"| {r['counter']} | {r.get('slope_per_cycle','-')} | {r.get('ci','-')} "
                f"| {r.get('n','-')} | **{r['verdict']}** | {reason} |"
            )
        out.append("")

    # Verdict logic uses only verdict_rows (not informational).
    verdicts = [r["verdict"] for r in verdict_rows]
    # NO_DATA MUST NOT COLLAPSE INTO "CLEAN". A counter that never reported is a
    # BROKEN COLLECTOR, and a half-failed pipeline that prints "CLEAN" is the single
    # worst output this tool can produce — it is exactly the false all-clear the
    # positive control exists to prevent. Surface it as its own verdict.
    missing = [r.get("counter") or r.get("action") for r in verdict_rows if r["verdict"] == "NO_DATA"]
    unexpected = [m for m in missing if m not in EXPECTED_MISSING]

    # An absent host stream is itself INCONCLUSIVE — missing collector != healthy system.
    host_absent = results.get("host_count") == 0
    # A server stream that was provided but ALL records were unusable is INCONCLUSIVE —
    # it does NOT mean "no server leak found"; it means we couldn't measure.
    server_inconclusive = results.get("server_inconclusive", False)
    server_timing_lines = results.get("server_timing_lines", 0)

    if "LEAK" in verdicts or "DEGRADED" in verdicts:
        overall = "LEAK/DEGRADED FOUND"
    elif unexpected or host_absent or server_inconclusive:
        reasons = []
        if unexpected:
            reasons.append(f"{len(unexpected)} counter(s) reported no data: {', '.join(unexpected)}")
        if host_absent:
            reasons.append("host stream absent")
        if server_inconclusive:
            reasons.append(f"server stream provided but all {server_timing_lines} "
                           f"[timing] line(s) produced 0 usable records — "
                           f"check --log-tz or MONAI_PERF_TRACE setting")
        overall = f"INCONCLUSIVE — {'; '.join(reasons)}"
    else:
        overall = "CLEAN"

    out += ["## Overall", "", f"**{overall}**", ""]
    if unexpected:
        out += ["> A counter with no data means its collector failed, NOT that the system is healthy.",
                "> Fix the collector and re-run before treating this soak as evidence of anything.", ""]
    if host_absent:
        out += ["> Host stream was absent. The container-memory and GPU counters were not checked.",
                "> Run the host sampler and re-analyze before treating this as CLEAN.", ""]
    if missing and not unexpected:
        out += [f"_({len(missing)} expected-missing series/actions omitted: {', '.join(missing)})_", ""]
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser(
        description="Merge client/host/server soak traces and emit a three-tier memory-leak verdict.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Tier 1  volCount / listenerCount / viewportCount   [phase=cycleEnd]
        segCount / blockCount / blockSlices           [phase=studyOpen]
        Any monotonic growth after warmup is a LEAK — no statistics needed.
        Most counters use phase='cycleEnd' (at-rest baseline). Block/segment
        counters use phase='studyOpen' because OHIF's onModeExit clears
        segmentations before cycleEnd — they return -1 at rest.

Tier 2  heapMB / cacheMB / volMB (client)
        + host.memMB[<container>] / host.gpuMB / host.diskMB (host stream)
        + server.rssMB / server.vramMB (--server [timing] log)
        Slope fitted with 95% CI; LEAK only when CI excludes zero on the positive side.
        Client counters use cycleEnd samples; host/server records are bucketed
        into cycles by wallT overlap with each cycleEnd sample.

Tier 3  nninter / nninterRecovered / sam2 / segReset  (+ expected-missing seg* actions)
        Last-5 vs early-5 cycles; DEGRADED when change exceeds 20%.

Cycles 1-2 are warmup and excluded from all fitting.
-1 values mean "unreadable" and are excluded from statistics; an all-(-1)
counter surfaces as NO_DATA -> INCONCLUSIVE, never CLEAN.

If no cycleEnd samples exist (old pre-contract trace), the tool yields
NO_DATA -> INCONCLUSIVE rather than silently mixing phases.

An absent host stream yields INCONCLUSIVE — a missing collector is not the
same as a healthy one reporting zero growth.
"""
    )
    ap.add_argument("--client", help="client JSONL path (default: newest runs/client-*.jsonl)")
    ap.add_argument("--host", help="host JSONL path (default: newest runs/host-*.jsonl, optional)")
    ap.add_argument("--server", metavar="LOGFILE",
                    help="server log path containing [timing] lines with rss=/vram_alloc= fields")
    ap.add_argument("--warmup", type=int, default=2, metavar="N",
                    help="cycles to skip as warmup (default: 2)")
    ap.add_argument("--out", metavar="PATH",
                    help="report output path (default: reports/<date>-soak.md)")
    ap.add_argument("--log-tz", metavar="HOURS", type=float, default=0.0,
                    help="UTC offset (hours) of the logger timestamp in --server log "
                         "(default: 0 = UTC, because containers default to UTC). "
                         "Example: --log-tz=-5 for US Eastern, --log-tz=1 for CET. "
                         "The assumed timezone is recorded in the report.")
    ap.add_argument("--pinned-gpu", type=int, default=7, metavar="IDX",
                    help="GPU device index pinned to monai_server via docker-compose "
                         "device_ids (default: 7). LABELLING AID ONLY -- all host.gpuMB[*] "
                         "rows are informational regardless of this value, because "
                         "nvidia-smi --query-gpu=memory.used reports per-DEVICE usage, not "
                         "per-process. On a shared DGX the pinned GPU showed 26,929 MiB "
                         "total vs 826 MiB our process (about 3%%), so the row cannot support a "
                         "verdict. The annotated row is labelled to show which device is ours. "
                         "Process-scoped VRAM verdict comes from server.vram_alloc via --server. "
                         "Source: docker-compose.yml device_ids: ['7:0'].")
    ap.add_argument("--min-slope", type=float, default=0.2, metavar="MB_PER_CYCLE",
                    help="Minimum effect-size floor for Tier-2 MB verdicts (default: 0.2 "
                         "MB/cycle). A positive slope whose magnitude is below this floor is "
                         "reported as CLEAN even when the CI excludes zero — statistically "
                         "tight but physically meaningless. Set to 0 to disable. "
                         "Does NOT apply to Tier-1 integer counters (any growth is real).")
    a = ap.parse_args()

    here = os.path.dirname(os.path.abspath(__file__))
    client_path = a.client or max(glob.glob(os.path.join(here, "runs", "client-*.jsonl")), key=os.path.getmtime)
    recs = [json.loads(l) for l in open(client_path) if l.strip()]
    samples = [r for r in recs if r.get("kind") == "sample"]
    measures = [r for r in recs if r.get("kind") == "measure"]

    # Host stream
    host_recs = []
    host_glob = glob.glob(os.path.join(here, "runs", "host-*.jsonl"))
    if a.host or host_glob:
        hp = a.host or max(host_glob, key=os.path.getmtime)
        host_recs = [json.loads(l) for l in open(hp) if l.strip()]
    host_count = len(host_recs)

    # Resolve --log-tz to a datetime.timezone
    log_tz = datetime.timezone(datetime.timedelta(hours=a.log_tz))
    log_tz_label = f"UTC{a.log_tz:+.1f}" if a.log_tz else "UTC"

    # Server stream
    server_recs = []
    server_present = False
    server_skipped_counter_no_timestamp = 0
    server_skipped_non_counter_lines = 0
    server_timing_lines = 0
    server_inconclusive = False
    if a.server:
        server_recs = parse_server_log(a.server, log_tz=log_tz)
        server_present = True
        server_skipped_counter_no_timestamp = getattr(server_recs, "skipped_counter_no_timestamp", 0)
        server_skipped_non_counter_lines = getattr(server_recs, "skipped_non_counter_lines", 0)
        server_timing_lines = getattr(server_recs, "timing_lines", 0)
        # C7: ALL records unusable means the stream was provided but measured nothing.
        # This includes the case where [timing] lines exist but carry no counters
        # (server without MONAI_PERF_TRACE) — server_timing_lines > 0 makes that visible.
        if server_timing_lines > 0 and len(server_recs) == 0:
            server_inconclusive = True

    # Build rows.
    # Tier-1 counters are fitted on their phase-specific samples (see COUNTER_PHASE).
    # Block counters (segCount, blockCount, blockSlices) are fitted on 'studyOpen'
    # because onModeExit removes all segmentations before 'cycleEnd' is sampled.
    rows = ([tier1_verdict(samples, c, a.warmup, phase=COUNTER_PHASE.get(c, "cycleEnd")) for c in TIER1]
            + [tier2_verdict(samples, c, a.warmup, min_slope=a.min_slope) for c in TIER2]
            + parse_host_stream(host_recs, samples, a.warmup,
                                pinned_gpu=a.pinned_gpu, min_slope=a.min_slope)
            + tier2_verdicts_from_server(server_recs, samples, a.warmup, min_slope=a.min_slope)
            + [tier3_verdict(measures, n, a.warmup) for n in TIER3])

    from datetime import date
    results = {
        "generated": str(date.today()),
        "rows": rows,
        "gaps": check_gaps(host_recs),
        "host_count": host_count,
        "server_present": server_present if a.server else None,
        "server_skipped_counter_no_timestamp": server_skipped_counter_no_timestamp,
        "server_skipped_non_counter_lines": server_skipped_non_counter_lines,
        "server_timing_lines": server_timing_lines,
        "server_inconclusive": server_inconclusive,
        "log_tz_label": log_tz_label,
        "min_slope": a.min_slope,
    }
    report = render_report(results)

    out = a.out or os.path.join(here, "reports", f"{date.today()}-soak.md")
    d = os.path.dirname(out)
    if d:
        os.makedirs(d, exist_ok=True)
    open(out, "w").write(report)
    print(report)
    print(f"\nwritten to {out}")


if __name__ == "__main__":
    main()
