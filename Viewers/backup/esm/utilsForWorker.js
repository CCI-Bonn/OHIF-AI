import { cache, utilities, eventTarget, Enums, triggerEvent, metaData, } from '@cornerstonejs/core';
import { getActiveSegmentIndex } from '../../stateManagement/segmentation/getActiveSegmentIndex';
import { getSegmentation } from '../../stateManagement/segmentation/getSegmentation';
import { getStrategyData } from '../../tools/segmentation/strategies/utils/getStrategyData';
import ensureSegmentationVolume from '../../tools/segmentation/strategies/compositions/ensureSegmentationVolume';
import ensureImageVolume from '../../tools/segmentation/strategies/compositions/ensureImageVolume';
export const triggerWorkerProgress = (workerType, progress) => {
    triggerEvent(eventTarget, Enums.Events.WEB_WORKER_PROGRESS, {
        progress,
        type: workerType,
    });
};
function getScalarData(image) {
    if (!image) {
        return undefined;
    }
    return image.getPixelData?.() ?? image.voxelManager?.getScalarData?.();
}
function resolveSegImageIds(Labelmap, segmentIndices) {
    const primaryImageIds = Labelmap.imageIds;
    const allImageIds = Labelmap.allImageIds ?? primaryImageIds;
    const isMultiBlock = Array.isArray(allImageIds) &&
        Array.isArray(primaryImageIds) &&
        allImageIds.length > primaryImageIds.length &&
        Labelmap.labelmaps &&
        Labelmap.segmentBindings;
    if (!isMultiBlock) {
        return allImageIds;
    }
    const indices = Array.isArray(segmentIndices)
        ? segmentIndices
        : segmentIndices != null
            ? [segmentIndices]
            : [];
    const ids = [];
    for (const segIdx of indices) {
        const binding = Labelmap.segmentBindings[segIdx];
        if (!binding?.labelmapId) {
            continue;
        }
        const layer = Labelmap.labelmaps[binding.labelmapId];
        if (layer?.imageIds?.length) {
            ids.push(...layer.imageIds);
        }
    }
    return ids.length ? ids : allImageIds;
}
export const getSegmentationDataForWorker = (segmentationId, segmentIndices) => {
    const segmentation = getSegmentation(segmentationId);
    if (!segmentation?.representationData) {
        console.debug('getSegmentationDataForWorker: segmentation missing or not ready', segmentationId);
        return null;
    }
    const { representationData } = segmentation;
    const { Labelmap } = representationData;
    if (!Labelmap) {
        console.debug('No labelmap found for segmentation', segmentationId);
        return null;
    }
    const segVolumeId = Labelmap.volumeId;
    const primaryImageIds = Labelmap.imageIds;
    let indices = segmentIndices;
    if (!indices) {
        indices = [getActiveSegmentIndex(segmentationId)];
    }
    else if (!Array.isArray(indices)) {
        indices = [indices, 255];
    }
    const segImageIds = resolveSegImageIds(Labelmap, indices);
    const isMultiBlock = Array.isArray(segImageIds) &&
        Array.isArray(primaryImageIds) &&
        segImageIds.length > primaryImageIds.length;
    const operationData = {
        segmentationId,
        volumeId: isMultiBlock ? undefined : segVolumeId,
        imageIds: segImageIds,
    };
    let reconstructableVolume = Boolean(segVolumeId) && !isMultiBlock;
    if (!reconstructableVolume && segImageIds?.length) {
        const refImageIds = segImageIds
            .map((imageId) => cache.getImage(imageId)?.referencedImageId)
            .filter(Boolean);
        reconstructableVolume =
            !isMultiBlock && refImageIds.length === segImageIds.length && utilities.isValidVolume(refImageIds);
    }
    return {
        operationData,
        segVolumeId: isMultiBlock ? undefined : segVolumeId,
        segImageIds,
        reconstructableVolume,
        indices,
    };
};
export const prepareVolumeStrategyDataForWorker = (operationData) => {
    return getStrategyData({
        operationData,
        strategy: {
            ensureSegmentationVolumeFor3DManipulation: ensureSegmentationVolume.ensureSegmentationVolumeFor3DManipulation,
            ensureImageVolumeFor3DManipulation: ensureImageVolume.ensureImageVolumeFor3DManipulation,
        },
    });
};
export const prepareImageInfo = (imageVoxelManager, imageData) => {
    const imageScalarData = imageVoxelManager.getCompleteScalarDataArray();
    return {
        scalarData: imageScalarData,
        dimensions: imageData.getDimensions(),
        spacing: imageData.getSpacing(),
        origin: imageData.getOrigin(),
        direction: imageData.getDirection(),
    };
};
// getImageDataMetadata() returns zSpacing = EPSILON (1e-3) for a 2D stack image — it
// has no inherent slice spacing. Using that as spacing[2] makes stack-path volume
// (count × sx × sy × sz) ~1000x too small vs the reconstructed-volume path. Recover the
// real inter-slice spacing from the referenced source slices' imagePositionPatient
// (distance between the first two slices), with metadata fallbacks.
const computeStackSliceSpacing = (segImageIds) => {
    const ippFor = (segImageId) => {
        const refImageId = cache.getImage(segImageId)?.referencedImageId;
        if (!refImageId) {
            return null;
        }
        const plane = metaData.get('imagePlaneModule', refImageId);
        return plane?.imagePositionPatient ?? null;
    };
    if (Array.isArray(segImageIds) && segImageIds.length >= 2) {
        const p0 = ippFor(segImageIds[0]);
        const p1 = ippFor(segImageIds[1]);
        if (p0 && p1) {
            const dx = p1[0] - p0[0];
            const dy = p1[1] - p0[1];
            const dz = p1[2] - p0[2];
            const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (dist > 1e-3) {
                return dist;
            }
        }
    }
    // Fallbacks: explicit spacing-between-slices, then slice thickness.
    const refImageId = cache.getImage(segImageIds?.[0])?.referencedImageId;
    const plane = refImageId ? metaData.get('imagePlaneModule', refImageId) : null;
    return plane?.spacingBetweenSlices || plane?.sliceThickness || null;
};

