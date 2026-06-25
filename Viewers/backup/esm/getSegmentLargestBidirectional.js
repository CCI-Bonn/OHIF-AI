import { cache, getWebWorkerManager } from '@cornerstonejs/core';
import { WorkerTypes } from '../../enums';
import { registerComputeWorker } from '../registerComputeWorker';
import { triggerWorkerProgress, getSegmentationDataForWorker, prepareVolumeStrategyDataForWorker, prepareStackDataForWorker, getMultiBlockSegmentStatsInput, isMultiBlockLabelmap, } from './utilsForWorker';
import { getSegmentation } from '../../stateManagement/segmentation/getSegmentation';
export async function getSegmentLargestBidirectional({ segmentationId, segmentIndices, mode = 'individual', }) {
    registerComputeWorker();
    //triggerWorkerProgress(WorkerTypes.COMPUTE_LARGEST_BIDIRECTIONAL, 0);
    const segmentation = getSegmentation(segmentationId);
    const Labelmap = segmentation?.representationData?.Labelmap;
    if (isMultiBlockLabelmap(Labelmap) && mode === 'individual') {
        let indices = segmentIndices;
        if (!indices) {
            indices = Object.keys(segmentation.segments)
                .map((index) => parseInt(index))
                .filter((index) => index > 0);
        }
        else if (!Array.isArray(indices)) {
            indices = [indices];
        }
        const bidirectionalResults = [];
        for (const segmentIndex of indices) {
            const input = getMultiBlockSegmentStatsInput(Labelmap, segmentIndex);
            if (!input) {
                console.warn(`[bidirectional] seg${segmentIndex}: no multiblock input`);
                continue;
            }
            console.log(`[bidirectional] seg${segmentIndex}: segImageIds.length=${input.segImageIds?.length}, pixelIndex=${input.pixelIndex}`);
            const stackResults = await calculateStackBidirectional({
                segImageIds: input.segImageIds,
                indices: [input.pixelIndex],
                mode: 'individual',
            });
            console.log(`[bidirectional] seg${segmentIndex}: stackResults.length=${stackResults?.length}, sliceIndices=[${stackResults?.map(r=>r?.sliceIndex).join(',')}]`);
            const candidates = stackResults?.filter((result) => result?.segmentIndex === input.pixelIndex);
            const measurement = candidates?.length
                ? candidates.reduce((best, cur) => ((cur.maxMajor ?? 0) > (best.maxMajor ?? 0) ? cur : best))
                : stackResults?.[0];
            console.log(`[bidirectional] seg${segmentIndex}: best sliceIndex=${measurement?.sliceIndex}, maxMajor=${measurement?.maxMajor}`);
            if (measurement) {
                bidirectionalResults.push({
                    ...measurement,
                    segmentIndex: input.resultKey,
                });
            }
        }
        //triggerWorkerProgress(WorkerTypes.COMPUTE_LARGEST_BIDIRECTIONAL, 100);
        const finalResults = bidirectionalResults.map((measurement) => {
            // Use includedSegImageIds (from prepareStackDataForWorker) to correctly map
            // sliceIndex back to the original segImageId, accounting for any skipped slices.
            const effectiveIds = measurement._includedSegImageIds ?? inputSegImageIds(Labelmap, measurement.segmentIndex);
            return attachReferencedImageId(measurement, effectiveIds);
        });
        finalResults.forEach(r => console.log(`[bidirectional] seg${r?.segmentIndex}: referencedImageId=${r?.referencedImageId}`));
        return finalResults;
    }
    const segData = getSegmentationDataForWorker(segmentationId, segmentIndices);
    if (!segData) {
        return;
    }
    const { operationData, segImageIds, reconstructableVolume, indices } = segData;
    const bidirectionalData = reconstructableVolume
        ? await calculateVolumeBidirectional({
            operationData,
            indices,
            mode,
        })
        : await calculateStackBidirectional({
            segImageIds,
            indices,
            mode,
        });
    //triggerWorkerProgress(WorkerTypes.COMPUTE_LARGEST_BIDIRECTIONAL, 100);
    return bidirectionalData.map(measurement => {
        const effectiveIds = measurement._includedSegImageIds ?? segImageIds;
        return attachReferencedImageId(measurement, effectiveIds, operationData);
    });
}
function inputSegImageIds(Labelmap, segmentIndex) {
    const input = getMultiBlockSegmentStatsInput(Labelmap, segmentIndex);
    return input?.segImageIds;
}
function resolveReferencedImageId(segImageIds, sliceIndex, operationData) {
    if (sliceIndex === undefined) {
        return undefined;
    }
    let imageId;
    if (operationData?.segmentationVoxelManager?.getImageIds) {
        imageId = operationData.segmentationVoxelManager.getImageIds()[sliceIndex];
    }
    else if (segImageIds?.length) {
        imageId = segImageIds[sliceIndex];
    }
    if (!imageId) {
        return undefined;
    }
    return cache.getImage(imageId)?.referencedImageId ?? imageId;
}
function attachReferencedImageId(measurement, segImageIds, operationData) {
    const referencedImageId = resolveReferencedImageId(segImageIds, measurement.sliceIndex, operationData);
    return {
        ...measurement,
        referencedImageId,
    };
}
async function calculateVolumeBidirectional({ operationData, indices, mode }) {
    const strategyData = prepareVolumeStrategyDataForWorker(operationData);
    const { segmentationVoxelManager, segmentationImageData } = strategyData;
    const segmentationScalarData = segmentationVoxelManager.getCompleteScalarDataArray();
    const segmentationInfo = {
        scalarData: segmentationScalarData,
        dimensions: segmentationImageData.getDimensions(),
        spacing: segmentationImageData.getSpacing(),
        origin: segmentationImageData.getOrigin(),
        direction: segmentationImageData.getDirection(),
    };
    const bidirectionalData = await getWebWorkerManager().executeTask('compute', 'getSegmentLargestBidirectionalInternal', {
        segmentationInfo,
        indices,
        mode,
    });
    return bidirectionalData;
}
async function calculateStackBidirectional({ segImageIds, indices, mode }) {
    const { segmentationInfo, includedSegImageIds } = prepareStackDataForWorker(segImageIds);
    if (!segmentationInfo.length) {
        return [];
    }
    const bidirectionalData = await getWebWorkerManager().executeTask('compute', 'getSegmentLargestBidirectionalInternal', {
        segmentationInfo,
        indices,
        mode,
        isStack: true,
    });
    // Tag each result with the correctly-aligned imageIds so resolveReferencedImageId
    // maps sliceIndex → the right segImageId even when some slices were skipped.
    const effectiveIds = includedSegImageIds ?? segImageIds;
    return bidirectionalData.map(r => ({ ...r, _includedSegImageIds: effectiveIds }));
}
