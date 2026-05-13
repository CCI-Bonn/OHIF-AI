import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { ContactAngleResult } from '../services/PancreasAngleService';
import { PancreasAngleServiceEvents } from '../services/PancreasAngleService';


const RISK_COLOR: Record<string, string> = {
  low: '#4ade80',
  moderate: '#facc15',
  high: '#f87171',
};

const RISK_LABEL: Record<string, string> = {
  low: 'Resectable',
  moderate: 'Borderline',
  high: 'Locally Advanced',
};

interface SegmentOption {
  /** Composite key: "<seriesUID>::<segmentIndex>" */
  key: string;
  segmentationId: string;
  segmentIndex: number;
  label: string;
}

interface Props {
  commandsManager: AppTypes.CommandsManager;
  servicesManager: AppTypes.ServicesManager;
}

/** Build a flat list of all segments across all segmentations currently
 *  represented in any viewport. Mirrors the approach used by useViewportSegmentations. */
function buildSegmentOptions(
  segmentationService: any,
  viewportGridService: any,
  displaySetService: any,
  seriesUIDOverrides: Record<string, string> = {}
): SegmentOption[] {
  const options: SegmentOption[] = [];
  const seen = new Set<string>();

  // Resolve the DICOM SeriesInstanceUID for a segmentation display set
  const getSeriesUID = (segId: string): string => {
    if (seriesUIDOverrides[segId]) return seriesUIDOverrides[segId];
    const ds = displaySetService.getDisplaySetByUID?.(segId);
    return ds?.SeriesInstanceUID ?? segId;
  };

  // Collect segmentation IDs from all viewports
  const { viewports, activeViewportId } = viewportGridService.getState();
  const viewportIds: string[] = [];

  if (viewports) {
    // viewports may be a Map or plain object
    if (typeof viewports.keys === 'function') {
      viewportIds.push(...Array.from(viewports.keys() as IterableIterator<string>));
    } else {
      viewportIds.push(...Object.keys(viewports));
    }
  }
  if (activeViewportId && !viewportIds.includes(activeViewportId)) {
    viewportIds.push(activeViewportId);
  }

  for (const vpId of viewportIds) {
    const representations = segmentationService.getSegmentationRepresentations?.(vpId) ?? [];
    for (const rep of representations) {
      const segId = rep.segmentationId;
      if (!segId || seen.has(segId)) continue;
      seen.add(segId);

      const seg = segmentationService.getSegmentation(segId);
      if (!seg) continue;

      const seriesUID = getSeriesUID(segId);
      const segments: Record<string, any> = seg.segments ?? {};
      for (const [idxStr, segment] of Object.entries(segments)) {
        if (!segment) continue;
        const segmentIndex = Number(idxStr);
        if (isNaN(segmentIndex) || segmentIndex <= 0) continue;
        const label = segment.label || `Segment ${segmentIndex}`;
        options.push({
          key: `${seriesUID}::${segmentIndex}`,
          segmentationId: segId,
          segmentIndex,
          label,
        });
      }
    }
  }

  // Fallback: if no viewport representations found, read all segmentations directly
  if (options.length === 0) {
    const segs = segmentationService.getSegmentations?.() ?? [];
    for (const seg of segs) {
      const seriesUID = getSeriesUID(seg.segmentationId);
      const segments: Record<string, any> = seg.segments ?? {};
      for (const [idxStr, segment] of Object.entries(segments)) {
        if (!segment) continue;
        const segmentIndex = Number(idxStr);
        if (isNaN(segmentIndex) || segmentIndex <= 0) continue;
        const label = segment.label || `Segment ${segmentIndex}`;
        options.push({
          key: `${seriesUID}::${segmentIndex}`,
          segmentationId: seg.segmentationId,
          segmentIndex,
          label,
        });
      }
    }
  }

  return options;
}