export const prepareStackDataForWorker = (segImageIds) => {
    const segmentationInfo = [];
    const imageInfo = [];
    const includedSegImageIds = [];
    let skipped = 0;
    for (let idx = 0; idx < segImageIds.length; idx++) {
        const segImageId = segImageIds[idx];
        const segImage = cache.getImage(segImageId);
        if (!segImage) {
            console.warn(`[prepareStack] idx=${idx}: segImage not in cache for ${segImageId}`);
            skipped++;
            continue;
        }
        const refImageId = segImage.referencedImageId;
        if (!refImageId) {
            console.warn(`[prepareStack] idx=${idx}: no referencedImageId on segImage ${segImageId}`);
            skipped++;
            continue;
        }
        const refImage = cache.getImage(refImageId);
        if (!refImage) {
            console.warn(`[prepareStack] idx=${idx}: refImage not in cache for ${refImageId}`);
            skipped++;
            continue;
        }
        const segPixelData = getScalarData(segImage);
        const refPixelData = getScalarData(refImage);
        if (!segPixelData || !refPixelData) {
            console.warn(`[prepareStack] idx=${idx}: missing pixel data`);
            skipped++;
            continue;
        }
        const { origin, direction, spacing, dimensions } = utilities.getImageDataMetadata(segImage);
        const refVoxelManager = refImage.voxelManager;
        segmentationInfo.push({
            scalarData: segPixelData,
            dimensions,
            spacing,
            origin,
            direction,
        });
        imageInfo.push({
            scalarData: refPixelData,
            dimensions: refVoxelManager
                ? refVoxelManager.dimensions
                : [refImage.columns, refImage.rows, 1],
            spacing: [refImage.rowPixelSpacing, refImage.columnPixelSpacing],
        });
        includedSegImageIds.push(segImageId);
    }
    if (skipped > 0) {
        console.warn(`[prepareStack] SKIPPED ${skipped}/${segImageIds.length} slices — sliceIndex will be misaligned without includedSegImageIds!`);
    }
    // Replace the EPSILON z-spacing with the real inter-slice spacing so stack-path
    // volume matches the reconstructed-volume path. The worker computes the block volume
    // from segmentationInfo[0].spacing, so overriding every slice's spacing[2] is enough.
    const realZ = computeStackSliceSpacing(includedSegImageIds);
    if (realZ && realZ > 0) {
        for (const info of segmentationInfo) {
            info.spacing = [info.spacing[0], info.spacing[1], realZ];
        }
    } else {
        console.warn('[prepareStack] could not determine real slice spacing — volume may be inaccurate');
    }
    return { segmentationInfo, imageInfo, includedSegImageIds };
};
export function getMultiBlockSegmentStatsInput(Labelmap, segmentIndex) {
    const binding = Labelmap?.segmentBindings?.[segmentIndex];
    if (!binding?.labelmapId) {
        return null;
    }
    const layer = Labelmap.labelmaps?.[binding.labelmapId];
    if (!layer?.imageIds?.length) {
        return null;
    }
    // By construction of the multi-block scheme, each block stores its own segment's
    // value (= segmentIndex, and === binding.labelValue). So the pixel value is
    // deterministic and we can EARLY-EXIT the scan as soon as we see the preferred
    // value, instead of scanning every pixel of all ~321 block slices (~84M reads on
    // the main thread) just to build a full foreground Set. Only when the preferred
    // value is genuinely absent do we fall back to the previous first-foreground logic.
    const preferred = Number.isFinite(segmentIndex) ? segmentIndex : null;
    const foregroundValues = new Set();
    let foundPreferred = false;
    for (const imageId of layer.imageIds) {
        const data = getScalarData(cache.getImage(imageId));
        if (!data) {
            continue;
        }
        for (let i = 0; i < data.length; i++) {
            const v = data[i];
            if (v > 0) {
                if (v === preferred) {
                    foundPreferred = true;
                    break;
                }
                foregroundValues.add(v);
            }
        }
        if (foundPreferred) {
            break;
        }
    }
    let pixelIndex = preferred;
    if (!foundPreferred) {
        if (binding.labelValue != null && foregroundValues.has(binding.labelValue)) {
            pixelIndex = binding.labelValue;
        }
        else if (foregroundValues.has(1)) {
            pixelIndex = 1;
        }
        else if (foregroundValues.size > 0) {
            pixelIndex = Array.from(foregroundValues)[0];
        }
    }
    return {
        segImageIds: layer.imageIds,
        pixelIndex,
        resultKey: segmentIndex,
    };
}
export function isMultiBlockLabelmap(Labelmap) {
    const primaryImageIds = Labelmap?.imageIds;
    const allImageIds = Labelmap?.allImageIds ?? primaryImageIds;
    return Boolean(Labelmap?.labelmaps &&
        Labelmap?.segmentBindings &&
        Array.isArray(allImageIds) &&
        Array.isArray(primaryImageIds) &&
        allImageIds.length > primaryImageIds.length);
}
export const getImageReferenceInfo = (segVolumeId, segImageIds) => {
    let refImageId;
    if (segVolumeId) {
        const segmentationVolume = cache.getVolume(segVolumeId);
        const imageIds = segmentationVolume.imageIds;
        const cachedImage = cache.getImage(imageIds[0]);
        if (cachedImage) {
            refImageId = cachedImage.referencedImageId;
        }
    }
    else if (segImageIds?.length) {
        const segImage = cache.getImage(segImageIds[0]);
        refImageId = segImage?.referencedImageId;
    }
    const refImage = cache.getImage(refImageId);
    const scalingModule = metaData.get('scalingModule', refImageId);
    const modalityUnitOptions = {
        isPreScaled: Boolean(refImage?.preScale?.scaled),
        isSuvScaled: typeof scalingModule?.suvbw === 'number',
    };
    return { refImageId, modalityUnitOptions };
};
