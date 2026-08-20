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
    }
};
// PROJECT OVERRIDE. When a viewport rendering labelmaps through the volume-slice image
// mapper turns oblique (crosshair rotation), canRenderVolumeViewportLabelmapAsImage flips
// false and upstream's CAMERA_MODIFIED branch returned without triggering anything — the
// render-plan switch away from the image mapper then happened only whenever some unrelated
// segmentation event arrived, leaving a stale slice actor on screen until it did. The
// capability-LOSS transition now fires exactly one segmentation render: the tracked state
// key doubles as "was in image-mapper mode", and deleting it before triggering makes later
// oblique camera frames no-ops.
const perViewportManualTriggers = new Map();
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
                triggerSegmentationRender(viewportId);
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
