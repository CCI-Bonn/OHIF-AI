import { getEnabledElement } from '@cornerstonejs/core';
import { getSegmentation } from '../../../stateManagement/segmentation/getSegmentation';
import { resolveLabelmapRenderPlan, } from './labelmapRenderPlan';
async function addLabelmapToElement(element, labelMapData, segmentationId, config) {
    const enabledElement = getEnabledElement(element);
    const { viewport } = enabledElement;
    const segmentation = getSegmentation(segmentationId);
    if (!segmentation) {
        return;
    }
    const renderPlan = resolveLabelmapRenderPlan({
        viewport,
        segmentation,
        representation: {
            segmentationId,
            config,
        },
    });
    return renderPlan.mount({ labelMapData });
}
export default addLabelmapToElement;
