#!/usr/bin/env node
/**
 * Pre-flight instrument check — RUN THIS BEFORE EVERY SOAK.
 *
 * Loads the fixture study with ?perf=1 in a real browser, samples the client
 * counters in both STACK and MPR, and reports which ones cannot be read.
 *
 * Why this exists: three whole-branch code reviews did not find the defects this
 * check found in one run. Every client counter is unit-tested against fake
 * objects; several only fail on contact with real cornerstone state. Found here:
 *   - volMB permanently -1 (over-strict rule)
 *   - volMB reporting -1 for an EMPTY volume cache, at exactly the at-rest phase
 *     the verdict is computed from
 *   - volMB permanently NO_DATA forcing INCONCLUSIVE on every run
 * Any of those alone would have wasted an hour of GPU time on a useless verdict.
 *
 * READ-ONLY: loads a study and reads counters. No segmentation, no inference,
 * no writes to Orthanc, no container changes.
 *
 * Usage:
 *   node tools/perf/preflight.js                 # uses fixture.json's primary study
 *   node tools/perf/preflight.js <StudyUID>
 *
 * Requires a Chrome/Chromium binary. Uses the system Chrome via Playwright's
 * `channel: 'chrome'`, so no `npx playwright install` download is needed.
 * Exits non-zero if an instrument is unreadable in a state where it should work.
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require(path.join(__dirname, '..', '..', 'Viewers', 'node_modules', '@playwright', 'test'));

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

const fx = loadFixture(__dirname);
const STUDY = process.argv[2] || fx.primaryStudyUID;
const BASE = process.env.PERF_VIEWER_URL || fx.viewerUrl || 'http://localhost:1030';

/** Counters that must be readable in BOTH stack and MPR. */
const ALWAYS = ['heapMB', 'cacheMB', 'volCount', 'volUnsized', 'imgCount', 'viewportCount', 'listenerCount'];
/** Known-unreadable, with the reason. Not a failure — see analyze.py's allow-list. */
const KNOWN_UNREADABLE = {
  volMB: 'cornerstone 5.x streaming voxel managers have no materialized scalar data, ' +
         'so ImageVolume.sizeInBytes throws. volCount is the load-bearing volume-leak signal.',
};

(async () => {
  const browser = await chromium.launch({
    channel: 'chrome',
    args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'],
  });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e).slice(0, 200)));

  const url = `${BASE}/viewer?StudyInstanceUIDs=${STUDY}&perf=1`;
  console.log(`loading ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });

  try {
    await page.waitForFunction(() => !!window.__ohifPerf, null, { timeout: 120000 });
  } catch {
    console.error('\nFAIL: window.__ohifPerf never appeared.');
    console.error('  - the flag must be present on a FULL document load (?perf=1 in the address bar);');
    console.error('    clicking through from the worklist will NOT arm it — the module decides once at load.');
    console.error('  - or the viewer image predates the telemetry: docker compose build ohif_viewer');
    await browser.close();
    process.exit(1);
  }

  await page.waitForSelector('canvas', { timeout: 180000 }).catch(() => {});
  await page.waitForTimeout(20000);

  const snap = label => page.evaluate(l => {
    const h = window.__ohifPerf;
    h.forceGC && h.forceGC();
    return { gc: typeof window.gc === 'function', ...h.snapshot(l) };
  }, label);

  const stack = await snap('preflight-stack');
  await page.evaluate(() =>
    window.__ohifPerf.commandsManager.runCommand('setHangingProtocol', { protocolId: 'mpr' })
  ).catch(e => pageErrors.push('mpr: ' + String(e).slice(0, 120)));
  await page.waitForTimeout(30000);
  const mpr = await snap('preflight-mpr');

  await browser.close();

  const fmt = s => ALWAYS.concat(Object.keys(KNOWN_UNREADABLE))
    .map(k => `${k}=${s[k]}`).join('  ');
  console.log(`\nstack: ${fmt(stack)}`);
  console.log(`mpr  : ${fmt(mpr)}`);
  console.log(`gc available: ${stack.gc}`);
  if (pageErrors.length) console.log('page errors:', pageErrors.slice(0, 3));

  const bad = [];
  for (const k of ALWAYS) {
    for (const [state, s] of [['stack', stack], ['mpr', mpr]]) {
      if (s[k] === -1) bad.push(`${k} unreadable in ${state}`);
    }
  }
  // Block counters are legitimately -1 until a segmentation exists; not checked here.
  for (const [k, why] of Object.entries(KNOWN_UNREADABLE)) {
    if (stack[k] === -1 || mpr[k] === -1) console.log(`\nnote: ${k} unreadable — ${why}`);
  }
  if (!stack.gc) {
    console.log('\nnote: window.gc absent — heap TRENDS are unreliable without forced GC.');
  }

  if (bad.length) {
    console.error('\nFAIL — instruments unreadable against real cornerstone:');
    bad.forEach(b => console.error('  - ' + b));
    console.error('Fix these before soaking; a soak cannot produce a verdict from counters that report -1.');
    process.exit(1);
  }
  console.log('\nPASS — every required instrument reports a real value in both stack and MPR.');
})();
