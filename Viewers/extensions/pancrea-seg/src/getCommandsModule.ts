import { metaData, eventTarget, Enums as csEnums } from '@cornerstonejs/core';
import { computeContactAngle } from './utils/computeContactAngle';
import type { ContactAngleResult } from './services/PancreasAngleService';

const PANCREAS_API_BASE =
  (typeof window !== 'undefined' && (window as any).config?.pancreasApiBase) ?? '/pancreas-api';

// Per-viewport overlay state: viewportId → { svg, cleanup }
const overlayMap = new Map<string, { svg: SVGSVGElement; cleanup: () => void }>();

type PerSliceEntry = ContactAngleResult['perSliceAngles'][number];

/** Find the per-slice entry whose Z position is closest to the given image's Z. */
function findSliceEntry(
  imageId: string,
  perSliceAngles: PerSliceEntry[]
): PerSliceEntry | null {
  const plane = metaData.get('imagePlaneModule', imageId);
  if (!plane?.imagePositionPatient || perSliceAngles.length === 0) return null;
  const z = plane.imagePositionPatient[2];
  let best: PerSliceEntry | null = null;
  let minDist = Infinity;
  for (const entry of perSliceAngles) {
    const dist = Math.abs(entry.zPositionMm - z);
    if (dist < minDist) { minDist = dist; best = entry; }
  }
  // Only return an entry if the slice is within ~2 mm of a known contact slice
  return minDist < 2.0 ? best : null;
}

/** Convert a (row, col) pixel coordinate to SVG canvas coords via imagePlane metadata. */
function pixelToCanvas(
  row: number,
  col: number,
  imageId: string,
  viewport: any
): [number, number] | null {
  const plane = metaData.get('imagePlaneModule', imageId);
  if (!plane) return null;
  const { imagePositionPatient: ipp, rowCosines, columnCosines, rowPixelSpacing, columnPixelSpacing } = plane;
  if (!ipp || !rowCosines || !columnCosines) return null;
  const rSpacing = rowPixelSpacing ?? 1;
  const cSpacing = columnPixelSpacing ?? 1;
  const world = [
    ipp[0] + col * rowCosines[0] * cSpacing + row * columnCosines[0] * rSpacing,
    ipp[1] + col * rowCosines[1] * cSpacing + row * columnCosines[1] * rSpacing,
    ipp[2] + col * rowCosines[2] * cSpacing + row * columnCosines[2] * rSpacing,
  ];
  const canvas = viewport.worldToCanvas(world);
  if (!canvas) return null;
  return [canvas[0], canvas[1]];
}

/** Build an SVG <polyline> points string from (row,col) pairs. */
function buildPolylinePoints(
  contour: Array<[number, number]> | undefined,
  imageId: string,
  viewport: any
): string {
  if (!contour?.length) return '';
  const pts: string[] = [];
  for (const [row, col] of contour) {
    const c = pixelToCanvas(row, col, imageId, viewport);
    if (c) pts.push(`${c[0].toFixed(1)},${c[1].toFixed(1)}`);
  }
  return pts.join(' ');
}

/** Create an SVG polyline element. */
function makeLine(points: string, stroke: string, strokeWidth: number): SVGPolylineElement {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  el.setAttribute('points', points);
  el.setAttribute('stroke', stroke);
  el.setAttribute('stroke-width', String(strokeWidth));
  el.setAttribute('fill', 'none');
  el.setAttribute('stroke-linecap', 'round');
  el.setAttribute('stroke-linejoin', 'round');
  return el;
}


