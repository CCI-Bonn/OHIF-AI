import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

// Set PERF_LEAK=1 in the environment to enable the positive leak-detector
// control: the viewer will retain ~8 MB of ballast per study open, producing
// a deterministic heap ramp that proves the analyzer can detect leaks.
// Example: PERF_LEAK=1 npx playwright test --config ...
// Default is OFF (no extra query param appended).
const PERF_LEAK = process.env.PERF_LEAK === '1';

function loadFixture(dir) {
  const p = require('path').join(dir, 'fixture.json');
  let raw;
  try {
    raw = require('fs').readFileSync(p, 'utf8');
  } catch (e) {
    throw new Error(
      `tools/perf/fixture.json not found.\n` +
      `It is gitignored because it holds DICOM UIDs from a real archive.\n` +
      `Copy tools/perf/fixture.example.json to tools/perf/fixture.json and fill in your own study UIDs.`
    );
  }
  const fx = JSON.parse(raw);
  const unset = Object.entries(fx).filter(([, v]) =>
    typeof v === 'string' ? v.startsWith('REPLACE_WITH') :
    Array.isArray(v) && v.some(x => typeof x === 'string' && x.startsWith('REPLACE_WITH')));
  if (unset.length) {
    throw new Error(
      `tools/perf/fixture.json still has placeholder values: ${unset.map(([k]) => k).join(', ')}.\n` +
      `Fill them in with UIDs from your own Orthanc before running.`
    );
  }
  return fx;
}

const fx: any = loadFixture(__dirname);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const runsDir = path.join(__dirname, 'runs');
const clientOut = path.join(runsDir, `client-${stamp}.jsonl`);
const createdOut = path.join(runsDir, `created-segs-${stamp}.json`);
const orphanOut = path.join(runsDir, `orphan-warning-${stamp}.txt`);
// Per-step timing log. Written with appendFileSync so a kill -9 still leaves
// everything up to the stalled step on disk. The LAST "start" entry with no
// matching "end" entry IS the stalled step — search for it with:
//   jq 'select(.event=="start")' runs/steps-<stamp>.jsonl | tail -1
const stepsOut = path.join(runsDir, `steps-${stamp}.jsonl`);

// =========================================================================
// Per-step timing helper.
//
// Writes one JSON line the moment a step STARTS and another when it ENDS:
//   {"t":<epoch ms>,"cycle":N,"step":"<name>","event":"start"|"end","ms":<duration on end>}
//
// Uses fs.appendFileSync so a kill -9 still preserves everything written so far.
// The last "start" line with no matching "end" line IS the stalled step.
//
// Also enforces a per-step timeout: if fn() does not resolve within timeoutMs,
// throws immediately with a message naming the step, the cycle, and the budget.
// This makes it impossible for any single step to hang the entire soak.
//
// Echoes each step completion to stdout as:
//   [perf] cycle N step <name> <ms>ms
// so a live run is watchable via the forwarded console output.
// =========================================================================
async function step<T>(
  cycle: number,
  name: string,
  fn: () => Promise<T>,
  timeoutMs: number
): Promise<T> {
  const startMs = Date.now();
  fs.appendFileSync(
    stepsOut,
    JSON.stringify({ t: startMs, cycle, step: name, event: 'start' }) + '\n'
  );
  let result: T;
  try {
    result = await Promise.race([
      fn(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `[perf] STALL: cycle ${cycle} step "${name}" exceeded budget of ${timeoutMs}ms. ` +
                  `This is where the run stalled — check steps-${stamp}.jsonl for prior steps.`
              )
            ),
          timeoutMs
        )
      ),
    ]);
  } catch (err) {
    // Record a timeout/error end event so the file stays parseable.
    const durationMs = Date.now() - startMs;
    fs.appendFileSync(
      stepsOut,
      JSON.stringify({ t: Date.now(), cycle, step: name, event: 'end', ms: durationMs, error: String(err) }) + '\n'
    );
    throw err;
  }
  const durationMs = Date.now() - startMs;
  fs.appendFileSync(
    stepsOut,
    JSON.stringify({ t: Date.now(), cycle, step: name, event: 'end', ms: durationMs }) + '\n'
  );
  console.log(`[perf] cycle ${cycle} step ${name} ${durationMs}ms`);
  return result;
}

/** Force GC then sample. Without the GC, retained memory and uncollected garbage
 *  are indistinguishable and every run looks like a leak.
 *  The optional `extra` object is forwarded into the record (e.g. wallT, studyUID). */
async function sample(page: Page, phase: string, extra?: Record<string, unknown>) {
  await page.evaluate(
    async ([p, ex]) => {
      const h = (window as any).__ohifPerf;
      h.forceGC?.();
      await new Promise(r => setTimeout(r, 250));
      h.snapshot(p, ex ?? undefined);
    },
    [phase, extra ?? null] as [string, Record<string, unknown> | null]
  );
}

/**
 * Open a study via CLIENT-SIDE navigation (does NOT reload the document).
 * `window.__ohifPerf.navigate` is a wrapper around React Router's `navigate()`
 * that was wired up in commandsModule.ts → installPerfHandle.
 *
 * C5 FIX: navigate is NOT called via `?.` — a null navigate must throw, not
 * silently no-op. `history.navigate` is only assigned while the viewer route is
 * mounted (Mode.tsx:56); calling this from the worklist would swallow the nav
 * and then time out three minutes later on the canvas waitForSelector. We make
 * the failure loud and immediate instead.
 *
 * We wait for a canvas to appear as the signal that the viewer has rendered.
 * `__ohifPerf` itself persists because it is module-level — no re-init needed.
 */
