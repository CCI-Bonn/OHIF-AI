# Perf telemetry & leak soak

Flag-gated instrumentation for the OHIF viewer, the MONAI Label inference server, and the host.
**Everything is OFF by default.** With all flags off, `main` behaves exactly as before: no-op stubs
bound once at module load, `window.__ohifPerf` undefined, the server's `[timing]` line byte-identical,
and `torch.cuda` never touched (it forces a device sync).

| Flag | Effect |
|---|---|
| `?perf=1` or `localStorage.ohifPerf=1` | client telemetry + `window.__ohifPerf` |
| `MONAI_PERF_TRACE=1` | server counters appended to the `[timing]` line |
| `?perfLeak=1` (via `PERF_LEAK=1` env for the soak) | client positive control — retains 8 MB/call |
| `MONAI_PERF_LEAK=1` | server positive control — retains 64 MB/request, hard-capped at 4 GB |

---

## Read this before the first run

Three whole-branch reviews produced two operator-facing warnings. Both will cost you a run if ignored.

**1. `docker-compose.yml` has no `MONAI_PERF_TRACE` passthrough.** That file is deliberately never
committed (it carries your local port/GPU edits), so you must add this by hand under
`monai_server.environment`:

```yaml
      - MONAI_PERF_TRACE=${MONAI_PERF_TRACE:-0}
      - MONAI_PERF_LEAK=${MONAI_PERF_LEAK:-0}
```

Setting the variable in your shell alone does **nothing** — compose only forwards what the service
lists. Without this the server stream is `INCONCLUSIVE` by construction.
`docker compose restart` does **not** re-read environment variables; use `--force-recreate`.

**2. Run `node tools/perf/preflight.js` first** (see below), then do a 3-cycle smoke run before the 30-cycle soak. `promptPoints` in `fixture.json` are
normalized canvas coordinates that have **never been executed against a real render**. This is the
single most likely thing to fail. The driver asserts a segment actually appeared and fails loudly, so
a bad coordinate aborts rather than soaking a no-op — but expect to tune those numbers.

---

## REQUIRED: pre-flight instrument check

**Run this before every soak.** It loads the fixture study in a real browser, samples the
client counters in stack and MPR, and fails if any instrument cannot be read.

```bash
node tools/perf/preflight.js          # uses fixture.json's primary study
```

Uses the system Chrome (`/usr/bin/google-chrome` is present on this host) via Playwright's
`channel: 'chrome'` — no `npx playwright install` download required.

Why it is required, not optional: every client counter is unit-tested against fake objects,
and several only fail on contact with real cornerstone state. Three whole-branch code reviews
missed three separate `volMB` defects that this check found in one run — including one that
would have made **every** soak report `INCONCLUSIVE`. It costs a minute; a soak costs an hour
of shared GPU time.

Known and accepted: `volMB` is unreadable in cornerstone 5.x (streaming voxel managers have no
materialized scalar data, so `ImageVolume.sizeInBytes` throws). It is allow-listed in
`analyze.py` so it cannot block a verdict. `volCount` is the load-bearing volume-leak signal —
this project's historic MPR leak showed up as `volCount` growing while `cacheMB` stayed flat.


## Running a soak

```bash
# 0. add the compose passthrough above (uncommitted), then:
docker compose build ohif_viewer monai_server
MONAI_PERF_TRACE=1 docker compose up -d --force-recreate ohif_viewer monai_server
docker exec monai_server printenv MONAI_PERF_TRACE      # must print 1

# 1. host sampler (read-only; never modifies a container)
bash tools/perf/sample_host.sh &

# 2. VERIFY THE FIRST 3 TICKS before continuing — see "Sanity checks" below

# 3. smoke run: set cycles=3, refinesPerCycle=1 in fixture.json first
cd Viewers && npx playwright test --config ../tools/perf/playwright.perf.config.ts

# 4. full soak (restore cycles=30, refinesPerCycle=5)
cd Viewers && npx playwright test --config ../tools/perf/playwright.perf.config.ts

# 5. analyze
python3 tools/perf/analyze.py --server <(docker compose logs monai_server)

# 6. clean up ONLY the SEGs this run created — dry run first, always
python3 tools/perf/cleanup_orthanc.py            # review the "would delete" list
python3 tools/perf/cleanup_orthanc.py --apply
```

### Sanity checks that are not optional

Read the sampler's **first three ticks** and confirm all of:

- `container` records for **all three** of `ohif_viewer`, `ohif_orthanc`, `monai_server`
- at least one `gpu` record
- `disk` records for **both** `orthanc-db` and `img_cache`

A missing series is now named as `NO_DATA` and forces `INCONCLUSIVE` (it used to vanish silently and
read CLEAN) — but catching it at tick 3 beats discovering it after an hour.