export default function getCommandsModule({ servicesManager, commandsManager }) {
  const {
    pancreasAngleService,
    cornerstoneViewportService,
    uiNotificationService,
    segmentationService,
    displaySetService,
  } = servicesManager.services as any;

  return {
    definitions: {
      /**
       * Main command: fetch tumor-vessel contact angles from the Python backend
       * and store results in PancreasAngleService.
       */
      computePancreasContactAngle: {
        commandFn: async ({
          tumorSegmentationId,
          vesselSegmentations,
          studyInstanceUID,
        }: {
          tumorSegmentationId: string;
          vesselSegmentations: Array<{ id: string; name: string }>;
          studyInstanceUID: string;
        }) => {
          if (!tumorSegmentationId || vesselSegmentations.length === 0) {
            uiNotificationService?.show?.({
              title: 'PancreaSeg',
              message: 'Please select a tumor segmentation and at least one vessel.',
              type: 'warning',
            });
            return;
          }

          pancreasAngleService.setLoading(true);

          // Auto-save any in-memory (unsaved) segments before hitting the backend.
          // A segment is unsaved when its segmentationId (the key prefix) resolves
          // in segmentationService but has no DICOM display-set backing.
          const allKeys = [tumorSegmentationId, ...vesselSegmentations.map(v => v.id)];
          const uniqueSegIds = [...new Set(allKeys.map(k => {
            const sep = k.lastIndexOf('::');
            return sep !== -1 ? k.slice(0, sep) : k;
          }))];

          const seriesUIDOverrides: Record<string, string> = {};

          for (const segId of uniqueSegIds) {
            // Only auto-save if this ID is a known CornerstoneJS segmentationId
            // (in-memory segs) and it has no DICOM display set backing.
            const seg = segmentationService?.getSegmentation?.(segId);
            if (!seg) continue; // segId is a SeriesUID or unknown — already saved
            const ds = displaySetService?.getDisplaySetByUID?.(segId);
            if (ds?.SeriesInstanceUID) continue; // already DICOM-backed
            try {
              const report = await commandsManager.runCommand('storeSegmentationSilent', { segmentationId: segId });
              if (report?.SeriesInstanceUID) {
                seriesUIDOverrides[segId] = report.SeriesInstanceUID;
              }
            } catch (e) {
              console.warn('[PancreaSeg] Auto-save failed for', segId, e);
            }
          }

          // Remap keys if any segments were auto-saved
          const remap = (key: string): string => {
            const sep = key.lastIndexOf('::');
            if (sep === -1) return key;
            const segId = key.slice(0, sep);
            const idx = key.slice(sep + 2);
            return seriesUIDOverrides[segId] ? `${seriesUIDOverrides[segId]}::${idx}` : key;
          };

          const remappedTumorId = remap(tumorSegmentationId);
          const remappedVessels = vesselSegmentations.map(v => ({ ...v, id: remap(v.id) }));

          try {
            const results = await computeContactAngle({
              tumorSegmentationId: remappedTumorId,
              vesselSegmentations: remappedVessels,
              studyInstanceUID,
              apiBaseUrl: PANCREAS_API_BASE,
            });

            pancreasAngleService.setResults(results);

            const highRisk = results.filter(r => r.riskLevel === 'high');
            if (highRisk.length > 0) {
              uiNotificationService?.show?.({
                title: 'PancreaSeg — High Risk',
                message: highRisk.map(r => r.summary).join('\n'),
                type: 'error',
              });
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            pancreasAngleService.setError(message);
            uiNotificationService?.show?.({
              title: 'PancreaSeg — Error',
              message,
              type: 'error',
            });
          }
        },
      },

      /**
       * Jump the active viewport to a specific slice index.
       */
      jumpToPancreasSlice: {
        commandFn: ({
          viewportId,
          zPositionMm,
        }: {
          viewportId: string;
          zPositionMm: number;
        }) => {
          const viewport = cornerstoneViewportService?.getCornerstoneViewport?.(viewportId);
          if (!viewport) {
            console.warn('[PancreaSeg] No viewport found for id:', viewportId);
            return;
          }

          // Find the CT frame whose Z position (ImagePositionPatient[2]) is
          // closest to the Z position reported by the API.  This correctly maps
          // the SEG-local Z index back to the CT frame index in the viewport.
          let targetIndex = 0;
          const imageIds: string[] = viewport.getImageIds?.() ?? [];
          let minDist = Infinity;
          imageIds.forEach((id: string, idx: number) => {
            const plane = metaData.get('imagePlaneModule', id);
            if (plane?.imagePositionPatient) {
              const dist = Math.abs(plane.imagePositionPatient[2] - zPositionMm);
              if (dist < minDist) {
                minDist = dist;
                targetIndex = idx;
              }
            }
          });

          if (typeof viewport.setImageIdIndex === 'function') {
            viewport.setImageIdIndex(targetIndex).then(() => viewport.render());
          } else if (typeof viewport.setScrollIndex === 'function') {
            viewport.setScrollIndex(targetIndex);
            viewport.render();
          } else {
            console.warn('[PancreaSeg] Viewport does not support slice navigation');
          }
        },
      },
      /**
       * Draw tumor/vessel contour SVG overlays on the active viewport.
       * Call after jumpToPancreasSlice.  Overlay auto-updates on scroll/zoom.
       */
      highlightPancreasContours: {
        commandFn: ({
          viewportId,
          vesselResult,
        }: {
          viewportId: string;
          vesselResult: ContactAngleResult;
        }) => {
          const viewport = cornerstoneViewportService?.getCornerstoneViewport?.(viewportId);
          if (!viewport) return;
          const element: HTMLElement = viewport.element;
          if (!element) return;

          // Ensure the element is positioned so the SVG can be absolute-overlaid
          const computedPos = window.getComputedStyle(element).position;
          if (computedPos === 'static') element.style.position = 'relative';

          // Remove any previous overlay for this viewport
          const prev = overlayMap.get(viewportId);
          if (prev) { prev.cleanup(); overlayMap.delete(viewportId); }

          // Create SVG overlay
          const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          svg.setAttribute('data-pancrea-seg-overlay', '1');
          svg.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:visible;';
          element.appendChild(svg);

          const redraw = () => {
            // Clear previous drawings
            while (svg.firstChild) svg.removeChild(svg.firstChild);

            const imageIds: string[] = viewport.getImageIds?.() ?? [];
            const currentIdx: number = viewport.getCurrentImageIdIndex?.() ?? 0;
            const imageId = imageIds[currentIdx];
            if (!imageId) return;

            const entry = findSliceEntry(imageId, vesselResult.perSliceAngles);
            if (!entry || !entry.vesselContour?.length) return;

            // Vessel contour — blue
            const vesselPts = buildPolylinePoints(entry.vesselContour as Array<[number, number]>, imageId, viewport);
            if (vesselPts) svg.appendChild(makeLine(vesselPts, '#60a5fa', 1.5));

            // Tumor contour — red
            const tumorPts = buildPolylinePoints(entry.tumorContour as Array<[number, number]>, imageId, viewport);
            if (tumorPts) svg.appendChild(makeLine(tumorPts, '#f87171', 1.5));

            // Contact arc — yellow, thicker, one polyline per contiguous run
            for (const run of (entry.contactArcContours ?? [])) {
              const arcPts = buildPolylinePoints(run as Array<[number, number]>, imageId, viewport);
              if (arcPts) svg.appendChild(makeLine(arcPts, '#fde047', 2.5));
            }
          };

          const onCameraOrStack = () => redraw();

          eventTarget.addEventListener(csEnums.Events.CAMERA_MODIFIED, onCameraOrStack);
          eventTarget.addEventListener(csEnums.Events.STACK_NEW_IMAGE, onCameraOrStack);

          const ro = new ResizeObserver(() => redraw());
          ro.observe(element);

          const cleanup = () => {
            eventTarget.removeEventListener(csEnums.Events.CAMERA_MODIFIED, onCameraOrStack);
            eventTarget.removeEventListener(csEnums.Events.STACK_NEW_IMAGE, onCameraOrStack);
            ro.disconnect();
            svg.remove();
          };

          overlayMap.set(viewportId, { svg, cleanup });

          // Initial draw
          redraw();
        },
      },

      /**
       * Remove the contour overlay from the given viewport (or active viewport).
       */
      clearPancreasContourHighlight: {
        commandFn: ({ viewportId }: { viewportId?: string }) => {
          const id = viewportId;
          if (id) {
            const entry = overlayMap.get(id);
            if (entry) { entry.cleanup(); overlayMap.delete(id); }
          } else {
            overlayMap.forEach(e => e.cleanup());
            overlayMap.clear();
          }
        },
      },
    },
    defaultContext: 'CORNERSTONE',
  };
}