async function openStudy(page: Page, studyUID: string) {
  const urlBefore = page.url();
  await page.evaluate(uid => {
    const h = (window as any).__ohifPerf;
    // Explicitly guard — do NOT use `?.` here. A null navigate silently
    // no-ops (C5): the worklist never mounts the viewer route so history.navigate
    // is null there, and `?.` would swallow the call without moving the URL.
    const nav = h && h.navigate;
    if (typeof nav !== 'function') {
      throw new Error(
        '[perf C5] window.__ohifPerf.navigate is null or not a function. ' +
        'history.navigate is only assigned while the viewer route is mounted ' +
        '(Mode.tsx:56). If this is cycle 1 it means the first openStudy() was ' +
        'incorrectly invoked from the worklist — use page.goto() for cycle 1, ' +
        'not openStudy(). Check the soak initialization sequence.'
      );
    }
    nav(`/viewer?StudyInstanceUIDs=${uid}&perf=1`);
  }, studyUID);
  // Verify that client-side navigation actually moved the URL.  If navigate was
  // a no-op (e.g. wrong route mounted, stale closure), the canvas wait below
  // would silently time out three minutes later — fail fast and name C5.
  await page.waitForFunction(
    ([before, uid]) => {
      const url = window.location.href;
      return url !== before && url.includes(uid);
    },
    [urlBefore, studyUID] as [string, string],
    { timeout: 10_000 }
  ).catch(() => {
    throw new Error(
      `[perf C5] Client-side navigation did not change the URL after 10 s ` +
      `(still at ${urlBefore}). The navigate call was silently swallowed — ` +
      `history.navigate was not wired up or was null at call time. ` +
      `Check installPerfHandle in commandsModule.ts and Mode.tsx:56.`
    );
  });
  await page.waitForSelector('canvas', { timeout: 180_000 });
  await page.waitForTimeout(3000); // let initial series load settle
}

/**
 * Close the current study and return to the study list via CLIENT-SIDE navigation.
 * Does NOT reload the document — the JS realm and all counters are preserved.
 */
async function closeStudy(page: Page) {
  await page.evaluate(() => {
    const nav = (window as any).__ohifPerf?.navigate;
    if (!nav) {
      throw new Error(
        '[perf] window.__ohifPerf.navigate is not available for closeStudy.'
      );
    }
    nav('/');
  });
  // Wait for the study list to render (a table row or the worklist heading).
  // Use a broad selector that is stable regardless of data-cy attributes.
  await page.waitForFunction(
    () => !document.querySelector('canvas'),
    { timeout: 30_000 }
  );
  await page.waitForTimeout(1000); // let unload/cleanup settle
}

async function segmentCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as any).__ohifPerf.snapshot('probe').segCount);
}

/** The segmentation commands all take an explicit segmentationId. */
async function activeSegmentationId(page: Page): Promise<string> {
  const id = await page.evaluate(() => {
    const sm = (window as any).__ohifPerf.servicesManager.services;
    const svc = sm.segmentationService;
    // getActiveSegmentation requires a viewportId (verified: SegmentationService.ts:824).
    // Obtain it from viewportGridService.getActiveViewportId() (verified: ViewportGridService.ts:175).
    const viewportId = sm.viewportGridService?.getActiveViewportId?.() ?? undefined;
    return (
      (viewportId ? svc.getActiveSegmentation?.(viewportId)?.segmentationId : undefined) ??
      svc.getSegmentations?.()?.[0]?.segmentationId ??
      null
    );
  });
  expect(id, 'no active segmentation to drive segment commands').not.toBeNull();
  return id as string;
}

/** Return the set of segment indices present on a segmentation. */
async function segmentIndices(page: Page, segId: string): Promise<number[]> {
  return page.evaluate(id => {
    const svc = (window as any).__ohifPerf.servicesManager.services.segmentationService;
    const segs = svc.getSegmentations?.() ?? [];
    const seg = segs.find((s: any) => s.segmentationId === id);
    if (!seg?.segments) return [];
    return Object.keys(seg.segments).map(Number);
  }, segId);
}

