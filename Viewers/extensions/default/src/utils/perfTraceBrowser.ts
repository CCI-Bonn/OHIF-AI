import { cache, eventTarget, getRenderingEngines } from '@cornerstonejs/core';
import { createPerfTrace, PerfDeps, PerfTrace } from './perfTrace';

/**
 * Reads the perf-enabled flag from two sources:
 * - `?perf=1` in the query string
 * - `ohifPerf = '1'` in localStorage (useful for private-browsing where query
 *   params are not persisted across reloads)
 *
 * Both `search` and `storage` are injected so the function can be tested
 * without touching `window`.
 */
export function isPerfEnabled(search: string, storage: Pick<Storage, 'getItem'> | null): boolean {
  if (new URLSearchParams(search).get('perf') === '1') {
    return true;
  }
  try {
    return storage?.getItem('ohifPerf') === '1';
  } catch {
    // storage can throw in private-browsing modes in some browsers
    return false;
  }
}

/**
 * Wires real cornerstone 5.0.13 accessors to the PerfDeps interface.
 *
 * `_imageCache` and `listeners` are PRIVATE in cornerstone 5.0.13 — there is
 * no public accessor for either. Both are read defensively: if a future version
 * renames or removes them the counter degrades to -1 rather than silently
 * reporting a plausible-looking value (e.g. 0) that would mask a real leak.
 */
export function buildCornerstoneDeps(
  cs: { cache: any; eventTarget: any; getRenderingEngines: () => any[] },
  getBlockStats: () => { segCount: number; blockCount: number; blockSlices: number }
): PerfDeps {
  return {
    now: () => performance.now(),
    getHeapBytes: () => (performance as any).memory?.usedJSHeapSize ?? -1,
    getCacheBytes: () => cs.cache.getCacheSize(),
    getVolumes: () => {
      if (typeof cs.cache?.getVolumes !== 'function') {
        throw new Error('cache.getVolumes unavailable');
      }
      return cs.cache.getVolumes();
    },
    getImageCount: () => {
      const m = cs.cache?._imageCache;
      return m && typeof m.size === 'number' ? m.size : -1;
    },
    getBlockStats,
    getViewportCount: () => {
      if (typeof cs.getRenderingEngines !== 'function') {
        return -1;
      }
      const engines = cs.getRenderingEngines();
      if (!Array.isArray(engines)) {
        return -1;
      }
      for (const re of engines) {
        if (typeof re.getViewports !== 'function') return -1;
        const vps = re.getViewports();
        if (!Array.isArray(vps)) return -1;
      }
      return engines.reduce(
        (acc: number, re: any) => acc + (re.getViewports().length),
        0
      );
    },
    getListenerCount: () => {
      const l = cs.eventTarget?.listeners;
      if (!l || typeof l !== 'object') {
        return -1;
      }
      return Object.values(l).reduce<number>(
        (acc, v) => acc + (Array.isArray(v) ? v.length : 0),
        0
      );
    },
  };
}

/**
 * Block-stats provider. Starts as a stub that reports -1 for all fields;
 * Task 3 wires in the real implementation via `setBlockStatsProvider` to avoid
 * creating an import cycle with the segmentation layer here.
 */
let blockStatsProvider: () => { segCount: number; blockCount: number; blockSlices: number } = () => ({
  segCount: -1,
  blockCount: -1,
  blockSlices: -1,
});

export function setBlockStatsProvider(
  fn: () => { segCount: number; blockCount: number; blockSlices: number }
): void {
  blockStatsProvider = fn;
}

// ---------------------------------------------------------------------------
// Singleton — evaluated once at module load.
// When the flag is off, `createPerfTrace` returns no-op stubs bound once;
// the deps object passed is unused by the disabled path so we pass a bare {}.
// `window.__ohifPerf` is never set when disabled.
//
// IMPORTANT: `window.localStorage` is accessed INSIDE isPerfEnabled's try/catch
// (not directly here) so that a browser with storage blocked (SecurityError)
// degrades to perf-disabled instead of crashing the entire default extension at
// module load (which re-exports this module via utils/index.ts).
// ---------------------------------------------------------------------------
let _storage: Pick<Storage, 'getItem'> | null = null;
if (typeof window !== 'undefined') {
  try {
    _storage = window.localStorage;
  } catch {
    // Storage blocked (e.g. Safari with "Block All Cookies") — perf stays off.
    _storage = null;
  }
}

const enabled =
  typeof window !== 'undefined' &&
  isPerfEnabled(window.location.search, _storage);

