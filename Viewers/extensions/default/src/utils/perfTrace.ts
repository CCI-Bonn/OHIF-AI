export interface PerfSample {
  t: number; cycle: number; phase: string;
  heapMB: number; cacheMB: number; volCount: number; volMB: number;
  volUnsized: number;
  imgCount: number; segCount: number; blockCount: number; blockSlices: number;
  viewportCount: number; listenerCount: number;
  // Optional extras forwarded from snapshot(phase, extra) — e.g. wallT, studyUID.
  [key: string]: unknown;
}

export interface PerfDeps {
  now(): number;
  getHeapBytes(): number;
  getCacheBytes(): number;
  getVolumes(): Array<{ sizeInBytes: number }>;
  getImageCount(): number;
  getBlockStats(): { segCount: number; blockCount: number; blockSlices: number };
  getViewportCount(): number;
  getListenerCount(): number;
}

export interface PerfTrace {
  enabled: boolean;
  setCycle(n: number): void;
  snapshot(phase: string, extra?: Record<string, unknown>): PerfSample | null;
  measure(name: string, startMs: number, extra?: Record<string, number>): void;
  dump(): string;
  reset(): void;
}

const MB = 1024 * 1024;

/** Never let instrumentation break the app: a failing counter reports -1. */
function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export function createPerfTrace(deps: PerfDeps, enabled: boolean): PerfTrace {
  if (!enabled) {
    return {
      enabled: false,
      setCycle: () => undefined,
      snapshot: (_phase: string, _extra?: Record<string, unknown>) => null,
      measure: () => undefined,
      dump: () => '',
      reset: () => undefined,
    };
  }

  const records: string[] = [];
  let cycle = 0;

  const snapshot = (phase: string, extra?: Record<string, unknown>): PerfSample => {
    const vols = safe(() => deps.getVolumes(), null);
    const blockStats = safe(() => deps.getBlockStats(), null);
    const sample: PerfSample = {
      t: safe(() => deps.now(), -1),
      cycle,
      phase,
      heapMB: safe(() => deps.getHeapBytes() / MB, -1),
      cacheMB: safe(() => deps.getCacheBytes() / MB, -1),
      volCount: vols === null ? -1 : vols.length,
      // volMB is a partial sum over volumes that HAVE a finite sizeInBytes.
      // Still-loading streaming volumes and geometry/labelmap volumes typically
      // lack a computed size — returning -1 for ANY non-finite entry would make
      // this counter permanently NO_DATA in a real viewer. Instead we sum the
      // finite subset and report how many were excluded via volUnsized.
      // If NO volume has a finite size, volMB stays -1 (nothing could be measured).
      volMB: vols === null ? -1 : safe(() => {
        if (vols.length === 0) return 0;
        const unsizedCount = vols.filter(v => !Number.isFinite(v.sizeInBytes)).length;
        if (unsizedCount === vols.length) return -1;
        return vols.filter(v => Number.isFinite(v.sizeInBytes)).reduce((a, v) => a + v.sizeInBytes, 0) / MB;
      }, -1),
      // Count of volumes whose sizeInBytes is missing or non-finite (not counted in volMB).
      // A GROWING volUnsized means the volMB trend is measuring a shifting subset and
      // cannot be trusted. A STABLE volUnsized means the undercount is constant and
      // the volMB slope is still meaningful.
      volUnsized: vols === null ? -1 : safe(() => {
        if (vols.length === 0) return 0;
        return vols.filter(v => !Number.isFinite(v.sizeInBytes)).length;
      }, -1),
      imgCount: safe(() => deps.getImageCount(), -1),
      viewportCount: safe(() => deps.getViewportCount(), -1),
      listenerCount: safe(() => deps.getListenerCount(), -1),
      segCount: blockStats === null ? -1 : (typeof blockStats.segCount === 'number' ? blockStats.segCount : -1),
      blockCount: blockStats === null ? -1 : (typeof blockStats.blockCount === 'number' ? blockStats.blockCount : -1),
      blockSlices: blockStats === null ? -1 : (typeof blockStats.blockSlices === 'number' ? blockStats.blockSlices : -1),
      ...(extra || {}),
    };
    records.push(JSON.stringify({ kind: 'sample', ...sample }));
    return sample;
  };

  return {
    enabled: true,
    setCycle: (n: number) => {
      cycle = n;
    },
    snapshot,
    measure: (name, startMs, extra) => {
      const now = safe(() => deps.now(), null);
      records.push(
        JSON.stringify({
          kind: 'measure',
          t: now === null ? -1 : now,
          cycle,
          name,
          durMs: now === null ? -1 : (now - startMs),
          ...(extra || {}),
        })
      );
    },
    dump: () => records.join('\n'),
    reset: () => {
      records.length = 0;
    },
  };
}