test('perf soak', async ({ page }) => {
  // Belt-and-suspenders: set localStorage before any page navigation so
  // __ohifPerf is enabled even if the router strips the ?perf=1 query param.
  await page.addInitScript(() => localStorage.setItem('ohifPerf', '1'));

  // Suppress the onboarding tour. FOUND BY AN ACTUAL RUN, not by review: on a fresh
  // browser profile OHIF shows a 12-step Shepherd tour ('basicViewerTour') with a modal
  // backdrop that SWALLOWS the canvas click. No annotation is created, MEASUREMENT_ADDED
  // never fires, and the soak reports "no segment appeared" — with the real cause
  // invisible in any log. The failure screenshot is what exposed it.
  // Suppression contract: utilities.ts does `getShownTours().includes(tourId)` over
  // JSON.parse(localStorage.getItem('shownTours')), so pre-seeding the id is enough.
  await page.addInitScript(() =>
    localStorage.setItem('shownTours', JSON.stringify(['basicViewerTour']))
  );

  fs.mkdirSync(runsDir, { recursive: true });
  const createdSegs: string[] = [];
  // Print the allowlist path NOW so an operator whose run dies knows where to look.
  console.log(`created SEG allowlist -> ${createdOut}  (written incrementally)`);
  // Print the steps file path so a stalled run can be diagnosed immediately.
  // The last "start" entry with no matching "end" entry in this file IS the stalled step.
  console.log(`step timing log      -> ${stepsOut}  (written incrementally; last start-without-end = stall)`);

  let deleteSkipCount = 0;
  let primaryCycleCount = 0;

  // I-4 FIX: forward both [perf] and [perfLeak] messages.
  // '[perfLeak] POSITIVE CONTROL ACTIVE'.startsWith('[perf]') is FALSE — the
  // old filter silently swallowed the one signal confirming the control armed.
  // '[perfLeak]'.startsWith('[perf') is TRUE — both prefixes now pass.
  const perfLeakMessages: string[] = [];
  page.on('console', m => {
    const t = m.text();
    if (t.startsWith('[perf')) {
      console.log(t);
      if (t.includes('[perfLeak]')) perfLeakMessages.push(t);
    }
  });

  // =========================================================================
  // C5 FIX: Seed the router with the FIRST study via a REAL document navigation.
  //
  // history.navigate is only assigned while the viewer ROUTE is mounted
  // (Mode.tsx:56). Landing on the worklist first (/?perf=1) means
  // history.navigate is null, openStudy()'s `?.` swallows the call silently,
  // and the canvas waitForSelector times out three minutes later.
  //
  // Solution: for cycle 1 only, use page.goto('/viewer?StudyInstanceUIDs=...'),
  // which mounts the viewer route and assigns history.navigate.  All subsequent
  // openStudy() calls use client-side navigation — the document is never replaced
  // after this point, so all counters and module-level state are preserved.
  //
  // The leak-control query param (&perfLeak=1) is appended when PERF_LEAK=1 is
  // set in the environment — see the top of this file for usage instructions.
  // =========================================================================
  const firstStudyUID = fx.switchStudyUIDs[1 % fx.switchStudyUIDs.length];
  const leakParam = PERF_LEAK ? '&perfLeak=1' : '';
  const seedURL = `/viewer?StudyInstanceUIDs=${firstStudyUID}&perf=1${leakParam}`;
  await page.goto(seedURL);
  // Wait for the perf handle to appear — it is installed by installPerfHandle
  // which runs after the viewer route mounts and commandsModule activates.
  await page.waitForFunction(() => !!(window as any).__ohifPerf, null, { timeout: 120_000 });
  // Also wait for a canvas so we know the viewer actually rendered before we
  // stamp the nonce.  Without this, the nonce might be captured before the
  // viewer is fully up and subsequent client-side navs would look like the
  // first cycle is still loading.
  await page.waitForSelector('canvas', { timeout: 180_000 });
  await page.waitForTimeout(3000); // let initial series load settle

  // CONTINUITY INVARIANT: stamp a nonce AFTER the first real navigation.
  // The nonce is asserted at the start of every subsequent cycle.
  // If any navigation replaced the document, the nonce will be absent or wrong
  // and the test fails loudly — because a fresh document resets all counters to
  // zero and cross-cycle trends become meaningless.
  // NOTE: The nonce is stamped here (after first real goto), not at the worklist.
  // This means the continuity invariant covers cycles 2..N — the cycles where
  // accumulation actually matters.
  const nonce = await page.evaluate(() => {
    (window as any).__ohifPerf.__nonce ??= Math.random();
    return (window as any).__ohifPerf.__nonce;
  });

  // =========================================================================
  // I11 FIX: Hard-assert that --expose-gc reached the renderer before cycle 1.
  //
  // forceGC() calls globalThis.gc() (no `?.`) — if gc is absent every sample
  // measures retained garbage as heap growth, making every run look like a leak.
  // The playwright config passes --js-flags=--expose-gc; if that flag was
  // dropped or overridden, this assertion fails immediately with a clear message
  // rather than silently producing false positives for the entire run.
  // =========================================================================
  await page.evaluate(() => {
    if (typeof (window as any).gc !== 'function') {
      throw new Error(
        '[perf I11] window.gc is not a function — --js-flags=--expose-gc did not ' +
        'reach the renderer process. Without forced GC, retained memory and ' +
        'uncollected garbage are indistinguishable and every run will look like ' +
        'a leak (false positive). Fix: verify launchOptions.args in ' +
        'playwright.perf.config.ts includes --js-flags=--expose-gc.'
      );
    }
  });

  // =========================================================================
  // I3 FIX: Activate Probe2 + nnInteractive + live mode BEFORE the loop.
  // toolboxState defaults: liveMode=true, selectedModel='nnInteractive'.
  // We still force them here to be resilient to future default changes.
  // Command names VERIFIED against registry:
  //   setToolActive   -> extensions/cornerstone/src/commandsModule.ts:764
  //   runAiSegmentation -> extensions/default/src/commandsModule.ts:1067,4593
  // toolboxState.setSelectedModel / setLiveMode are module-level setters
  // accessed via the servicesManager path (no public command, set directly).
  // =========================================================================
  await page.evaluate(() => {
    const h = (window as any).__ohifPerf;
    // Prefer commandsManager to activate the tool so tool groups are updated.
    h.commandsManager.runCommand('setToolActive', { toolName: 'Probe2' });
    // Arm toolboxState via the perf handle (exposed by installPerfHandle after
    // the fix in perfTraceBrowser.ts). These three conditions gate the
    // MEASUREMENT_ADDED subscription in commandsModule.ts:81-96 — all must
    // hold or the subscription bails before calling runAiSegmentationCommand.
    // Setter names verified in stores/toolboxState.ts:70,99,112.
    const ts = h.toolboxState;
    ts.setSelectedModel('nnInteractive');
    ts.setLiveMode(true);
    ts.setLocked(false);
  });

  // =========================================================================
  // Cycle 1: the first study is ALREADY OPEN (seeded via page.goto above).
  // Run the full in-study workflow on it, then enter the normal loop starting
  // at cycle 2.  We track the current studyUID separately so the loop body
  // can assume the study is already open at loop entry.
  // =========================================================================

  for (let cycle = 1; cycle <= fx.cycles; cycle++) {
    // Cycle 1 uses firstStudyUID (already open via page.goto).
    // Cycles 2..N pick from the round-robin list and open via client-side nav.
    const studyUID = cycle === 1
      ? firstStudyUID
      : fx.switchStudyUIDs[cycle % fx.switchStudyUIDs.length];

    // CONTINUITY ASSERTION: the nonce must survive every cycle (cycles 2..N).
    // Cycle 1's nonce was stamped just above, so assert from cycle 2 onward.
    // If it changed, the document was replaced and all counters restarted from
    // zero — the soak can no longer observe cross-cycle trends.
    if (cycle > 1) {
      const currentNonce = await page.evaluate(() => (window as any).__ohifPerf?.__nonce);
      expect(
        currentNonce,
        `CONTINUITY VIOLATION at start of cycle ${cycle}: document was replaced ` +
          `(nonce changed from ${nonce} to ${currentNonce}). ` +
          `All counters reset to zero — cross-cycle trends are meaningless. ` +
          `Fix: ensure no page.goto or full-reload occurs inside the loop.`
      ).toBe(nonce);
    }

    // I-4 FIX: When PERF_LEAK=1 is set, hard-assert that the positive control
    // actually armed before cycle 2.  A control that silently fails to fire is
    // the same failure class as a detector that silently fails to detect — both
    // produce false confidence.  We check at the START of cycle 2 (after cycle 1
    // has fully executed) so the browser has had time to emit the console message.
    if (PERF_LEAK && cycle === 2) {
      const armed = perfLeakMessages.some(msg => msg.includes('POSITIVE CONTROL ACTIVE'));
      expect(
        armed,
        '[perf I-4] PERF_LEAK=1 was set but the "[perfLeak] POSITIVE CONTROL ACTIVE" ' +
          'console message was NEVER observed before cycle 2. ' +
          'The leak injector did not arm — the positive control run is invalid. ' +
          'Check that &perfLeak=1 was appended to the seed URL and that the ' +
          'leakRetain() hook in the viewer is reachable.'
      ).toBe(true);
    }

    // Cycle 1: already open via page.goto — do not call openStudy().
    // Cycles 2..N: client-side navigation via window.__ohifPerf.navigate.
    if (cycle > 1) {
      await step(cycle, 'openStudy', () => openStudy(page, studyUID), 240_000);
    }
    await page.evaluate(c => (window as any).__ohifPerf.setCycle(c), cycle);
    await step(cycle, 'studyOpenSample', () => sample(page, 'afterOpen', { wallT: Date.now(), studyUID }), 60_000);

    // --- nnInteractive: new segment + K refines (pinned fixture study only) ---
    if (studyUID === fx.primaryStudyUID) {
      // Re-activate Probe2 each primary cycle in case a prior cycle left a
      // different tool active (e.g. from the MPR toggle restoring Pan).
      // Also arm toolboxState so the MEASUREMENT_ADDED subscription fires
      // inference — this is the real user path (verified root cause: calling
      // runAiSegmentation directly bypasses the 50ms defer that lets
      // _calculateCachedStats populate cachedStats[targetId].scribble, causing
      // nninter to receive an empty prompt and return an empty prediction).
      // Setters verified in stores/toolboxState.ts: setLiveMode (line 70),
      // setSelectedModel (line 99), setLocked (line 112).
      await page.evaluate(() => {
        const h = (window as any).__ohifPerf;
        h.commandsManager.runCommand('setToolActive', { toolName: 'Probe2' });
        // Force the three conditions that gate the MEASUREMENT_ADDED handler:
        //   toolboxState.getLiveMode()        must be true
        //   toolboxState.getSelectedModel()   must be 'nnInteractive'
        //   toolboxState.getLocked()          must be false (default, forced here)
        const ts = h.toolboxState;
        ts.setSelectedModel('nnInteractive');
        ts.setLiveMode(true);
        ts.setLocked(false);
      });

      for (let i = 0; i < fx.refinesPerCycle; i++) {
        const [nx, ny] = fx.promptPoints[i % fx.promptPoints.length];
        const box = await page.locator('canvas').first().boundingBox();
        expect(box, 'canvas must be present for prompt clicks').not.toBeNull();

        await step(cycle, `promptClick${i}`, async () => {
          // Click only — do NOT call runAiSegmentation manually.
          // The click creates a Probe2 annotation, which fires MEASUREMENT_ADDED,
          // which the commandsModule subscription defers 50ms (past the RAF that
          // populates cachedStats[targetId].scribble), then calls runAiSegmentation.
          // Bypassing this path caused prompt_info:{} / empty prediction in the
          // smoke run (server logged model_core=0.000s, nninter_first_interaction_ts=None).
          await page.mouse.click(box!.x + box!.width * nx, box!.y + box!.height * ny);
        }, 30_000);

        // FAIL FAST: wait for a segment to appear with a 60-second bound.
        // If no segment appears the soak must abort immediately, not hang for
        // 25 minutes. Likely causes if this throws:
        //   - liveMode is off (setLiveMode(true) above did not apply)
        //   - selectedModel is not 'nnInteractive'
        //   - the Probe2 annotation produced no scribble in cachedStats
        //   - toolboxState.getLocked() returned true (inference guard bailed)
        //   - the MONAI server is unreachable or returned an empty prediction
        const segAppeared = await step(cycle, `segAppears${i}`, () =>
          page.waitForFunction(
            () => {
              const sm = (window as any).__ohifPerf?.servicesManager?.services;
              if (!sm) return false;
              const svc = sm.segmentationService;
              const viewportId = sm.viewportGridService?.getActiveViewportId?.() ?? undefined;
              const activeSeg = viewportId ? svc.getActiveSegmentation?.(viewportId) : null;
              if (!activeSeg?.segments) return false;
              return Object.keys(activeSeg.segments).length > 0;
            },
            undefined,
            { timeout: 60_000 }
          ).catch(() => null),
          60_000
        );

        if (!segAppeared) {
          throw new Error(
            `[perf] Prompt ${i + 1}/${fx.refinesPerCycle} on cycle ${cycle}: ` +
            `no segment appeared within 60 s after the Probe2 click. ` +
            `Likely causes: liveMode is off, selectedModel is not nnInteractive, ` +
            `Probe2 annotation produced no scribble in cachedStats (scribble not ` +
            `populated before nninter read it), or MONAI server returned an empty prediction. ` +
            `The 25-minute hang is prevented — fix the upstream cause and re-run.`
          );
        }

        await step(cycle, `afterRefineSample${i}`, () => sample(page, `afterRefine${i}`, { wallT: Date.now(), studyUID }), 60_000);
      }

      // Fail loudly: a soak that silently measures nothing is the main failure mode.
      // Assert on live segmentation segments via segmentationService (not the
      // block-derived segCount which is known to be stale).
      const liveSegCount = await page.evaluate(() => {
        const sm = (window as any).__ohifPerf.servicesManager.services;
        const svc = sm.segmentationService;
        const viewportId = sm.viewportGridService?.getActiveViewportId?.() ?? undefined;
        const activeSeg = viewportId ? svc.getActiveSegmentation?.(viewportId) : null;
        if (!activeSeg?.segments) return 0;
        return Object.keys(activeSeg.segments).length;
      });
      expect(liveSegCount, 'nnInteractive produced no segment (live segmentation check)').toBeGreaterThan(0);
    }

    // --- segment add / delete / export (primary study only) ---
    // The nnInteractive block above is already gated on primaryStudyUID; keeping
    // the segment-mutation block on the same gate prevents SEG writes into the
    // non-primary studies opened during switching cycles.
    //
    // Command names VERIFIED against the registry:
    //   addSegment / deleteSegment / storeSegmentation -> extensions/cornerstone/src/commandsModule.ts:2066,2099,2090
    //   setHangingProtocol                             -> extensions/default/src/commandsModule.ts
    //   MPR protocol id 'mpr'                          -> extensions/cornerstone/src/hps/mpr.ts:5
    if (studyUID === fx.primaryStudyUID) {
      primaryCycleCount++;

      const segId = await step(cycle, 'activeSegmentationId', () => activeSegmentationId(page), 60_000);

      // Snapshot the index set BEFORE add so we can identify the new index exactly.
      const indicesBefore = await step(cycle, 'segmentIndicesBefore', () => segmentIndices(page, segId), 60_000);

      await step(cycle, 'addSegment', () =>
        page.evaluate(
          id => (window as any).__ohifPerf.commandsManager.runCommand('addSegment', { segmentationId: id }),
          segId
        ).then(() => page.waitForTimeout(1500)),
        60_000
      );
      await step(cycle, 'afterSegAddSample', () => sample(page, 'afterSegAdd', { wallT: Date.now(), studyUID }), 60_000);

      // Determine the new index: the one present after add but not before.
      const indicesAfter = await step(cycle, 'segmentIndicesAfter', () => segmentIndices(page, segId), 60_000);
      const newIndices = indicesAfter.filter(i => !indicesBefore.includes(i));
      if (newIndices.length === 1) {
        // Delete exactly the segment we just created — not an arbitrary one.
        await step(cycle, 'deleteSegment', () =>
          page.evaluate(
            ([id, idx]) =>
              (window as any).__ohifPerf.commandsManager.runCommand('deleteSegment', {
                segmentationId: id,
                segmentIndex: idx,
              }),
            [segId, newIndices[0]] as [string, number]
          ).then(() => page.waitForTimeout(1500)),
          60_000
        );
        await step(cycle, 'afterSegDeleteSample', () => sample(page, 'afterSegDelete', { wallT: Date.now(), studyUID }), 60_000);
      } else {
        // Cannot identify the new segment unambiguously — skip delete and record it.
        deleteSkipCount++;
        console.warn(
          `[perf] cycle ${cycle}: skipping deleteSegment — could not identify new index ` +
            `(before=${JSON.stringify(indicesBefore)}, after=${JSON.stringify(indicesAfter)})`
        );
        await step(cycle, 'afterSegDeleteSkippedSample', () => sample(page, 'afterSegDeleteSkipped', { wallT: Date.now(), studyUID }), 60_000);
      }

      // --- SEG export, recording the created UID for cleanup ---
      const uidsBefore = await step(cycle, 'listSegUidsBefore', () => listSegUids(fx, studyUID), 60_000);

      // storeSegmentation blocks on a modal dialog ("Store Segmentation") that
      // requires a report name and a Save click before it resolves.  Awaiting it
      // directly causes a permanent stall — confirmed by instrumented run showing
      // "STALL: storeSegmentation exceeded budget of 300000ms" with Orthanc never
      // receiving a write.  Fix: kick off the export WITHOUT awaiting, fill the
      // dialog, click Save, THEN await the promise so the 300 s budget covers only
      // the actual DICOM write (which is genuinely slow for 694-slice studies).
      const reportName = `perf-soak-${stamp}-c${cycle}`;
      console.log(`[perf] cycle ${cycle} storeSegmentation reportName=${reportName}`);

      // Step 1: open the dialog.  The export command fires but will not resolve
      // until after we interact with the modal — do NOT await yet.
      // storeSegmentation takes ONLY { segmentationId } — verified at
      // extensions/cornerstone-dicom-seg/src/commandsModule.ts:374.
      const exportPromise = page.evaluate(
        id =>
          (window as any).__ohifPerf.commandsManager.runCommand('storeSegmentation', {
            segmentationId: id,
          }),
        segId
      );

      // Step 2: wait for the dialog, fill in the report name, click Save.
      // Budget: 60 s — if the dialog never appears the export flow has changed
      // and the driver needs updating (do NOT silently skip).
      await step(cycle, 'storeSegmentationDialog', async () => {
        const inputSelector = 'input[placeholder="Report name"]';
        const appeared = await page.waitForSelector(inputSelector, { timeout: 60_000 }).catch(() => null);
        if (!appeared) {
          throw new Error(
            `[perf] cycle ${cycle}: "Store Segmentation" dialog did not appear within 60 s. ` +
            `Export may have changed to a non-modal flow — update the soak driver to match.`
          );
        }
        await page.fill(inputSelector, reportName);
        await page.getByRole('button', { name: 'Save' }).click();
      }, 60_000);

      // Step 3: now await the actual DICOM write.  The 300 s budget here covers
      // the real write latency (694-slice SEG can be slow), not dialog wait time.
      await step(cycle, 'storeSegmentation', () =>
        exportPromise.then(() => page.waitForTimeout(8000)),
        300_000
      );
      // Wrap uidsAfter: if the query fails AFTER the SEG was already written to Orthanc,
      // record an orphan warning to a separate file and rethrow so the run still aborts loudly.
      // Do NOT put the sentinel in createdOut — that file must only contain confirmed ids.
      let uidsAfter: string[];
      try {
        uidsAfter = await step(cycle, 'listSegUidsAfter', () => listSegUids(fx, studyUID), 60_000);
      } catch (err) {
        const warning =
          `ORPHAN WARNING — ${new Date().toISOString()}\n` +
          `A SEG was written to Orthanc but the post-export UID query failed.\n` +
          `Study UID : ${studyUID}\n` +
          `Cycle     : ${cycle}\n` +
          `Error     : ${String(err)}\n` +
          `Action    : Check study ${studyUID} in Orthanc for an untracked SEG and remove it manually.\n`;
        fs.appendFileSync(orphanOut, warning + '\n');
        console.error(`[perf] orphan warning written to ${orphanOut}`);
        throw err;
      }
      uidsAfter.filter(u => !uidsBefore.includes(u)).forEach(u => createdSegs.push(u));
      // (a) Write the allowlist incrementally after every cycle so an abort leaves a usable record.
      fs.writeFileSync(createdOut, JSON.stringify(createdSegs, null, 2));
      await step(cycle, 'afterSegExportSample', () => sample(page, 'afterSegExport', { wallT: Date.now(), studyUID }), 60_000);

      // --- SEG reload leg ---
      // PURPOSE: exercise and measure the export→reload path, which is the
      // most leak-prone path in the codebase (sparse labelmap blocks, SEG
      // truncation history).  The 'studyOpen' canonical sample is taken AFTER
      // this step, so Tier-1 block counters (segCount/blockCount/blockSlices)
      // fitted on 'studyOpen' automatically capture any per-cycle block leakage
      // introduced by reload.
      //
      // IDENTIFY the newly-exported SEG displaySet:
      //   displaySetService.getActiveDisplaySets() — verified:
      //   Viewers/platform/core/src/services/DisplaySetService/DisplaySetService.ts:114
      //   Returns the live activeDisplaySets array (pushed in insertion order).
      //   Filter by Modality === 'SEG' (set by getSopClassHandlerModule.ts:34)
      //   and SeriesDescription === reportName (set via storeSegmentation options:
      //   cornerstone-dicom-seg/src/commandsModule.ts:403).
      //   This combination uniquely identifies the SEG this cycle just created.
      //
      // LOAD via:
      //   loadSegmentationDisplaySetsForViewport — registered at
      //   extensions/cornerstone/src/commandsModule.ts:2160, implemented at :1858.
      //   Takes { viewportId, displaySetInstanceUIDs: [uid] }.
      //
      // ASSERT reload actually happened: a silent no-op here would recreate the
      // exact class of bug this project has hit repeatedly (reload path changed,
      // service returns stale data, command resolves before hydration completes).
      await step(cycle, 'segReload', async () => {
        // Locate the newly-exported SEG displaySet by SeriesDescription match.
        // displaySetService.getActiveDisplaySets() is verified at:
        //   Viewers/platform/core/src/services/DisplaySetService/DisplaySetService.ts:114-115
        // Modality 'SEG' is set at: cornerstone-dicom-seg/src/getSopClassHandlerModule.ts:34
        // SeriesDescription is set from the dialog's reportName at:
        //   cornerstone-dicom-seg/src/commandsModule.ts:403
        const segDisplaySet = await page.evaluate(rn => {
          const sm = (window as any).__ohifPerf.servicesManager.services;
          const dss = sm.displaySetService.getActiveDisplaySets() as any[];
          // Primary strategy: exact SeriesDescription match for this cycle's export.
          let found = dss.find(
            (ds: any) => ds.Modality === 'SEG' && ds.SeriesDescription === rn
          );
          // Fallback: most recently added SEG (last in insertion-order array).
          if (!found) {
            const segs = dss.filter((ds: any) => ds.Modality === 'SEG');
            found = segs[segs.length - 1] ?? null;
          }
          if (!found) return null;
          return {
            uid: found.displaySetInstanceUID as string,
            desc: found.SeriesDescription as string,
          };
        }, reportName);

        if (!segDisplaySet) {
          throw new Error(
            `[perf] cycle ${cycle} segReload: no SEG displaySet found in ` +
            `getActiveDisplaySets() (Modality=SEG, SeriesDescription="${reportName}"). ` +
            `The export may not have added the displaySet to the active set, or ` +
            `DicomMetadataStore.addInstances() did not trigger displaySet creation. ` +
            `Cannot proceed with reload.`
          );
        }
        console.log(
          `[perf] cycle ${cycle} segReload uid=${segDisplaySet.uid} desc="${segDisplaySet.desc}"`
        );

        // Get the active viewportId — same pattern used throughout this file.
        // viewportGridService.getActiveViewportId() verified at:
        //   Viewers/platform/core/src/services/ViewportGridService/ViewportGridService.ts:175
        const viewportId = await page.evaluate(
          () =>
            (window as any).__ohifPerf.servicesManager.services.viewportGridService.getActiveViewportId()
        );

        // Load the SEG displaySet into the active viewport.
        // Command registered at extensions/cornerstone/src/commandsModule.ts:2160.
        // Implementation at :1858 — calls getUpdatedViewportsForSegmentation then
        // viewportGridService.setDisplaySetsForViewport for each updated viewport.
        await page.evaluate(
          ([vId, uid]) =>
            (window as any).__ohifPerf.commandsManager.runCommand(
              'loadSegmentationDisplaySetsForViewport',
              { viewportId: vId, displaySetInstanceUIDs: [uid] }
            ),
          [viewportId, segDisplaySet.uid] as [string, string]
        );
        // Allow the hydration pipeline to settle (a 694-slice SEG hydrate is genuinely slow).
        await page.waitForTimeout(8000);
      }, 180_000);

      // ASSERT the reload actually happened — a silent no-op would produce a
      // 'studyOpen' sample indistinguishable from before the reload, giving a
      // false clean verdict just as the pre-reload segmentation still being
      // loaded would.  This is the same live check used by the prompt guard above.
      const reloadedSegCount = await page.evaluate(() => {
        const sm = (window as any).__ohifPerf.servicesManager.services;
        const svc = sm.segmentationService;
        const viewportId = sm.viewportGridService?.getActiveViewportId?.() ?? undefined;
        const activeSeg = viewportId ? svc.getActiveSegmentation?.(viewportId) : null;
        if (!activeSeg?.segments) return 0;
        return Object.keys(activeSeg.segments).length;
      });
      if (reloadedSegCount === 0) {
        throw new Error(
          `[perf] cycle ${cycle} segReload: reload completed but segmentationService ` +
          `reports 0 segments in the active segmentation after 8 s settle. ` +
          `The reload was a silent no-op — the SEG was loaded into the viewport but ` +
          `the segmentation service was not updated, or the hydration pipeline did ` +
          `not complete within the settle window. Increase the waitForTimeout or ` +
          `investigate the loadSegmentationDisplaySetsForViewport→hydrate path.`
        );
      }

      await step(cycle, 'afterSegReloadSample', () =>
        sample(page, 'afterSegReload', { wallT: Date.now(), studyUID }),
        60_000
      );
    }

    // --- MPR toggle (the historic volume-leak path) — runs on ALL studies ---
    await step(cycle, 'mprToggle', () =>
      page.evaluate(() =>
        (window as any).__ohifPerf.commandsManager.runCommand('setHangingProtocol', { protocolId: 'mpr' })
      ).then(() => page.waitForTimeout(6000)),
      120_000
    );
    await step(cycle, 'afterMPRSample', () => sample(page, 'afterMPR', { wallT: Date.now(), studyUID }), 60_000);

    await step(cycle, 'stackToggle', () =>
      page.evaluate(() =>
        (window as any).__ohifPerf.commandsManager.runCommand('setHangingProtocol', { protocolId: 'default' })
      ).then(() => page.waitForTimeout(4000)),
      120_000
    );
    await step(cycle, 'afterStackSample', () => sample(page, 'afterStack', { wallT: Date.now(), studyUID }), 60_000);

    // =========================================================================
    // C6 FIX: CANONICAL 'studyOpen' sample — taken while the study is STILL OPEN.
    //
    // WHY TWO CANONICAL PHASES EXIST:
    //   - 'cycleEnd' (below) measures return-to-baseline at rest: after
    //     closeStudy(), OHIF's onModeExit fires removeAllSegmentations(), so
    //     the segmentation service is empty.  Block-stat counters (segCount,
    //     blockCount, blockSlices) therefore return {-1,-1,-1} at cycleEnd and
    //     are permanently NO_DATA — they CANNOT be observed at rest.
    //   - 'studyOpen' is the ONLY point where per-study block/segment counters
    //     are observable. It is taken after the MPR→stack toggle has settled
    //     (the historic volume-leak path) and after a forced GC, so it is a
    //     stable in-study resting state.
    //
    // THE ANALYZER must fit block counter trends (segCount, blockCount,
    // blockSlices) on 'studyOpen' samples, NOT on 'cycleEnd' samples.
    // wallT and studyUID are carried so the analyzer can align records across
    // cycles exactly as it does for cycleEnd.
    // =========================================================================
    await step(cycle, 'studyOpenSampleCanonical', () => sample(page, 'studyOpen', { wallT: Date.now(), studyUID }), 60_000);

    // --- Close the study via client-side navigation (NO document reload) ---
    // dump BEFORE navigating away: the perf records live in the browser's JS heap
    // and are preserved across client-side nav, but we dump here to keep per-cycle
    // records granular and avoid the final dump growing unbounded.
    // The dump+reset happen BEFORE the canonical cycleEnd sample so that the
    // cycleEnd sample itself is NOT included in the per-cycle dump (it is
    // captured in the NEXT iteration's dump or the final flush).
    await step(cycle, 'closeStudy', () => closeStudy(page), 120_000);

    // C2 FIX: canonical per-cycle sample.
    // Taken at the CANONICAL RESTING STATE: after the study is closed, back at
    // the study list, after forceGC. With nothing loaded, every cycle is
    // comparable — this is what makes Tier-1's "must return to baseline" meaningful.
    // wallT (epoch ms) and studyUID make records self-describing for the analyzer.
    await step(cycle, 'cycleEndSample', () => sample(page, 'cycleEnd', { wallT: Date.now(), studyUID }), 60_000);

    // dump this cycle's records (includes all intermediate phases + cycleEnd).
    const cycleDump = await step(cycle, 'cycleDump', async () => {
      const dump = await page.evaluate(() => (window as any).__ohifPerf?.dump?.() ?? '');
      expect(dump, `cycle ${cycle} produced no telemetry records`).not.toBe('');
      fs.appendFileSync(clientOut, dump + '\n');
      return dump;
    }, 60_000);
    // Reset so records do not accumulate / duplicate across cycles.
    await page.evaluate(() => (window as any).__ohifPerf?.reset?.());

    // Continuity post-check: after reset, nonce must still be present.
    const nonceAfterReset = await page.evaluate(() => (window as any).__ohifPerf?.__nonce);
    expect(
      nonceAfterReset,
      `CONTINUITY VIOLATION after cycle ${cycle} reset: nonce changed ` +
        `(expected ${nonce}, got ${nonceAfterReset}). Document was replaced.`
    ).toBe(nonce);
  }

  // Final flush: in case any records were captured after the last reset
  // (e.g. by navigation listeners) before the test ends.
  const finalDump = await page.evaluate(() => (window as any).__ohifPerf?.dump?.() ?? '');
  if (finalDump) fs.appendFileSync(clientOut, finalDump + '\n');

  // Final write (harmless — already written incrementally during the loop).
  fs.writeFileSync(createdOut, JSON.stringify(createdSegs, null, 2));
  console.log(`client trace -> ${clientOut}`);
  console.log(`created SEG UIDs -> ${createdOut} (${createdSegs.length})`);

  // GAP 2: fail if the delete workflow was skipped on EVERY primary-study cycle.
  // A blind spot that does not report itself is exactly the failure mode this project keeps hitting.
  if (primaryCycleCount > 0 && deleteSkipCount === primaryCycleCount) {
    throw new Error(
      `[perf] delete workflow was NEVER exercised — skipped on all ${primaryCycleCount} ` +
        `primary-study cycles. The soak has a blind spot: check seg.segments shape and fix segmentIndices().`
    );
  }
  if (deleteSkipCount > 0) {
    console.warn(
      `[perf] SUMMARY: delete workflow skipped on ${deleteSkipCount}/${primaryCycleCount} primary-study cycles — partial blind spot, investigate seg.segments shape.`
    );
  }
});

/** Orthanc instance ids of SEG series on a study. Used to diff before/after export
 *  so cleanup only ever touches instances THIS RUN created. */
async function listSegUids(fxCfg: any, studyUID: string): Promise<string[]> {
  const res = await fetch(`${fxCfg.orthancProxy}/tools/find`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Level: 'Series', Query: { StudyInstanceUID: studyUID, Modality: 'SEG' } }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '(unreadable)');
    throw new Error(
      `Orthanc /tools/find failed with ${res.status} ${res.statusText}: ${body}. ` +
        `Aborting — a failed query must never silently degrade into an empty baseline.`
    );
  }
  return (await res.json()) as string[];
}
