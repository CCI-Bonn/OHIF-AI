import { utilities, getWebWorkerManager } from '@cornerstonejs/core';
import { triggerWorkerProgress, getSegmentationDataForWorker, prepareVolumeStrategyDataForWorker, prepareStackDataForWorker, getImageReferenceInfo, getMultiBlockSegmentStatsInput, isMultiBlockLabelmap, } from './utilsForWorker';
import { getPixelValueUnitsImageId } from '../getPixelValueUnits';
import { getSegmentation } from '../../stateManagement/segmentation/getSegmentation';
import VolumetricCalculator from './VolumetricCalculator';
import { WorkerTypes } from '../../enums';
import { registerComputeWorker } from '../registerComputeWorker';
const radiusForVol1 = Math.pow((3 * 1000) / (4 * Math.PI), 1 / 3);
async function getStatistics({ segmentationId, segmentIndices, mode = 'collective', }) {
    registerComputeWorker();
    triggerWorkerProgress(WorkerTypes.COMPUTE_STATISTICS, 0);
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
        const finalStats = {};
        for (const segmentIndex of indices) {
            const input = getMultiBlockSegmentStatsInput(Labelmap, segmentIndex);
            if (!input) {
                continue;
            }
            const { refImageId, modalityUnitOptions } = getImageReferenceInfo(undefined, input.segImageIds);
            const unit = getPixelValueUnitsImageId(refImageId, modalityUnitOptions);
            const stackStats = await calculateStackStatistics({
                segImageIds: input.segImageIds,
                indices: [input.pixelIndex],
                unit,
                mode: 'individual',
            });
            const stat = stackStats?.[input.pixelIndex];
            if (stat) {
                finalStats[input.resultKey] = stat;
            }
        }
        triggerWorkerProgress(WorkerTypes.COMPUTE_STATISTICS, 100);
        return Object.keys(finalStats).length ? finalStats : undefined;
    }
    const segData = getSegmentationDataForWorker(segmentationId, segmentIndices);
    if (!segData) {
        return;
    }
    const { operationData, segVolumeId, segImageIds, reconstructableVolume, indices, } = segData;
    const { refImageId, modalityUnitOptions } = getImageReferenceInfo(segVolumeId, segImageIds);
    const unit = getPixelValueUnitsImageId(refImageId, modalityUnitOptions);
    const stats = reconstructableVolume
        ? await calculateVolumeStatistics({
            operationData,
            indices,
            unit,
            mode,
        })
        : await calculateStackStatistics({
            segImageIds,
            indices,
            unit,
            mode,
        });
    return stats;
}
async function calculateVolumeStatistics({ operationData, indices, unit, mode, }) {
    const strategyData = prepareVolumeStrategyDataForWorker(operationData);
    if (!strategyData) {
        return;
    }
    const { segmentationVoxelManager, imageVoxelManager, segmentationImageData, imageData, } = strategyData;
    if (!segmentationVoxelManager || !segmentationImageData) {
        return;
    }
    const spacing = segmentationImageData.getSpacing();
    const { boundsIJK: boundsOrig } = segmentationVoxelManager;
    if (!boundsOrig) {
        return VolumetricCalculator.getStatistics({ spacing });
    }
    const segmentationScalarData = segmentationVoxelManager.getCompleteScalarDataArray();
    const segmentationInfo = {
        scalarData: segmentationScalarData,
        dimensions: segmentationImageData.getDimensions(),
        spacing: segmentationImageData.getSpacing(),
        origin: segmentationImageData.getOrigin(),
        direction: segmentationImageData.getDirection(),
    };
    const imageInfo = {
        scalarData: imageVoxelManager.getCompleteScalarDataArray(),
        dimensions: imageData.getDimensions(),
        spacing: imageData.getSpacing(),
        origin: imageData.getOrigin(),
        direction: imageData.getDirection(),
    };
    if (!imageInfo.scalarData?.length) {
        return;
    }
    const stats = await getWebWorkerManager().executeTask('compute', 'calculateSegmentsStatisticsVolume', {
        segmentationInfo,
        imageInfo,
        indices,
        unit,
        mode,
    });
    triggerWorkerProgress(WorkerTypes.COMPUTE_STATISTICS, 100);
    if (mode === 'collective') {
        return processSegmentationStatistics({
            stats,
            unit,
            spacing,
            segmentationImageData,
            imageVoxelManager,
        });
    }
    else {
        const finalStats = {};
        Object.entries(stats).forEach(([segmentIndex, stat]) => {
            finalStats[segmentIndex] = processSegmentationStatistics({
                stats: stat,
                unit,
                spacing,
                segmentationImageData,
                imageVoxelManager,
            });
        });
        return finalStats;
    }
}
const updateStatsArray = (stats, newStat) => {
    if (!stats.array) {
        return;
    }
    const existingIndex = stats.array.findIndex((stat) => stat.name === newStat.name);
    if (existingIndex !== -1) {
        stats.array[existingIndex] = newStat;
    }
    else {
        stats.array.push(newStat);
    }
};
const processSegmentationStatistics = ({ stats, unit, spacing, segmentationImageData, imageVoxelManager, }) => {
    stats.mean.unit = unit;
    stats.max.unit = unit;
    stats.min.unit = unit;
    if (unit !== 'SUV') {
        return stats;
    }
    const radiusIJK = spacing.map((s) => Math.max(1, Math.round((1.1 * radiusForVol1) / s)));
    for (const testMax of stats.maxIJKs) {
        const testStats = getSphereStats(testMax, radiusIJK, segmentationImageData, imageVoxelManager, spacing);
        if (!testStats) {
            continue;
        }
        const { mean } = testStats;
        if (!stats.peakValue || stats.peakValue.value <= mean.value) {
            stats.peakValue = {
                name: 'peakValue',
                label: 'Peak Value',
                value: mean.value,
                unit,
            };
            stats.peakPoint = {
                name: 'peakLPS',
                label: 'Peak SUV Point',
                value: testMax.pointLPS ? [...testMax.pointLPS] : null,
                unit: null,
            };
            updateStatsArray(stats, stats.peakValue);
            updateStatsArray(stats, stats.peakPoint);
        }
    }
    if (stats.volume && stats.mean) {
        const mtv = stats.volume.value;
        const suvMean = stats.mean.value;
        stats.lesionGlycolysis = {
            name: 'lesionGlycolysis',
            label: 'Lesion Glycolysis',
            value: mtv * suvMean,
            unit: `${stats.volume.unit}·${unit}`,
        };
        updateStatsArray(stats, stats.lesionGlycolysis);
    }
    return stats;
};
async function calculateStackStatistics({ segImageIds, indices, unit, mode }) {
    triggerWorkerProgress(WorkerTypes.COMPUTE_STATISTICS, 0);
    const { segmentationInfo, imageInfo } = prepareStackDataForWorker(segImageIds);
    if (!segmentationInfo.length || !imageInfo.length) {
        triggerWorkerProgress(WorkerTypes.COMPUTE_STATISTICS, 100);
        return mode === 'individual' ? {} : undefined;
    }
    const stats = await getWebWorkerManager().executeTask('compute', 'calculateSegmentsStatisticsStack', {
        segmentationInfo,
        imageInfo,
        indices,
        mode,
    });
    triggerWorkerProgress(WorkerTypes.COMPUTE_STATISTICS, 100);
    const spacing = segmentationInfo[0].spacing;
    const segmentationImageData = segmentationInfo[0];
    const imageVoxelManager = imageInfo[0].voxelManager;
    if (mode === 'collective') {
        return processSegmentationStatistics({
            stats,
            unit,
            spacing,
            segmentationImageData,
            imageVoxelManager,
        });
    }
    else {
        const finalStats = {};
        Object.entries(stats).forEach(([segmentIndex, stat]) => {
            finalStats[segmentIndex] = processSegmentationStatistics({
                stats: stat,
                unit,
                spacing,
                segmentationImageData,
                imageVoxelManager,
            });
        });
        return finalStats;
    }
}
function getSphereStats(testMax, radiusIJK, segData, imageVoxels, spacing) {
    const { pointIJK: centerIJK, pointLPS: centerLPS } = testMax;
    if (!centerIJK) {
        return;
    }
    const boundsIJK = centerIJK.map((ijk, idx) => [
        ijk - radiusIJK[idx],
        ijk + radiusIJK[idx],
    ]);
    const testFunction = (_pointLPS, pointIJK) => {
        const i = (pointIJK[0] - centerIJK[0]) / radiusIJK[0];
        const j = (pointIJK[1] - centerIJK[1]) / radiusIJK[1];
        const k = (pointIJK[2] - centerIJK[2]) / radiusIJK[2];
        const radius = i * i + j * j + k * k;
        return radius <= 1;
    };
    const statsFunction = ({ pointIJK, pointLPS }) => {
        const value = imageVoxels.getAtIJKPoint(pointIJK);
        if (value === undefined) {
            return;
        }
        VolumetricCalculator.statsCallback({ value, pointLPS, pointIJK });
    };
    VolumetricCalculator.statsInit({ storePointData: false });
    utilities.pointInShapeCallback(segData, {
        pointInShapeFn: testFunction,
        callback: statsFunction,
        boundsIJK,
    });
    return VolumetricCalculator.getStatistics({ spacing });
}
export default getStatistics;
