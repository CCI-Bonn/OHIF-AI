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

## Build speed

Measured results for the `ohif_viewer` container (all times in seconds; raw data in
`tools/perf/runs/build-bench.tsv`):

| scenario | before | after |
|---|---|---|
| no-op rebuild (no changes) | 152 s | 1.2 s |
| rebuild after a Playwright run | 143 s | 1 s |
| rebuild after a real source edit | 145 s | 63 s |

The `bundle_sha` column is a fingerprint of the served asset names. For the two unchanged-source
scenarios (`noop`, `after_playwright`) it held constant at `c41ddc24d5b5f890` across every task,
proving the build output did not change. The `after_source_edit` scenario intentionally modifies
source, so its hash necessarily differs between the before and after rows — that is expected; it
is a TIME-only scenario, not a hash-gate scenario. Do not treat the differing hash as a bug.

Know the gate's blind spot: `bundle_sha` fingerprints asset **filenames**, not their bytes. JS
chunks are chunkhashed, so any JS content change moves a filename and is caught — but CSS is
emitted as `[name].bundle.css` with no hash, so a CSS-only output change leaves the fingerprint
identical and slips through unnoticed.

Re-measure any time with:

```bash
bash tools/perf/build-bench.sh <label>
column -t -s $'\t' tools/perf/runs/build-bench.tsv
```

### What caused the slow builds

The original hypothesis (webpack was doing unnecessary work) was wrong. The real cause was that
docker-compose bind-mounts the **live Orthanc SQLite database and nginx logs** into paths inside
the viewer build context:

- `Viewers/platform/app/.recipes/Nginx-Orthanc/volumes/` — Orthanc database (WAL updated continuously)
- `Viewers/platform/app/.recipes/Nginx-Orthanc/logs/` — nginx access/error logs

Orthanc writes its WAL on every query, so every `docker compose build` saw a changed build context
and invalidated `COPY ./`, forcing a full webpack rebuild even with zero source changes. Playwright's
`test-results/.last-run.json` had the same effect. The fix was adding `.dockerignore` entries only —
the bind-mount lines in `docker-compose.yml` were deliberately left untouched (that file is never
committed in this project).

Three things make builds fast now, and each can be reverted independently:

**1. `Viewers/.dockerignore` excludes volatile runtime files.**
Without these entries, the Orthanc WAL and Playwright output invalidate `COPY ./` on every build,
forcing a full ~100 s webpack rebuild even with zero source changes.

**2. webpack's filesystem cache is persisted via a BuildKit cache mount.**
`webpack.base.js` always asked for `cache: { type: 'filesystem' }`, but the cache directory lived
in the builder stage's filesystem layer and was thrown away with it, so it never helped. The
Dockerfile now mounts that directory as a BuildKit cache so it survives across builds. The mount
targets webpack's **default** cache location
(`platform/app/node_modules/.cache/webpack` — webpack walks up from cwd to the nearest
`package.json`, and lerna runs the build inside `platform/app`). The config deliberately does not
pin an absolute `cacheDirectory`: `webpack.pwa.js` also backs host-side `yarn dev` / `yarn build`,
and a container-only path such as `/usr/src/app/...` is not writable on a developer host — webpack
would degrade to a `Caching failed for pack` warning and silently run with no cache.

Because the overrides are files inside `node_modules`, `webpack.pwa.js` also sets
`snapshot.unmanagedPaths` for the three override roots. Without it, webpack validates managed
(`node_modules`) files by package `name@version` instead of content, and an edited override yields
a stale cache hit with no warning. **Do not delete that block.**

If you ever suspect stale webpack output, clear the cache with:

```bash
docker builder prune --filter type=exec.cachemount
```

**3. `Viewers/backup/esm/` mirrors `node_modules/` and is applied with a single COPY.**
To add a new cornerstone override, put the file at its real `node_modules`-relative path under
`backup/esm/` — **do not edit the Dockerfile**. Example: to override
`@cornerstonejs/tools/dist/esm/eventListeners/imageSpacingCalibratedEventListener.js`, place it at
`Viewers/backup/esm/@cornerstonejs/tools/dist/esm/eventListeners/imageSpacingCalibratedEventListener.js`.

#### Critical warnings for the ESM override tree

- **The `!backup/esm/**` exception in `.dockerignore` must not be removed.** Every mirror path
  contains `dist/` (e.g. `@cornerstonejs/tools/dist/esm/...`), and `.dockerignore` has a
  `**/dist/` rule. The `!backup/esm/**` exception re-includes the entire mirror tree. If someone
  removes that exception, the `COPY ./backup/esm/ /usr/src/app/node_modules/` instruction silently
  copies **nothing**, the build still succeeds, and every override vanishes from the bundle with
  no error message. The symptom is subtle behavioral regression, not a build failure.

- **A file placed in `backup/esm/` is active by definition.** There is no way to have a disabled
  override inside the mirror tree — keep any deliberately-disabled override outside it.

- **Two overrides live OUTSIDE the mirror tree** in sibling directories with their own COPY lines:
  - `Viewers/backup/dcmjs/dcmjs.es.js`
  - `Viewers/backup/vtkjs/ImageMarchingSquares.js`

  These have no replacement in `backup/esm/` by design. A reader who searches only `backup/esm/`
  will find no entry for them and may conclude they are unneeded — they are not. Both have
  explicit `COPY` lines in the Dockerfile for exactly this reason.

### Verifying that overrides survived a rebuild

```bash
# Exercise the real deployed bundle end-to-end
node tools/perf/preflight.js

# Grep the served bundle for known override markers
docker exec ohif_viewer sh -c 'grep -l "_disableHandler" /var/www/html/*.js'
docker exec ohif_viewer sh -c 'grep -l "_toolGroupViewportAddedHandler" /var/www/html/*.js'
```

Both greps must return at least one filename. An empty result means the override was not
included in the bundle — check the `.dockerignore` exception first.

These two symbols are introduced by the overrides and do **not** exist in the corresponding
upstream files, so they discriminate. Do not add `_onEvent` to this list: it is present in the
UNPATCHED upstream `Synchronizer.js` as well, so it matches whether or not the override landed —
a passing grep would prove nothing.

For a stronger, marker-free check, compare each file under `Viewers/backup/esm/` byte-for-byte
against the matching `sourcesContent` entry in the shipped `.js.map` files. Note that
`addLabelmapToElement.js` and `removeLabelmapFromElement.js` are orphaned in the currently
installed cornerstone version (nothing imports them), so 27 of the 29 overrides is the expected
full-pass result.
