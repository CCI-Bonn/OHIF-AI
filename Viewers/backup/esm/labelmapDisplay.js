import { Enums as CoreEnums, eventTarget, getEnabledElementByViewportId, } from '@cornerstonejs/core';
import { getSegmentation } from '../../../stateManagement/segmentation/getSegmentation';
import SegmentationRepresentations from '../../../enums/SegmentationRepresentations';
import { getLabelmapActorEntries } from '../../../stateManagement/segmentation/helpers/getSegmentationActor';
import { getPolySeg } from '../../../config';
import { computeAndAddRepresentation } from '../../../utilities/segmentation/computeAndAddRepresentation';
import { triggerSegmentationDataModified } from '../../../stateManagement/segmentation/triggerSegmentationEvents';
import { defaultSegmentationStateManager } from '../../../stateManagement/segmentation/SegmentationStateManager';
import { removeLabelmapRepresentationFromViewport, resolveLabelmapRenderPlan, } from './labelmapRenderPlan';
import { MAX_NUMBER_COLORS, setLabelmapColorAndOpacity, } from './labelmapActorStyle';
export { MAX_NUMBER_COLORS };
const unsupportedImageMapperStates = new Map();
let polySegConversionInProgress = false;
function removeRepresentation(viewportId, segmentationId, renderImmediate = false) {
    clearUnsupportedImageMapperError(viewportId, segmentationId);
    const enabledElement = getEnabledElementByViewportId(viewportId);
    if (!enabledElement) {
        return;
    }
    const { viewport } = enabledElement;
    removeLabelmapRepresentationFromViewport(viewport, segmentationId);
    if (!renderImmediate) {
        return;
    }
    viewport.render();
}
async function render(viewport, representation) {
    const { segmentationId } = representation;
    const segmentation = getSegmentation(segmentationId);
    if (!segmentation) {
        console.warn('No segmentation found for segmentationId: ', segmentationId);
        return;
    }
    let labelmapData = segmentation.representationData[SegmentationRepresentations.Labelmap];
    let labelmapActorEntries = getLabelmapActorEntries(viewport.id, segmentationId);
    if (!labelmapData &&
        getPolySeg()?.canComputeRequestedRepresentation(segmentationId, SegmentationRepresentations.Labelmap) &&
        !polySegConversionInProgress) {
        polySegConversionInProgress = true;
        const polySeg = getPolySeg();
        labelmapData = await computeAndAddRepresentation(segmentationId, SegmentationRepresentations.Labelmap, () => polySeg.computeLabelmapData(segmentationId, {
            viewport: viewport,
        }), () => {
            defaultSegmentationStateManager.processLabelmapRepresentationAddition(viewport.id, segmentationId);
            setTimeout(() => {
                triggerSegmentationDataModified(segmentationId);
            }, 0);
        });
        if (!labelmapData) {
            throw new Error(`No labelmap data found for segmentationId ${segmentationId}.`);
        }
        polySegConversionInProgress = false;
    }
    else if (!labelmapData && !getPolySeg()) {
        console.debug(`No labelmap data found for segmentationId ${segmentationId} and PolySeg add-on is not configured. Unable to convert from other representations to labelmap. Please register PolySeg using cornerstoneTools.init({ addons: { polySeg } }) to enable automatic conversion.`);
    }
    if (!labelmapData) {
        return;
    }
    const renderPlan = resolveLabelmapRenderPlan({
        viewport,
        segmentation,
        representation,
    });
    if (renderPlan.kind === 'unsupported') {
        if (labelmapActorEntries?.length) {
            renderPlan.remove();
        }
        if (renderPlan.unsupportedStateKey) {
            reportUnsupportedImageMapperError(viewport.id, segmentationId, renderPlan.unsupportedStateKey);
        }
        return;
    }
    clearUnsupportedImageMapperError(viewport.id, segmentationId);
    const beforeCount = labelmapActorEntries?.length ?? 0;
    labelmapActorEntries = await renderPlan.reconcile({
        actorEntries: labelmapActorEntries,
        labelMapData: labelmapData,
    });
    console.log(`[labelmapRender] ${segmentationId} actors: ${beforeCount}→${labelmapActorEntries?.length ?? 0}`);
    if (!labelmapActorEntries?.length) {
        return;
    }
    for (const labelmapActorEntry of labelmapActorEntries) {
        setLabelmapColorAndOpacity(viewport.id, labelmapActorEntry, representation);
    }
}
function getUpdateFunction(_viewport) {
    return;
}
function getUnsupportedImageMapperStateKey(viewportId, segmentationId) {
    return `${viewportId}:${segmentationId}`;
}
function clearUnsupportedImageMapperError(viewportId, segmentationId) {
    unsupportedImageMapperStates.delete(getUnsupportedImageMapperStateKey(viewportId, segmentationId));
}
function reportUnsupportedImageMapperError(viewportId, segmentationId, stateKey) {
    const cacheKey = getUnsupportedImageMapperStateKey(viewportId, segmentationId);
    const previousStateKey = unsupportedImageMapperStates.get(cacheKey);
    if (previousStateKey === stateKey) {
        return;
    }
    unsupportedImageMapperStates.set(cacheKey, stateKey);
    eventTarget.dispatchEvent(new CustomEvent(CoreEnums.Events.ERROR_EVENT, {
        detail: {
            type: 'Segmentation',
            message: 'Labelmap image-mapper rendering is only supported on legacy orthographic single-slice volume viewports.',
        },
        cancelable: true,
    }));
}
export default {
    getUpdateFunction,
    render,
    removeRepresentation,
};
export { render, removeRepresentation };
