import { utils, Types, DicomMetadataStore } from '@ohif/core';

import { ContextMenuController } from './CustomizableContextMenu';
import DicomTagBrowser from './DicomTagBrowser/DicomTagBrowser';
import reuseCachedLayouts from './utils/reuseCachedLayouts';
import findViewportsByPosition, {
  findOrCreateViewport as layoutFindOrCreate,
} from './findViewportsByPosition';

import { ContextMenuProps } from './CustomizableContextMenu/types';
import { NavigateHistory } from './types/commandModuleTypes';
import { history } from '@ohif/app';
import { useViewportGridStore } from './stores/useViewportGridStore';
import { useDisplaySetSelectorStore } from './stores/useDisplaySetSelectorStore';
import { useHangingProtocolStageIndexStore } from './stores/useHangingProtocolStageIndexStore';
import { useToggleHangingProtocolStore } from './stores/useToggleHangingProtocolStore';
import { useViewportsByPositionStore } from './stores/useViewportsByPositionStore';
import { useToggleOneUpViewportGridStore } from './stores/useToggleOneUpViewportGridStore';
import requestDisplaySetCreationForStudy from './Panels/requestDisplaySetCreationForStudy';
import promptSaveReport from './utils/promptSaveReport';

import { Enums as csToolsEnums, Types as cstTypes, segmentation as csToolsSegmentation, utilities as csToolsUtils } from '@cornerstonejs/tools';
import { updateLabelmapSegmentationImageReferences } from '@cornerstonejs/tools/segmentation/updateLabelmapSegmentationImageReferences';
import { cache, imageLoader, metaData, Types as csTypes, utilities as csUtils, VolumeViewport, VolumeViewport3D, eventTarget } from '@cornerstonejs/core';
import { adaptersSEG } from '@cornerstonejs/adapters';
const LABELMAP = csToolsEnums.SegmentationRepresentations.Labelmap;
import MonaiLabelClient from '../../monai-label/src/services/MonaiLabelClient';
import { updateSegmentationStats } from '../../cornerstone/src/utils/updateSegmentationStats';
import axios from 'axios';
import {
  toolboxState,
  type VlmProviderId,
  type VllmFamilyId,
  type VllmThinkingLevel,
  type MedgemmaVariantId,
} from './stores/toolboxState';
import { parseMultipart } from './utils/multipart';
import { callInputDialog } from './utils/callInputDialog';
import { getNninterToken, clearNninterToken } from './utils/nninterSession';
import { LabelmapBlock, describeBlocks } from './utils/labelmapBlocks';

/** Tracks the last series initialized by initNninter to detect study/series changes. */
let _lastInitSeries: string | undefined = undefined;

/** Safely parse a numeric timing field from multipart response metadata. */
function metaNum(meta: Record<string, unknown>, key: string): number | undefined {
  const v = meta[key];
  if (v === undefined || v === null) return undefined;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return isFinite(n) ? n : undefined;
}


export type HangingProtocolParams = {
  protocolId?: string;
  stageIndex?: number;
  activeStudyUID?: string;
  stageId?: string;
  reset?: false;
};

export type UpdateViewportDisplaySetParams = {
  direction: number;
  excludeNonImageModalities?: boolean;
};

