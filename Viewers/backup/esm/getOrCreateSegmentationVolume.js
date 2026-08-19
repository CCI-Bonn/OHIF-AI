import { cache, volumeLoader, utilities, ImageVolume, } from '@cornerstonejs/core';
import { getSegmentation } from '../../stateManagement/segmentation/getSegmentation';
// PROJECT OVERRIDE. Upstream keys this volume by a CONTENT HASH of the labelmap imageIds
// (cache.generateVolumeId) and never evicts the volume it supersedes.
//
// That is harmless when a segmentation's labelmap images are stable. In this project every
// nnInteractive/SAM2 refine allocates NEW derived labelmap images for the block, so the hash
// changes on each refine, a fresh volume is cached under the new key, and the previous one is
// orphaned in the cache forever. Measured: one 160-slice block leaked 40MB per refine
// (1 volume/40MB -> 4 volumes/160MB after a handful of refines), unbounded.
//
// It is not enough to rely on representationData.Labelmap.volumeId as upstream's fast path:
// remountSegmentationRepresentations deliberately deletes that key when purging stale MPR
// volumes, so this function takes the hash path essentially every time.
//
// Fix: remember the hash-keyed volume last created for each segmentation and evict it when a
// new key supersedes it. The eviction is guarded — the old volume is dropped only when NONE of
// its images are still referenced by the segmentation's current labelmap, so a volume that is
// still live is never pulled out from under a consumer.
const lastHashKeyedVolumeIdBySegmentationId = new Map();
function evictSupersededHashKeyedVolume(segmentationId, nextVolumeId, currentLabelmapImageIds) {
    const previousVolumeId = lastHashKeyedVolumeIdBySegmentationId.get(segmentationId);
    lastHashKeyedVolumeIdBySegmentationId.set(segmentationId, nextVolumeId);
    if (!previousVolumeId || previousVolumeId === nextVolumeId) {
        return;
    }
    const previousVolume = cache.getVolume(previousVolumeId);
    if (!previousVolume) {
        return;
    }
    const currentImageIdSet = new Set(currentLabelmapImageIds ?? []);
    const stillReferenced = (previousVolume.imageIds ?? []).some((imageId) => currentImageIdSet.has(imageId));
    if (stillReferenced) {
        return;
    }
    cache.removeVolumeLoadObject(previousVolumeId);
}
function getOrCreateSegmentationVolume(segmentationId) {
    const { representationData } = getSegmentation(segmentationId);
    if (!representationData.Labelmap) {
        return;
    }
    let { volumeId } = representationData.Labelmap;
    let segVolume;
    if (volumeId) {
        segVolume = cache.getVolume(volumeId);
        if (segVolume) {
            return segVolume;
        }
    }
    const { imageIds: labelmapImageIds } = representationData.Labelmap;
    volumeId = cache.generateVolumeId(labelmapImageIds);
    if (!labelmapImageIds || labelmapImageIds.length === 0) {
        return;
    }
    const isValidVolume = utilities.isValidVolume(labelmapImageIds);
    if (!isValidVolume) {
        return;
    }
    // Reuse before allocating: an unchanged block hashes to the same key, and re-creating the
    // volume would discard a valid 40MB allocation for an identical one.
    segVolume = cache.getVolume(volumeId);
    if (segVolume) {
        lastHashKeyedVolumeIdBySegmentationId.set(segmentationId, volumeId);
        return segVolume;
    }
    evictSupersededHashKeyedVolume(segmentationId, volumeId, labelmapImageIds);
    segVolume = volumeLoader.createAndCacheVolumeFromImagesSync(volumeId, labelmapImageIds);
    return segVolume;
}
export default getOrCreateSegmentationVolume;
