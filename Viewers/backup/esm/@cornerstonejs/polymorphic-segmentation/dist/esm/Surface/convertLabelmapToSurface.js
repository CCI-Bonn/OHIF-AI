import { cache, eventTarget, getWebWorkerManager, triggerEvent, Enums, volumeLoader, } from '@cornerstonejs/core';
import * as cornerstoneTools from '@cornerstonejs/tools';
const { WorkerTypes } = cornerstoneTools.Enums;
const { computeVolumeLabelmapFromStack } = cornerstoneTools.utilities.segmentation;
const workerManager = getWebWorkerManager();
// PROJECT OVERRIDE. The 3D (volume3d) viewport shows a segmentation as a SURFACE that polySeg
// extracts from the labelmap. Upstream builds the volume it extracts from out of
// `Labelmap.imageIds` — which, under this project's multi-block scheme, is the PRIMARY block only
// (the legacy adapter reverts `imageIds` to the first layer on every state write). Every other
// segment lives in its own private block, so its surface was always extracted from a volume that
// holds none of its voxels: the worker returned no points, createAndCacheSurfacesFromRaw threw
// "No points found for surface", the whole Surface rebuild rejected, and from the second segment
// on the 3D viewport never updated again — for ANY segment. Each failed attempt also minted a fresh
// uuid volume per segment (computeVolumeLabelmapFromStack) that nothing ever evicted; a short
// session was measured at 143 cached labelmap volumes.
//
// Three changes:
//   1. Resolve the LAYER that holds the segment (segmentBindings, else the layer whose voxels
//      contain the index) and extract from that layer's volume.
//   2. Use the layer's deterministic `<labelmapId>-geometry` volume — the same one MPR rendering
//      uses — instead of a new uuid volume per call. Image-backed, so creating it copies nothing.
//   3. A segment with no voxels (declared but not yet drawn, or reset) yields an EMPTY mesh rather
//      than a rejection, so one empty segment can no longer freeze the 3D view for all the others.
const triggerWorkerProgress = (eventTarget, progress, id) => {
    triggerEvent(eventTarget, Enums.Events.WEB_WORKER_PROGRESS, {
        progress,
        type: WorkerTypes.POLYSEG_LABELMAP_TO_SURFACE,
        id,
    });
};
function emptySurface() {
    return { points: [], polys: [] };
}
function getLayerVolume(layer) {
    const volumeId = layer.volumeId ?? layer.geometryVolumeId ?? `${layer.labelmapId}-geometry`;
    const cached = cache.getVolume(volumeId);
    if (cached) {
        return cached;
    }
    if (!layer.imageIds?.length) {
        return;
    }
    if (!layer.volumeId) {
        // Same bookkeeping tools' own getOrCreateLabelmapVolume does, so removeLabelmap and the
        // project's remount purge find (and evict) this volume by the same key.
        layer.geometryVolumeId = volumeId;
    }
    return volumeLoader.createAndCacheVolumeFromImagesSync(volumeId, layer.imageIds);
}
/**
 * Pick the volume (and its materialised scalar data) that holds `segmentIndex`.
 * Returns undefined when no layer holds the segment.
 */
async function resolveSegmentVolume(labelmapRepresentationData, segmentIndex) {
    // Volume labelmap: single volume holds every segment (upstream behaviour).
    if (labelmapRepresentationData.volumeId) {
        const volume = cache.getVolume(labelmapRepresentationData.volumeId);
        if (!volume) {
            return;
        }
        return { volume, scalarData: volume.voxelManager.getCompleteScalarDataArray() };
    }
    const layers = Object.values(labelmapRepresentationData.labelmaps ?? {});
    if (layers.length) {
        const boundLabelmapId = labelmapRepresentationData.segmentBindings?.[segmentIndex]?.labelmapId;
        const bound = boundLabelmapId
            ? layers.find((layer) => layer.labelmapId === boundLabelmapId)
            : undefined;
        // A bound layer is authoritative. Otherwise (stock single layer, or a multi-layer labelmap
        // without bindings) scan the layers for the one whose voxels actually contain the index.
        const candidates = bound ? [bound] : layers;
        for (const layer of candidates) {
            const volume = getLayerVolume(layer);
            if (!volume) {
                continue;
            }
            const scalarData = volume.voxelManager.getCompleteScalarDataArray();
            if (candidates.length === 1 || scalarData.indexOf(segmentIndex) !== -1) {
                return { volume, scalarData };
            }
        }
        return;
    }
    // Legacy stack labelmap with no layer state at all: upstream path.
    const { imageIds } = labelmapRepresentationData;
    if (!imageIds?.length) {
        return;
    }
    const { volumeId } = await computeVolumeLabelmapFromStack({ imageIds });
    const volume = cache.getVolume(volumeId);
    if (!volume) {
        return;
    }
    return { volume, scalarData: volume.voxelManager.getCompleteScalarDataArray() };
}
export async function convertLabelmapToSurface(labelmapRepresentationData, segmentIndex) {
    const resolved = await resolveSegmentVolume(labelmapRepresentationData, segmentIndex);
    // No layer holds this segment, or it holds no voxels yet: an empty mesh, not a failure. The
    // native indexOf over a Uint8Array is far cheaper than a marching-cubes pass that finds nothing.
    if (!resolved || resolved.scalarData.indexOf(segmentIndex) === -1) {
        return emptySurface();
    }
    const { volume, scalarData } = resolved;
    const { dimensions, spacing, origin, direction } = volume;
    triggerWorkerProgress(eventTarget, 0, segmentIndex);
    const results = await workerManager.executeTask('polySeg', 'convertLabelmapToSurface', {
        scalarData,
        dimensions,
        spacing,
        origin,
        direction,
        segmentIndex,
    }, {
        callbacks: [
            (progress) => {
                triggerWorkerProgress(eventTarget, progress, segmentIndex);
            },
        ],
    });
    triggerWorkerProgress(eventTarget, 100, segmentIndex);
    if (!results?.points) {
        return emptySurface();
    }
    return results;
}
