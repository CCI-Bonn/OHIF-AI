import { cache, getEnabledElementByViewportId, } from '@cornerstonejs/core';
import getViewportLabelmapRenderMode from '../helpers/getViewportLabelmapRenderMode';
import { ensureLabelmapState } from './normalizeLabelmapSegmentationData';
import { getLabelmaps } from './labelmapLayerStore';
import { getLabelmapForSegment } from './labelmapSegmentBindings';
import { getReferencedImageIdToCurrentImageIdMap } from './labelmapLegacyAdapter';
import { getLabelmapImageIdsForReferencedImageId } from './labelmapImageIdMapping';
// PROJECT OVERRIDE. Upstream resolves a layer's labelmap image for the displayed slice by
// matching referencedImageId, then falls back to indexing the layer POSITIONALLY with the
// viewport's slice index. That fallback is only meaningful when the layer covers the series
// 1:1 -- an assumption that held while labelmaps always spanned the whole stack.
//
// This project z-crops labelmap blocks (sparse blocks), so a layer usually holds far fewer
// images than the viewport has slices (e.g. a 160-slice block over a 694-slice series). The
// positional fallback then resolves viewport slices 0..159 to unrelated block images, and
// syncStackLabelmapActors draws them at the CURRENT slice's origin -- rendering a second,
// ghost copy of the segment at the wrong depth. Observed as one segment appearing both at
// its true location (source slices 333-453) and at block-local ones (viewport 13-133).
//
// Every positional index below is guarded with this helper, so the fallback applies only to
// full-stack layers. For a cropped layer, resolution relies solely on the referencedImageId
// match -- correct by construction -- and slices outside the block carry no labelmap.
function layerSpansViewportStack(layer, viewportImageIdCount) {
    return (viewportImageIdCount > 0 &&
        layer?.imageIds?.length === viewportImageIdCount);
}
class LabelmapImageReferenceResolver {
    constructor(getSegmentation) {
        this.stackLabelmapImageIdReferenceMap = new Map();
        this.labelmapImageIdReferenceMap = new Map();
        this.keysBySegmentationId = new Map();
        this.getSegmentation = getSegmentation;
    }
    reset() {
        this.stackLabelmapImageIdReferenceMap.clear();
        this.labelmapImageIdReferenceMap.clear();
        this.keysBySegmentationId.clear();
    }
    removeSegmentation(segmentationId) {
        this.stackLabelmapImageIdReferenceMap.delete(segmentationId);
        const keys = this.keysBySegmentationId.get(segmentationId);
        if (keys) {
            for (const key of keys) {
                this.labelmapImageIdReferenceMap.delete(key);
            }
            this.keysBySegmentationId.delete(segmentationId);
        }
    }
    setLabelmapImageIds(segmentationId, key, labelmapImageIds) {
        this.labelmapImageIdReferenceMap.set(key, labelmapImageIds);
        let keys = this.keysBySegmentationId.get(segmentationId);
        if (!keys) {
            keys = new Set();
            this.keysBySegmentationId.set(segmentationId, keys);
        }
        keys.add(key);
    }
    getLabelmapImageIds(representationData) {
        const labelmapData = representationData.Labelmap;
        let labelmapImageIds;
        if (!labelmapData) {
            return;
        }
        if (labelmapData?.labelmaps) {
            const imageIds = Object.values(labelmapData.labelmaps).flatMap((layer) => {
                if (layer.imageIds?.length) {
                    return layer.imageIds;
                }
                if (layer.volumeId) {
                    return cache.getVolume(layer.volumeId)
                        ?.imageIds;
                }
                return [];
            });
            return Array.from(new Set(imageIds.filter(Boolean)));
        }
        if (labelmapData.imageIds) {
            labelmapImageIds = labelmapData
                .imageIds;
        }
        else if (labelmapData.volumeId) {
            const volumeId = labelmapData
                .volumeId;
            const volume = cache.getVolume(volumeId);
            labelmapImageIds = volume.imageIds;
        }
        return labelmapImageIds;
    }
    getLabelmapImageIdsForImageId(imageId, segmentationId) {
        const segmentation = this.getSegmentation(segmentationId);
        if (!segmentation?.representationData?.Labelmap) {
            return;
        }
        ensureLabelmapState(segmentation);
        return getReferencedImageIdToCurrentImageIdMap(segmentation).get(imageId);
    }
    updateLabelmapSegmentationImageReferences(viewportId, segmentationId) {
        const segmentation = this.getSegmentation(segmentationId);
        if (!segmentation) {
            return;
        }
        if (!this.stackLabelmapImageIdReferenceMap.has(segmentationId)) {
            this.stackLabelmapImageIdReferenceMap.set(segmentationId, new Map());
        }
        const { representationData } = segmentation;
        if (!representationData.Labelmap) {
            return;
        }
        const labelmapImageIds = this.getLabelmapImageIds(representationData);
        const enabledElement = getEnabledElementByViewportId(viewportId);
        if (!enabledElement || !labelmapImageIds?.length) {
            return;
        }
        return this.updateLabelmapSegmentationReferences(segmentationId, enabledElement.viewport, labelmapImageIds);
    }
    getCurrentLabelmapImageIdsForViewport(viewportId, segmentationId) {
        const enabledElement = getEnabledElementByViewportId(viewportId);
        if (!enabledElement) {
            return;
        }
        const { viewport } = enabledElement;
        const viewportRenderMode = getViewportLabelmapRenderMode(viewport);
        if (viewportRenderMode !== 'image' ||
            typeof viewport.getCurrentImageId !== 'function') {
            return;
        }
        const referenceImageId = viewport.getCurrentImageId();
        const segmentation = this.getSegmentation(segmentationId);
        if (!segmentation) {
            return;
        }
        ensureLabelmapState(segmentation);
        const viewportImageIds = viewport.getImageIds();
        const currentIndex = viewportImageIds.indexOf(referenceImageId);
        const labelmapImageIds = [];
        getLabelmaps(segmentation).forEach((layer) => {
            const referencedLabelmapImageIds = getLabelmapImageIdsForReferencedImageId(layer, referenceImageId);
            if (referencedLabelmapImageIds.length) {
                labelmapImageIds.push(...referencedLabelmapImageIds);
                return;
            }
            if (currentIndex !== -1 &&
                layerSpansViewportStack(layer, viewportImageIds.length) &&
                layer.imageIds[currentIndex]) {
                labelmapImageIds.push(layer.imageIds[currentIndex]);
                return;
            }
            layer.imageIds?.some((candidateImageId) => {
                const viewableImageId = viewport.isReferenceViewable({ referencedImageId: candidateImageId }, { asOverlay: true });
                if (viewableImageId) {
                    labelmapImageIds.push(candidateImageId);
                }
                return !!viewableImageId;
            });
        });
        const resolvedImageIds = Array.from(new Set(labelmapImageIds));
        const key = this.generateMapKey({
            segmentationId,
            referenceImageId,
        });
        this.setLabelmapImageIds(segmentationId, key, resolvedImageIds);
        if (!this.stackLabelmapImageIdReferenceMap.has(segmentationId)) {
            this.stackLabelmapImageIdReferenceMap.set(segmentationId, new Map());
        }
        const activeSegmentIndex = Object.keys(segmentation.segments).find((segmentIndex) => segmentation.segments[segmentIndex].active);
        const activeLayer = activeSegmentIndex
            ? getLabelmapForSegment(segmentation, Number(activeSegmentIndex))
            : undefined;
        const activeImageId = layerSpansViewportStack(activeLayer, viewportImageIds.length)
            ? activeLayer.imageIds[currentIndex]
            : undefined;
        this.stackLabelmapImageIdReferenceMap
            .get(segmentationId)
            .set(referenceImageId, activeImageId ?? resolvedImageIds[0]);
        return resolvedImageIds;
    }
    getCurrentLabelmapImageIdForViewport(viewportId, segmentationId) {
        const enabledElement = getEnabledElementByViewportId(viewportId);
        if (!enabledElement) {
            return;
        }
        const { viewport } = enabledElement;
        const viewportRenderMode = getViewportLabelmapRenderMode(viewport);
        if (viewportRenderMode !== 'image' ||
            typeof viewport.getCurrentImageId !== 'function') {
            return;
        }
        const currentImageId = viewport.getCurrentImageId();
        const currentImageIds = this.getCurrentLabelmapImageIdsForViewport(viewportId, segmentationId);
        if (!currentImageIds?.length) {
            return;
        }
        const segmentation = this.getSegmentation(segmentationId);
        const viewportImageIds = viewport.getImageIds();
        const currentIndex = viewportImageIds.indexOf(currentImageId);
        const activeSegmentIndex = segmentation
            ? Object.keys(segmentation.segments).find((segmentIndex) => segmentation.segments[segmentIndex].active)
            : undefined;
        const activeLayer = segmentation && activeSegmentIndex
            ? getLabelmapForSegment(segmentation, Number(activeSegmentIndex))
            : undefined;
        const activeImageId = layerSpansViewportStack(activeLayer, viewportImageIds.length)
            ? activeLayer.imageIds[currentIndex]
            : undefined;
        return activeImageId ?? currentImageIds[0];
    }
    getStackSegmentationImageIdsForViewport(viewportId, segmentationId) {
        const segmentation = this.getSegmentation(segmentationId);
        if (!segmentation) {
            return [];
        }
        this.updateAllLabelmapSegmentationImageReferences(viewportId, segmentationId);
        const enabledElement = getEnabledElementByViewportId(viewportId);
        const imageIds = enabledElement?.viewport.getImageIds?.() ?? [];
        const imageIdMap = getReferencedImageIdToCurrentImageIdMap(segmentation);
        return imageIds.flatMap((imageId) => imageIdMap.get(imageId) ?? []);
    }
    updateLabelmapSegmentationReferences(segmentationId, viewport, labelmapImageIds, updateCallback) {
        const referenceImageId = viewport.getCurrentImageId();
        let viewableLabelmapImageIdFound = false;
        for (const labelmapImageId of labelmapImageIds) {
            const viewableImageId = viewport.isReferenceViewable({ referencedImageId: labelmapImageId }, { asOverlay: true });
            if (viewableImageId) {
                viewableLabelmapImageIdFound = true;
                this.stackLabelmapImageIdReferenceMap
                    .get(segmentationId)
                    .set(referenceImageId, labelmapImageId);
                this.updateLabelmapImageIdReferenceMap({
                    segmentationId,
                    referenceImageId,
                    labelmapImageId,
                });
            }
        }
        updateCallback?.(viewport, segmentationId, labelmapImageIds);
        return viewableLabelmapImageIdFound
            ? this.stackLabelmapImageIdReferenceMap
                .get(segmentationId)
                .get(referenceImageId)
            : undefined;
    }
    updateAllLabelmapSegmentationImageReferences(viewportId, segmentationId) {
        const segmentation = this.getSegmentation(segmentationId);
        if (!segmentation) {
            return;
        }
        if (!this.stackLabelmapImageIdReferenceMap.has(segmentationId)) {
            this.stackLabelmapImageIdReferenceMap.set(segmentationId, new Map());
        }
        const { representationData } = segmentation;
        if (!representationData.Labelmap) {
            return;
        }
        const labelmapImageIds = this.getLabelmapImageIds(representationData);
        const enabledElement = getEnabledElementByViewportId(viewportId);
        if (!enabledElement || !labelmapImageIds?.length) {
            return;
        }
        const stackViewport = enabledElement.viewport;
        this.updateLabelmapSegmentationReferences(segmentationId, stackViewport, labelmapImageIds, (stackViewport, segmentationId, labelmapImageIds) => {
            const imageIds = stackViewport.getImageIds();
            imageIds.forEach((referenceImageId, index) => {
                for (const labelmapImageId of labelmapImageIds) {
                    const viewableImageId = stackViewport.isReferenceViewable({ referencedImageId: labelmapImageId, sliceIndex: index }, { asOverlay: true, withNavigation: true });
                    if (viewableImageId) {
                        this.stackLabelmapImageIdReferenceMap
                            .get(segmentationId)
                            .set(referenceImageId, labelmapImageId);
                        this.updateLabelmapImageIdReferenceMap({
                            segmentationId,
                            referenceImageId,
                            labelmapImageId,
                        });
                    }
                }
            });
        });
    }
    updateLabelmapImageIdReferenceMap({ segmentationId, referenceImageId, labelmapImageId, }) {
        const key = this.generateMapKey({ segmentationId, referenceImageId });
        if (!this.labelmapImageIdReferenceMap.has(key)) {
            this.setLabelmapImageIds(segmentationId, key, [labelmapImageId]);
            return;
        }
        const currentValues = this.labelmapImageIdReferenceMap.get(key) ?? [];
        const newValues = Array.from(new Set([...currentValues, labelmapImageId]));
        this.setLabelmapImageIds(segmentationId, key, newValues);
    }
    generateMapKey({ segmentationId, referenceImageId }) {
        return `${segmentationId}-${referenceImageId}`;
    }
}
export default LabelmapImageReferenceResolver;