// The transport probe (commandsModule nninter breakdown) reads the POST's
// PerformanceResourceTiming entry. The default 250-entry buffer overflows on
// DICOM instance loading (hundreds of fetches per study) and a FULL buffer
// silently DROPS new entries — so the probe would read nothing exactly in the
// sessions worth measuring. Raise it and recycle on overflow, perf-gated.
if (enabled) {
  try {
    performance.setResourceTimingBufferSize(10000);
    performance.addEventListener('resourcetimingbufferfull', () => {
      performance.clearResourceTimings();
    });
  } catch {
    // Older browsers: probe degrades to -1s via its own guard.
  }
}

export const perf: PerfTrace = createPerfTrace(
  enabled
    ? buildCornerstoneDeps({ cache, eventTarget, getRenderingEngines }, () => blockStatsProvider())
    : ({} as PerfDeps),
  enabled
);

export function isPerfLeakEnabled(search: string): boolean {
  return new URLSearchParams(search).get('perfLeak') === '1';
}

const leakEnabled = typeof window !== 'undefined' && isPerfLeakEnabled(window.location.search);
const _leakStore: unknown[] = [];
let _leakWarnedOnce = false;

/** Bytes of synthetic ballast retained per call. Sized so a short soak produces an
 *  unmistakable heapMB ramp: the control must never under-fire, because a weak signal
 *  would be misread as "the detector is broken". */
const _LEAK_BALLAST_BYTES = 8 * 1024 * 1024;

/**
 * POSITIVE CONTROL ONLY. Retains a reference so the analyzer has a known-leaking
 * run to prove it can detect. Never enabled outside a validation soak.
 *
 * When enabled (via `?perfLeak=1`), this function retains BOTH:
 * 1. The passed real object — maintaining realistic object shape
 * 2. Fixed-size synthetic ballast (~8 MB per call) — ensuring deterministic magnitude
 *
 * The synthetic ballast guarantees the control cannot silently under-fire: even if
 * the real object is already cached elsewhere, the ballast ensures a predictable,
 * unmistakable heap growth. This makes the leak detector's signal unambiguous.
 */
export function leakRetain(obj: unknown): void {
  if (!leakEnabled) {
    return;
  }
  if (!_leakWarnedOnce) {
    _leakWarnedOnce = true;
    console.warn(
      '[perfLeak] POSITIVE CONTROL ACTIVE — leakRetain is retaining ~8 MB per call. ' +
      'This is a deliberate leak detector validation run. Do NOT leave ?perfLeak=1 in production.'
    );
  }
  _leakStore.push(obj);
  // Touch the buffer so it is really committed, not lazily-mapped zero pages.
  const ballast = new Uint8Array(_LEAK_BALLAST_BYTES);
  ballast[0] = _leakStore.length & 0xff;
  ballast[ballast.length - 1] = 1;
  _leakStore.push(ballast);
}

/**
 * Installs `window.__ohifPerf` for the Playwright soak driver.
 * A no-op when perf is disabled so call-sites do not need to guard.
 *
 * @param commandsManager - OHIF commands manager
 * @param servicesManager - OHIF services manager
 * @param navigate - Optional React Router navigate function for client-side
 *   navigation without a full document reload. When provided, exposed as
 *   `window.__ohifPerf.navigate` so the soak driver can switch studies
 *   without destroying the JS realm and resetting all counters.
 * @param toolboxState - Optional toolboxState singleton. When provided,
 *   exposed as `window.__ohifPerf.toolboxState` so the soak driver can
 *   set liveMode / selectedModel / locked before prompting, causing the
 *   real MEASUREMENT_ADDED subscription to fire inference instead of a
 *   direct runAiSegmentation call.
 */
export function installPerfHandle(
  commandsManager: unknown,
  servicesManager: unknown,
  navigate?: ((path: string) => void) | null,
  toolboxState?: unknown
): void {
  if (!perf.enabled || typeof window === 'undefined') {
    return;
  }
  (window as any).__ohifPerf = {
    snapshot: (phase: string, extra?: Record<string, unknown>) => perf.snapshot(phase, extra),
    dump: () => perf.dump(),
    reset: () => perf.reset(),
    setCycle: (n: number) => perf.setCycle(n),
    /**
     * Trigger a GC cycle.  Requires --js-flags=--expose-gc on the browser
     * launch command; the soak driver asserts `typeof window.gc === 'function'`
     * before cycle 1 (I11) and fails the test if this is absent.
     */
    forceGC: () => (globalThis as any).gc(),
    /**
     * Client-side navigation — does NOT reload the document.
     * Provided so the soak driver can switch studies while keeping the same
     * JS realm, preserving all module-level counters and caches for
     * accurate cross-cycle trend detection.
     */
    navigate: navigate ?? null,
    commandsManager,
    servicesManager,
    /**
     * toolboxState singleton — exposed so the soak driver can arm
     * liveMode + selectedModel before clicking, allowing the real
     * MEASUREMENT_ADDED subscription to drive inference.  Unreachable
     * when perf is off (early-return above prevents the entire block).
     */
    toolboxState: toolboxState ?? null,
  };
}