The real sampler cadence is **~4.5 s**, not the 2 s the gap detector assumes, so an occasional
spurious gap warning is expected when `du` runs long on the 2.4 GB Orthanc DB.

---

## Validating the detector before trusting a green result

A clean report is only meaningful if the detector demonstrably fires. Run a short soak with both
controls armed:

```bash
MONAI_PERF_TRACE=1 MONAI_PERF_LEAK=1 docker compose up -d --force-recreate monai_server
PERF_LEAK=1 npx playwright test --config ../tools/perf/playwright.perf.config.ts
```

Expected: **`LEAK/DEGRADED FOUND`**, with `heapMB` showing a Tier-2 slope whose CI excludes zero and
`server.rssMB` climbing. The run asserts that `[perfLeak] POSITIVE CONTROL ACTIVE` was actually
observed, so a control that failed to arm aborts instead of producing a misleading pass.

**Do not expect Tier 1 to move.** The client control retains image *references*, growing the heap
without creating volumes or blocks. Tier 1's growth-detection logic is pinned by the `analyze.py`
unit tests instead. If `heapMB` comes back CLEAN, the detector is broken — stop and fix it.

`MONAI_PERF_LEAK=1` costs up to **4 GB RSS** on a shared machine. Check free memory first.

---

## Reading the report

**Verdict-bearing rows** — these are the ones that matter:

| Tier | Counters | Phase |
|---|---|---|
| 1 (must return to baseline) | `volCount`, `listenerCount`, `viewportCount` | `cycleEnd` (at rest) |
| 1 | `segCount`, `blockCount`, `blockSlices` | `studyOpen` (in-study — they don't exist at rest) |
| 2 (slope must span zero) | `heapMB`, `cacheMB`, `server.rssMB`, `server.vramMB`, per-container `memMB` | `cycleEnd` |
| 3 (degradation) | `nninter`, `nninterRecovered` | per-action |

**Informational rows are excluded from the verdict on purpose:**
- `host.diskMB[orthanc-db]` — the soak writes ~10 SEGs into the DB it measures, so it always grows.
- `host.gpuMB[*]` — **all** GPU rows, including the one our server runs on. `nvidia-smi
  --query-gpu=memory.used` is per-DEVICE and this is a shared DGX: measured on GPU 7,
  `monai_server` held 826 MiB of 26,929 MiB in use. A neighbouring job would swamp or fake a
  leak. `--pinned-gpu` (default 7) now only *labels* which row is ours.
  **`server.vramMB` is the only VRAM signal that can support a verdict** — it comes from
  `torch.cuda.memory_allocated()` inside our own process, so it is correctly attributed.
  Without `--server`, VRAM is effectively unmonitored for verdict purposes.
- `volMB` — allow-listed: cornerstone 5.x streaming voxel managers make `sizeInBytes` throw, so it
  is usually NO_DATA. `volCount` (Tier 1) is the load-bearing volume-leak signal.

**`INCONCLUSIVE` is a failed run, not a soft pass.** It means a collector produced nothing. Read the
named reason, fix the collector, re-soak. A verdict of `CLEAN` from a half-broken pipeline is the one
outcome this whole tool exists to prevent, so missing data is escalated rather than ignored.

Slopes below `--min-slope` (default 0.2 MB/cycle, the spec's own floor) report CLEAN even when
statistically tight — sub-megabyte drift over a whole run is not a leak.

---

## What a CLEAN verdict does *not* cover

Record these alongside any green result; the soak does not exercise them:

- **SEG export → reload.** The soak exports but never reloads. Given this project's history, SEG
  reload is its most leak-prone path, and `blockCount`/`blockSlices` is precisely the instrument
  built to catch it. This is the most consequential gap.
- **SAM2**, `remount`/`postSeg` legs, and the refine sub-legs (`netOut`…`sliceWrite`) — not emitted.
- **`sessions` / `threads` / `queue_depth`** — emitted by the server, consumed by nothing. The
  bounded-monotonic session check and the PR #69 backlog signal are not implemented.
- Tier 1 compares final-vs-baseline, not true monotonicity: a sawtooth reclaimed on the last cycle
  reads CLEAN, and a transient `+1` on the last cycle reads LEAK.
- A perfectly frozen collector is indistinguishable from a genuinely flat one.

## fixture.json is not in the repo

`fixture.json` holds DICOM study/series UIDs from a real archive plus machine-specific URLs and
tuning, so it is gitignored. Copy `fixture.example.json` to `fixture.json` and fill in UIDs from
your own Orthanc. Both `preflight.js` and `soak.spec.ts` fail with an explicit message if the file
is missing or still contains `REPLACE_WITH` placeholders, rather than proceeding on bad input.

`promptPoints` are normalised canvas coordinates and must land inside the anatomy of your series;
if inference returns empty masks, re-tune them first.
