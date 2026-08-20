import { cache, utilities } from '@cornerstonejs/core';
import { getSegmentation } from '../getSegmentation';
import { triggerSegmentationDataModified } from '../triggerSegmentationEvents';
import { createLabelmapMemo } from '../../../utilities/segmentation/createLabelmapMemo';
import { getSegmentBinding, getLabelmapForSegment, removeSegmentBinding, } from './labelmapSegmentationState';
const { DefaultHistoryMemo } = utilities.HistoryMemo;
export function clearSegmentValue(segmentationId, segmentIndex, options) {
    const segmentation = getSegmentation(segmentationId);
    if (segmentation.representationData.Labelmap) {
        const binding = getSegmentBinding(segmentation, segmentIndex);
        const layer = getLabelmapForSegment(segmentation, segmentIndex);
        if (binding && layer) {
            const items = layer.volumeId
                ? [cache.getVolume(layer.volumeId)]
                : (layer.imageIds ?? []).map((imageId) => cache.getImage(imageId));
            items.forEach((item) => {
                if (!item) {
                    return;
                }
                const { voxelManager } = item;
                const memo = options?.recordHistory
                    ? createLabelmapMemo(segmentationId, voxelManager)
                    : null;
                const useVoxelManager = memo?.voxelManager ?? voxelManager;
                voxelManager.forEach(({ value, index }) => {
                    if (value === binding.labelValue) {
                        useVoxelManager.setAtIndex(index, 0);
                    }
                });
                if (memo?.commitMemo()) {
                    DefaultHistoryMemo.push(memo);
                }
            });
            removeSegmentBinding(segmentation, segmentIndex);
        }
        triggerSegmentationDataModified(segmentationId);
    }
    else {
        throw new Error('Invalid segmentation type, only labelmap is supported right now');
    }
}
