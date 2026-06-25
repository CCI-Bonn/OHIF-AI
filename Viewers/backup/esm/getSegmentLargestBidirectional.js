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
                continue;
            }
            const stackResults = await calculateStackBidirectional({
                segImageIds: input.segImageIds,
                indices: [input.pixelIndex],
                mode: 'individual',
            });
            const candidates = stackResults?.filter((result) => result?.segmentIndex === input.pixelIndex);
            const measurement = candidates?.length
                ? candidates.reduce((best, cur) => ((cur.maxMajor ?? 0) > (best.maxMajor ?? 0) ? cur : best))
                : stackResults?.[0];
            if (measurement) {
                bidirectionalResults.push({
                    ...measurement,
                    segmentIndex: input.resultKey,
                });
            }
        }
        //triggerWorkerProgress(WorkerTypes.COMPUTE_LARGEST_BIDIRECTIONAL, 100);
        return bidirectionalResults.map((measurement) => attachReferencedImageId(measurement, inputSegImageIds(Labelmap, measurement.segmentIndex)));
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
    return bidirectionalData.map(measurement => attachReferencedImageId(measurement, segImageIds, operationData));
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
    const { segmentationInfo } = prepareStackDataForWorker(segImageIds);
    if (!segmentationInfo.length) {
        return [];
    }
    const bidirectionalData = await getWebWorkerManager().executeTask('compute', 'getSegmentLargestBidirectionalInternal', {
        segmentationInfo,
        indices,
        mode,
        isStack: true,
    });
    return bidirectionalData;
}
