import { triggerEvent, eventTarget, Enums, getRenderingEngines, getEnabledElementByViewportId, metaData, utilities as csCoreUtils, } from '@cornerstonejs/core';
import { SegmentationRepresentations, Events as csToolsEvents, } from '../../enums';
import { getSegmentation } from './getSegmentation';
import { getSegmentationRepresentations } from './getSegmentationRepresentation';
import { addTool } from '../../store/addTool';
import { state } from '../../store/state';
import PlanarFreehandContourSegmentationTool from '../../tools/annotation/PlanarFreehandContourSegmentationTool';
import { getToolGroupForViewport } from '../../store/ToolGroupManager';
import { setAnnotationSelected } from '../../stateManagement/annotation/annotationSelection';
import { getAllAnnotations } from '../../stateManagement/annotation/annotationState';
import { addDefaultSegmentationListener } from './segmentationEventManager';
import { getSegmentationRepresentationDisplay } from './SegmentationRepresentationDisplayRegistry';
import { buildPromptLoadPlan, makeWorldFromIndex } from './promptLoadPlan';
const planarContourToolName = PlanarFreehandContourSegmentationTool.toolName;
class SegmentationRenderingEngine {
    constructor() {
        this._needsRender = new Set();
        this._pendingRenderQueue = [];
        this._animationFrameSet = false;
        this._animationFrameHandle = null;
        this._getAllViewports = () => {
            const renderingEngine = getRenderingEngines();
            return renderingEngine.flatMap((renderingEngine) => renderingEngine.getViewports());
        };
        this._renderFlaggedSegmentations = () => {
            this._throwIfDestroyed();
            const viewportIds = Array.from(this._needsRender);
            viewportIds.forEach((viewportId) => {
                this._triggerRender(viewportId);
            });
            this._needsRender.clear();
            this._animationFrameSet = false;
            this._animationFrameHandle = null;
            if (this._pendingRenderQueue.length > 0) {
                const nextViewportIds = this._pendingRenderQueue.shift();
                if (nextViewportIds && nextViewportIds.length > 0) {
                    this._setViewportsToBeRenderedNextFrame(nextViewportIds);
                }
            }
        };
    }
    renderSegmentationsForViewport(viewportId) {
        const viewportIds = viewportId
            ? [viewportId]
            : this._getViewportIdsForSegmentation();
        this._setViewportsToBeRenderedNextFrame(viewportIds);
    }
    renderSegmentation(segmentationId) {
        const viewportIds = this._getViewportIdsForSegmentation(segmentationId);
        this._setViewportsToBeRenderedNextFrame(viewportIds);
    }
    _getViewportIdsForSegmentation(segmentationId) {
        const viewports = this._getAllViewports();
        const viewportIds = [];
        for (const viewport of viewports) {
            const viewportId = viewport.id;
            if (segmentationId) {
                const segmentationRepresentations = getSegmentationRepresentations(viewportId, { segmentationId });
                if (segmentationRepresentations?.length > 0) {
                    viewportIds.push(viewportId);
                }
            }
            else {
                const segmentationRepresentations = getSegmentationRepresentations(viewportId);
                if (segmentationRepresentations?.length > 0) {
                    viewportIds.push(viewportId);
                }
            }
        }
        return viewportIds;
    }
    _throwIfDestroyed() {
        if (this.hasBeenDestroyed) {
            throw new Error('this.destroy() has been manually called to free up memory, can not longer use this instance. Instead make a new one.');
        }
    }
    _setViewportsToBeRenderedNextFrame(viewportIds) {
        if (this._animationFrameSet) {
            this._pendingRenderQueue.push(viewportIds);
            return;
        }
        viewportIds.forEach((viewportId) => {
            this._needsRender.add(viewportId);
        });
        this._render();
    }
    _render() {
        if (this._needsRender.size > 0 && this._animationFrameSet === false) {
            this._animationFrameHandle = window.requestAnimationFrame(this._renderFlaggedSegmentations);
            this._animationFrameSet = true;
        }
    }
    _triggerRender(viewportId) {
        const segmentationRepresentations = getSegmentationRepresentations(viewportId);
        if (!segmentationRepresentations?.length) {
            return;
        }
        const { viewport } = getEnabledElementByViewportId(viewportId) || {};
        if (!viewport) {
            return;
        }
        const segmentationRenderList = segmentationRepresentations.map((representation) => {
            if (representation.type === SegmentationRepresentations.Contour) {
                this._addPlanarFreeHandToolIfAbsent(viewport);
            }
            const display = getSegmentationRepresentationDisplay(representation.type);
            const segmentation = getSegmentation(representation.segmentationId);
            const existingRepresentation = segmentation.representationData[representation.type] !== undefined;
            if (!display) {
                console.warn(`No display registered for segmentation representation type ${representation.type}.`);
                return Promise.resolve({
                    segmentationId: representation.segmentationId,
                    type: representation.type,
                });
            }
            return display
                .render(viewport, representation)
                .then(() => {
                if (!existingRepresentation) {
                    addDefaultSegmentationListener(viewport, representation.segmentationId, representation.type);
                }
                return {
                    segmentationId: representation.segmentationId,
                    type: representation.type,
                };
            })
                .catch((error) => {
                console.error(error);
                return {
                    segmentationId: representation.segmentationId,
                    type: representation.type,
                };
            });
        });
        Promise.allSettled(segmentationRenderList).then((results) => {
            const segmentationDetails = results
                .filter((r) => r.status === 'fulfilled')
                .map((r) => r.value);
            function onSegmentationRender(evt) {
                const { element, viewportId } = evt.detail;
                element.removeEventListener(Enums.Events.IMAGE_RENDERED, onSegmentationRender);
                segmentationDetails.forEach((detail) => {
                    const eventDetail = {
                        viewportId,
                        segmentationId: detail.segmentationId,
                        type: detail.type,
                    };
                    triggerEvent(eventTarget, csToolsEvents.SEGMENTATION_RENDERED, {
                        ...eventDetail,
                    });
                });
            }
            const element = viewport.element;
            element.addEventListener(Enums.Events.IMAGE_RENDERED, onSegmentationRender);
            viewport.render();
            repopulatePromptAnnotations(viewport, segmentationDetails[0]?.segmentationId);
        });
    }
    _addPlanarFreeHandToolIfAbsent(viewport) {
        if (!(planarContourToolName in state.tools)) {
            addTool(PlanarFreehandContourSegmentationTool);
        }
        const toolGroup = getToolGroupForViewport(viewport.id);
        if (!toolGroup.hasTool(planarContourToolName)) {
            toolGroup.addTool(planarContourToolName);
            toolGroup.setToolPassive(planarContourToolName);
        }
    }
}
function repopulatePromptAnnotations(viewport, segmentationId) {
    const services = window.services;
    if (!segmentationId || !services?.displaySetService || !services?.measurementService) {
        return;
    }
    const displaySet = services.displaySetService.getDisplaySetByUID(segmentationId);
    const segMetadataData = displaySet?.segMetadata?.data;
    if (!(segMetadataData?.length > 1) ||
        !segMetadataData.some((data) => data?.SegmentDescription !== undefined)) {
        return;
    }
    if (services.measurementService.getMeasurements().length !== 0) {
        return;
    }
    if (getAllAnnotations().some((annotation) => annotation.metadata?.segmentationId === segmentationId &&
        annotation.metadata?.toolLoad === true)) {
        return;
    }
    const referencedDisplaySet = services.displaySetService.getDisplaySetByUID(displaySet.referencedDisplaySetInstanceUID);
    const imageIds = referencedDisplaySet?.imageIds;
    if (!imageIds?.length) {
        return;
    }
    const frameOfReferenceUID = metaData.get('instance', imageIds[0])?.FrameOfReferenceUID;
    if (!frameOfReferenceUID) {
        return;
    }
    const volumeImageIds = typeof viewport.getImageIds === 'function' ? viewport.getImageIds() : undefined;
    const flipped = Boolean(volumeImageIds?.length) && volumeImageIds[0] !== imageIds[0];
    const volumeId = typeof viewport.getVolumeId === 'function' ? viewport.getVolumeId() : undefined;
    const plan = buildPromptLoadPlan(segMetadataData, {
        segmentationId,
        frameOfReferenceUID,
        volumeId,
        imageIds,
        flipped,
        worldFromIndex: makeWorldFromIndex(imageIds, csCoreUtils.imageToWorldCoords),
    });
    if (!plan.length) {
        return;
    }
    const toolGroup = getToolGroupForViewport(viewport.id);
    for (const descriptor of plan) {
        const tool = toolGroup?.getToolInstance(descriptor.toolName);
        if (!tool?._addNewAnnotationFromLoad) {
            continue;
        }
        try {
            const annotation = tool._addNewAnnotationFromLoad(viewport.element, descriptor);
            setAnnotationSelected(annotation.annotationUID);
        }
        catch (error) {
            console.warn(`Failed to repopulate ${descriptor.toolName} prompt for segment ${descriptor.SegmentNumber}:`, error);
        }
    }
}
function triggerSegmentationRender(viewportId) {
    segmentationRenderingEngine.renderSegmentationsForViewport(viewportId);
}
function triggerSegmentationRenderBySegmentationId(segmentationId) {
    segmentationRenderingEngine.renderSegmentation(segmentationId);
}
const segmentationRenderingEngine = new SegmentationRenderingEngine();
export { triggerSegmentationRender, triggerSegmentationRenderBySegmentationId, segmentationRenderingEngine, };
