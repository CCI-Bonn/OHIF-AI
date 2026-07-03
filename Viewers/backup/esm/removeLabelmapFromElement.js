import { getEnabledElement } from '@cornerstonejs/core';
import { getLabelmapActorEntries } from '../../../stateManagement/segmentation/helpers/getSegmentationActor';
function removeLabelmapFromElement(element, segmentationId) {
    const enabledElement = getEnabledElement(element);
    const { viewport } = enabledElement;
    const entries = getLabelmapActorEntries(viewport.id, segmentationId) || [];
    const uids = entries.map((entry) => entry.uid).filter(Boolean);
    if (uids.length > 0) {
        viewport.removeActors(uids);
    }
}
export default removeLabelmapFromElement;
