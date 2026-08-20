import { BaseVolumeViewport } from '@cornerstonejs/core';
import { getEnabledElement, Enums, getEnabledElementByIds, } from '@cornerstonejs/core';
import { triggerSegmentationRender } from '../../stateManagement/segmentation/SegmentationRenderingEngine';
import { SegmentationRepresentations } from '../../enums';
import getViewportLabelmapRenderMode from '../../stateManagement/segmentation/helpers/getViewportLabelmapRenderMode';
import { canRenderVolumeViewportLabelmapAsImage, getVolumeViewportLabelmapImageMapperState, shouldUseSliceRendering, } from '../../stateManagement/segmentation/helpers/labelmapImageMapperSupport';
import { getSegmentationRepresentations } from '../../stateManagement/segmentation/getSegmentationRepresentation';
import { getSegmentation } from '../../stateManagement/segmentation/getSegmentation';
import { syncStackLabelmapActors } from '../../tools/displayTools/Labelmap/syncStackLabelmapActors';
const enable = function (element) {
    if (!element) {
        return;
    }
    const enabledElement = getEnabledElement(element);
    if (!enabledElement) {
        return;
    }
    const { viewport } = enabledElement;
    const isVolumeViewport = viewport instanceof BaseVolumeViewport;
    const isPlanarViewport = viewport.type === Enums.ViewportType.PLANAR_NEXT;
    const canUseStackImageEvents = typeof viewport
        .getCurrentImageId === 'function';
    if (isVolumeViewport || isPlanarViewport) {
        element.addEventListener(Enums.Events.CAMERA_MODIFIED, _imageChangeEventListener);
    }
    if (isVolumeViewport ||
        !canUseStackImageEvents ||
        getViewportLabelmapRenderMode(viewport) !== 'image') {
        return;
    }
    element.addEventListener(Enums.Events.PRE_STACK_NEW_IMAGE, _imageChangeEventListener);
    element.addEventListener(Enums.Events.IMAGE_RENDERED, _imageChangeEventListener);
};
const disable = function (element) {
    const viewportId = getEnabledElement(element)?.viewport?.id;
    element.removeEventListener(Enums.Events.PRE_STACK_NEW_IMAGE, _imageChangeEventListener);
    element.removeEventListener(Enums.Events.IMAGE_RENDERED, _imageChangeEventListener);
    element.removeEventListener(Enums.Events.CAMERA_MODIFIED, _imageChangeEventListener);
    if (viewportId) {
        perViewportManualTriggers.delete(viewportId);
        cancelCapabilityLossTrigger(viewportId);
    }
};
// PROJECT OVERRIDE. When a viewport rendering labelmaps through the volume-slice image
// mapper turns oblique (crosshair rotation), canRenderVolumeViewportLabelmapAsImage flips
// false and upstream's CAMERA_MODIFIED branch returned without triggering anything — the
// render-plan switch away from the image mapper then happened only whenever some unrelated
// segmentation event arrived, leaving a stale slice actor on screen until it did. The
// capability-LOSS transition now fires exactly one segmentation render. The tracked state
// key doubles as "was in image-mapper mode".
//
// The trigger is DEFERRED until the camera has been quiet for a beat: firing it on the
// first oblique frame remounts legacy volume actors (with a full labelmap texture upload)
// in the middle of the crosshair drag, which visibly disrupted the rotation gesture. Every
// further camera frame while the viewport stays oblique re-arms the timer, so the plan
// switch lands once, just after the drag pauses.
const perViewportManualTriggers = new Map();
const pendingCapabilityLossTimers = new Map();
const CAPABILITY_LOSS_SETTLE_MS = 250;
function armCapabilityLossTrigger(viewportId) {
    const existingTimer = pendingCapabilityLossTimers.get(viewportId);
    if (existingTimer !== undefined) {
        clearTimeout(existingTimer);
    }
    pendingCapabilityLossTimers.set(viewportId, setTimeout(() => {
        pendingCapabilityLossTimers.delete(viewportId);
        triggerSegmentationRender(viewportId);
    }, CAPABILITY_LOSS_SETTLE_MS));
}
function cancelCapabilityLossTrigger(viewportId) {
    const existingTimer = pendingCapabilityLossTimers.get(viewportId);
    if (existingTimer !== undefined) {
        clearTimeout(existingTimer);
        pendingCapabilityLossTimers.delete(viewportId);
    }
}
function _imageChangeEventListener(evt) {
    const eventData = evt.detail;
    const { viewportId, renderingEngineId } = eventData;
    const enabledElement = getEnabledElementByIds(viewportId, renderingEngineId);
    if (!enabledElement) {
        return;
    }
    const { viewport } = enabledElement;
    const isVolumeViewport = viewport instanceof BaseVolumeViewport;
    const representations = getSegmentationRepresentations(viewportId);
    if (!representations?.length) {
        perViewportManualTriggers.delete(viewportId);
        return;
    }
    const labelmapRepresentations = representations.filter((representation) => representation.type === SegmentationRepresentations.Labelmap);
    const hasVolumeImageMapperRepresentation = labelmapRepresentations.some((representation) => {
        const segmentation = getSegmentation(representation.segmentationId);
        return (canRenderVolumeViewportLabelmapAsImage(viewport) &&
            shouldUseSliceRendering(segmentation, representation.config));
    });
    if (evt.type === Enums.Events.CAMERA_MODIFIED) {
        if (hasVolumeImageMapperRepresentation) {
            cancelCapabilityLossTrigger(viewportId);
            const nextState = getVolumeViewportLabelmapImageMapperState(viewport);
            const previousState = perViewportManualTriggers.get(viewportId);
            if (previousState === nextState.key) {
                return;
            }
            perViewportManualTriggers.set(viewportId, nextState.key);
            triggerSegmentationRender(viewportId);
            return;
        }
        const isPlanarNext = viewport.type === Enums.ViewportType.PLANAR_NEXT;
        if (!isPlanarNext) {
            if (perViewportManualTriggers.has(viewportId)) {
                perViewportManualTriggers.delete(viewportId);
                armCapabilityLossTrigger(viewportId);
            }
            else if (pendingCapabilityLossTimers.has(viewportId)) {
                armCapabilityLossTrigger(viewportId);
            }
            return;
        }
    }
    if (getViewportLabelmapRenderMode(viewport) !== 'image') {
        return;
    }
    if (canRenderVolumeViewportLabelmapAsImage(viewport)) {
        return;
    }
    if (typeof viewport
        .getCurrentImageId !== 'function') {
        return;
    }
    const stackViewport = viewport;
    labelmapRepresentations.forEach((representation) => {
        const { segmentationId } = representation;
        syncStackLabelmapActors(stackViewport, segmentationId);
        if (evt.type === Enums.Events.IMAGE_RENDERED) {
            stackViewport.element.removeEventListener(Enums.Events.IMAGE_RENDERED, _imageChangeEventListener);
        }
    });
}
export default {
    enable,
    disable,
};