const commandsModule = ({
  servicesManager,
  commandsManager,
  extensionManager,
}: Types.Extensions.ExtensionParams): Types.Extensions.CommandsModule => {
  const {
    customizationService,
    measurementService,
    hangingProtocolService,
    uiNotificationService,
    viewportGridService,
    displaySetService,
    multiMonitorService,
  } = servicesManager.services;

  // Listen for measurement added events to trigger nninter() when live mode is enabled
  measurementService.subscribe(
    measurementService.EVENTS.MEASUREMENT_ADDED,
    (evt) => {
      if (toolboxState.getLiveMode() &&
      ['Probe2', 'PlanarFreehandROI2', 'PlanarFreehandROI3', 'RectangleROI2'].includes(
        evt.measurement.toolName
      )) {
        const _measCount = measurementService.getMeasurements().length;
        // Defer past the render cycle so _calculateCachedStats can populate
        // cachedStats[targetId].scribble before nninter reads measurement data.
        // Promise.resolve() (microtask) is too early — scribble data is set
        // during the requestAnimationFrame render cycle that follows MEASUREMENT_ADDED.
        setTimeout(() => {
          if (toolboxState.getLocked()) {
            return;
          }

          runAiSegmentationCommand();
        }, 50);
      }
    }
  );

  // Define a context menu controller for use with any context menus
  const contextMenuController = new ContextMenuController(servicesManager, commandsManager);

  function runAiSegmentationCommand() {
    const selectedModel = toolboxState.getSelectedModel();
    if (selectedModel === 'nnInteractive') {
      commandsManager.run('nninter');
    } else if (selectedModel === 'sam2' || selectedModel === 'medsam2' || selectedModel === 'sam3') {
      commandsManager.run('sam2');
    }
  }
  function finishInferenceRun() {
    toolboxState.setInferenceInFlight(false);
    const _hadPending = toolboxState.consumePendingInferenceRun();
    if (_hadPending) {
      setTimeout(() => runAiSegmentationCommand(), 0);
    }
  }

  // Loop guard for session-expired auto-recovery: if a second recovery is
  // needed within 5s the pool is thrashing (capacity pressure) — stop and
  // tell the user instead of ping-ponging claims.
  let _lastNninterRecoveryTs = 0;

  function beginInferenceRunOrQueue(): boolean {
    if (toolboxState.getLocked()) {
      return false;
    }
    if (toolboxState.getInferenceInFlight()) {
      toolboxState.requestPendingInferenceRun();
      return false;
    }
    toolboxState.setInferenceInFlight(true);
    return true;
  }

  // Refuse to refine a hidden segment: if the active segment is hidden in the viewport the
  // user almost certainly means a visible one, and refining a segment they can't see is
  // confusing. Returns true (and notifies) when the target segment is explicitly hidden.
  function blockIfActiveSegmentHidden(
    activeViewportId: string,
    segmentationId: string,
    segmentIndex: number
  ): boolean {
    const reps = servicesManager.services.segmentationService.getSegmentationRepresentations(
      activeViewportId,
      { segmentationId }
    );
    const seg = reps?.[0]?.segments?.[segmentIndex];
    if (seg && seg.visible === false) {
      servicesManager.services.uiNotificationService.show({
        title: 'Segment hidden',
        message: 'This segment is hidden. Make it visible (or select a visible segment) to refine it.',
        type: 'warning',
        duration: 4000,
      });
      return true;
    }
    return false;
  }

  // Segmentation stats (volume/mean/etc.) are display-only but expensive for the
  // multi-block labelmap scheme — computing one segment's stats scans its full block
  // (~5s). Running it inside the inference lock queued every subsequent live-mode
  // trigger (lock-hold grew 5.9s→8s→11.8s). Instead schedule it debounced and
  // OFF the critical path so the lock releases as soon as the segmentation renders.
  // Keyed per (segmentationId, segmentIndex): rapid refinements of the same segment
  // collapse to a single trailing run; distinct segments each get their own.
  const _statsDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  function scheduleSegmentationStats(
    segmentationId: string,
    segmentNumber: number,
    readableText: any,
  ) {
    const key = `${segmentationId}:${segmentNumber}`;
    const prev = _statsDebounceTimers.get(key);
    if (prev) {
      clearTimeout(prev);
    }
    const timer = setTimeout(async () => {
      _statsDebounceTimers.delete(key);
      try {
        // Stats are computed from the block IMAGES, so land any deferred in-place write first.
        materializePendingImageSync(segmentationId);
        await updateSegmentationStats({
          segmentation: csToolsSegmentation.state.getSegmentation(segmentationId) ?? {
            segments: {},
            segmentationId,
          },
          segmentationId,
          readableText,
          targetSegmentIndex: segmentNumber,
        });
      } catch (error) {
        console.warn('Failed to update segmentation stats (deferred):', error);
      }
    }, 400);
    _statsDebounceTimers.set(key, timer);
  }

  function buildMultiBlockLabelmapRepresentation({
    segmentationId,
    derivedImageIds,
    imageIds,
    currentDisplaySets,
    segments,
    blockSegments,
    blocks,
  }: {
    segmentationId: string;
    derivedImageIds: string[];
    imageIds: string[];
    currentDisplaySets: any;
    segments: { [segmentIndex: string]: cstTypes.Segment };
    blockSegments?: number[];
    blocks?: LabelmapBlock[];
  }) {
    const N = imageIds.length;
    const blockCount = N > 0 ? Math.floor(derivedImageIds.length / N) : 1;
    // EXPLICIT block -> segment map. This used to be positional (block b always held segment b+1),
    // which is why a segment's block could never be removed: dropping a middle block shifted every
    // later block and silently renumbered those segments. Callers now pass the mapping so blocks can
    // be added/removed independently of segment numbering; we fall back to the old positional rule
    // for representations built before this existed.
    const blockSeg: number[] = (blockSegments && blockSegments.length === blockCount)
      ? blockSegments.slice()
      : Array.from({ length: blockCount }, (_, b) => b + 1);

    // Explicit blocks (possibly VARIABLE length — a z-cropped block covers only its mask's slices).
    // Without them we fall back to the legacy uniform layout: N-sized chunks of derivedImageIds.
    const blockList: LabelmapBlock[] = (blocks && blocks.length)
      ? blocks
      : Array.from({ length: blockCount }, (_, b) => ({
          segmentIndex: blockSeg[b],
          z0: 0,
          imageIds: derivedImageIds.slice(b * N, (b + 1) * N),
        }));
    // Flat list cornerstone consumes; derived from the blocks so the two can never disagree.
    const flatImageIds: string[] = blockList.flatMap(b => b.imageIds);
    const primaryLabelmapId = `${segmentationId}-storage-0`;
    const labelmaps: Record<string, object> = {};
    const segmentBindings: Record<number, object> = {};

    // Cornerstone's labelmap resolver maps labelmap image k -> referencedImageIds[k]
    // strictly by INDEX. For a flipped series the block's imageIds are stored in reversed
    // z-order, so using the display-order `imageIds` here would pair each labelmap slice
    // with the wrong source slice and render the overlay z-mirrored. Derive referencedImageIds
    // from each labelmap image's own referencedImageId so the mapping is order-safe
    // (identity for a non-flipped series where blockImageIds are already in display order).
    const refIdsFor = (ids: string[]): string[] => {
      const refs = ids.map(id => (cache.getImage(id) as any)?.referencedImageId);
      // Compare against the BLOCK's own length: a sparse (z-cropped) block is shorter than N, and
      // the old `refs.length === N` guard would silently fall back to the full source list, pairing
      // its slices with the wrong source images.
      return refs.length === ids.length && refs.every(Boolean) ? (refs as string[]) : imageIds;
    };

    for (let b = 0; b < blockList.length; b++) {
      const segIdx = blockList[b].segmentIndex;
      const blockImageIds = blockList[b].imageIds;
      const labelmapId = b === 0 ? primaryLabelmapId : `${segmentationId}-private-${segIdx}`;
      labelmaps[labelmapId] = {
        labelmapId,
        type: 'stack',
        imageIds: blockImageIds,
        referencedVolumeId: currentDisplaySets.displaySetInstanceUID,
        referencedImageIds: refIdsFor(blockImageIds),
        labelToSegmentIndex: {},
      };
      segmentBindings[segIdx] = { labelmapId, labelValue: segIdx };
    }

    // Single-layer labelmaps (e.g. SAM2 overlap=false) store multiple segment values in one block.
    if (blockList.length === 1) {
      const primaryId = primaryLabelmapId;
      Object.keys(segments)
        .map(Number)
        .filter(index => index > 0)
        .forEach(segIdx => {
          segmentBindings[segIdx] = { labelmapId: primaryId, labelValue: segIdx };
        });
    }

    return {
      blockCount: blockList.length,
      blockSegments: blockList.map(b => b.segmentIndex),
      blocks: blockList,
      labelmapRepresentation: {
        imageIds: flatImageIds,
        allImageIds: flatImageIds,
        // Persisted so later refines/deletes know which segment each block holds, and (for sparse
        // blocks) which slices it covers.
        blockSegments: blockList.map(b => b.segmentIndex),
        blocks: blockList,
        referencedVolumeId: currentDisplaySets.displaySetInstanceUID,
        // The SOURCE image ids for the whole series (not a block's) — releaseSegmentBlock and the
        // legacy describeBlocks path both use this to know the series length.
        referencedImageIds: imageIds,
        labelmaps,
        segmentBindings,
        primaryLabelmapId,
        sourceRepresentationName: 'binaryLabelmap',
      },
    };
  }

  function refreshActiveSegmentationContext(
    activeViewportId: string,
    currentDisplaySets: any,
    fallbackSegmentationId: string,
  ) {
    const freshActiveSegmentation =
      servicesManager.services.segmentationService.getActiveSegmentation(activeViewportId);

    if (!freshActiveSegmentation) {
      return {
        segments: {} as { [segmentIndex: string]: cstTypes.Segment },
        segmentationId: fallbackSegmentationId,
        segImageIds: [] as string[],
        existingSegments: {} as { [segmentIndex: string]: cstTypes.Segment },
        existing: false,
        blockSegments: null as number[] | null,
      };
    }

    let existingSegments: { [segmentIndex: string]: cstTypes.Segment } = {};
    let segImageIds: string[] = [];
    let blockSegments: number[] | null = null;
    let existing = false;
    let segmentationId = freshActiveSegmentation.segmentationId;

    let existingseriesInstanceUid = freshActiveSegmentation.cachedStats?.seriesInstanceUid;
    if (existingseriesInstanceUid === undefined) {
      for (const segment of Object.values(freshActiveSegmentation.segments ?? {})) {
        if (segment.cachedStats?.algorithmType !== undefined) {
          existingseriesInstanceUid = segment.cachedStats.algorithmType;
          break;
        }
      }
    }

    if (existingseriesInstanceUid === currentDisplaySets.SeriesInstanceUID) {
      existingSegments = freshActiveSegmentation.segments || {};
      segImageIds =
        freshActiveSegmentation.representationData?.Labelmap?.allImageIds ??
        freshActiveSegmentation.representationData?.Labelmap?.imageIds ??
        [];
      blockSegments =
        (freshActiveSegmentation.representationData?.Labelmap as any)?.blockSegments ?? null;
      existing = true;
    }

    return {
      segments: { ...(freshActiveSegmentation.segments ?? {}) },
      segmentationId,
      segImageIds,
      existingSegments,
      existing,
      blockSegments,
    };
  }

  function mergeSegmentsForUpdate(
    segmentationId: string,
    segmentsUpdate: { [segmentIndex: string]: cstTypes.Segment },
  ) {
    const latest = csToolsSegmentation.state.getSegmentation(segmentationId);
    const merged: { [segmentIndex: string]: cstTypes.Segment } = {
      ...(latest?.segments ?? {}),
    };

    for (const [key, segment] of Object.entries(segmentsUpdate)) {
      const segmentIndex = Number(key);
      if (!Number.isFinite(segmentIndex) || segmentIndex <= 0) {
        continue;
      }
      merged[segmentIndex] = {
        ...(merged[segmentIndex] ?? {}),
        ...segment,
        segmentIndex,
      };
    }

    return merged;
  }

  function ensureAllSegmentsVisible(segmentationId: string) {
    const latest = csToolsSegmentation.state.getSegmentation(segmentationId);
    if (!latest?.segments) {
      return;
    }

    const viewportIds = servicesManager.services.cornerstoneViewportService.getViewportIds();
    for (const viewportId of viewportIds) {
      for (const key of Object.keys(latest.segments)) {
        const segmentIndex = Number(key);
        if (!Number.isFinite(segmentIndex) || segmentIndex <= 0) {
          continue;
        }
        servicesManager.services.segmentationService.setSegmentVisibility(
          viewportId,
          segmentationId,
          segmentIndex,
          true
        );
      }
    }
  }

  /**
   * Pending image-sync work from volume-only in-place refines, keyed segmentationId -> segmentIndex.
   *
   * On an in-place refine we write the crop into the MPR labelmap VOLUME (what the screen shows) and
   * deliberately skip writing the block's stack IMAGES, because touching an existing labelmap image
   * costs ~7ms/slice (cornerstone re-materialises the buffer lazily) — that was ~2.5s/refine, far
   * more than the remount it replaced. The images are only needed by stack viewports, DICOM-SEG
   * export, and any later remount (which rebuilds the volume FROM them), so we defer that write until
   * one of those actually happens.
   *
   * nnInteractive returns the segment's FULL current mask each refine (never a delta), so only the
   * LATEST payload per segment matters — later refines simply overwrite the entry. That removes any
   * ordering/replay concern: N rapid refines cost one materialisation, not N.
   */
  const _pendingImageSync = new Map<string, Map<number, any>>();

  /** Apply (and clear) deferred image writes so the block's images match what MPR already shows. */
  function materializePendingImageSync(segmentationId?: string) {
    const keys = segmentationId ? [segmentationId] : Array.from(_pendingImageSync.keys());
    for (const segId of keys) {
      const bySegment = _pendingImageSync.get(segId);
      if (!bySegment?.size) continue;
      for (const p of bySegment.values()) {
        // Clear the segment's previous pixels, then write the current crop — same result the
        // interactive path would have produced, just paid once and off the critical path.
        for (const arrIdx of p.clearIdxs as number[]) {
          const vm = cache.getImage(p.blockImageIds[arrIdx])?.voxelManager as csTypes.IVoxelManager<number>;
          if (!vm) continue;
          const sd = vm.getScalarData();
          for (let j = 0; j < sd.length; j++) if (sd[j] === p.segmentNumber) sd[j] = 0;
        }
        for (let z = p.segZ0; z < p.segZ1; z++) {
          const vm = cache.getImage(p.blockImageIds[z])?.voxelManager as csTypes.IVoxelManager<number>;
          if (!vm) continue;
          const sd = vm.getScalarData();
          const cropSliceBase = (z - p.segZ0) * p.cropY * p.cropX;
          for (let cy = 0; cy < p.cropY; cy++) {
            const srcRow = cropSliceBase + cy * p.cropX;
            const dstRow = (p.y0 + cy) * p.fullX + p.x0;
            for (let cx = 0; cx < p.cropX; cx++) {
              if (p.cropBytes[srcRow + cx] === 1) sd[dstRow + cx] = p.segmentNumber;
            }
          }
        }
      }
      _pendingImageSync.delete(segId);
    }
  }

  /**
   * IN-PLACE MPR UPDATE — write a refined segment's crop straight into its existing labelmap
   * VOLUME, so a refine needs neither a fresh block nor a remount.
   *
   * Why: every refine used to mint a fresh full-volume block (new derived imageIds), which forced
   * a remount, which made cornerstone build a NEW MPR labelmap volume and orphan the old one under
   * an internal uuid. That orphan is unreachable (four eviction strategies failed to identify it),
   * so the volume cache grew +1/refine unbounded — driving the MPR remount creep (36->158ms) and
   * multi-second GC freezes. The only fix is to stop creating the orphan: keep the same imageIds
   * and mutate the volume that is already on screen.
   *
   * Mechanism proven by resetSegment: the rendered labelmap volume's scalar buffer is a Uint8Array
   * we can mutate + mark modified. Only labelmap volumes are Uint8Array (the CT is Int16/float), and
   * in the multi-block scheme each segment owns its own block/volume, so indexOf(segmentNumber)
   * identifies this segment's volume without needing its (unreachable) volumeId.
   *
   * Clears the segment's previous extent first so a refine REPLACES rather than unions, then writes
   * the new crop. Both passes are bounded to the affected z-slabs, never the whole volume.
   *
   * Returns true if the segment's volume was found and updated (caller can then skip the remount).
   */
  function updateMprLabelmapVolumeInPlace({
    segmentNumber,
    cropBytes,
    segZ0,
    segZ1,
    cropY,
    cropX,
    y0,
    x0,
    fullX,
    fullY,
    prevZ0,
    prevZ1,
    prevBox,
  }: {
    segmentNumber: number;
    cropBytes: Uint8Array;
    segZ0: number; segZ1: number;
    cropY: number; cropX: number;
    y0: number; x0: number;
    fullX: number; fullY: number;
    prevZ0: number; prevZ1: number;
    prevBox?: { y0: number; x0: number; cropY: number; cropX: number } | null;
  }): boolean {
    const vpSvc = servicesManager.services.cornerstoneViewportService;
    const sliceLen = fullY * fullX;
    if (!sliceLen) return false;

    const scanned = new Set<any>();
    const mprVps: any[] = [];
    let updated = false;

    for (const viewportId of vpSvc.getViewportIds()) {
      const vp = vpSvc.getCornerstoneViewport(viewportId) as any;
      if (!(vp instanceof VolumeViewport) || vp instanceof VolumeViewport3D) continue;
      mprVps.push(vp);

      for (const actorEntry of (vp?.getActors?.() ?? [])) {
        const inputData = actorEntry?.actor?.getMapper?.()?.getInputData?.();
        const scalars = inputData?.getPointData?.()?.getScalars?.();
        const data = scalars?.getData?.();
        if (!(data instanceof Uint8Array)) continue;   // labelmap volumes only; never the CT
        if (scanned.has(data)) continue;               // volumes are shared across the 3 MPR panes
        scanned.add(data);
        if (data.indexOf(segmentNumber) === -1) continue;  // not this segment's block volume

        // Pass 1: clear the segment's previous extent. Bounded in Z *and* XY — the segment only ever
        // occupies its crop bbox, so scanning full 512x512 slices was ~10M redundant checks/refine
        // (measured 46-149ms). prevBox is the previous refine's bbox (union'd with the new crop so a
        // moved/shrunk mask is fully cleared); without it we fall back to the full slice.
        const clearZ0 = Math.max(0, Math.min(prevZ0, segZ0));
        const clearZ1 = Math.min(Math.floor(data.length / sliceLen), Math.max(prevZ1, segZ1));
        const bx0 = prevBox ? Math.max(0, Math.min(prevBox.x0, x0)) : 0;
        const bx1 = prevBox ? Math.min(fullX, Math.max(prevBox.x0 + prevBox.cropX, x0 + cropX)) : fullX;
        const by0 = prevBox ? Math.max(0, Math.min(prevBox.y0, y0)) : 0;
        const by1 = prevBox ? Math.min(fullY, Math.max(prevBox.y0 + prevBox.cropY, y0 + cropY)) : fullY;
        for (let z = clearZ0; z < clearZ1; z++) {
          const base = z * sliceLen;
          for (let by = by0; by < by1; by++) {
            const row = base + by * fullX;
            for (let bx = bx0; bx < bx1; bx++) {
              if (data[row + bx] === segmentNumber) data[row + bx] = 0;
            }
          }
        }

        // Pass 2: write the new crop.
        for (let z = segZ0; z < segZ1; z++) {
          const cropSliceBase = (z - segZ0) * cropY * cropX;
          const volSliceBase = z * sliceLen;
          for (let cy = 0; cy < cropY; cy++) {
            const srcRow = cropSliceBase + cy * cropX;
            const dstRow = volSliceBase + (y0 + cy) * fullX + x0;
            for (let cx = 0; cx < cropX; cx++) {
              if (cropBytes[srcRow + cx] === 1) data[dstRow + cx] = segmentNumber;
            }
          }
        }

        scalars.modified?.();
        inputData.modified?.();
        actorEntry.actor?.modified?.();
        actorEntry.actor?.getMapper?.()?.modified?.();
        updated = true;
      }
    }

    if (updated) {
      for (const vp of mprVps) vp?.render?.();
    }
    return updated;
  }

  /**
   * Lightweight reconcile for a LAYER-SET change (a block added or removed).
   *
   * remountSegmentationRepresentations is all-or-nothing: cornerstone's remove/add API works on the
   * whole segmentationId, so it tears down and rebuilds EVERY block's MPR volume even when only one
   * block changed. That is both the cost that grows with segment count (mpr= 16->38ms) and the source
   * of the remaining +1 volume/remount leak.
   *
   * We don't need it here. Per the note in remountSegmentationRepresentations, cornerstone's own
   * reconcile already mounts/unmounts correctly WHEN THE LAYER SET CHANGES — the forced remove/re-add
   * was only needed for the refine case (layer set unchanged, block imageIds swapped), and that case
   * is now handled by writing into the volume in place. So for add/remove we just refresh the MPR
   * image references and fire segmentationModified, letting the reconcile touch only the changed layer.
   */
  function reconcileLabelmapLayers(segmentationId: string) {
    const vpSvc = servicesManager.services.cornerstoneViewportService;
    for (const viewportId of vpSvc.getViewportIds()) {
      const vp = vpSvc.getCornerstoneViewport(viewportId) as any;
      if (vp instanceof VolumeViewport && !(vp instanceof VolumeViewport3D)) {
        updateLabelmapSegmentationImageReferences(viewportId, segmentationId);
      }
    }
    const trig = (cornerstoneTools as any)?.segmentation?.triggerSegmentationEvents;
    if (trig?.triggerSegmentationModified) {
      trig.triggerSegmentationModified(segmentationId);
    } else {
      eventTarget.dispatchEvent(
        new CustomEvent(csToolsEnums.Events.SEGMENTATION_MODIFIED, { detail: { segmentationId } })
      );
    }
    eventTarget.dispatchEvent(
      new CustomEvent(csToolsEnums.Events.SEGMENTATION_DATA_MODIFIED, { detail: { segmentationId } })
    );
  }

  async function syncLabelmapRepresentations({
    activeViewportId,
    segmentationId,
    existing,
    blockCount,
    prevBlockCount,
    currentImageIdIndex,
    representations,
    mprInPlaceDone = false,
  }: {
    activeViewportId: string;
    segmentationId: string;
    existing: boolean;
    blockCount: number;
    prevBlockCount: number;
    currentImageIdIndex?: number;
    representations: any[];
    mprInPlaceDone?: boolean;
  }) {
    const blockCountIncreased = existing && blockCount > prevBlockCount;

    if (!existing) {
      await remountSegmentationRepresentations({
        activeViewportId,
        segmentationId,
        currentImageIdIndex,
        representations,
      });
      return;
    }

    if (blockCountIncreased) {
      // Adding a segment only appends a layer — reconcile mounts it without rebuilding the others.
      materializePendingImageSync(segmentationId);
      reconcileLabelmapLayers(segmentationId);
      return;
    } else {
      // Refine case (same block count): VolumeViewport (MPR) actors are VTK-based and need
      // remount when the block's imageIds change — SEGMENTATION_DATA_MODIFIED alone is not enough.
      // EXCEPT when the crop was already written straight into the on-screen labelmap volume
      // (updateMprLabelmapVolumeInPlace): the MPR is then already correct, and skipping the remount
      // avoids building a fresh volume that orphans the previous one (+1 volume/refine leak).
      const allViewportIds = servicesManager.services.cornerstoneViewportService.getViewportIds();
      const hasMprViewport = allViewportIds.some(vid => {
        const vp = servicesManager.services.cornerstoneViewportService.getCornerstoneViewport(vid);
        return vp instanceof VolumeViewport && !(vp instanceof VolumeViewport3D);
      });
      if (hasMprViewport && !mprInPlaceDone) {
        await remountSegmentationRepresentations({
          activeViewportId,
          segmentationId,
          currentImageIdIndex,
          representations,
        });
        return; // remountSegmentationRepresentations already dispatches SEGMENTATION_DATA_MODIFIED
      }
    }

    eventTarget.dispatchEvent(
      new CustomEvent(csToolsEnums.Events.SEGMENTATION_DATA_MODIFIED, {
        detail: { segmentationId },
      })
    );
  }

  async function remountSegmentationRepresentations({
    activeViewportId,
    segmentationId,
    currentImageIdIndex,
    representations,
  }: {
    activeViewportId: string;
    segmentationId: string;
    currentImageIdIndex?: number;
    representations: any[];
  }) {
    // A remount rebuilds the MPR volume FROM the block images, so any deferred write from a
    // volume-only in-place refine must land first — otherwise the rebuild would resurrect the
    // pre-refine mask and the segment would appear to roll back.
    materializePendingImageSync(segmentationId);
    // Capture the current per-segment visibility BEFORE any remove/re-add. Removing and
    // re-adding a representation resets every segment to visible, so we restore this map
    // AFTER all re-adds below — otherwise each inference clobbers the user's hidden segments.
    const visibilityBySegment: Record<number, boolean> = {};
    for (let i = 0; i < representations.length; i++) {
      const segs = Object.values(representations[i].segments);
      for (let j = 0; j < segs.length; j++) {
        const seg = segs[j] as any;
        if (seg.segmentIndex != null) {
          visibilityBySegment[seg.segmentIndex] = seg.visible;
        }
      }
    }

    const currentViewportIds = servicesManager.services.cornerstoneViewportService.getViewportIds();
    const stackViewportIds: string[] = [];
    const mprViewportIds: string[] = [];
    const volume3DViewportIds: string[] = [];
    for (const viewportId of currentViewportIds) {
      const vp = servicesManager.services.cornerstoneViewportService.getCornerstoneViewport(viewportId);
      if (vp instanceof VolumeViewport3D) volume3DViewportIds.push(viewportId);
      else if (vp instanceof VolumeViewport) mprViewportIds.push(viewportId);
      else stackViewportIds.push(viewportId);
    }

    // Purge stale MPR volume caches synchronously BEFORE any events that could trigger
    // the SegmentationRenderingEngine reconcile for MPR viewports.
    if (mprViewportIds.length > 0) {
      const csToolsAny = cornerstoneTools as any;
      const seg = csToolsAny.segmentation.state.getSegmentation(segmentationId);
      const labelmapData = seg?.representationData?.Labelmap as any;
      if (labelmapData) {
        if (labelmapData.volumeId) {
          cache.removeVolumeLoadObject(labelmapData.volumeId);
          delete labelmapData.volumeId;
        }
        for (const [labelmapId, layer] of Object.entries(labelmapData.labelmaps ?? {}) as [string, any][]) {
          if ((layer as any).geometryVolumeId) {
            if (cache.getVolume((layer as any).geometryVolumeId)) {
              cache.removeVolumeLoadObject((layer as any).geometryVolumeId);
            }
            delete (layer as any).geometryVolumeId;
          }
          const defaultKey = `${labelmapId}-geometry`;
          if (cache.getVolume(defaultKey)) {
            cache.removeVolumeLoadObject(defaultKey);
          }
        }
      }
    }

    // Update MPR image references synchronously before triggering any renders.
    for (const viewportId of mprViewportIds) {
      updateLabelmapSegmentationImageReferences(viewportId, segmentationId);
    }

    // Remove + re-add STACK viewports only.
    // MPR viewports are intentionally NOT removed here. The SegmentationRenderingEngine's
    // reconcile (triggered as a side effect of the stack re-add's triggerSegmentationModified)
    // handles the MPR remove+remount atomically as microtasks. No animation frame can fire
    // between reconcile's remove() and mount(), so the MPR canvas never shows a blank frame.
    for (const viewportId of stackViewportIds) {
      servicesManager.services.segmentationService.removeSegmentationRepresentations(viewportId, { segmentationId });
    }
    await Promise.all(stackViewportIds.map(viewportId =>
      servicesManager.services.segmentationService.addSegmentationRepresentation(viewportId, { segmentationId })
    ));

    // Force MPR actors to rebuild. The legacy-volume reconcile REUSES the existing actor
    // (actors 1->1) when the layer set is unchanged (single-segment refine) and does NOT
    // rebuild the actor's volume from the new block imageIds. Since remount purged the old
    // volume, the reused actor then references a dead volume and renders blank (disappears).
    // Explicitly removing the representation drops the stale actor (1->0) so the re-add
    // rebuilds it (0->1) from the current imageIds. (Adding a 2nd segment worked only because
    // the new layer changed the actor set and forced this rebuild.)
    for (const viewportId of mprViewportIds) {
      servicesManager.services.segmentationService.removeSegmentationRepresentations(viewportId, { segmentationId });
    }
    for (const viewportId of mprViewportIds) {
      updateLabelmapSegmentationImageReferences(viewportId, segmentationId);
      await servicesManager.services.segmentationService.addSegmentationRepresentation(viewportId, {
        segmentationId,
        type: csToolsEnums.SegmentationRepresentations.Labelmap,
      });
    }

    // Volume3D viewports: explicit remove+re-add with timeout to ensure actors mount.
    for (const viewportId of volume3DViewportIds) {
      servicesManager.services.segmentationService.removeSegmentationRepresentations(viewportId, { segmentationId });
      const vp = servicesManager.services.cornerstoneViewportService.getCornerstoneViewport(viewportId);
      updateLabelmapSegmentationImageReferences(viewportId, segmentationId);
      await servicesManager.services.segmentationService.addSegmentationRepresentation(viewportId, {
        segmentationId,
        type: csToolsEnums.SegmentationRepresentations.Labelmap,
      });
      await new Promise(resolve => setTimeout(resolve, 100));
      requestAnimationFrame(() => vp?.render());
    }

    // Restore per-segment visibility on every viewport (the remove/re-adds above reset it
    // to visible). Newly-added segments aren't in the map, so they stay visible by default.
    const _restoreViewportIds = servicesManager.services.cornerstoneViewportService.getViewportIds();
    for (const viewportId of _restoreViewportIds) {
      for (const [segIdxStr, visible] of Object.entries(visibilityBySegment)) {
        servicesManager.services.segmentationService.setSegmentVisibility(
          viewportId,
          segmentationId,
          Number(segIdxStr),
          visible
        );
      }
    }

    const activeVp = activeViewportId.startsWith('default')
      ? servicesManager.services.cornerstoneViewportService.getCornerstoneViewport(activeViewportId)
      : null;
    if (activeVp?.setImageIdIndex && currentImageIdIndex !== undefined) {
      const away = currentImageIdIndex === 0 ? 1 : 0;
      await activeVp.setImageIdIndex(away);
      await activeVp.setImageIdIndex(currentImageIdIndex);
    }


    eventTarget.dispatchEvent(
      new CustomEvent(csToolsEnums.Events.SEGMENTATION_DATA_MODIFIED, {
        detail: { segmentationId },
      })
    );
  }

  /**
   * Helper function to handle post-segmentation processing after segmentation data is created/updated.
   * This includes updating representations, handling viewports, and triggering events.
   */
  async function postSegmentationProcessing({
    activeViewportId,
    segmentationId,
    segmentNumber,
    segments,
    derivedImageIds,
    currentDisplaySets,
    imageIds,
    existingSegments,
    existing,
    activeSegmentation,
    currentImageIdIndex,
    z_range,
    mprInPlaceDone = false,
    blockSegments,
  }: {
    activeViewportId: string;
    segmentationId: string;
    segmentNumber: number;
    segments: { [segmentIndex: string]: cstTypes.Segment };
    derivedImageIds: string[];
    currentDisplaySets: any;
    imageIds: string[];
    existingSegments: { [segmentIndex: string]: cstTypes.Segment };
    existing: boolean;
    activeSegmentation: any;
    mprInPlaceDone?: boolean;
    blockSegments?: number[] | null;
    currentImageIdIndex?: number;
    z_range: number[];
  }) {
    // Get the representations for the segmentation to recover the visibility of the segments
    const representations = servicesManager.services.segmentationService.getSegmentationRepresentations(activeViewportId, { segmentationId });

    const prevSegmentation = csToolsSegmentation.state.getSegmentation(segmentationId);
    const prevAllImageIds =
      prevSegmentation?.representationData?.Labelmap?.allImageIds ??
      prevSegmentation?.representationData?.Labelmap?.imageIds ??
      [];
    const prevBlockCount = imageIds.length > 0 ? Math.floor(prevAllImageIds.length / imageIds.length) : 0;

    const { blockCount, labelmapRepresentation } = buildMultiBlockLabelmapRepresentation({
      segmentationId,
      derivedImageIds,
      imageIds,
      currentDisplaySets,
      segments,
      blockSegments: blockSegments ?? undefined,
    });
    const mergedSegments = mergeSegmentsForUpdate(segmentationId, segments);

    if (segmentNumber === 1 && Object.keys(existingSegments).length === 0 && !existing) {
      csToolsSegmentation.addSegmentations([
        {
          segmentationId,
          representation: {
            type: LABELMAP,
            data: labelmapRepresentation,
          },
          config: {
            cachedStats: {
              center: z_range.length > 0 ? z_range.reduce((sum, z) => sum + z, 0) / z_range.length : 0
            },
            label: currentDisplaySets.SeriesDescription,
            segments: mergedSegments,
          },
        }
      ]);
    } else {
      const readableText = customizationService.getCustomization('panelSegmentation.readableText');

      const existingSegmentation = prevSegmentation ?? csToolsSegmentation.state.getSegmentation(segmentationId);
      const existingRepresentationData = existingSegmentation?.representationData || {};

      const updatedRepresentationData = { ...existingRepresentationData };
      const SURFACE = csToolsEnums.SegmentationRepresentations.Surface;
      if (updatedRepresentationData[SURFACE]) {
        delete updatedRepresentationData[SURFACE];
      }

      csToolsSegmentation.updateSegmentations([
        {
          segmentationId,
          payload: {
            segments: mergedSegments,
            representationData: {
              ...updatedRepresentationData,
              [LABELMAP]: labelmapRepresentation,
            }
          },
        },
      ]);

      // Off the critical path — do NOT await. Holding the inference lock on this
      // ~5s multi-block stats computation queued every subsequent live-mode trigger.
      scheduleSegmentationStats(segmentationId, segmentNumber, readableText);
    }

    // Only make the target segment visible if it's newly added — not a refinement.
    // ensureAllSegmentsVisible was clobbering user-hidden segments on every prediction.
    if (!existingSegments[segmentNumber]) {
      const viewportIds = servicesManager.services.cornerstoneViewportService.getViewportIds();
      for (const viewportId of viewportIds) {
        servicesManager.services.segmentationService.setSegmentVisibility(
          viewportId, segmentationId, segmentNumber, true
        );
      }
    }
    // Don't override active segment if user already switched (e.g. pressed 'm' during inference).
    // The pending queued inference run must fire with the user's chosen segment, not the just-completed one.
    const _currentActive = servicesManager.services.segmentationService.getActiveSegment(activeViewportId);
    if (!_currentActive || _currentActive.segmentIndex === segmentNumber) {
      servicesManager.services.segmentationService.setActiveSegment(segmentationId, segmentNumber);
    }
    // Always update toolboxState — it tracks the server's last segment context for _needsReset detection.
    toolboxState.setCurrentActiveSegment(segmentNumber);

    if (toolboxState.getRefineNew()) {
      toolboxState.setRefineNew(false);
    }

    await syncLabelmapRepresentations({
      activeViewportId,
      segmentationId,
      existing,
      blockCount,
      prevBlockCount,
      currentImageIdIndex,
      representations,
      mprInPlaceDone,
    });
  }

  const actions = {
    setAiToolActive: ({ toolName }: { toolName: string }) => {
      if (!toolName) {
        return;
      }

      if (toolboxState.getLocked() && toolName !== 'Pan') {
        return commandsManager.run('setToolActive', { toolName: 'Pan' });
      }

      return commandsManager.run('setToolActive', { toolName });
    },

    runAiSegmentation: () => {
      if (toolboxState.getLocked()) {
        return;
      }

      const selectedModel = toolboxState.getSelectedModel();
      if (selectedModel === 'sam2' || selectedModel === 'medsam2' || selectedModel === 'sam3') {
        return commandsManager.run('sam2');
      }

      return commandsManager.run('nninter');
    },

    /**
     * Runs a command in multi-monitor mode.  No-op if not multi-monitor.
     */
    multimonitor: async options => {
      const { screenDelta, StudyInstanceUID, commands, hashParams } = options;
      if (multiMonitorService.numberOfScreens < 2) {
        return options.fallback?.(options);
      }

      const newWindow = await multiMonitorService.launchWindow(
        StudyInstanceUID,
        screenDelta,
        hashParams
      );

      // Only run commands if we successfully got a window with a commands manager
      if (newWindow && commands) {
        // Todo: fix this properly, but it takes time for the new window to load
        // and then the commandsManager is available for it
        setTimeout(() => {
          multiMonitorService.run(screenDelta, commands, options);
        }, 1000);
      }
    },

    /** Displays a prompt and then save the report if relevant */
    promptSaveReport: props => {
      const { StudyInstanceUID } = props;
      promptSaveReport({ servicesManager, commandsManager, extensionManager }, props, {
        data: { StudyInstanceUID },
      });
    },

    /**
     * Ensures that the specified study is available for display
     * Then, if commands is specified, runs the given commands list/instance
     */
    loadStudy: async options => {
      const { StudyInstanceUID } = options;
      const displaySets = displaySetService.getActiveDisplaySets();
      const isActive = displaySets.find(ds => ds.StudyInstanceUID === StudyInstanceUID);
      if (isActive) {
        return;
      }
      const [dataSource] = extensionManager.getActiveDataSource();
      await requestDisplaySetCreationForStudy(dataSource, displaySetService, StudyInstanceUID);

      const study = DicomMetadataStore.getStudy(StudyInstanceUID);
      hangingProtocolService.addStudy(study);
    },

    /**
     * Show the context menu.
     * @param options.menuId defines the menu name to lookup, from customizationService
     * @param options.defaultMenu contains the default menu set to use
     * @param options.element is the element to show the menu within
     * @param options.event is the event that caused the context menu
     * @param options.selectorProps is the set of selection properties to use
     */
    showContextMenu: (options: ContextMenuProps) => {
      const {
        menuCustomizationId,
        element,
        event,
        selectorProps,
        defaultPointsPosition = [],
      } = options;

      const optionsToUse = { ...options };

      if (menuCustomizationId) {
        Object.assign(optionsToUse, customizationService.getCustomization(menuCustomizationId));
      }

      // TODO - make the selectorProps richer by including the study metadata and display set.
      const { protocol, stage } = hangingProtocolService.getActiveProtocol();
      optionsToUse.selectorProps = {
        event,
        protocol,
        stage,
        ...selectorProps,
      };

      contextMenuController.showContextMenu(optionsToUse, element, defaultPointsPosition);
    },

    /** Close a context menu currently displayed */
    closeContextMenu: () => {
      contextMenuController.closeContextMenu();
    },

    displayNotification: ({ text, title, type }) => {
      uiNotificationService.show({
        title: title,
        message: text,
        type: type,
      });
    },

    clearMeasurements: options => {
      measurementService.clearMeasurements(options.measurementFilter);
    },

    /**
     *  Sets the specified protocol
     *    1. Records any existing state using the viewport grid service
     *    2. Finds the destination state - this can be one of:
     *       a. The specified protocol stage
     *       b. An alternate (toggled or restored) protocol stage
     *       c. A restored custom layout
     *    3. Finds the parameters for the specified state
     *       a. Gets the displaySetSelectorMap
     *       b. Gets the map by position
     *       c. Gets any toggle mapping to map position to/from current view
     *    4. If restore, then sets layout
     *       a. Maps viewport position by currently displayed viewport map id
     *       b. Uses toggle information to map display set id
     *    5. Else applies the hanging protocol
     *       a. HP Service is provided displaySetSelectorMap
     *       b. HP Service will throw an exception if it isn't applicable
     * @param options - contains information on the HP to apply
     * @param options.activeStudyUID - the updated study to apply the HP to
     * @param options.protocolId - the protocol ID to change to
     * @param options.stageId - the stageId to apply
     * @param options.stageIndex - the index of the stage to go to.
     * @param options.reset - flag to indicate if the HP should be reset to its original and not restored to a previous state
     *
     * commandsManager.run('setHangingProtocol', {
     *   activeStudyUID: '1.2.3',
     *   protocolId: 'myProtocol',
     *   stageId: 'myStage',
     *   stageIndex: 0,
     *   reset: false,
     * });
     */
    setHangingProtocol: ({
      activeStudyUID = '',
      StudyInstanceUID = '',
      protocolId,
      stageId,
      stageIndex,
      reset = false,
    }: HangingProtocolParams): boolean => {
      const toUseStudyInstanceUID = activeStudyUID || StudyInstanceUID;
      try {
        // Stores in the state the display set selector id to displaySetUID mapping
        // Pass in viewportId for the active viewport.  This item will get set as
        // the activeViewportId
        const state = viewportGridService.getState();
        const hpInfo = hangingProtocolService.getState();
        reuseCachedLayouts(state, hangingProtocolService);
        const { hangingProtocolStageIndexMap } = useHangingProtocolStageIndexStore.getState();
        const { displaySetSelectorMap } = useDisplaySetSelectorStore.getState();

        if (!protocolId) {
          // Reuse the previous protocol id, and optionally stage
          protocolId = hpInfo.protocolId;
          if (stageId === undefined && stageIndex === undefined) {
            stageIndex = hpInfo.stageIndex;
          }
        } else if (stageIndex === undefined && stageId === undefined) {
          // Re-set the same stage as was previously used
          const hangingId = `${toUseStudyInstanceUID || hpInfo.activeStudyUID}:${protocolId}`;
          stageIndex = hangingProtocolStageIndexMap[hangingId]?.stageIndex;
        }

        const useStageIdx =
          stageIndex ??
          hangingProtocolService.getStageIndex(protocolId, {
            stageId,
            stageIndex,
          });

        const activeStudyChanged = hangingProtocolService.setActiveStudyUID(toUseStudyInstanceUID);

        const storedHanging = `${toUseStudyInstanceUID || hangingProtocolService.getState().activeStudyUID}:${protocolId}:${
          useStageIdx || 0
        }`;

        const { viewportGridState } = useViewportGridStore.getState();
        const restoreProtocol = !reset && viewportGridState[storedHanging];

        if (
          reset ||
          (activeStudyChanged &&
            !viewportGridState[storedHanging] &&
            stageIndex === undefined &&
            stageId === undefined)
        ) {
          // Run the hanging protocol fresh, re-using the existing study data
          // This is done on reset or when the study changes and we haven't yet
          // applied it, and don't specify exact stage to use.
          const displaySets = displaySetService.getActiveDisplaySets();
          const activeStudy = {
            StudyInstanceUID: toUseStudyInstanceUID,
            displaySets,
          };
          hangingProtocolService.run(activeStudy, protocolId);
        } else if (
          protocolId === hpInfo.protocolId &&
          useStageIdx === hpInfo.stageIndex &&
          !toUseStudyInstanceUID
        ) {
          // Clear the HP setting to reset them
          hangingProtocolService.setProtocol(protocolId, {
            stageId,
            stageIndex: useStageIdx,
          });
        } else {
          hangingProtocolService.setProtocol(protocolId, {
            displaySetSelectorMap,
            stageId,
            stageIndex: useStageIdx,
            restoreProtocol,
          });
          if (restoreProtocol) {
            viewportGridService.set(viewportGridState[storedHanging]);
          }
        }
        // Do this after successfully applying the update
        const { setDisplaySetSelector } = useDisplaySetSelectorStore.getState();
        setDisplaySetSelector(
          `${toUseStudyInstanceUID || hpInfo.activeStudyUID}:activeDisplaySet:0`,
          null
        );
        return true;
      } catch (e) {
        console.error(e);
        uiNotificationService.show({
          title: 'Apply Hanging Protocol',
          message: 'The hanging protocol could not be applied.',
          type: 'error',
          duration: 3000,
        });
        return false;
      }
    },

    toggleHangingProtocol: ({ protocolId, stageIndex }: HangingProtocolParams): boolean => {
      const {
        protocol,
        stageIndex: desiredStageIndex,
        activeStudy,
      } = hangingProtocolService.getActiveProtocol();
      const { toggleHangingProtocol, setToggleHangingProtocol } =
        useToggleHangingProtocolStore.getState();
      const storedHanging = `${activeStudy.StudyInstanceUID}:${protocolId}:${stageIndex | 0}`;
      if (
        protocol.id === protocolId &&
        (stageIndex === undefined || stageIndex === desiredStageIndex)
      ) {
        // Toggling off - restore to previous state
        const previousState = toggleHangingProtocol[storedHanging] || {
          protocolId: 'default',
        };
        return actions.setHangingProtocol(previousState);
      } else {
        setToggleHangingProtocol(storedHanging, {
          protocolId: protocol.id,
          stageIndex: desiredStageIndex,
        });
        return actions.setHangingProtocol({
          protocolId,
          stageIndex,
          reset: true,
        });
      }
    },

    deltaStage: ({ direction }) => {
      const { protocolId, stageIndex: oldStageIndex } = hangingProtocolService.getState();
      const { protocol } = hangingProtocolService.getActiveProtocol();
      for (
        let stageIndex = oldStageIndex + direction;
        stageIndex >= 0 && stageIndex < protocol.stages.length;
        stageIndex += direction
      ) {
        if (protocol.stages[stageIndex].status !== 'disabled') {
          return actions.setHangingProtocol({
            protocolId,
            stageIndex,
          });
        }
      }
      uiNotificationService.show({
        title: 'Change Stage',
        message: 'The hanging protocol has no more applicable stages',
        type: 'info',
        duration: 3000,
      });
    },

    /**
     * Changes the viewport grid layout in terms of the MxN layout.
     */
    setViewportGridLayout: ({ numRows, numCols, isHangingProtocolLayout = false }) => {
      const { protocol } = hangingProtocolService.getActiveProtocol();
      const onLayoutChange = protocol.callbacks?.onLayoutChange;
      if (commandsManager.run(onLayoutChange, { numRows, numCols }) === false) {
        // Don't apply the layout if the run command returns false
        return;
      }

      const completeLayout = () => {
        const state = viewportGridService.getState();
        findViewportsByPosition(state, { numRows, numCols });

        const { viewportsByPosition, initialInDisplay } = useViewportsByPositionStore.getState();

        const findOrCreateViewport = layoutFindOrCreate.bind(
          null,
          hangingProtocolService,
          isHangingProtocolLayout,
          { ...viewportsByPosition, initialInDisplay }
        );

        viewportGridService.setLayout({
          numRows,
          numCols,
          findOrCreateViewport,
          isHangingProtocolLayout,
        });
      };
      // Need to finish any work in the callback
      window.setTimeout(completeLayout, 0);
    },

    toggleOneUp() {
      const viewportGridState = viewportGridService.getState();
      const { activeViewportId, viewports, layout, isHangingProtocolLayout } = viewportGridState;
      const { displaySetInstanceUIDs, displaySetOptions, viewportOptions } =
        viewports.get(activeViewportId);

      if (layout.numCols === 1 && layout.numRows === 1) {
        // The viewer is in one-up. Check if there is a state to restore/toggle back to.
        const { toggleOneUpViewportGridStore } = useToggleOneUpViewportGridStore.getState();

        if (!toggleOneUpViewportGridStore) {
          return;
        }
        // There is a state to toggle back to. The viewport that was
        // originally toggled to one up was the former active viewport.
        const viewportIdToUpdate = toggleOneUpViewportGridStore.activeViewportId;

        // We are restoring the previous layout but taking into the account that
        // the current one up viewport might have a new displaySet dragged and dropped on it.
        // updatedViewportsViaHP below contains the viewports applicable to the HP that existed
        // prior to the toggle to one-up - including the updated viewports if a display
        // set swap were to have occurred.
        const updatedViewportsViaHP =
          displaySetInstanceUIDs.length > 1
            ? []
            : displaySetInstanceUIDs
                .map(displaySetInstanceUID =>
                  hangingProtocolService.getViewportsRequireUpdate(
                    viewportIdToUpdate,
                    displaySetInstanceUID,
                    isHangingProtocolLayout
                  )
                )
                .flat();

        // findOrCreateViewport returns either one of the updatedViewportsViaHP
        // returned from the HP service OR if there is not one from the HP service then
        // simply returns what was in the previous state for a given position in the layout.
        const findOrCreateViewport = (position: number, positionId: string) => {
          // Find the viewport for the given position prior to the toggle to one-up.
          const preOneUpViewport = Array.from(toggleOneUpViewportGridStore.viewports.values()).find(
            viewport => viewport.positionId === positionId
          );

          // Use the viewport id from before the toggle to one-up to find any updates to the viewport.
          const viewport = updatedViewportsViaHP.find(
            viewport => viewport.viewportId === preOneUpViewport.viewportId
          );

          return viewport
            ? // Use the applicable viewport from the HP updated viewports
              { viewportOptions, displaySetOptions, ...viewport }
            : // Use the previous viewport for the given position
              preOneUpViewport;
        };

        const layoutOptions = viewportGridService.getLayoutOptionsFromState(
          toggleOneUpViewportGridStore
        );

        // Restore the previous layout including the active viewport.
        viewportGridService.setLayout({
          numRows: toggleOneUpViewportGridStore.layout.numRows,
          numCols: toggleOneUpViewportGridStore.layout.numCols,
          activeViewportId: viewportIdToUpdate,
          layoutOptions,
          findOrCreateViewport,
          isHangingProtocolLayout: true,
        });

        // Reset crosshairs after restoring the layout
        setTimeout(() => {
          commandsManager.runCommand('resetCrosshairs');
        }, 0);
      } else {
        // We are not in one-up, so toggle to one up.

        // Store the current viewport grid state so we can toggle it back later.
        const { setToggleOneUpViewportGridStore } = useToggleOneUpViewportGridStore.getState();
        setToggleOneUpViewportGridStore(viewportGridState);

        // one being toggled to one up.
        const findOrCreateViewport = () => {
          return {
            displaySetInstanceUIDs,
            displaySetOptions,
            viewportOptions,
          };
        };

        // Set the layout to be 1x1/one-up.
        viewportGridService.setLayout({
          numRows: 1,
          numCols: 1,
          findOrCreateViewport,
          isHangingProtocolLayout: true,
        });
      }
    },

    /**
     * Exposes the browser history navigation used by OHIF. This command can be used to either replace or
     * push a new entry into the browser history. For example, the following will replace the current
     * browser history entry with the specified relative URL which changes the study displayed to the
     * study with study instance UID 1.2.3. Note that as a result of using `options.replace = true`, the
     * page prior to invoking this command cannot be returned to via the browser back button.
     *
     * navigateHistory({
     *   to: 'viewer?StudyInstanceUIDs=1.2.3',
     *   options: { replace: true },
     * });
     *
     * @param historyArgs - arguments for the history function;
     *                      the `to` property is the URL;
     *                      the `options.replace` is a boolean indicating if the current browser history entry
     *                      should be replaced or a new entry pushed onto the history (stack); the default value
     *                      for `replace` is false
     */
    navigateHistory(historyArgs: NavigateHistory) {
      history.navigate(historyArgs.to, historyArgs.options);
    },

    openDICOMTagViewer({ displaySetInstanceUID }: { displaySetInstanceUID?: string }) {
      const { activeViewportId, viewports } = viewportGridService.getState();
      const activeViewportSpecificData = viewports.get(activeViewportId);
      const { displaySetInstanceUIDs } = activeViewportSpecificData;

      const displaySets = displaySetService.activeDisplaySets;
      const { UIModalService } = servicesManager.services;

      const defaultDisplaySetInstanceUID = displaySetInstanceUID || displaySetInstanceUIDs[0];
      UIModalService.show({
        content: DicomTagBrowser,
        contentProps: {
          displaySets,
          displaySetInstanceUID: defaultDisplaySetInstanceUID,
        },
        title: 'DICOM Tag Browser',
        containerClassName: 'max-w-3xl',
      });
    },

    async sam2() {
      if (!beginInferenceRunOrQueue()) {
        return;
      }

      const overlap = false
      const selectedModel = toolboxState.getSelectedModel();
      const medsam2 = selectedModel //Check at monailabel server;
      const start = Date.now();

      const segs = servicesManager.services.segmentationService.getSegmentations()
      const { activeViewportId, viewports } = viewportGridService.getState();
      const activeViewportSpecificData = viewports.get(activeViewportId);

      const { setViewportGridState } = useViewportGridStore.getState();
      const currentImageIdIndex = servicesManager.services.cornerstoneViewportService.getCornerstoneViewport(activeViewportId).getCurrentImageIdIndex();
      setViewportGridState('currentImageIdIndex', currentImageIdIndex);
      const { displaySetInstanceUIDs } = activeViewportSpecificData;
      const displaySets = displaySetService.activeDisplaySets;

      const displaySetInstanceUID = displaySetInstanceUIDs[0];
      const currentDisplaySets = displaySets.find(e => e.displaySetInstanceUID === displaySetInstanceUID);
      if (!currentDisplaySets) return;

      const currentMeasurements = measurementService.getMeasurements()

      const unAssignedMeasurements = currentMeasurements.filter(e => {
        return e.metadata.SegmentNumber === undefined;
      })


    const activeSegmentation = servicesManager.services.segmentationService.getActiveSegmentation(activeViewportId)
    let segmentNumber = 1;
    let segments: { [segmentIndex: string]: cstTypes.Segment } = {};
    let segmentationId = `${csUtils.uuidv4()}`
    if (activeSegmentation !== undefined){
      segmentationId = activeSegmentation.segmentationId;
      segments = { ...activeSegmentation.segments };
    if (Object.values(segments).length > 0) {
      // Find the minimum available segment number
      const existingSegmentNumbers = Object.values(segments).map(e => e.segmentIndex).sort((a, b) => a - b);
      let minAvailableNumber = 1;
      // Find the first gap in segment numbers, or use the next number after the highest
      for (let i = 0; i < existingSegmentNumbers.length; i++) {
        if (existingSegmentNumbers[i] !== minAvailableNumber) {
          break;
        }
        minAvailableNumber++;
      }
      segmentNumber = minAvailableNumber;
      if (!toolboxState.getRefineNew()) {
        const activeSegment = servicesManager.services.segmentationService.getActiveSegment(activeViewportId);
        if (activeSegment !== undefined){
          for (let i = 0; i < unAssignedMeasurements.length; i++) {
            const e = unAssignedMeasurements[i];
            e.metadata.SegmentNumber = activeSegment.segmentIndex;
            e.metadata.segmentationId = activeSegmentation.segmentationId;
          }
          segmentNumber = activeSegment.segmentIndex;
          if (blockIfActiveSegmentHidden(activeViewportId, activeSegmentation.segmentationId, segmentNumber)) {
            finishInferenceRun();
            return;
          }
          if (toolboxState.getCurrentActiveSegment() !== segmentNumber){
            await commandsManager.run('resetNninter');
            toolboxState.setCurrentActiveSegment(segmentNumber);
          }
        } else {
          uiNotificationService.show({
            title: 'Click Segment to refine',
            message: 'No active segment found, please click segment to refine',
            type: 'warning',
            duration: 4000,
          });
          return
        }
      } else {
        // For new Segment
        for (let i = 0; i < unAssignedMeasurements.length; i++) {
          const e = unAssignedMeasurements[i];
          e.metadata.SegmentNumber = segmentNumber;
          e.metadata.segmentationId = activeSegmentation.segmentationId;
        }
      }
    } else{
      // No existing segments in current active segmentation
      for (let i = 0; i < unAssignedMeasurements.length; i++) {
        const e = unAssignedMeasurements[i];
        e.metadata.SegmentNumber = segmentNumber;
        e.metadata.segmentationId = activeSegmentation.segmentationId;
      }
    }
    
  } else {
    // No existing segmentation
    for (let i = 0; i < unAssignedMeasurements.length; i++) {
      const e = unAssignedMeasurements[i];
      e.metadata.SegmentNumber = segmentNumber;
      e.metadata.segmentationId = segmentationId;
    }
  }

      const pos_points: any[] = [];
      const neg_points: any[] = [];
      const pos_boxes: any[] = [];
      const seriesUID = currentDisplaySets.SeriesInstanceUID;
      const imageIdsSam2: string[] = currentDisplaySets.imageIds ?? [];
      for (const e of currentMeasurements) {
        if (e.referenceSeriesUID !== seriesUID || e.metadata.SegmentNumber !== segmentNumber) continue;
        if (e.toolName === 'Probe2') {
          (e.metadata.neg ? neg_points : pos_points).push(Object.values(e.data)[0].index);
        } else if (e.toolName === 'RectangleROI2' && !e.metadata.neg) {
          const pts = Object.values(e.data)[0].pointsInShape;
          const p0 = [...pts.at(0).pointIJK];
          const p1 = [...pts.at(-1).pointIJK];
          // Stack viewports: pointsInShape k=0 from 2D imageData; use referencedImageId for correct slice.
          if (p0[2] === 0) { const refK = imageIdsSam2.indexOf(e.referencedImageId); if (refK > 0) { p0[2] = refK; p1[2] = refK; } }
          pos_boxes.push([p0, p1]);
        }
      }



      //Disable text prompts for SAM2
      const text_prompts = []//currentMeasurements
      //.filter(e => { return e.toolName === 'Probe2' && e.referenceSeriesUID === currentDisplaySets.SeriesInstanceUID && e.metadata.neg === false && e.metadata.SegmentNumber === segmentNumber; })
      //.map(e => { return e.label })

      // Hide measurements after inference unless user has set prompts to always-show
      if (!toolboxState.getPromptsVisible()) {
        currentMeasurements
          .filter(e => e.referenceSeriesUID === currentDisplaySets.SeriesInstanceUID)
          .forEach(e => measurementService.toggleVisibilityMeasurement(e.uid, false));
        document.dispatchEvent(new Event('measurement-state-changed'));
      }
      if (pos_points.length == 0 && neg_points.length == 0 && pos_boxes.length == 0 && text_prompts.length == 0){
        uiNotificationService.show({
          title: 'Prompt warning',
          message: 'Only pos/neg points and bbox are available for SAM2-based models',
          type: 'warning',
          duration: 4000,
        });
        return;
      }

      uiNotificationService.show({
        title: 'Prompt info',
        message: 'Only pos/neg points and bbox are accepted for SAM2-based models, other prompt types are ignored',
        type: 'info',
        duration: 4000,
      });

      let url = `/monai/infer/segmentation?image=${currentDisplaySets.SeriesInstanceUID}&output=dicom_seg`;
      let params = {
        largest_cc: false,
        result_extension: '.nii.gz',
        result_dtype: 'uint16',
        result_compress: false,
        studyInstanceUID: currentDisplaySets.StudyInstanceUID,
        restore_label_idx: false,
        pos_points: pos_points,
        neg_points: neg_points,
        pos_boxes: pos_boxes,
        texts: text_prompts,
        nninter: false,
        medsam2: medsam2,
      };

      let data = MonaiLabelClient.constructFormData(params, null);

      // Create the axios promise
      const segmentationPromise = axios.post(url, data, {
        responseType: 'arraybuffer',
        headers: {
          accept: 'application/json, multipart/form-data',
        },
      });

      // Show notification with promise support
      uiNotificationService.show({
        title: 'MONAI Label',
        message: 'Processing segmentation...',
        type: 'info',
        promise: segmentationPromise,
        promiseMessages: {
          loading: 'Processing segmentation...',
          success: () => 'Run Segmentation - Successful',
          // Prod: no red seg-failure alert for end users — log it and quietly
          // dismiss the "Processing..." toast (null suppresses the error toast).
          error: (error) => {
            console.error('Run Segmentation failed:', error);
            return null;
          },
        },
      });

            try {
        // Process the response
        const response = await segmentationPromise;
        if (response.status === 200) {
          const afterPost = Date.now();
          console.log(`Just after Post request: ${(afterPost - start)/1000} Seconds`);
          const ct = response.headers["content-type"] as string;

          if (ct.includes('application/json') && new TextDecoder("utf-8").decode(response.data).includes("sam3_not_found.nii.gz")){
            uiNotificationService.show({
              title: 'SAM3 not found',
              message: 'SAM3 model not found, please check the checkpoint path',
              type: 'warning',
              duration: 4000,
            });
            return;
          }

          const { meta, seg } = await parseMultipart(response.data, ct);
          console.log(`Just after parseMultipart: ${(Date.now() - start)/1000} Seconds`);
          //const arrayBuffer = response.data
          const flipped = meta.flipped.toLowerCase() === "true"
          const sam_elapsed = meta.sam_elapsed
          const prompt_info = meta.prompt_info
          const label_name = meta.label_name
          const raw = seg
          const new_arrayBuffer = new Uint8Array(raw);

          let imageIds = currentDisplaySets.imageIds
          let existingSegments: { [segmentIndex: string]: cstTypes.Segment } = {};
            
          let segImageIds = [];

          let existing = false;
          // Find existing segmentation with matching seriesInstanceUid
          if (activeSegmentation !== undefined){
            let existingseriesInstanceUid = activeSegmentation.cachedStats?.seriesInstanceUid;
            
            if (existingseriesInstanceUid === undefined) {
              const segments = Object.values(activeSegmentation.segments);
              for (let j = 0; j < segments.length; j++) {
                const segment = segments[j];
                if (segment.cachedStats?.algorithmType !== undefined) {
                  existingseriesInstanceUid = segment.cachedStats.algorithmType;
                }
              }
            }
            
            if (existingseriesInstanceUid === currentDisplaySets.SeriesInstanceUID) {
              existingSegments = activeSegmentation.segments || {};
              segmentationId = activeSegmentation.segmentationId;
              // allImageIds preserves all blocks; imageIds is reverted to block1 by syncLegacyLabelmapData
              segImageIds = activeSegmentation.representationData.Labelmap.allImageIds
                ?? activeSegmentation.representationData.Labelmap.imageIds;
              existing = true;
            }
          }
          
          let merged_derivedImages = [];
          let z_range = [];
          if(overlap){
          let derivedImages_new = await imageLoader.createAndCacheDerivedLabelmapImages(imageIds);
          console.log(`Just after createAndCacheDerivedLabelmapImages: ${(Date.now() - start)/1000} Seconds`);
          let derivedImages = [];
          if (segImageIds.length > 0){
            derivedImages = segImageIds.map(imageId => cache.getImage(imageId));
          }
          if(flipped){
            derivedImages_new.reverse();
          }
          for (let i = 0; i < derivedImages_new.length; i++) {
            const voxelManager = derivedImages_new[i]
              .voxelManager as csTypes.IVoxelManager<number>;
            let scalarData = voxelManager.getScalarData();
            const sliceData = new_arrayBuffer.slice(i * scalarData.length, (i + 1) * scalarData.length);
            if (sliceData.some(v => v === 1)){
              voxelManager.setScalarData(sliceData.map(v => v === 1 ? segmentNumber : v));
              z_range.push(i);
            }
          }
          console.log(`After slice assignment: ${(Date.now() - start)/1000} Seconds`);


          let filteredDerivedImages = []
          const imgLength = imageIds.length;
          let updatedIndices = new Set<number>();

          // If toolboxState.getRefineNew() is false (Refine), exclude derivedImages that contain segmentNumber
          // Each derivedImage is binary mask of a single slice ([0],[0,1],[0,2],[0,3].. etc)
          // derivedImages size is imgLength * the number of segment
          // We need to filter out the derivedImages block that contain segmentNumber (consists of [0] or [0, segmentNumber] masks)
          // If filter out which contains segmentNumber and all [0] masks, it can lead to incorrect calculation of the segment. e.g. bidirectional measurement
          if (!toolboxState.getRefineNew() && derivedImages.length > 0) {
            let addFlag = true;
            for (let i=0; i<derivedImages.length; i++){
              const image = derivedImages[i];
              const voxelManager = image.voxelManager as csTypes.IVoxelManager<number>;
              const scalarData = voxelManager.getScalarData();
              if (scalarData.some(value => value === segmentNumber)){
                const updatedScalarData = scalarData.map(v => v === segmentNumber ? 0 : v)
                voxelManager.setScalarData(updatedScalarData);
                if (addFlag) {
                  for (let j = 0; j < imgLength; j++) {
                    updatedIndices.add(Math.floor(i / imgLength) * imgLength + j);
                  }
                  addFlag = false;
                }

              }
            }
            for (let i = 0; i < derivedImages.length; i++) {
              if (!updatedIndices.has(i)) {
                filteredDerivedImages.push(derivedImages[i]);
              }
            }            
          } else if (derivedImages.length > 0) {
            filteredDerivedImages = derivedImages;
          }
          merged_derivedImages = [...filteredDerivedImages, ...derivedImages_new]
        } else {
          if (segImageIds.length == 0){
            const _tCreate2 = Date.now();
            let derivedImages_new = await imageLoader.createAndCacheDerivedLabelmapImages(imageIds);

            if(flipped){
              derivedImages_new.reverse();
            }
            for (let i = 0; i < derivedImages_new.length; i++) {
              const voxelManager = derivedImages_new[i]
                .voxelManager as csTypes.IVoxelManager<number>;
              let scalarData = voxelManager.getScalarData();
              const sliceData = new_arrayBuffer.slice(i * scalarData.length, (i + 1) * scalarData.length);
              if (sliceData.some(v => v === 1)){
                voxelManager.setScalarData(sliceData.map(v => v === 1 ? segmentNumber : v));
                if (flipped) {
                  z_range.push(derivedImages_new.length - i - 1);
                } else {
                  z_range.push(i);
                }
              }
            }
            if(flipped){
              derivedImages_new.reverse();
            }
            merged_derivedImages = derivedImages_new
          } else {
            merged_derivedImages = segImageIds.map(imageId => cache.getImage(imageId));
            if(flipped){
              merged_derivedImages.reverse();
            }
            for (let i = 0; i < merged_derivedImages.length; i++) {
              const voxelManager = merged_derivedImages[i]
                .voxelManager as csTypes.IVoxelManager<number>;
              let scalarData = voxelManager.getScalarData();
              const sliceData = new_arrayBuffer.slice(i * scalarData.length, (i + 1) * scalarData.length);
              if (!toolboxState.getRefineNew()){
                if (scalarData.some(v => v === segmentNumber)){
                  voxelManager.setScalarData(scalarData.map(v => v === segmentNumber ? 0 : v));
                  scalarData = voxelManager.getScalarData();
                }
              }
              if (sliceData.some(v => v === 1)){
                voxelManager.setScalarData(sliceData.map((v, idx) => v === 1 ? segmentNumber : scalarData[idx]));
                if (flipped) {
                  z_range.push(merged_derivedImages.length - i - 1);
                } else {
                  z_range.push(i);
                }
              }
            }
            if(flipped){
              merged_derivedImages.reverse();
            }
          }
        }
          
                    
          const derivedImageIds = merged_derivedImages.map(image => image.imageId);  
          console.log(`Just after derivedImageIds: ${(Date.now() - start)/1000} Seconds`);
          const _zMin = z_range.length > 0 ? Math.min(...z_range) : 0;
          const _zMax = z_range.length > 0 ? Math.max(...z_range) + 1 : (merged_derivedImages?.length ?? 0);
          segments[segmentNumber] = {
            segmentIndex: segmentNumber,
            label: label_name,
            locked: false,
            cachedStats: {
              modifiedTime: utils.formatDate(Date.now(), 'YYYYMMDD'),
              algorithmType: currentDisplaySets.SeriesInstanceUID,
              algorithmName: selectedModel+"_"+sam_elapsed,
              description: prompt_info,
              center:  z_range.length > 0 ? z_range.reduce((sum, z) => sum + z, 0) / z_range.length : 0,
              segZ0: _zMin,
              segZ1: _zMax,
            }
          };

          // Post-segmentation processing: update representations, handle viewports, trigger events
          await postSegmentationProcessing({
            activeViewportId,
            segmentationId,
            segmentNumber,
            segments,
            derivedImageIds,
            currentDisplaySets,
            imageIds,
            existingSegments,
            existing,
            activeSegmentation,
            currentImageIdIndex,
            z_range,
          });
          const end = Date.now();
          console.log(`Time taken: ${(end - start)/1000} Seconds`);
          return response;
        }
      } catch (error) {
        console.error('Segmentation error:', error);
        throw error;
      } finally {
        finishInferenceRun();
      }
    },
    async initNninter( options: {viewportId: string} = {viewportId: undefined}, _sessionRetry = false ){

      let { activeViewportId, viewports } = viewportGridService.getState();
      if(options.viewportId !== undefined){
        activeViewportId = options.viewportId;
      }
      const activeViewportSpecificData = viewports.get(activeViewportId);
      if(activeViewportSpecificData === undefined){
        return;
      }
      const { displaySetInstanceUIDs } = activeViewportSpecificData;
      const displaySets = displaySetService.activeDisplaySets;
      const displaySetInstanceUID = displaySetInstanceUIDs[0];
      let currentDisplaySets;
      for (let i = 0; i < displaySets.length; i++) {
        if (displaySets[i].displaySetInstanceUID == displaySetInstanceUID) {
          currentDisplaySets = displaySets[i];
          break; // Exit early once found
        }
      }
      if(currentDisplaySets === undefined || currentDisplaySets.Modality === "SEG"){
        return;
      }

      // Detect series change — used both for posNeg reset and notification gating.
      const _seriesChanged = currentDisplaySets.SeriesInstanceUID !== _lastInitSeries;
      if (_seriesChanged) {
        _lastInitSeries = currentDisplaySets.SeriesInstanceUID;
        toolboxState.setPosNeg(false);
      }

      let nninterToken = '';
      try {
        nninterToken = await getNninterToken();
      } catch (e) {
        // Server down or old server image without the endpoint — proceed
        // tokenless; the infer call surfaces its own error/expired handling.
        console.warn('nninter session claim failed; proceeding without token', e);
      }
      let url = `/monai/infer/segmentation?image=${currentDisplaySets.SeriesInstanceUID}&output=dicom_seg`;
      let params = {
        largest_cc: false,
        result_extension: '.nii.gz',
        result_dtype: 'uint16',
        result_compress: false,
        studyInstanceUID: currentDisplaySets.StudyInstanceUID,
        restore_label_idx: false,
        nninter: "init",
        nninter_token: nninterToken,
      };

      // Show notification only on the first initNninter for a new series.
      // _seriesChanged is false for all repeat triggers (other MPR panes loading the
      // same series, viewport-type switches stack↔volume, active-viewport clicks, etc.)
      // so a single _seriesChanged gate is sufficient — no need to check viewport type.
      const _showNotification = _seriesChanged;

      let data = MonaiLabelClient.constructFormData(params, null);

      // Create the axios promise
      const initPromise = axios.post(url, data, {
        responseType: 'arraybuffer',
        headers: {
          accept: 'application/json, multipart/form-data',
        },
      });

      if (_showNotification) {
        uiNotificationService.show({
          title: 'NNInit',
          message: 'Initializing nninter...',
          type: 'info',
          duration: 3000,
        });
      }

      try {
        const response = await initPromise;
        if (response.status === 200) {
          const _initBody = new TextDecoder('utf-8').decode(response.data);
          if (_initBody.includes('session_expired')) {
            if (_sessionRetry) {
              console.warn('Init nninter: session expired again after reclaim; giving up');
              return response;
            }
            clearNninterToken();
            await getNninterToken();
            return actions.initNninter(options, true);
          }
          if (_showNotification) {
            uiNotificationService.show({
              title: 'NNInit',
              message: 'Init nninter - Successful',
              type: 'success',
              duration: 3000,
            });
          }
          return response;
        }
      } catch (error) {
        // The MONAI server returns 502/503/504 while it is still starting up — that's expected,
        // not a real failure. Surface it as a warning (and don't rethrow as an error) so the user
        // isn't alarmed by a red error while the server warms up; it re-inits on next use.
        const status = error?.response?.status;
        if (status === 502 || status === 503 || status === 504) {
          console.warn(`Init nninter: MONAI server not ready yet (HTTP ${status}); will retry when used.`);
          if (_showNotification) {
            uiNotificationService.show({
              title: 'NNInit',
              message: 'MONAI server is still starting up — nnInteractive will be ready shortly.',
              type: 'warning',
              duration: 5000,
            });
          }
          return;
        }
        console.error('Init nninter error:', error);
        if (_showNotification) {
          uiNotificationService.show({
            title: 'NNInit',
            message: `Init nninter - Failed: ${error.message || 'Unknown error'}`,
            type: 'error',
            duration: 5000,
          });
        }
        throw error;
      }

    },
    async undoNninter() {
      if (toolboxState.getLocked()) {
        return;
      }
      if (toolboxState.getSelectedModel() !== 'nnInteractive') {
        return;
      }

      const start = Date.now();
      const { activeViewportId, viewports } = viewportGridService.getState();
      const activeViewportSpecificData = viewports.get(activeViewportId);
      const { displaySetInstanceUIDs } = activeViewportSpecificData;
      const displaySets = displaySetService.activeDisplaySets;
      const displaySetInstanceUID = displaySetInstanceUIDs[0];
      const currentDisplaySets = displaySets.filter(
        e => e.displaySetInstanceUID == displaySetInstanceUID
      )[0];

      // Locate the active nnInteractive segmentation for this series.
      const { segmentationService, cornerstoneViewportService } = servicesManager.services;
      const activeSegmentation = segmentationService.getActiveSegmentation(activeViewportId);
      const activeSegmentObj = segmentationService.getActiveSegment(activeViewportId);
      if (!activeSegmentation || !activeSegmentObj) {
        return;
      }
      const segmentationId = activeSegmentation.segmentationId;
      const segmentNumber = activeSegmentObj.segmentIndex;
      // With multi-layer labelmaps (5.x), each segment has its own layer.
      // Prefer the layer-specific imageIds; fall back to the flat legacy field.
      const labelmapState = (csToolsSegmentation.state.getSegmentation(segmentationId)
        ?.representationData?.Labelmap as any);
      const segBinding = labelmapState?.segmentBindings?.[segmentNumber];
      const segLayerId = segBinding?.labelmapId;
      const segImageIds: string[] =
        (segLayerId && labelmapState?.labelmaps?.[segLayerId]?.imageIds) ||
        (labelmapState?.imageIds ?? []);
      if (segImageIds.length === 0) {
        return;
      }

      let nninterToken = '';
      try {
        nninterToken = await getNninterToken();
      } catch (e) {
        // Server down or old server image without the endpoint — proceed
        // tokenless; the infer call surfaces its own error/expired handling.
        console.warn('nninter session claim failed; proceeding without token', e);
      }
      const url = `/monai/infer/segmentation?image=${currentDisplaySets.SeriesInstanceUID}&output=dicom_seg`;
      const params = {
        largest_cc: false,
        result_extension: '.nii.gz',
        result_dtype: 'uint16',
        result_compress: false,
        studyInstanceUID: currentDisplaySets.StudyInstanceUID,
        restore_label_idx: false,
        nninter: 'undo',
        nninter_token: nninterToken,
      };
      const data = MonaiLabelClient.constructFormData(params, null);

      const beforePost = Date.now();
      const undoPromise = axios.post(url, data, {
        responseType: 'arraybuffer',
        headers: { accept: 'application/octet-stream' },
      });

      uiNotificationService.show({
        title: 'MONAI Label',
        message: 'Undoing last interaction...',
        type: 'info',
        promise: undoPromise,
        promiseMessages: {
          loading: 'Undoing last interaction...',
          error: error => `Undo - Failed: ${error.message || 'Unknown error'}`,
        },
      });

      try {
        const response = await undoPromise;
        const afterPost = Date.now();
        if (response.status !== 200) {
          return;
        }
        const ct = response.headers['content-type'] as string;
        // allowEmptySeg: undoing the only interaction restores an empty segment,
        // which arrives as a zero-length seg part.
        const { meta, seg } = await parseMultipart(response.data, ct, { allowEmptySeg: true });
        let _undoOp: unknown = (meta as any).nninter_op;
        try {
          _undoOp = JSON.parse(((meta as any).nninter_op ?? 'null') as string);
        } catch {
          /* keep raw value */
        }
        if (_undoOp === 'session_expired') {
          clearNninterToken();
          uiNotificationService.show({
            title: 'Undo',
            message: 'nnInteractive session expired — nothing to undo.',
            type: 'warning',
            duration: 3000,
          });
          return;
        }
        const afterParse = Date.now();

        // --- round-trip timing breakdown (mirrors the normal nninter path) ---
        const networkRoundTripMs = afterPost - beforePost;
        const sRequestTs = metaNum(meta as Record<string, unknown>, 'server_request_ts');
        const sBeginTs   = metaNum(meta as Record<string, unknown>, 'server_begin_ts');
        const sEndTs     = metaNum(meta as Record<string, unknown>, 'server_end_ts');
        const sUndoCore  = metaNum(meta as Record<string, unknown>, 'nninter_core_elapsed');
        const sResult    = metaNum(meta as Record<string, unknown>, 'server_result_elapsed');
        const postInFlightMs     = (sRequestTs != null) ? sRequestTs * 1000 - beforePost : undefined;
        const monaiPrepMs        = (sRequestTs != null && sBeginTs != null) ? (sBeginTs - sRequestTs) * 1000 : undefined;
        const serverProcessMs    = (sBeginTs != null && sEndTs != null) ? (sEndTs - sBeginTs) * 1000 : undefined;
        const responseInFlightMs = (sEndTs != null) ? afterPost - sEndTs * 1000 : undefined;

        const undone = String((meta as any).undone).toLowerCase() === 'true';
        if (!undone) {
          uiNotificationService.show({
            title: 'MONAI Label',
            message: 'Nothing to undo',
            type: 'info',
          });
          return;
        }

        const flipped = String((meta as any).flipped).toLowerCase() === 'true';
        const predOffset: number[] = JSON.parse((meta as any).pred_offset || '[0,0,0]');
        const predFull: number[] = JSON.parse((meta as any).pred_full_shape || '[]');
        const predCrop: number[] = JSON.parse((meta as any).pred_crop_shape || '[]');
        const cropBytes = new Uint8Array(seg);

        let _hasCropGeom = false;
        let _segZ0 = 0, _segZ1 = 0, _cropY = 0, _cropX = 0, _y0 = 0, _x0 = 0, _fullX = 0;
        if (predFull.length === 3 && predCrop.length === 3 && predCrop.every(v => v > 0)) {
          const [, , fullX] = predFull;
          const [cropZ, cropY, cropX] = predCrop;
          const [z0, y0, x0] = predOffset;
          _segZ0 = z0; _segZ1 = z0 + cropZ;
          _cropY = cropY; _cropX = cropX;
          _y0 = y0; _x0 = x0; _fullX = fullX;
          _hasCropGeom = true;
        }

        // segImageIds is the stored block order. The running (overlap) inference path already
        // leaves it in reversed z-order for a flipped series — the same order the crop is
        // written by index. Do NOT reverse here: doing so double-flips and lands the restored
        // crop on the mirrored slice. The `flipped ? merged.length-1-x : x` formulas below map
        // array index <-> display-slice index within this stored order.
        const merged = segImageIds.map(imageId => cache.getImage(imageId));

        // Pass 1: clear all voxels of the active segment (use dirtySlices when available).
        const prevStats = (activeSegmentation.segments?.[segmentNumber] as any)?.cachedStats;
        const prevDirty: number[] | undefined = prevStats?.dirtySlices;
        const clearSlice = (arrIdx: number) => {
          const vm = merged[arrIdx]?.voxelManager;
          if (!vm) return;
          const sd = vm.getScalarData();
          for (let j = 0; j < sd.length; j++) {
            if (sd[j] === segmentNumber) sd[j] = 0;
          }
        };
        if (prevDirty?.length) {
          for (const origIdx of prevDirty) {
            clearSlice(flipped ? merged.length - 1 - origIdx : origIdx);
          }
        } else {
          for (let i = 0; i < merged.length; i++) clearSlice(i);
        }

        // Pass 2: write the restored crop (skipped entirely when the object is now empty).
        const z_range: number[] = [];
        if (_hasCropGeom) {
          for (let i = _segZ0; i < _segZ1; i++) {
            const sd = merged[i].voxelManager.getScalarData();
            const c = i - _segZ0;
            const cropSliceBase = c * _cropY * _cropX;
            let wrote = false;
            for (let cy = 0; cy < _cropY; cy++) {
              const srcRow = cropSliceBase + cy * _cropX;
              const dstRow = (_y0 + cy) * _fullX + _x0;
              for (let cx = 0; cx < _cropX; cx++) {
                if (cropBytes[srcRow + cx] === 1) {
                  sd[dstRow + cx] = segmentNumber;
                  wrote = true;
                }
              }
            }
            if (wrote) z_range.push(flipped ? merged.length - i - 1 : i);
          }
        }

        // Keep cachedStats.dirtySlices in sync so the next interaction clears correctly.
        if ((activeSegmentation.segments?.[segmentNumber] as any)?.cachedStats) {
          (activeSegmentation.segments[segmentNumber] as any).cachedStats.dirtySlices = z_range;
          (activeSegmentation.segments[segmentNumber] as any).cachedStats.segZ0 = _hasCropGeom ? _segZ0 : 0;
          (activeSegmentation.segments[segmentNumber] as any).cachedStats.segZ1 = _hasCropGeom ? _segZ1 : merged.length;
        }

        // Remove the most-recently-added prompt measurement for this series.
        const AI_PROMPT_TOOLS = ['Probe2', 'RectangleROI2', 'PlanarFreehandROI2', 'PlanarFreehandROI3'];
        const promptsForSeries = measurementService
          .getMeasurements()
          .filter(
            m =>
              AI_PROMPT_TOOLS.includes(m.toolName) &&
              m.referenceSeriesUID === currentDisplaySets.SeriesInstanceUID
          );
        const lastPrompt = promptsForSeries[promptsForSeries.length - 1];
        if (lastPrompt?.uid) {
          measurementService.removeMany([lastPrompt.uid]);
        }

        // Repaint.
        const activeVp = cornerstoneViewportService.getCornerstoneViewport(activeViewportId);
        (activeVp as any)?.render?.();
        eventTarget.dispatchEvent(
          new CustomEvent(csToolsEnums.Events.SEGMENTATION_DATA_MODIFIED, {
            detail: { segmentationId },
          })
        );
        uiNotificationService.show({
          title: 'MONAI Label',
          message: 'Undo - Successful',
          type: 'success',
        });
        return response;
      } catch (error) {
        console.error('Undo nninter error:', error);
        throw error;
      }
    },

    async resetNninter(options: {clearMeasurements: boolean} = {clearMeasurements: false}){
      if (toolboxState.getLocked()) {
        return;
      }

      const { activeViewportId, viewports } = viewportGridService.getState();
      const activeViewportSpecificData = viewports.get(activeViewportId);
      const { displaySetInstanceUIDs } = activeViewportSpecificData;
      const displaySets = displaySetService.activeDisplaySets;
      const displaySetInstanceUID = displaySetInstanceUIDs[0];
      const currentDisplaySets = displaySets.filter(e => {
        return e.displaySetInstanceUID == displaySetInstanceUID;
      })[0];
      let nninterToken = '';
      try {
        nninterToken = await getNninterToken();
      } catch (e) {
        // Server down or old server image without the endpoint — proceed
        // tokenless; the infer call surfaces its own error/expired handling.
        console.warn('nninter session claim failed; proceeding without token', e);
      }
      let url = `/monai/infer/segmentation?image=${currentDisplaySets.SeriesInstanceUID}&output=dicom_seg`;
      let params = {
        largest_cc: false,
        result_extension: '.nii.gz',
        result_dtype: 'uint16',
        result_compress: false,
        studyInstanceUID: currentDisplaySets.StudyInstanceUID,
        restore_label_idx: false,
        nninter: "reset",
        nninter_token: nninterToken,
      };

      let data = MonaiLabelClient.constructFormData(params, null);

      // Create the axios promise
      const resetPromise = axios.post(url, data, {
        responseType: 'arraybuffer',
        headers: {
          accept: 'application/json, multipart/form-data',
        },
      });

      try {
        const response = await resetPromise;
        if (response.status === 200) {
          if (options.clearMeasurements) {
            commandsManager.run('clearMeasurements')
          }
          return response;
        }
      } catch (error) {
        console.error('Reset nninter error:', error);
        throw error;
      }
    },
    /**
     * Release the labelmap block owned by a deleted segment.
     *
     * Each segment owns a full-volume block of derived labelmap images (~84MB). Deleting a segment
     * goes through cornerstone's generic removeSegment, which only zeroes the segment's pixel VALUES
     * — it knows nothing about our multi-block scheme, so the block's imageIds stayed in the
     * representation and its images stayed in the cache forever (cacheMB never dropped after a
     * delete). This rebuilds the representation without that block and evicts its images.
     *
     * Safe for middle segments now that block -> segment is an explicit map: dropping a block no
     * longer renumbers the segments after it (which is why this could not be done before).
     */
    async releaseSegmentBlock({ segmentationId, segmentIndex }: { segmentationId: string; segmentIndex: number }) {
      const seg = csToolsSegmentation.state.getSegmentation(segmentationId);
      const lm = seg?.representationData?.Labelmap as any;
      if (!lm) return;
      const all: string[] = lm.allImageIds ?? lm.imageIds ?? [];
      const srcIds: string[] = lm.referencedImageIds ?? [];
      const N = srcIds.length;
      if (!N || all.length < N) return;
      const blockCount = Math.floor(all.length / N);
      // Keep at least one block: cornerstone needs a primary labelmap to render at all.
      if (blockCount <= 1) return;
      const blockSeg: number[] = (lm.blockSegments?.length === blockCount)
        ? lm.blockSegments.slice()
        : Array.from({ length: blockCount }, (_, b) => b + 1);
      const bIdx = blockSeg.indexOf(segmentIndex);
      if (bIdx < 0) return;   // segment has no dedicated block (e.g. single-layer SAM2 labelmap)

      // Drop any deferred in-place write for this segment — its block is going away.
      _pendingImageSync.get(segmentationId)?.delete(segmentIndex);

      const removed = all.slice(bIdx * N, (bIdx + 1) * N);
      const remaining = [...all.slice(0, bIdx * N), ...all.slice((bIdx + 1) * N)];
      const nextBlockSeg = blockSeg.filter((_, i) => i !== bIdx);

      const { labelmapRepresentation } = buildMultiBlockLabelmapRepresentation({
        segmentationId,
        derivedImageIds: remaining,
        imageIds: srcIds,
        currentDisplaySets: { displaySetInstanceUID: lm.referencedVolumeId },
        segments: seg?.segments ?? {},
        blockSegments: nextBlockSeg,
      });

      const existingRepresentationData = seg?.representationData || {};
      csToolsSegmentation.updateSegmentations([
        {
          segmentationId,
          payload: {
            representationData: { ...existingRepresentationData, [LABELMAP]: labelmapRepresentation },
          },
        },
      ]);

      // Removing a block is a LAYER-SET change, so cornerstone's reconcile can unmount just that
      // layer — no need to tear down and rebuild every other block's volume (that full remount is
      // what leaks a volume each time and scales with segment count).
      reconcileLabelmapLayers(segmentationId);
      // Let the reconcile settle before the images backing the dropped layer are freed below.
      await new Promise(resolve => requestAnimationFrame(() => resolve(null)));

      // Nothing references these now — reclaim the block (~84MB).
      for (const id of removed) {
        try { cache.removeImageLoadObject(id, { force: true }); } catch { /* already gone */ }
      }
    },

    async resetSegment({ segmentationId, segmentIndex }: { segmentationId: string; segmentIndex: number }) {
      // Reset zeroes the block IMAGES; land any deferred in-place write first so it can't be
      // re-applied afterwards and resurrect the segment.
      materializePendingImageSync(segmentationId);
      const segmentation = csToolsSegmentation.state.getSegmentation(segmentationId);
      // Use allImageIds (every block). representationData.Labelmap.imageIds is reverted to the PRIMARY
      // block (segment 1) by syncLegacyLabelmapData, so it misses segments 2+ (their private blocks) —
      // which is why Reset only cleared the 1st segment. _zeroImageId only zeros THIS segment's value,
      // so scanning every block's images is safe (other segments' blocks hold other values, untouched).
      const _lmData = (segmentation?.representationData?.Labelmap as any);
      const imageIds: string[] = _lmData?.allImageIds ?? _lmData?.imageIds ?? [];

      const _zeroImageId = (imageId: string) => {
        const image = cache.getImage(imageId);
        if (!image) return;
        const vm = image.voxelManager as csTypes.IVoxelManager<number>;
        const scalarData = vm.getScalarData();
        if (!scalarData.some((v: number) => v === segmentIndex)) return;
        for (let j = 0; j < scalarData.length; j++) {
          if (scalarData[j] === segmentIndex) scalarData[j] = 0;
        }
        vm.setScalarData(scalarData);
      };

      // 1. Find the labelmap actors currently in the active viewport.
      //    Using referencedId (the actor's imageId) avoids the flipped-series
      //    index mismatch that caused the "vague then gone" two-step.
      const { activeViewportId } = viewportGridService.getState();
      const activeVp = servicesManager.services.cornerstoneViewportService.getCornerstoneViewport(activeViewportId);
      const allActors: any[] = (activeVp as any)?.getActors?.() ?? [];
      const labelmapActors = allActors.filter((a: any) =>
        a.representationUID?.startsWith(`${segmentationId}-Labelmap`)
      );
      const visibleImageIds = new Set(labelmapActors.map((a: any) => a.referencedId).filter(Boolean));

      // 2. Zero the visible slice(s) and synchronously push the zeroed data into
      //    VTK's internal buffer + force an immediate WebGL render.
      //    Bypasses the rAF event queue → no intermediate "vague" frame.
      for (const actorEntry of labelmapActors) {
        const imageId = actorEntry.referencedId;
        if (!imageId) continue;
        _zeroImageId(imageId);
        const inputData = actorEntry.actor?.getMapper?.()?.getInputData?.();
        if (inputData) {
          const csImage = cache.getImage(imageId);
          if (csImage) {
            const pixelData = csImage.voxelManager?.getScalarData?.();
            const vtkScalars = inputData.getPointData?.()?.getScalars?.();
            const vtkData = vtkScalars?.getData?.();
            if (pixelData && vtkData && vtkData.length === pixelData.length) {
              vtkData.set(pixelData);
              vtkScalars?.modified();
              inputData.modified();
            }
          }
          actorEntry.actor?.modified?.();
          actorEntry.actor?.getMapper?.()?.modified?.();
        }
      }
      (activeVp as any)?.render?.();   // synchronous WebGL render — instant visual removal

      // 2b. MPR viewports render the labelmap as built 3D VOLUMEs (not per-slice stack images), so the
      //     stack push above never touches them — and because reset keeps the same imageIds, cornerstone
      //     just re-serves the cached (pre-zeroed) volume, which is why a remount/DATA_MODIFIED didn't
      //     clear it. Instead, zero this segment's value directly in each labelmap volume's scalar buffer
      //     and re-render. Only labelmap volumes are Uint8Array (the CT is Int16/float) so the source is
      //     never touched; native indexOf skips block volumes that don't hold this segment; and volumes
      //     shared across the 3 MPR viewports are scanned once.
      {
        const _vpService = servicesManager.services.cornerstoneViewportService;
        const _scanned = new Set<any>();
        const _mprVps: any[] = [];
        for (const _vid of _vpService.getViewportIds()) {
          const _vp = _vpService.getCornerstoneViewport(_vid) as any;
          if (!(_vp instanceof VolumeViewport) || _vp instanceof VolumeViewport3D) continue;
          _mprVps.push(_vp);
          for (const _ae of (_vp?.getActors?.() ?? [])) {
            const _inputData = _ae?.actor?.getMapper?.()?.getInputData?.();
            const _scalars = _inputData?.getPointData?.()?.getScalars?.();
            const _vtkData = _scalars?.getData?.();
            if (!(_vtkData instanceof Uint8Array)) continue;   // labelmap volumes only; skip the CT
            if (!_scanned.has(_vtkData)) {
              _scanned.add(_vtkData);
              if (_vtkData.indexOf(segmentIndex) !== -1) {   // this block volume holds the segment
                for (let i = 0; i < _vtkData.length; i++) {
                  if (_vtkData[i] === segmentIndex) _vtkData[i] = 0;
                }
                _scalars.modified?.();
                _inputData.modified?.();
              }
            }
            _ae.actor?.modified?.();
            _ae.actor?.getMapper?.()?.modified?.();
          }
        }
        for (const _vp of _mprVps) _vp?.render?.();
      }

      // 3. Background: zero all remaining slices, remove measurements, reset server.
      setTimeout(() => {
        for (const imageId of imageIds) {
          if (!visibleImageIds.has(imageId)) _zeroImageId(imageId);
        }
        const measurementUIDs = measurementService
          .getMeasurements()
          .filter(e => e?.metadata?.segmentationId === segmentationId && e?.metadata?.SegmentNumber === segmentIndex)
          .map(e => e?.uid);
        if (measurementUIDs.length > 0) measurementService.removeMany(measurementUIDs);
        commandsManager.run('resetNninter', { clearMeasurements: false }).catch(() => {});
        eventTarget.dispatchEvent(
          new CustomEvent(csToolsEnums.Events.SEGMENTATION_DATA_MODIFIED, { detail: { segmentationId } })
        );
      }, 0);
    },
    async medGemma(
      query: string,
      instruction?: string,
      startSlice?: number,
      endSlice?: number,
      medgemmaVariant?: MedgemmaVariantId,
      medgemmaThinkingEnabled?: boolean
    ) {
      const { activeViewportId, viewports } = viewportGridService.getState();
      const activeViewportSpecificData = viewports.get(activeViewportId);
      const { displaySetInstanceUIDs } = activeViewportSpecificData;
      const displaySets = displaySetService.activeDisplaySets;
      const displaySetInstanceUID = displaySetInstanceUIDs[0];
      const currentDisplaySets = displaySets.filter(e => {
        return e.displaySetInstanceUID == displaySetInstanceUID;
      })[0];
      let url = `/monai/infer/segmentation?image=${currentDisplaySets.SeriesInstanceUID}&output=dicom_seg`;
      const variant =
        medgemmaVariant !== undefined
          ? medgemmaVariant
          : toolboxState.getMedgemmaVariant();
      const thinking =
        medgemmaThinkingEnabled !== undefined
          ? medgemmaThinkingEnabled
          : toolboxState.getMedgemmaThinkingEnabled();
      let params: Record<string, unknown> = {
        largest_cc: false,
        result_extension: '.nii.gz',
        result_dtype: 'uint16',
        result_compress: false,
        studyInstanceUID: currentDisplaySets.StudyInstanceUID,
        restore_label_idx: false,
        nninter: "medGemma",
        texts: [query],
        instruction: instruction || undefined,
        startSlice: startSlice !== undefined ? startSlice : undefined,
        endSlice: endSlice !== undefined ? endSlice : undefined,
        medgemma_variant: variant,
        medgemma_thinking_enabled: thinking,
      };

      let data = MonaiLabelClient.constructFormData(params, null);

      // Create the axios promise
      // For medGemma, we expect a text/string response, not arraybuffer
      const medgemmaPromise = axios.post(url, data, {
        responseType: 'text',
        headers: {
          accept: 'application/json, text/plain',
        },
      });

      const medgemmaTitle =
        variant === '27b'
          ? 'MedGemma 1-27B'
          : 'MedGemma 1.5-4B';

      // Show notification with promise support
      uiNotificationService.show({
        title: medgemmaTitle,
        message: 'Processing medgemma request...',
        type: 'info',
        promise: medgemmaPromise,
        promiseMessages: {
          loading: 'Processing medgemma request...',
          success: () => 'Medgemma request - Successful',
          error: (error) => `Medgemma request - Failed: ${error.message || 'Unknown error'}`,
        },
      });

      try {
        const response = await medgemmaPromise;
        if (response.status === 200) {
          return response;
        }
      } catch (error) {
        console.error('Medgemma error:', error);
        throw error;
      }
    },
    async gemini(
      query: string,
      instruction?: string,
      startSlice?: number,
      endSlice?: number,
      geminiModel?: string,
      geminiThinkingLevel?: '' | 'low' | 'medium' | 'high'
    ) {
      const { activeViewportId, viewports } = viewportGridService.getState();
      const activeViewportSpecificData = viewports.get(activeViewportId);
      const { displaySetInstanceUIDs } = activeViewportSpecificData;
      const displaySets = displaySetService.activeDisplaySets;
      const displaySetInstanceUID = displaySetInstanceUIDs[0];
      const currentDisplaySets = displaySets.filter(e => {
        return e.displaySetInstanceUID == displaySetInstanceUID;
      })[0];
      let url = `/monai/infer/segmentation?image=${currentDisplaySets.SeriesInstanceUID}&output=dicom_seg`;
      const level =
        geminiThinkingLevel !== undefined
          ? geminiThinkingLevel
          : toolboxState.getGeminiThinkingLevel();
      let params: Record<string, unknown> = {
        largest_cc: false,
        result_extension: '.nii.gz',
        result_dtype: 'uint16',
        result_compress: false,
        studyInstanceUID: currentDisplaySets.StudyInstanceUID,
        restore_label_idx: false,
        nninter: 'gemini',
        texts: [query],
        instruction: instruction || undefined,
        startSlice: startSlice !== undefined ? startSlice : undefined,
        endSlice: endSlice !== undefined ? endSlice : undefined,
        gemini_model: geminiModel || 'gemini-3-flash-preview',
      };
      if (level) {
        params.gemini_thinking_level = level;
      }

      let data = MonaiLabelClient.constructFormData(params, null);

      const geminiPromise = axios.post(url, data, {
        responseType: 'text',
        headers: {
          accept: 'application/json, text/plain',
        },
      });

      uiNotificationService.show({
        title: 'Gemini VLM',
        message: 'Processing Gemini request...',
        type: 'info',
        promise: geminiPromise,
        promiseMessages: {
          loading: 'Processing Gemini request...',
          success: () => 'Gemini request - Successful',
          error: (error) => `Gemini request - Failed: ${error.message || 'Unknown error'}`,
        },
      });

      try {
        const response = await geminiPromise;
        if (response.status === 200) {
          return response;
        }
      } catch (error) {
        console.error('Gemini error:', error);
        throw error;
      }
    },
    async openai(
      query: string,
      instruction?: string,
      startSlice?: number,
      endSlice?: number,
      openaiModel?: string,
      openaiReasoningEffort?: string
    ) {
      const { activeViewportId, viewports } = viewportGridService.getState();
      const activeViewportSpecificData = viewports.get(activeViewportId);
      const { displaySetInstanceUIDs } = activeViewportSpecificData;
      const displaySets = displaySetService.activeDisplaySets;
      const displaySetInstanceUID = displaySetInstanceUIDs[0];
      const currentDisplaySets = displaySets.filter(e => {
        return e.displaySetInstanceUID == displaySetInstanceUID;
      })[0];
      const url = `/monai/infer/segmentation?image=${currentDisplaySets.SeriesInstanceUID}&output=dicom_seg`;
      const params: Record<string, unknown> = {
        largest_cc: false,
        result_extension: '.nii.gz',
        result_dtype: 'uint16',
        result_compress: false,
        studyInstanceUID: currentDisplaySets.StudyInstanceUID,
        restore_label_idx: false,
        nninter: 'openai',
        texts: [query],
        instruction: instruction || undefined,
        startSlice: startSlice !== undefined ? startSlice : undefined,
        endSlice: endSlice !== undefined ? endSlice : undefined,
        openai_model: openaiModel || toolboxState.getOpenaiModel(),
        openai_reasoning_effort:
          openaiReasoningEffort ?? toolboxState.getOpenaiReasoningEffort(),
      };

      const data = MonaiLabelClient.constructFormData(params, null);

      const openaiPromise = axios.post(url, data, {
        responseType: 'text',
        headers: {
          accept: 'application/json, text/plain',
        },
      });

      uiNotificationService.show({
        title: 'OpenAI VLM',
        message: 'Processing OpenAI request...',
        type: 'info',
        promise: openaiPromise,
        promiseMessages: {
          loading: 'Processing OpenAI request...',
          success: () => 'OpenAI request - Successful',
          error: (error) => `OpenAI request - Failed: ${error.message || 'Unknown error'}`,
        },
      });

      try {
        const response = await openaiPromise;
        if (response.status === 200) {
          return response;
        }
      } catch (error) {
        console.error('OpenAI error:', error);
        throw error;
      }
    },
    async claude(
      query: string,
      instruction?: string,
      startSlice?: number,
      endSlice?: number,
      claudeModel?: string,
      claudeThinkingEffort?: '' | 'low' | 'medium' | 'high' | 'max'
    ) {
      const { activeViewportId, viewports } = viewportGridService.getState();
      const activeViewportSpecificData = viewports.get(activeViewportId);
      const { displaySetInstanceUIDs } = activeViewportSpecificData;
      const displaySets = displaySetService.activeDisplaySets;
      const displaySetInstanceUID = displaySetInstanceUIDs[0];
      const currentDisplaySets = displaySets.filter(e => {
        return e.displaySetInstanceUID == displaySetInstanceUID;
      })[0];
      const url = `/monai/infer/segmentation?image=${currentDisplaySets.SeriesInstanceUID}&output=dicom_seg`;
      const effort =
        claudeThinkingEffort !== undefined
          ? claudeThinkingEffort
          : toolboxState.getClaudeThinkingEffort();
      const params: Record<string, unknown> = {
        largest_cc: false,
        result_extension: '.nii.gz',
        result_dtype: 'uint16',
        result_compress: false,
        studyInstanceUID: currentDisplaySets.StudyInstanceUID,
        restore_label_idx: false,
        nninter: 'claude',
        texts: [query],
        instruction: instruction || undefined,
        startSlice: startSlice !== undefined ? startSlice : undefined,
        endSlice: endSlice !== undefined ? endSlice : undefined,
        claude_model: claudeModel || toolboxState.getClaudeModel(),
      };
      if (effort) {
        params.claude_thinking_effort = effort;
      }

      const data = MonaiLabelClient.constructFormData(params, null);

      const claudePromise = axios.post(url, data, {
        responseType: 'text',
        headers: {
          accept: 'application/json, text/plain',
        },
      });

      uiNotificationService.show({
        title: 'Claude (Anthropic)',
        message: 'Processing Claude request...',
        type: 'info',
        promise: claudePromise,
        promiseMessages: {
          loading: 'Processing Claude request...',
          success: () => 'Claude request - Successful',
          error: (error) => `Claude request - Failed: ${error.message || 'Unknown error'}`,
        },
      });

      try {
        const response = await claudePromise;
        if (response.status === 200) {
          return response;
        }
      } catch (error) {
        console.error('Claude error:', error);
        throw error;
      }
    },
    async kimi(
      query: string,
      instruction?: string,
      startSlice?: number,
      endSlice?: number,
      kimiModel?: string,
      kimiReasoningEnabled?: boolean
    ) {
      const { activeViewportId, viewports } = viewportGridService.getState();
      const activeViewportSpecificData = viewports.get(activeViewportId);
      const { displaySetInstanceUIDs } = activeViewportSpecificData;
      const displaySets = displaySetService.activeDisplaySets;
      const displaySetInstanceUID = displaySetInstanceUIDs[0];
      const currentDisplaySets = displaySets.filter(e => {
        return e.displaySetInstanceUID == displaySetInstanceUID;
      })[0];
      const url = `/monai/infer/segmentation?image=${currentDisplaySets.SeriesInstanceUID}&output=dicom_seg`;
      const reasoning =
        kimiReasoningEnabled !== undefined
          ? kimiReasoningEnabled
          : toolboxState.getKimiReasoningEnabled();
      const params: Record<string, unknown> = {
        largest_cc: false,
        result_extension: '.nii.gz',
        result_dtype: 'uint16',
        result_compress: false,
        studyInstanceUID: currentDisplaySets.StudyInstanceUID,
        restore_label_idx: false,
        nninter: 'kimi',
        texts: [query],
        instruction: instruction || undefined,
        startSlice: startSlice !== undefined ? startSlice : undefined,
        endSlice: endSlice !== undefined ? endSlice : undefined,
        kimi_model: kimiModel || toolboxState.getKimiModel(),
        kimi_disable_thinking: !reasoning,
      };

      const data = MonaiLabelClient.constructFormData(params, null);

      const kimiPromise = axios.post(url, data, {
        responseType: 'text',
        headers: {
          accept: 'application/json, text/plain',
        },
      });

      uiNotificationService.show({
        title: 'Kimi (HF router)',
        message: 'Processing Kimi request...',
        type: 'info',
        promise: kimiPromise,
        promiseMessages: {
          loading: 'Processing Kimi request...',
          success: () => 'Kimi request - Successful',
          error: (error) => `Kimi request - Failed: ${error.message || 'Unknown error'}`,
        },
      });

      try {
        const response = await kimiPromise;
        if (response.status === 200) {
          return response;
        }
      } catch (error) {
        console.error('Kimi error:', error);
        throw error;
      }
    },
    async qwen(
      query: string,
      instruction?: string,
      startSlice?: number,
      endSlice?: number,
      qwenModel?: string,
      qwenThinkingEnabled?: boolean
    ) {
      const { activeViewportId, viewports } = viewportGridService.getState();
      const activeViewportSpecificData = viewports.get(activeViewportId);
      const { displaySetInstanceUIDs } = activeViewportSpecificData;
      const displaySets = displaySetService.activeDisplaySets;
      const displaySetInstanceUID = displaySetInstanceUIDs[0];
      const currentDisplaySets = displaySets.filter(e => {
        return e.displaySetInstanceUID == displaySetInstanceUID;
      })[0];
      const url = `/monai/infer/segmentation?image=${currentDisplaySets.SeriesInstanceUID}&output=dicom_seg`;
      const thinking =
        qwenThinkingEnabled !== undefined
          ? qwenThinkingEnabled
          : toolboxState.getQwenThinkingEnabled();
      const params: Record<string, unknown> = {
        largest_cc: false,
        result_extension: '.nii.gz',
        result_dtype: 'uint16',
        result_compress: false,
        studyInstanceUID: currentDisplaySets.StudyInstanceUID,
        restore_label_idx: false,
        nninter: 'qwen',
        texts: [query],
        instruction: instruction || undefined,
        startSlice: startSlice !== undefined ? startSlice : undefined,
        endSlice: endSlice !== undefined ? endSlice : undefined,
        qwen_model: qwenModel || toolboxState.getQwenModel(),
        qwen_thinking_enabled: thinking,
      };

      const data = MonaiLabelClient.constructFormData(params, null);

      const qwenPromise = axios.post(url, data, {
        responseType: 'text',
        headers: {
          accept: 'application/json, text/plain',
        },
      });

      uiNotificationService.show({
        title: 'Qwen (HF router)',
        message: 'Processing Qwen request...',
        type: 'info',
        promise: qwenPromise,
        promiseMessages: {
          loading: 'Processing Qwen request...',
          success: () => 'Qwen request - Successful',
          error: (error) => `Qwen request - Failed: ${error.message || 'Unknown error'}`,
        },
      });

      try {
        const response = await qwenPromise;
        if (response.status === 200) {
          return response;
        }
      } catch (error) {
        console.error('Qwen error:', error);
        throw error;
      }
    },
    async gemma(
      query: string,
      instruction?: string,
      startSlice?: number,
      endSlice?: number,
      gemmaModel?: string,
      gemmaThinkingEnabled?: boolean
    ) {
      const { activeViewportId, viewports } = viewportGridService.getState();
      const activeViewportSpecificData = viewports.get(activeViewportId);
      const { displaySetInstanceUIDs } = activeViewportSpecificData;
      const displaySets = displaySetService.activeDisplaySets;
      const displaySetInstanceUID = displaySetInstanceUIDs[0];
      const currentDisplaySets = displaySets.filter(e => {
        return e.displaySetInstanceUID == displaySetInstanceUID;
      })[0];
      const url = `/monai/infer/segmentation?image=${currentDisplaySets.SeriesInstanceUID}&output=dicom_seg`;
      const thinking =
        gemmaThinkingEnabled !== undefined
          ? gemmaThinkingEnabled
          : toolboxState.getGemmaThinkingEnabled();
      const params: Record<string, unknown> = {
        largest_cc: false,
        result_extension: '.nii.gz',
        result_dtype: 'uint16',
        result_compress: false,
        studyInstanceUID: currentDisplaySets.StudyInstanceUID,
        restore_label_idx: false,
        nninter: 'gemma',
        texts: [query],
        instruction: instruction || undefined,
        startSlice: startSlice !== undefined ? startSlice : undefined,
        endSlice: endSlice !== undefined ? endSlice : undefined,
        gemma_model: gemmaModel || toolboxState.getGemmaModel(),
        gemma_thinking_enabled: thinking,
      };

      const data = MonaiLabelClient.constructFormData(params, null);

      const gemmaPromise = axios.post(url, data, {
        responseType: 'text',
        headers: {
          accept: 'application/json, text/plain',
        },
      });

      uiNotificationService.show({
        title: 'Gemma 4 (HF router)',
        message: 'Processing Gemma request...',
        type: 'info',
        promise: gemmaPromise,
        promiseMessages: {
          loading: 'Processing Gemma request...',
          success: () => 'Gemma request - Successful',
          error: (error) => `Gemma request - Failed: ${error.message || 'Unknown error'}`,
        },
      });

      try {
        const response = await gemmaPromise;
        if (response.status === 200) {
          return response;
        }
      } catch (error) {
        console.error('Gemma error:', error);
        throw error;
      }
    },
    async vllm(
      query: string,
      instruction?: string,
      startSlice?: number,
      endSlice?: number,
      vllmBaseUrl?: string,
      vllmFamily?: VllmFamilyId,
      vllmThinkingLevel?: VllmThinkingLevel
    ) {
      const { activeViewportId, viewports } = viewportGridService.getState();
      const activeViewportSpecificData = viewports.get(activeViewportId);
      const { displaySetInstanceUIDs } = activeViewportSpecificData;
      const displaySets = displaySetService.activeDisplaySets;
      const displaySetInstanceUID = displaySetInstanceUIDs[0];
      const currentDisplaySets = displaySets.filter(e => {
        return e.displaySetInstanceUID == displaySetInstanceUID;
      })[0];
      const url = `/monai/infer/segmentation?image=${currentDisplaySets.SeriesInstanceUID}&output=dicom_seg`;
      const baseUrl =
        (vllmBaseUrl ?? toolboxState.getVllmBaseUrl()).trim() ||
        'http://host.docker.internal:8000/v1';
      const family = vllmFamily !== undefined ? vllmFamily : toolboxState.getVllmFamily();
      const thinking =
        vllmThinkingLevel !== undefined
          ? vllmThinkingLevel
          : toolboxState.getVllmThinkingLevel();
      const params: Record<string, unknown> = {
        largest_cc: false,
        result_extension: '.nii.gz',
        result_dtype: 'uint16',
        result_compress: false,
        studyInstanceUID: currentDisplaySets.StudyInstanceUID,
        restore_label_idx: false,
        nninter: 'vllm',
        texts: [query],
        instruction: instruction || undefined,
        startSlice: startSlice !== undefined ? startSlice : undefined,
        endSlice: endSlice !== undefined ? endSlice : undefined,
        vllm_base_url: baseUrl,
        vllm_thinking_level: thinking,
      };
      if (family) {
        params.vllm_family = family;
      }

      const data = MonaiLabelClient.constructFormData(params, null);

      const vllmPromise = axios.post(url, data, {
        responseType: 'text',
        headers: {
          accept: 'application/json, text/plain',
        },
      });

      uiNotificationService.show({
        title: 'vLLM (OpenAI API)',
        message: 'Processing vLLM request...',
        type: 'info',
        promise: vllmPromise,
        promiseMessages: {
          loading: 'Processing vLLM request...',
          success: () => 'vLLM request - Successful',
          error: (error) => `vLLM request - Failed: ${error.message || 'Unknown error'}`,
        },
      });

      try {
        const response = await vllmPromise;
        if (response.status === 200) {
          return response;
        }
      } catch (error) {
        console.error('vLLM error:', error);
        throw error;
      }
    },
    async nninter(textPrompts?: string | string[]) {
      if (!beginInferenceRunOrQueue()) {
        return;
      }

      const overlap = true;
      const start = Date.now();

      const { activeViewportId, viewports } = viewportGridService.getState();
      const activeViewportSpecificData = viewports.get(activeViewportId);

      const { setViewportGridState } = useViewportGridStore.getState();
      const currentImageIdIndex = servicesManager.services.cornerstoneViewportService.getCornerstoneViewport(activeViewportId).getCurrentImageIdIndex();
      setViewportGridState('currentImageIdIndex', currentImageIdIndex);
      const { displaySetInstanceUIDs } = activeViewportSpecificData;

      const displaySets = displaySetService.activeDisplaySets;

      const displaySetInstanceUID = displaySetInstanceUIDs[0];
      const currentDisplaySets = displaySets.find(e => e.displaySetInstanceUID === displaySetInstanceUID);
      if (!currentDisplaySets) return;
      const currentMeasurements = measurementService.getMeasurements()

      const unAssignedMeasurements = currentMeasurements.filter(e => {
          return e.metadata.SegmentNumber === undefined;
        })


      const activeSegmentation = servicesManager.services.segmentationService.getActiveSegmentation(activeViewportId)
      let segmentNumber = 1;
      let segments: { [segmentIndex: string]: cstTypes.Segment } = {};
      let segmentationId = `${csUtils.uuidv4()}`
      let _needsReset = false; // set true when switching segments; folded into inference POST
      if (activeSegmentation !== undefined){
        segmentationId = activeSegmentation.segmentationId;
        segments = { ...activeSegmentation.segments };
      if (Object.values(segments).length > 0) {
        // Find the minimum available segment number
        const existingSegmentNumbers = Object.values(segments).map(e => e.segmentIndex).sort((a, b) => a - b);
        let minAvailableNumber = 1;
        // Find the first gap in segment numbers, or use the next number after the highest
        for (let i = 0; i < existingSegmentNumbers.length; i++) {
          if (existingSegmentNumbers[i] !== minAvailableNumber) {
            break;
          }
          minAvailableNumber++;
        }
        segmentNumber = minAvailableNumber;
        if (!toolboxState.getRefineNew()) {
          const activeSegment = servicesManager.services.segmentationService.getActiveSegment(activeViewportId);
          if (activeSegment !== undefined){
            for (let i = 0; i < unAssignedMeasurements.length; i++) {
              const e = unAssignedMeasurements[i];
              e.metadata.SegmentNumber = activeSegment.segmentIndex;
              e.metadata.segmentationId = activeSegmentation.segmentationId;
            }
            segmentNumber = activeSegment.segmentIndex;
            if (blockIfActiveSegmentHidden(activeViewportId, activeSegmentation.segmentationId, segmentNumber)) {
              finishInferenceRun();
              return;
            }
            _needsReset = toolboxState.getCurrentActiveSegment() !== segmentNumber;
            if (_needsReset) {
              toolboxState.setCurrentActiveSegment(segmentNumber);
            }
          } else {
            uiNotificationService.show({
              title: 'Click Segment to refine',
              message: 'No active segment found, please click segment to refine',
              type: 'warning',
              duration: 4000,
            });
            return
          }
        } else {
          // For new Segment — fill an empty placeholder from Add Segment when present.
          const activeSegment = servicesManager.services.segmentationService.getActiveSegment(activeViewportId);
          const activeIdx = activeSegment?.segmentIndex;
          const isEmptyActiveSegment =
            activeIdx != null &&
            segments[activeIdx] &&
            !(segments[activeIdx] as any)?.cachedStats?.algorithmName;
          if (isEmptyActiveSegment) {
            segmentNumber = activeIdx;
          }
          for (let i = 0; i < unAssignedMeasurements.length; i++) {
            const e = unAssignedMeasurements[i];
            e.metadata.SegmentNumber = segmentNumber;
            e.metadata.segmentationId = activeSegmentation.segmentationId;
          }
        }
      } else{
        // No existing segments in current active segmentation
        for (let i = 0; i < unAssignedMeasurements.length; i++) {
          const e = unAssignedMeasurements[i];
          e.metadata.SegmentNumber = segmentNumber;
          e.metadata.segmentationId = activeSegmentation.segmentationId;
        }
      }  
    } else {
      // No existing segmentation
      for (let i = 0; i < unAssignedMeasurements.length; i++) {
        const e = unAssignedMeasurements[i];
        e.metadata.SegmentNumber = segmentNumber;
        e.metadata.segmentationId = segmentationId;
      }
    }


      const imageIdsForPrompts: string[] = currentDisplaySets.imageIds ?? [];
      const pos_points: any[] = [];
      const neg_points: any[] = [];
      const pos_boxes: any[] = [];
      const neg_boxes: any[] = [];
      const pos_lassos: any[] = [];
      const neg_lassos: any[] = [];
      const pos_scribbles: any[] = [];
      const neg_scribbles: any[] = [];
      const probe2Labels: string[] = [];
      const seriesUID = currentDisplaySets.SeriesInstanceUID;
      for (const e of currentMeasurements) {
        if (e.referenceSeriesUID !== seriesUID || e.metadata.SegmentNumber !== segmentNumber) continue;
        const isNeg = !!e.metadata.neg;
        if (e.toolName === 'Probe2') {
          (isNeg ? neg_points : pos_points).push(Object.values(e.data)[0].index);
          if (!isNeg && !textPrompts) probe2Labels.push(e.label);
        } else if (e.toolName === 'RectangleROI2') {
          const pts = Object.values(e.data)[0].pointsInShape;
          const p0 = [...pts.at(0).pointIJK];
          const p1 = [...pts.at(-1).pointIJK];
          // Stack viewports: pointsInShape k=0 from 2D imageData; use referencedImageId for correct slice.
          if (p0[2] === 0) { const refK = imageIdsForPrompts.indexOf(e.referencedImageId); if (refK > 0) { p0[2] = refK; p1[2] = refK; } }
          (isNeg ? neg_boxes : pos_boxes).push([p0, p1]);
        } else if (e.toolName === 'PlanarFreehandROI3') {
          const b = Object.values(e.data)[0]?.boundary;
          if (b) (isNeg ? neg_lassos : pos_lassos).push(b);
        } else if (e.toolName === 'PlanarFreehandROI2') {
          const s = Object.values(e.data)[0]?.scribble;
          if (s) (isNeg ? neg_scribbles : pos_scribbles).push(s);
        }
      }
      //VoxTell - Use provided textPrompts or extract from measurements
      const text_prompts: string[] = textPrompts
        ? (Array.isArray(textPrompts) ? textPrompts : [textPrompts])
        : probe2Labels;

      // Hide measurements after inference unless user has set prompts to always-show
      if (!toolboxState.getPromptsVisible()) {
        currentMeasurements
          .filter(e => e.referenceSeriesUID === currentDisplaySets.SeriesInstanceUID)
          .forEach(e => measurementService.toggleVisibilityMeasurement(e.uid, false));
        document.dispatchEvent(new Event('measurement-state-changed'));
      }

      let nninterToken = '';
      try {
        nninterToken = await getNninterToken();
      } catch (e) {
        // Server down or old server image without the endpoint — proceed
        // tokenless; the infer call surfaces its own error/expired handling.
        console.warn('nninter session claim failed; proceeding without token', e);
      }
      let url = `/monai/infer/segmentation?image=${currentDisplaySets.SeriesInstanceUID}&output=dicom_seg`;
      let params = {
        largest_cc: false,
      //  device: response.data.trainers.segmentation.config.device,
        result_extension: '.nii.gz',
        result_dtype: 'uint16',
        result_compress: false,
        studyInstanceUID: currentDisplaySets.StudyInstanceUID,
        restore_label_idx: false,
        pos_points: pos_points,
        neg_points: neg_points,
        pos_boxes: pos_boxes,
        neg_boxes: neg_boxes,
        pos_lassos: pos_lassos,
        neg_lassos: neg_lassos,
        pos_scribbles: pos_scribbles,
        neg_scribbles: neg_scribbles,
        texts: text_prompts,
        nninter: true,
        nninter_reset_first: _needsReset,
        nninter_token: nninterToken,
      };

      let data = MonaiLabelClient.constructFormData(params, null);

      
      const beforePost = Date.now();

      // Create the axios promise
      const segmentationPromise = axios.post(url, data, {
        responseType: 'arraybuffer',
        headers: {
          //accept: 'application/json, multipart/form-data',
          accept: 'application/octet-stream',
        },
      });

      // Show notification with promise support
      uiNotificationService.show({
        title: 'MONAI Label',
        message: 'Processing nninter segmentation...',
        type: 'info',
        promise: segmentationPromise,
        promiseMessages: {
          loading: 'Processing nninter segmentation...',
          success: () => 'Run Segmentation - Successful',
          // Prod: no red seg-failure alert for end users — log it and quietly
          // dismiss the "Processing..." toast (null suppresses the error toast).
          error: (error) => {
            console.error('Run Segmentation failed:', error);
            return null;
          },
        },
      });

      try {
        // Process the response
        const response = await segmentationPromise;
        if (response.status === 200) {
            const afterPost = Date.now();
            const networkRoundTripMs = afterPost - beforePost;
            const ct = response.headers["content-type"] as string;
            const { meta, seg } = await parseMultipart(response.data, ct, { allowEmptySeg: true });
            // Server-side session was evicted/timed out. Reclaim, re-init, and
            // re-run: measurements still hold the full prompt history, and the
            // server replays any prompts it hasn't seen (one GPU prediction).
            let _nninterOp: unknown = (meta as any).nninter_op;
            try {
              _nninterOp = JSON.parse(((meta as any).nninter_op ?? 'null') as string);
            } catch {
              /* keep raw value */
            }
            if (_nninterOp === 'session_expired') {
              const _now = Date.now();
              if (_now - _lastNninterRecoveryTs < 5000) {
                uiNotificationService.show({
                  title: 'MONAI Label',
                  message: 'nnInteractive session expired — please segment again.',
                  type: 'warning',
                  duration: 4000,
                });
                return;
              }
              _lastNninterRecoveryTs = _now;
              console.warn('nninter session expired — reclaiming and replaying prompts');
              clearNninterToken();
              await getNninterToken();
              await actions.initNninter();
              return actions.nninter(textPrompts);
            }
            if (!seg.length) {
              throw new Error('seg part not found');
            }
            const afterParse = Date.now();

            // --- server-side timing breakdown ---
            const sRequestTs     = metaNum(meta as Record<string,unknown>, 'server_request_ts');
            const sBeginTs       = metaNum(meta as Record<string,unknown>, 'server_begin_ts');
            const sEndTs         = metaNum(meta as Record<string,unknown>, 'server_end_ts');
            const sLoad          = metaNum(meta as Record<string,unknown>, 'server_load_elapsed');
            const sImgConvert    = metaNum(meta as Record<string,unknown>, 'server_img_convert_elapsed');
            const sPromptPrep    = metaNum(meta as Record<string,unknown>, 'server_prompt_prep_elapsed');
            const sModelCore     = metaNum(meta as Record<string,unknown>, 'nninter_core_elapsed');
            const sResult        = metaNum(meta as Record<string,unknown>, 'server_result_elapsed');
            const sTotal         = metaNum(meta as Record<string,unknown>, 'nninter_elapsed');
            const sFirstTs       = metaNum(meta as Record<string,unknown>, 'nninter_first_interaction_ts');

            // Four-leg split (all server timestamps share the same host clock as the container):
            //   leg1: POST in flight          = server_request_ts - beforePost (client clock vs server clock; same host → accurate)
            //   leg2: MONAI pre-processing    = server_begin_ts - server_request_ts (DICOM download from Orthanc, entirely server-side)
            //   leg3: our infer()             = server_end_ts - server_begin_ts (same clock, exact)
            //   leg4: response in flight      = afterPost - server_end_ts (same host → accurate)
            const postInFlightMs    = (sRequestTs != null) ? sRequestTs * 1000 - beforePost                     : undefined;
            const monaiPrepMs       = (sRequestTs != null && sBeginTs != null) ? (sBeginTs - sRequestTs) * 1000 : undefined;
            const serverProcessMs   = (sBeginTs   != null && sEndTs   != null) ? (sEndTs   - sBeginTs)   * 1000 : undefined;
            const responseInFlightMs= (sEndTs     != null)                     ? afterPost - sEndTs * 1000      : undefined;


            const flipped = meta.flipped.toLowerCase() === "true"
            const nninter_elapsed = meta.nninter_elapsed
            const prompt_info = meta.prompt_info
            const label_name = meta.label_name
            const raw = seg

            // Parse crop geometry. The slice loops write directly from cropBytes into
            // each slice's scalar data buffer — no full-volume reconstruction needed.
            // Avoiding the 182 MB allocation eliminates GC pauses that caused 0.3-1.3s jitter.
            const cropBytes = new Uint8Array(raw);
            const predOffset: number[] = JSON.parse((meta as any).pred_offset   || '[0,0,0]');
            const predFull:   number[] = JSON.parse((meta as any).pred_full_shape || '[]');
            const predCrop:   number[] = JSON.parse((meta as any).pred_crop_shape || '[]');

            // Crop geometry (exposed to slice loops below)
            let _segZ0 = 0, _segZ1 = Number.MAX_SAFE_INTEGER;
            let _cropY = 0, _cropX = 0, _y0 = 0, _x0 = 0, _fullX = 0, _fullY = 0;
            let _hasCropGeom = false;
            if (predFull.length === 3 && predCrop.length === 3) {
              const [, fullY, fullX] = predFull;   // predFull = [fullZ, fullY, fullX]
              const [cropZ, cropY, cropX] = predCrop;
              const [z0, y0, x0] = predOffset;
              _segZ0 = z0;  _segZ1 = z0 + cropZ;
              _cropY = cropY; _cropX = cropX;
              _y0 = y0; _x0 = x0; _fullX = fullX; _fullY = fullY;
              _hasCropGeom = true;
            } else {
            }
            // Legacy fallback: reconstruct full-volume buffer when crop geometry is unavailable.
            // This path should never trigger for current server builds.
            let new_arrayBuffer: Uint8Array | null = null;
            if (!_hasCropGeom) {
              new_arrayBuffer = cropBytes;
            }

            let imageIds = currentDisplaySets.imageIds

            const refreshedContext = refreshActiveSegmentationContext(
              activeViewportId,
              currentDisplaySets,
              segmentationId,
            );
            segments = refreshedContext.segments;
            segmentationId = refreshedContext.segmentationId;
            const segImageIds = refreshedContext.segImageIds;
            const existingSegments = refreshedContext.existingSegments;
            const existing = refreshedContext.existing;
            // Which segment each existing block holds. Null for representations built before the
            // explicit map existed -> the positional fallback (block b = segment b+1) applies.
            const _prevBlockSegments: number[] | null = refreshedContext.blockSegments;
            const _blockIdxForSeg = _prevBlockSegments
              ? _prevBlockSegments.indexOf(segmentNumber)
              : segmentNumber - 1;

          let merged_derivedImages = [];
          let z_range = [];
          // Old block's imageIds when this is a refine — evicted from the cornerstone cache
          // AFTER the representation swap below, so the ~84MB fresh block minted each refine
          // doesn't accumulate (leak was ~+84MB/refine, inflating MPR remount + GC pauses).
          let _orphanedImageIds: string[] = [];
          // Block -> segment map for the representation we are about to write.
          let _nextBlockSegments: number[] | null = null;
          // Set when the refined crop was written straight into the on-screen MPR labelmap volume,
          // which lets us skip the remount (the remount is what orphans a volume every refine).
          let _mprInPlaceDone = false;
          if(overlap){
          let derivedImages = [];
          if (segImageIds.length > 0){
            derivedImages = segImageIds.map(imageId => cache.getImage(imageId));
          }

          // TRUE IN-PLACE REFINE: reuse this segment's EXISTING block instead of minting a fresh one.
          // Keeping the same imageIds is what makes the whole thing consistent — the representation
          // is unchanged, so no remount is needed, so cornerstone never builds (and orphans) another
          // MPR volume. (An earlier attempt kept the new block AND skipped the remount; that made the
          // representation point at the new block while the screen still showed the volume built from
          // the old one — the refined segment disappeared. Reuse keeps both in agreement.)
          const _imgLen0 = imageIds.length;
          const _numBlocks0 = _imgLen0 > 0 ? Math.floor(derivedImages.length / _imgLen0) : 0;
          // Only take the in-place path in an MPR-ONLY layout. With a stack viewport on screen the
          // images must stay current every frame, so deferring their write would show stale pixels;
          // there the fresh-block path is used (its images are cheap to write and its remount is
          // only ~10-20ms without MPR volumes to rebuild).
          const _vpIdsNow = servicesManager.services.cornerstoneViewportService.getViewportIds();
          let _nMpr = 0, _nStack = 0;
          for (const _vid of _vpIdsNow) {
            const _vp = servicesManager.services.cornerstoneViewportService.getCornerstoneViewport(_vid);
            if (_vp instanceof VolumeViewport && !(_vp instanceof VolumeViewport3D)) _nMpr++;
            else if (!(_vp instanceof VolumeViewport3D)) _nStack++;
          }
          const _reuseIdx = (_hasCropGeom && !toolboxState.getRefineNew() && _nMpr > 0 && _nStack === 0
            && _blockIdxForSeg >= 0 && _blockIdxForSeg < _numBlocks0) ? _blockIdxForSeg : -1;

          let derivedImages_new: any[];
          let _clearIdxs: number[] = [];
          if (_reuseIdx >= 0) {
            // Reuse the block as-is: NO image reads/writes here (that is the ~2.5s getScalarData tax).
            // The crop goes into the volume below; the images are synced lazily via _pendingImageSync.
            const _bStart = _reuseIdx * _imgLen0;
            derivedImages_new = derivedImages.slice(_bStart, _bStart + _imgLen0);
            const _ps = (existingSegments[segmentNumber] as any)?.cachedStats;
            const _pd = _ps?.dirtySlices as number[] | undefined;
            // Bound the clear to slices that actually held pixels. With NO recorded extent there is
            // no prior mask to clear — the old code swept every slice at ~7ms each (321 slices was
            // the ~5s stall seen whenever the volume lookup missed), for nothing.
            const _prevIdxs: number[] = (!_pd?.length && (_ps?.segZ0 == null || _ps?.segZ1 == null))
              ? []
              : _pd?.length
              ? _pd
              : Array.from(
                  { length: Math.max(0, (_ps?.segZ1 ?? _imgLen0) - (_ps?.segZ0 ?? 0)) },
                  (_, k) => (_ps?.segZ0 ?? 0) + k
                );
            _clearIdxs = _prevIdxs.map((d: number) => (flipped ? (_imgLen0 - 1 - d) : d));
          } else {
            derivedImages_new = await imageLoader.createAndCacheDerivedLabelmapImages(imageIds);
          }

          // A freshly-created block is in display order and needs reversing for a flipped series;
          // a reused block is already stored in working order, so it must NOT be reversed again.
          if(flipped && _reuseIdx < 0){
            derivedImages_new.reverse();
          }
          if (_reuseIdx >= 0) {
            // Volume-only path: derive z_range straight from the crop bytes (which slices actually
            // contain mask) instead of from the image writes we just skipped. Same values the write
            // loop would have produced, for cachedStats/dirtySlices/center.
            const _sliceArea = _cropY * _cropX;
            for (let z = _segZ0; z < _segZ1; z++) {
              const _base = (z - _segZ0) * _sliceArea;
              for (let k = 0; k < _sliceArea; k++) {
                if (cropBytes[_base + k] === 1) {
                  z_range.push(flipped ? derivedImages_new.length - z - 1 : z);
                  break;
                }
              }
            }
          }
          for (let i = 0; _reuseIdx < 0 && i < derivedImages_new.length; i++) {
            if (_hasCropGeom && (i < _segZ0 || i >= _segZ1)) continue;
            const voxelManager = derivedImages_new[i].voxelManager as csTypes.IVoxelManager<number>;
            if (_hasCropGeom && i >= _segZ0 && i < _segZ1) {
              const scalarData = voxelManager.getScalarData();
              const c = i - _segZ0;
              const cropSliceBase = c * _cropY * _cropX;
              let wrote = false;
              for (let cy = 0; cy < _cropY; cy++) {
                const srcRow = cropSliceBase + cy * _cropX;
                const dstRow = (_y0 + cy) * _fullX + _x0;
                for (let cx = 0; cx < _cropX; cx++) {
                  if (cropBytes[srcRow + cx] === 1) {
                    scalarData[dstRow + cx] = segmentNumber;
                    wrote = true;
                  }
                }
              }
              if (wrote) z_range.push(flipped ? derivedImages_new.length - i - 1 : i);
            } else if (!_hasCropGeom && new_arrayBuffer) {
              // Legacy: full-slice scan
              const scalarData = voxelManager.getScalarData();
              const sliceLen = scalarData.length;
              const sliceData = new_arrayBuffer.slice(i * sliceLen, (i + 1) * sliceLen);
              if (sliceData.some(v => v === 1)) {
                voxelManager.setScalarData(sliceData.map(v => v === 1 ? segmentNumber : v));
                z_range.push(flipped ? derivedImages_new.length - i - 1 : i);
              }
            }
          }

          // IN-PLACE MPR UPDATE — only meaningful when the block was REUSED above (imageIds
          // unchanged). The block's images now hold the refined mask, but the MPR labelmap volume is
          // a separate buffer built from them, so it must be written too. When that succeeds the
          // representation AND the on-screen volume are both current, so the remount below can be
          // skipped — and skipping it is what stops cornerstone building (and orphaning) a fresh
          // volume every refine. If the volume can't be found we leave _mprInPlaceDone false and the
          // normal remount still runs, so MPR is never left stale.
          if (_reuseIdx >= 0) {
            const _prevStats = (existingSegments[segmentNumber] as any)?.cachedStats;
            _mprInPlaceDone = updateMprLabelmapVolumeInPlace({
              segmentNumber,
              cropBytes,
              segZ0: _segZ0,
              segZ1: _segZ1,
              cropY: _cropY,
              cropX: _cropX,
              y0: _y0,
              x0: _x0,
              fullX: _fullX,
              fullY: _fullY,
              prevZ0: (_prevStats?.segZ0 != null) ? _prevStats.segZ0 as number : _segZ0,
              prevZ1: (_prevStats?.segZ1 != null) ? _prevStats.segZ1 as number : _segZ1,
              prevBox: (_prevStats?.cropBox ?? null) as any,
            });
            if (_mprInPlaceDone) {
              // Queue the image write we skipped. Latest payload per segment wins (the server sends
              // the full current mask each refine), so rapid refines collapse to one materialisation.
              let _bySeg = _pendingImageSync.get(segmentationId);
              if (!_bySeg) { _bySeg = new Map<number, any>(); _pendingImageSync.set(segmentationId, _bySeg); }
              _bySeg.set(segmentNumber, {
                blockImageIds: derivedImages_new.map((img: any) => img?.imageId),
                segmentNumber, cropBytes,
                segZ0: _segZ0, segZ1: _segZ1, cropY: _cropY, cropX: _cropX,
                y0: _y0, x0: _x0, fullX: _fullX,
                clearIdxs: _clearIdxs,
              });
            } else {
              // Volume not found: nothing was written anywhere, so fall back to the normal path by
              // writing the images now (the remount below will rebuild the volume from them).
              for (const _ai of _clearIdxs) {
                const _vm = derivedImages_new[_ai]?.voxelManager as csTypes.IVoxelManager<number>;
                if (!_vm) continue;
                const _sd = _vm.getScalarData();
                for (let j = 0; j < _sd.length; j++) if (_sd[j] === segmentNumber) _sd[j] = 0;
              }
              for (let z = _segZ0; z < _segZ1; z++) {
                const _vm = derivedImages_new[z]?.voxelManager as csTypes.IVoxelManager<number>;
                if (!_vm) continue;
                const _sd = _vm.getScalarData();
                const _cb = (z - _segZ0) * _cropY * _cropX;
                for (let cy = 0; cy < _cropY; cy++) {
                  const _sr = _cb + cy * _cropX;
                  const _dr = (_y0 + cy) * _fullX + _x0;
                  for (let cx = 0; cx < _cropX; cx++) {
                    if (cropBytes[_sr + cx] === 1) _sd[_dr + cx] = segmentNumber;
                  }
                }
              }
            }
          }


          let filteredDerivedImages = [];
          const imgLength = imageIds.length;
          let excludedBlockIndex = -1; // 0-based block index of the segment being refined

          // buildMultiBlockLabelmapRepresentation assigns block b → segment b+1, so we can
          // compute the excluded block directly instead of scanning all images pixel-by-pixel.
          // Old approach: O(N_segments × N_slices × pixels) — grows with every new segment.
          // New approach: O(N_slices × pixels) — clears only the one target block.
          if (!toolboxState.getRefineNew() && derivedImages.length > 0) {
            const numBlocks = Math.ceil(derivedImages.length / imgLength);
            const candidateBlock = _blockIdxForSeg;
            if (candidateBlock >= 0 && candidateBlock < numBlocks) {
              excludedBlockIndex = candidateBlock;
              // NEVER evict when reusing: that block IS derivedImages_new (still live/on screen).
              // Only a fresh block orphans the old one.
              _orphanedImageIds = _reuseIdx >= 0 ? [] : derivedImages
                .slice(excludedBlockIndex * imgLength, (excludedBlockIndex + 1) * imgLength)
                .map((img: any) => img?.imageId)
                .filter(Boolean);
              // No pixel-clear needed: this old block is EXCLUDED below and replaced wholesale by
              // the freshly-created all-zero derivedImages_new (which already holds the new crop
              // from the slice loop above). createAndCacheDerivedLabelmapImages mints fresh
              // derived:uuid images every call, so the old block is orphaned, and nnInteractive
              // returns the full current mask each refine — the old pixels are superseded anyway.
            }
            for (let i = 0; i < derivedImages.length; i++) {
              if (Math.floor(i / imgLength) !== excludedBlockIndex) filteredDerivedImages.push(derivedImages[i]);
            }
          } else if (derivedImages.length > 0) {
            filteredDerivedImages = derivedImages;
          }

          // Insert derivedImages_new at the excluded block's original position to preserve
          // the block-index → segment-index invariant used by buildMultiBlockLabelmapRepresentation.
          if (excludedBlockIndex >= 0) {
            const blocksBefore = filteredDerivedImages.slice(0, excludedBlockIndex * imgLength);
            const blocksAfter = filteredDerivedImages.slice(excludedBlockIndex * imgLength);
            merged_derivedImages = [...blocksBefore, ...derivedImages_new, ...blocksAfter];
          } else {
            merged_derivedImages = [...filteredDerivedImages, ...derivedImages_new];
          }
          // Track which segment each block now holds. Refining an existing segment replaces its
          // block in place (map unchanged); a new segment appends a block at the end.
          const _basePrev = _prevBlockSegments
            ?? Array.from({ length: _numBlocks0 }, (_, b) => b + 1);
          _nextBlockSegments = excludedBlockIndex >= 0
            ? _basePrev.slice()
            : [..._basePrev.filter(sg => sg !== segmentNumber), segmentNumber];
        } else {
          if (segImageIds.length == 0){
            const _tCreate2 = Date.now();
            let derivedImages_new = await imageLoader.createAndCacheDerivedLabelmapImages(imageIds);

            if(flipped){
              derivedImages_new.reverse();
            }
            for (let i = 0; i < derivedImages_new.length; i++) {
              if (_hasCropGeom && (i < _segZ0 || i >= _segZ1)) continue;
              const voxelManager = derivedImages_new[i]
                .voxelManager as csTypes.IVoxelManager<number>;              // Write directly from cropBytes into the slice's scalar buffer.
              // Iterates only cropY×cropX elements (fits in L2 cache) vs 262K full-slice scan.
              if (_hasCropGeom && i >= _segZ0 && i < _segZ1) {
                const scalarData = voxelManager.getScalarData();
                const c = i - _segZ0;
                const cropSliceBase = c * _cropY * _cropX;
                let wrote = false;
                for (let cy = 0; cy < _cropY; cy++) {
                  const srcRow = cropSliceBase + cy * _cropX;
                  const dstRow = (_y0 + cy) * _fullX + _x0;
                  for (let cx = 0; cx < _cropX; cx++) {
                    if (cropBytes[srcRow + cx] === 1) {
                      scalarData[dstRow + cx] = segmentNumber;
                      wrote = true;
                    }
                  }
                }
                if (wrote) z_range.push(flipped ? derivedImages_new.length - i - 1 : i);
              } else if (!_hasCropGeom && new_arrayBuffer) {
                // Legacy: full-slice scan
                const scalarData = voxelManager.getScalarData();
                const sliceLen = scalarData.length;
                const sliceData = new_arrayBuffer.subarray(i * sliceLen, (i + 1) * sliceLen);
                if (sliceData.some(v => v === 1)){
                  for (let j = 0; j < sliceLen; j++) { if (sliceData[j] === 1) scalarData[j] = segmentNumber; }
                  z_range.push(flipped ? derivedImages_new.length - i - 1 : i);
                }
              }
            }
            if(flipped){
              derivedImages_new.reverse();
            }
            merged_derivedImages = derivedImages_new
          } else {
            merged_derivedImages = segImageIds.map(imageId => cache.getImage(imageId));
            if(flipped){
              merged_derivedImages.reverse();
            }

            // ── Pass 1: Clear old pixels ─────────────────────────────────────
            // Use dirtySlices (exact indices that have pixels) when available.
            // Falls back to the range-based scan on first refinement or old data.
            const _prevDirtySlices = (existingSegments[segmentNumber] as any)
              ?.cachedStats?.dirtySlices as number[] | undefined;

            const _prevCachedStats = (existingSegments[segmentNumber] as any)?.cachedStats;
            const _hasPrevData = _prevDirtySlices?.length ||
              _prevCachedStats?.segZ0 != null || _prevCachedStats?.segZ1 != null;

            if (_prevDirtySlices?.length) {
              // Fast path: only touch slices that actually contain pixels (~20-50 vs 500+)
              for (const origIdx of _prevDirtySlices) {
                const arrIdx = flipped ? (merged_derivedImages.length - 1 - origIdx) : origIdx;
                const vm = merged_derivedImages[arrIdx]?.voxelManager as csTypes.IVoxelManager<number>;
                if (!vm) continue;
                const sd = vm.getScalarData();
                for (let j = 0; j < sd.length; j++) {
                  if (sd[j] === segmentNumber) sd[j] = 0;
                }
              }
            } else if (_hasPrevData) {
              // Fallback: bounding-box range scan (dirtySlices not yet stored, e.g. first run after migration)
              const _prevZ0: number = (_hasCropGeom && _prevCachedStats?.segZ0 != null)
                ? _prevCachedStats.segZ0 as number : 0;
              const _prevZ1: number = (_hasCropGeom && _prevCachedStats?.segZ1 != null)
                ? _prevCachedStats.segZ1 as number : merged_derivedImages.length;
              const scanZ0 = _hasCropGeom ? Math.min(_prevZ0, _segZ0) : 0;
              const scanZ1 = _hasCropGeom ? Math.max(_prevZ1, _segZ1) : merged_derivedImages.length;
              for (let i = scanZ0; i < scanZ1; i++) {
                const sd = (merged_derivedImages[i].voxelManager as csTypes.IVoxelManager<number>).getScalarData();
                for (let j = 0; j < sd.length; j++) {
                  if (sd[j] === segmentNumber) sd[j] = 0;
                }
              }
            } else {
              // Brand-new segment — nothing to clear, skip entirely
            }

            // ── Pass 2: Write new pixels from crop only ───────────────────────
            if (_hasCropGeom) {
              for (let i = _segZ0; i < _segZ1; i++) {
                const scalarData = (merged_derivedImages[i].voxelManager as csTypes.IVoxelManager<number>).getScalarData();
                const c = i - _segZ0;
                const cropSliceBase = c * _cropY * _cropX;
                let wrote = false;
                for (let cy = 0; cy < _cropY; cy++) {
                  const srcRow = cropSliceBase + cy * _cropX;
                  const dstRow = (_y0 + cy) * _fullX + _x0;
                  for (let cx = 0; cx < _cropX; cx++) {
                    if (cropBytes[srcRow + cx] === 1) {
                      scalarData[dstRow + cx] = segmentNumber;
                      wrote = true;
                    }
                  }
                }
                if (wrote) z_range.push(flipped ? merged_derivedImages.length - i - 1 : i);
              }
            } else if (new_arrayBuffer) {
              for (let i = 0; i < merged_derivedImages.length; i++) {
                const sd = (merged_derivedImages[i].voxelManager as csTypes.IVoxelManager<number>).getScalarData();
                const sliceData = new_arrayBuffer.subarray(i * sd.length, (i + 1) * sd.length);
                if (sliceData.some(v => v === 1)){
                  for (let j = 0; j < sd.length; j++) { if (sliceData[j] === 1) sd[j] = segmentNumber; }
                  z_range.push(flipped ? merged_derivedImages.length - i - 1 : i);
                }
              }
            }

            if(flipped){
              merged_derivedImages.reverse();
            }
          }

        }
          
                    
          const derivedImageIds = merged_derivedImages.map(image => image.imageId);
          segments[segmentNumber] = {
            segmentIndex: segmentNumber,
            label: label_name,
            locked: false,
            cachedStats: {
              modifiedTime: utils.formatDate(Date.now(), 'YYYYMMDD'),
              algorithmType: currentDisplaySets.SeriesInstanceUID,
              algorithmName: "nninter_"+nninter_elapsed,
              description: prompt_info,
              center:  z_range.length > 0 ? z_range.reduce((sum, z) => sum + z, 0) / z_range.length : 0,
              // z-range kept for fallback; dirtySlices is the fast-path clear target
              segZ0: _hasCropGeom ? _segZ0 : 0,
              segZ1: _hasCropGeom ? _segZ1 : (merged_derivedImages?.length ?? 0),
              // XY bbox of this mask — lets the next in-place refine clear only the affected
              // region instead of full slices.
              cropBox: _hasCropGeom ? { y0: _y0, x0: _x0, cropY: _cropY, cropX: _cropX } : null,
              dirtySlices: z_range,
            }
          };
          // Post-segmentation processing: update representations, handle viewports, trigger events
          await postSegmentationProcessing({
            activeViewportId,
            segmentationId,
            segmentNumber,
            segments,
            derivedImageIds,
            currentDisplaySets,
            imageIds,
            existingSegments,
            existing,
            activeSegmentation,
            currentImageIdIndex,
            z_range,
            mprInPlaceDone: _mprInPlaceDone,
            blockSegments: _nextBlockSegments,
          });
          // Evict the orphaned old block now that the representation swap + volume rebuild are
          // done and nothing references these imageIds. Caps the ~84MB/refine cache growth that
          // was inflating the MPR remount and causing GC-pause spikes across the other legs.
          for (const _oid of _orphanedImageIds) {
            try { cache.removeImageLoadObject(_oid, { force: true }); } catch { /* already gone */ }
          }
          return response;
        }
      } catch (error) {
        console.error('Nninter segmentation error:', error);
        throw error;
      } finally {
        finishInferenceRun();
      }
    },

    async textPromptSegmentation() {
      if (toolboxState.getLocked()) {
        return;
      }

      const { uiDialogService } = servicesManager.services;

      try {
        // Open dialog to get text input
        const textInput = await callInputDialog({
          uiDialogService,
          defaultValue: '',
          title: 'Text Prompt Segmentation (VoxTell)',
          placeholder: 'Enter text prompt for segmentation',
          submitOnEnter: true,
        });

        // If user cancelled or entered empty text, return early
        if (!textInput || textInput.trim() === '') {
          return;
        }

        // Temporarily override refineNew with textPromptReplaceNew for this operation
        const originalRefineNew = toolboxState.getRefineNew();
        const textPromptReplaceNew = toolboxState.getTextPromptReplaceNew();
        toolboxState.setRefineNew(textPromptReplaceNew);

        try {
          // Call nninter with the text prompt
          // Reference actions.nninter - this works because the function executes
          // after the actions object is fully created
          return await actions.nninter(textInput.trim());
        } finally {
          // Restore original refineNew state
          toolboxState.setRefineNew(originalRefineNew);
        }
      } catch (error) {
        // User cancelled the dialog - callInputDialog may throw or return empty string
        console.error('Text prompt segmentation error:', error);
        return;
      }
    },
    async testVlm(options?: {
      vlmProvider?: VlmProviderId;
      instruction?: string;
      query?: string;
      startSlice?: number | null;
      endSlice?: number | null;
      medgemmaVariant?: MedgemmaVariantId;
      medgemmaThinkingEnabled?: boolean;
      geminiModel?: string;
      geminiThinkingLevel?: '' | 'low' | 'medium' | 'high';
      openaiModel?: string;
      openaiReasoningEffort?: string;
      claudeModel?: string;
      claudeThinkingEffort?: '' | 'low' | 'medium' | 'high' | 'max';
      kimiModel?: string;
      kimiReasoningEnabled?: boolean;
      qwenModel?: string;
      qwenThinkingEnabled?: boolean;
      gemmaModel?: string;
      gemmaThinkingEnabled?: boolean;
      vllmBaseUrl?: string;
      vllmFamily?: VllmFamilyId;
      vllmThinkingLevel?: VllmThinkingLevel;
    }) {
      const vlm: VlmProviderId = options?.vlmProvider ?? toolboxState.getVlmProvider();
      const instruction = options?.instruction;
      const query = options?.query;
      const startSlice = options?.startSlice;
      const endSlice = options?.endSlice;
      const geminiModel = options?.geminiModel ?? toolboxState.getGeminiModel();
      const geminiThinkingLevel =
        options?.geminiThinkingLevel ?? toolboxState.getGeminiThinkingLevel();
      const openaiModel = options?.openaiModel ?? toolboxState.getOpenaiModel();
      const openaiReasoningEffort =
        options?.openaiReasoningEffort ?? toolboxState.getOpenaiReasoningEffort();
      const claudeModel = options?.claudeModel ?? toolboxState.getClaudeModel();
      const claudeThinkingEffort =
        options?.claudeThinkingEffort ?? toolboxState.getClaudeThinkingEffort();
      const kimiModel = options?.kimiModel ?? toolboxState.getKimiModel();
      const kimiReasoningEnabled =
        options?.kimiReasoningEnabled ?? toolboxState.getKimiReasoningEnabled();
      const qwenModel = options?.qwenModel ?? toolboxState.getQwenModel();
      const qwenThinkingEnabled =
        options?.qwenThinkingEnabled ?? toolboxState.getQwenThinkingEnabled();
      const gemmaModel = options?.gemmaModel ?? toolboxState.getGemmaModel();
      const gemmaThinkingEnabled =
        options?.gemmaThinkingEnabled ?? toolboxState.getGemmaThinkingEnabled();
      const vllmBaseUrl = options?.vllmBaseUrl ?? toolboxState.getVllmBaseUrl();
      const vllmFamily = options?.vllmFamily ?? toolboxState.getVllmFamily();
      const vllmThinkingLevel =
        options?.vllmThinkingLevel ?? toolboxState.getVllmThinkingLevel();
      const medgemmaVariant =
        options?.medgemmaVariant ?? toolboxState.getMedgemmaVariant();
      const medgemmaThinkingEnabled =
        options?.medgemmaThinkingEnabled ?? toolboxState.getMedgemmaThinkingEnabled();
      const { uiDialogService } = servicesManager.services;

      const queryDialogTitles: Record<VlmProviderId, string> = {
        medGemma: 'MedGemma — Query',
        gemini: 'Gemini — Query',
        openai: 'OpenAI — Query',
        claude: 'Claude — Query',
        kimi: 'Kimi — Query',
        qwen: 'Qwen — Query',
        gemma: 'Gemma 4 — Query',
        vllm: 'vLLM — Query',
      };
      const queryDialogTitle = queryDialogTitles[vlm];

      try {
        let instructionText = instruction;
        if (!instructionText?.trim()) {
          instructionText =
            'You are an instructor teaching medical students. You are analyzing the following CT slices. Please review the slices provided below carefully.';
        }
        toolboxState.setMedgemmaInstruction(instructionText.trim());

        let queryText = query;
        if (!queryText) {
          queryText = await callInputDialog({
            uiDialogService,
            defaultValue: toolboxState.getMedgemmaQuery() || '',
            title: queryDialogTitle,
            placeholder: 'Enter your query/question',
            submitOnEnter: true,
          });

          if (!queryText || queryText.trim() === '') {
            return;
          }
          toolboxState.setMedgemmaQuery(queryText.trim());
        }

        if (startSlice !== undefined) {
          toolboxState.setMedgemmaStartSlice(startSlice);
        }
        if (endSlice !== undefined) {
          toolboxState.setMedgemmaEndSlice(endSlice);
        }

        toolboxState.setMedgemmaResult(null);

        let response;
        if (vlm === 'gemini') {
          response = await actions.gemini(
            queryText.trim(),
            instructionText.trim(),
            startSlice ?? undefined,
            endSlice ?? undefined,
            geminiModel,
            geminiThinkingLevel
          );
        } else if (vlm === 'openai') {
          response = await actions.openai(
            queryText.trim(),
            instructionText.trim(),
            startSlice ?? undefined,
            endSlice ?? undefined,
            openaiModel,
            openaiReasoningEffort
          );
        } else if (vlm === 'claude') {
          response = await actions.claude(
            queryText.trim(),
            instructionText.trim(),
            startSlice ?? undefined,
            endSlice ?? undefined,
            claudeModel,
            claudeThinkingEffort
          );
        } else if (vlm === 'kimi') {
          response = await actions.kimi(
            queryText.trim(),
            instructionText.trim(),
            startSlice ?? undefined,
            endSlice ?? undefined,
            kimiModel,
            kimiReasoningEnabled
          );
        } else if (vlm === 'qwen') {
          response = await actions.qwen(
            queryText.trim(),
            instructionText.trim(),
            startSlice ?? undefined,
            endSlice ?? undefined,
            qwenModel,
            qwenThinkingEnabled
          );
        } else if (vlm === 'gemma') {
          response = await actions.gemma(
            queryText.trim(),
            instructionText.trim(),
            startSlice ?? undefined,
            endSlice ?? undefined,
            gemmaModel,
            gemmaThinkingEnabled
          );
        } else if (vlm === 'vllm') {
          response = await actions.vllm(
            queryText.trim(),
            instructionText.trim(),
            startSlice ?? undefined,
            endSlice ?? undefined,
            vllmBaseUrl,
            vllmFamily,
            vllmThinkingLevel
          );
        } else {
          response = await actions.medGemma(
            queryText.trim(),
            instructionText.trim(),
            startSlice ?? undefined,
            endSlice ?? undefined,
            medgemmaVariant,
            medgemmaThinkingEnabled
          );
        }

        let responseText = '';
        if (response && response.data) {
          responseText = typeof response.data === 'string' ? response.data : String(response.data);
          toolboxState.setMedgemmaResult(responseText);
        } else {
          toolboxState.setMedgemmaResult('No response received');
        }
      } catch (error) {
        console.error('VLM request error:', error);
        toolboxState.setMedgemmaResult(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
        return;
      }
    },
    async testMedgemma(options?: { instruction?: string; query?: string; startSlice?: number | null; endSlice?: number | null }) {
      return actions.testVlm({ ...options, vlmProvider: 'medGemma' });
    },
    async testGemini(options?: {
      instruction?: string;
      query?: string;
      startSlice?: number | null;
      endSlice?: number | null;
      geminiModel?: string;
      geminiThinkingLevel?: '' | 'low' | 'medium' | 'high';
    }) {
      return actions.testVlm({ ...options, vlmProvider: 'gemini' });
    },
    jumpToSegment: () => {
      const activeViewportId = viewportGridService.getState().activeViewportId;
      const segmentationService = servicesManager.services.segmentationService;
      const activeSegmentation = segmentationService.getActiveSegmentation(activeViewportId);
      if (activeSegmentation != undefined) {
        segmentationService.jumpToSegmentCenter(activeSegmentation.segmentationId, 1, activeViewportId)
      }
    },
    toggleCurrentSegment: () => {
      const activeViewportId = viewportGridService.getState().activeViewportId;
      const segmentationService = servicesManager.services.segmentationService;
      const activeSegmentation = segmentationService.getActiveSegmentation(activeViewportId);
      if (activeSegmentation != undefined) {
        segmentationService.toggleSegmentationRepresentationVisibility(activeViewportId, {
          segmentationId: activeSegmentation.segmentationId,
          type: csToolsEnums.SegmentationRepresentations.Labelmap
        });
      }
    },

    /**
     * Toggle viewport overlay (the information panel shown on the four corners
     * of the viewport)
     * @see ViewportOverlay and CustomizableViewportOverlay components
     */
    toggleOverlays: () => {
      const overlays = document.getElementsByClassName('viewport-overlay');
      for (let i = 0; i < overlays.length; i++) {
        overlays.item(i).classList.toggle('hidden');
      }
    },

    scrollActiveThumbnailIntoView: () => {
      const { activeViewportId, viewports } = viewportGridService.getState();

      const activeViewport = viewports.get(activeViewportId);
      const activeDisplaySetInstanceUID = activeViewport.displaySetInstanceUIDs[0];

      const thumbnailList = document.querySelector('#ohif-thumbnail-list');

      if (!thumbnailList) {
        return;
      }

      const thumbnailListBounds = thumbnailList.getBoundingClientRect();

      const thumbnail = document.querySelector(`#thumbnail-${activeDisplaySetInstanceUID}`);

      if (!thumbnail) {
        return;
      }

      const thumbnailBounds = thumbnail.getBoundingClientRect();

      // This only handles a vertical thumbnail list.
      if (
        thumbnailBounds.top >= thumbnailListBounds.top &&
        thumbnailBounds.top <= thumbnailListBounds.bottom
      ) {
        return;
      }

      thumbnail.scrollIntoView({ behavior: 'smooth' });
    },

    updateViewportDisplaySet: ({
      direction,
      excludeNonImageModalities,
    }: UpdateViewportDisplaySetParams) => {
      const nonImageModalities = ['SR', 'SEG', 'SM', 'RTSTRUCT', 'RTPLAN', 'RTDOSE'];

      const currentDisplaySets = [...displaySetService.activeDisplaySets];

      const { activeViewportId, viewports, isHangingProtocolLayout } =
        viewportGridService.getState();

      const { displaySetInstanceUIDs } = viewports.get(activeViewportId);

      const activeDisplaySetIndex = currentDisplaySets.findIndex(displaySet =>
        displaySetInstanceUIDs.includes(displaySet.displaySetInstanceUID)
      );

      let displaySetIndexToShow: number;

      for (
        displaySetIndexToShow = activeDisplaySetIndex + direction;
        displaySetIndexToShow > -1 && displaySetIndexToShow < currentDisplaySets.length;
        displaySetIndexToShow += direction
      ) {
        if (
          !excludeNonImageModalities ||
          !nonImageModalities.includes(currentDisplaySets[displaySetIndexToShow].Modality)
        ) {
          break;
        }
      }

      if (displaySetIndexToShow < 0 || displaySetIndexToShow >= currentDisplaySets.length) {
        return;
      }

      const { displaySetInstanceUID } = currentDisplaySets[displaySetIndexToShow];

      let updatedViewports = [];

      try {
        updatedViewports = hangingProtocolService.getViewportsRequireUpdate(
          activeViewportId,
          displaySetInstanceUID,
          isHangingProtocolLayout
        );
      } catch (error) {
        console.warn(error);
        uiNotificationService.show({
          title: 'Navigate Viewport Display Set',
          message:
            'The requested display sets could not be added to the viewport due to a mismatch in the Hanging Protocol rules.',
          type: 'info',
          duration: 3000,
        });
      }

      commandsManager.run('setDisplaySetsForViewports', { viewportsToUpdate: updatedViewports });

      setTimeout(() => actions.scrollActiveThumbnailIntoView(), 0);
    },
  };

  const definitions = {
    multimonitor: actions.multimonitor,
    promptSaveReport: actions.promptSaveReport,
    loadStudy: actions.loadStudy,
    showContextMenu: actions.showContextMenu,
    closeContextMenu: actions.closeContextMenu,
    clearMeasurements: actions.clearMeasurements,
    displayNotification: actions.displayNotification,
    setHangingProtocol: actions.setHangingProtocol,
    toggleHangingProtocol: actions.toggleHangingProtocol,
    navigateHistory: actions.navigateHistory,
    nextStage: {
      commandFn: actions.deltaStage,
      options: { direction: 1 },
    },
    previousStage: {
      commandFn: actions.deltaStage,
      options: { direction: -1 },
    },
    setViewportGridLayout: actions.setViewportGridLayout,
    toggleOneUp: actions.toggleOneUp,
    openDICOMTagViewer: actions.openDICOMTagViewer,
    setAiToolActive: actions.setAiToolActive,
    runAiSegmentation: actions.runAiSegmentation,
    sam2: actions.sam2,
    initNninter: actions.initNninter,
    undoNninter: actions.undoNninter,
    resetNninter: actions.resetNninter,
    resetSegment: actions.resetSegment,
    releaseSegmentBlock: actions.releaseSegmentBlock,
    materializeSegmentationWrites: {
      commandFn: ({ segmentationId }: { segmentationId?: string } = {}) =>
        materializePendingImageSync(segmentationId),
    },
    medGemma: actions.medGemma,
    gemini: actions.gemini,
    openai: actions.openai,
    claude: actions.claude,
    kimi: actions.kimi,
    qwen: actions.qwen,
    gemma: actions.gemma,
    vllm: actions.vllm,
    nninter: actions.nninter,
    textPromptSegmentation: actions.textPromptSegmentation,
    testVlm: actions.testVlm,
    testMedgemma: actions.testMedgemma,
    testGemini: actions.testGemini,
    jumpToSegment: actions.jumpToSegment,
    toggleCurrentSegment: actions.toggleCurrentSegment,
    updateViewportDisplaySet: actions.updateViewportDisplaySet,
  };

  return {
    actions,
    definitions,
    defaultContext: 'DEFAULT',
  };
};

export default commandsModule;