export function PanelPancreasAngle({ commandsManager, servicesManager }: Props) {
  const { segmentationService, viewportGridService, pancreasAngleService, displaySetService } =
    servicesManager.services as any;

  const [segmentOptions, setSegmentOptions] = useState<SegmentOption[]>([]);
  const [tumorKey, setTumorKey] = useState('');
  const [selectedVesselKeys, setSelectedVesselKeys] = useState<string[]>([]);
  const [results, setResults] = useState<ContactAngleResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedSeriesUIDMap, setSavedSeriesUIDMap] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  // True if a segmentation has a real DICOM-backed SeriesInstanceUID
  const isSaved = useCallback(
    (segmentationId: string): boolean => {
      if (savedSeriesUIDMap[segmentationId]) return true;
      const ds = displaySetService.getDisplaySetByUID?.(segmentationId);
      return !!(ds?.SeriesInstanceUID);
    },
    [savedSeriesUIDMap, displaySetService]
  );

  // Sync segment list from SegmentationService — mirrors useViewportSegmentations approach
  useEffect(() => {
    const refreshSegs = () => {
      setSegmentOptions(
        buildSegmentOptions(segmentationService, viewportGridService, displaySetService, savedSeriesUIDMap)
      );
    };

    refreshSegs();

    const subs = [
      segmentationService.subscribe(segmentationService.EVENTS.SEGMENTATION_MODIFIED, refreshSegs),
      segmentationService.subscribe(segmentationService.EVENTS.SEGMENTATION_REMOVED, refreshSegs),
      segmentationService.subscribe(
        segmentationService.EVENTS.SEGMENTATION_REPRESENTATION_MODIFIED,
        refreshSegs
      ),
      segmentationService.subscribe(
        segmentationService.EVENTS.SEGMENTATION_LOADING_COMPLETE,
        refreshSegs
      ),
    ];

    return () => subs.forEach(s => s.unsubscribe());
  }, [segmentationService, viewportGridService, savedSeriesUIDMap]);

  // Subscribe to PancreasAngleService events
  useEffect(() => {
    const subs = [
      pancreasAngleService.subscribe(PancreasAngleServiceEvents.COMPUTATION_STARTED, () => {
        setLoading(true);
        setError(null);
      }),
      pancreasAngleService.subscribe(
        PancreasAngleServiceEvents.RESULTS_UPDATED,
        ({ results: r }: { results: ContactAngleResult[] }) => {
          setResults(r);
          setLoading(false);
        }
      ),
      pancreasAngleService.subscribe(
        PancreasAngleServiceEvents.COMPUTATION_ERROR,
        ({ error: e }: { error: string }) => {
          setError(e);
          setLoading(false);
        }
      ),
    ];

    // Restore any existing results (e.g. after panel re-mount)
    setResults(pancreasAngleService.getResults());
    setLoading(pancreasAngleService.isLoading());
    setError(pancreasAngleService.getLastError());

    return () => subs.forEach(s => s.unsubscribe());
  }, [pancreasAngleService]);

  // Unique segmentation IDs that are not yet saved to the server
  const unsavedSegmentationIds = useMemo(() => {
    const allIds = [...new Set(segmentOptions.map(o => o.segmentationId))];
    return allIds.filter(id => !isSaved(id));
  }, [segmentOptions, isSaved]);

  const hasUnsaved = unsavedSegmentationIds.length > 0;

  // Save all unsaved segmentations, then re-map any selected keys to the new UIDs
  const handleSaveAll = useCallback(async () => {
    setSaving(true);
    const newMap = { ...savedSeriesUIDMap };

    for (const segId of unsavedSegmentationIds) {
      try {
        const report = await commandsManager.runCommand('storeSegmentationSilent', { segmentationId: segId });
        if (report?.SeriesInstanceUID) {
          newMap[segId] = report.SeriesInstanceUID;
        }
      } catch (e) {
        console.error('[PancreaSeg] Save failed for', segId, e);
      }
    }

    // Re-map existing selections so the keys point to the new SeriesUIDs
    const remapKey = (oldKey: string): string => {
      const separatorIdx = oldKey.lastIndexOf('::');
      if (separatorIdx === -1) return oldKey;
      const oldSegId = oldKey.slice(0, separatorIdx);
      const idx = oldKey.slice(separatorIdx + 2);
      return newMap[oldSegId] ? `${newMap[oldSegId]}::${idx}` : oldKey;
    };

    if (tumorKey) setTumorKey(remapKey(tumorKey));
    setSelectedVesselKeys(prev => prev.map(remapKey));

    setSavedSeriesUIDMap(newMap);
    setSaving(false);
  }, [unsavedSegmentationIds, savedSeriesUIDMap, commandsManager, tumorKey]);

  const toggleVessel = useCallback((key: string) => {
    setSelectedVesselKeys(prev =>
      prev.includes(key) ? prev.filter(v => v !== key) : [...prev, key]
    );
  }, []);

  const handleCompute = useCallback(() => {
    if (!tumorKey || selectedVesselKeys.length === 0) return;

    const vesselSegmentations = selectedVesselKeys.map(key => ({
      id: key,
      name: segmentOptions.find(s => s.key === key)?.label ?? key,
    }));

    // studyInstanceUID: resolve from the active viewport's display set
    const { activeViewportId } = viewportGridService.getState();
    const viewport = viewportGridService.getViewportState(activeViewportId);
    const displaySetUID = viewport?.displaySetInstanceUIDs?.[0];
    const displaySet = displaySetService.getDisplaySetByUID?.(displaySetUID);
    const studyInstanceUID = displaySet?.StudyInstanceUID ?? '';
    console.log('tumorKey', tumorKey);

    commandsManager.runCommand('computePancreasContactAngle', {
      tumorSegmentationId: tumorKey,
      vesselSegmentations,
      studyInstanceUID,
    });
  }, [tumorKey, selectedVesselKeys, segmentOptions, commandsManager, viewportGridService]);

  const handleJumpToSlice = useCallback(
    (r: ContactAngleResult) => {
      const { activeViewportId } = viewportGridService.getState();
      commandsManager.runCommand('jumpToPancreasSlice', {
        viewportId: activeViewportId,
        zPositionMm: r.maxZPositionMm,
      });

      // Console logging — print per-slice breakdown for this vessel
      console.group(
        `[PancreaSeg] ${r.vesselName} — θmax ${r.maxAngleDegrees.toFixed(1)}° @ slice ${r.maxSliceIndex}`
      );
      console.table(
        r.perSliceAngles.map(p => ({
          slice: p.sliceIndex,
          'z (mm)': p.zPositionMm?.toFixed(2) ?? '—',
          'angle (°)': p.angleDegrees?.toFixed(1) ?? '—',
          'vessel perim (mm)': p.vesselPerimeterMm?.toFixed(2) ?? '—',
          'tumor perim (mm)': p.tumorPerimeterMm?.toFixed(2) ?? '—',
          'contact arc (mm)': p.contactArcMm?.toFixed(2) ?? '—',
        }))
      );
      console.groupEnd();

      // Draw contour overlay on the active viewport
      // commandsManager.runCommand('highlightPancreasContours', {
      //   viewportId: activeViewportId,
      //   vesselResult: r,
      // });
    },
    [commandsManager, viewportGridService]
  );

  // Clear overlay when results are replaced or panel unmounts
  useEffect(() => {
    return () => {
      commandsManager.runCommand('clearPancreasContourHighlight', {});
    };
  }, [results, commandsManager]);

  const vesselOptions = segmentOptions.filter(s => s.key !== tumorKey);

  // A segment option label decorated with an unsaved badge
  const segLabel = (s: SegmentOption) =>
    isSaved(s.segmentationId) ? s.label : `${s.label} ⚠ unsaved`;

  // Compute is always allowed — unsaved segments are auto-saved silently by the command.
  const canCompute = tumorKey && selectedVesselKeys.length > 0 && !loading;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        padding: '12px',
        color: '#e2e8f0',
        fontSize: '13px',
      }}
    >
      <h2 style={{ margin: 0, fontSize: '14px', fontWeight: 600, color: '#f1f5f9' }}>
        Pancreas Contact Angles
      </h2>

      {/* Tumor selector */}
      <div>
        <label style={{ display: 'block', marginBottom: '4px', color: '#94a3b8', fontSize: '11px' }}>
          TUMOR SEGMENTATION
        </label>
        <select
          value={tumorKey}
          onChange={e => {
            setTumorKey(e.target.value);
            setSelectedVesselKeys([]);
          }}
          style={{
            width: '100%',
            background: '#1e293b',
            color: '#e2e8f0',
            border: '1px solid #334155',
            borderRadius: '4px',
            padding: '6px 8px',
            fontSize: '12px',
          }}
        >
          <option value="">Select tumor segment...</option>
          {segmentOptions.map(s => (
            <option key={s.key} value={s.key}>
              {segLabel(s)}
            </option>
          ))}
        </select>
      </div>

      {/* Vessel checkboxes */}
      {tumorKey && (
        <div style={{height: '250px'}}>
          <label style={{ display: 'block', marginBottom: '6px', color: '#94a3b8', fontSize: '11px' }}>
            VESSELS TO ANALYZE
          </label>
          {vesselOptions.length === 0 ? (
            <p style={{ color: '#64748b', fontSize: '12px', margin: 0 }}>
              No other segmentations loaded.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', height: '230px', overflow: 'scroll' }}>
              {vesselOptions.map(s => (
                <label
                  key={s.key}
                  style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}
                >
                  <input
                    type="checkbox"
                    checked={selectedVesselKeys.includes(s.key)}
                    onChange={() => toggleVessel(s.key)}
                  />
                  <span>{segLabel(s)}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Compute button */}
      <button
        onClick={handleCompute}
        disabled={!canCompute}
        style={{
          padding: '8px 12px',
          background: canCompute ? '#3b82f6' : '#1e3a5f',
          color: canCompute ? '#fff' : '#64748b',
          border: 'none',
          borderRadius: '4px',
          fontSize: '13px',
          fontWeight: 500,
          cursor: canCompute ? 'pointer' : 'not-allowed',
          transition: 'background 0.15s',
        }}
      >
        {loading ? 'Computing...' : 'Compute Contact Angles'}
      </button>

      {/* Error */}
      {error && (
        <p style={{ color: '#f87171', fontSize: '12px', margin: 0 }}>
          Error: {error}
        </p>
      )}

      {/* Results table */}
      {results.length > 0 && (
        <div>
          <label style={{ display: 'block', marginBottom: '6px', color: '#94a3b8', fontSize: '11px' }}>
            RESULTS — click row to navigate
          </label>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #334155', color: '#64748b' }}>
                <th style={{ textAlign: 'left', padding: '4px 6px', fontWeight: 500 }}>Vessel</th>
                <th style={{ textAlign: 'right', padding: '4px 6px', fontWeight: 500 }}>Angle</th>
                <th style={{ textAlign: 'right', padding: '4px 6px', fontWeight: 500 }}>Slice</th>
                <th style={{ textAlign: 'right', padding: '4px 6px', fontWeight: 500 }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {results.map(r => (
                <tr
                  key={r.vesselId}
                  onClick={() => handleJumpToSlice(r)}
                  title={r.summary}
                  style={{
                    borderBottom: '1px solid #1e293b',
                    cursor: 'pointer',
                    transition: 'background 0.1s',
                  }}
                  onMouseEnter={e => {
                    (e.currentTarget as HTMLTableRowElement).style.background = '#1e293b';
                  }}
                  onMouseLeave={e => {
                    (e.currentTarget as HTMLTableRowElement).style.background = 'transparent';
                  }}
                >
                  <td style={{ padding: '5px 6px' }}>{r.vesselName}</td>
                  <td style={{ padding: '5px 6px', textAlign: 'right', fontFamily: 'monospace' }}>
                    {Math.round(r.maxAngleDegrees)}°
                  </td>
                  <td style={{ padding: '5px 6px', textAlign: 'right', fontFamily: 'monospace' }}>
                    {r.maxSliceIndex}
                    <span style={{ color: '#64748b', fontSize: '10px' }}>
                      {' '}({r.sliceRange[0]}–{r.sliceRange[1]})
                    </span>
                  </td>
                  <td
                    style={{
                      padding: '5px 6px',
                      textAlign: 'right',
                      color: RISK_COLOR[r.riskLevel],
                      fontWeight: 600,
                    }}
                  >
                    {RISK_LABEL[r.riskLevel]}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Risk legend */}
          <div
            style={{
              marginTop: '8px',
              display: 'flex',
              gap: '12px',
              fontSize: '11px',
              color: '#64748b',
            }}
          >
            <span style={{ color: RISK_COLOR.low }}>● &lt;90°: Resectable</span>
            <span style={{ color: RISK_COLOR.moderate }}>● 90–180°: Borderline</span>
            <span style={{ color: RISK_COLOR.high }}>● &gt;180°: Locally Advanced</span>
          </div>
        </div>
      )}
    </div>
  );
}

export default PanelPancreasAngle;
