import { triggerEvent, eventTarget, Enums, getRenderingEngines, getEnabledElementByViewportId, } from '@cornerstonejs/core';
import { SegmentationRepresentations, Events as csToolsEvents, } from '../../enums';
import { getSegmentation } from './getSegmentation';
import { getSegmentationRepresentations } from './getSegmentationRepresentation';
import { addTool } from '../../store/addTool';
import { state } from '../../store/state';
import PlanarFreehandContourSegmentationTool from '../../tools/annotation/PlanarFreehandContourSegmentationTool';
import { getToolGroupForViewport } from '../../store/ToolGroupManager';
import { setAnnotationSelected } from '../../stateManagement/annotation/annotationSelection';
import { addDefaultSegmentationListener } from './segmentationEventManager';
import { getSegmentationRepresentationDisplay } from './SegmentationRepresentationDisplayRegistry';
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
            if (
                window.services?.displaySetService?.getDisplaySetByUID?.(
                    segmentationDetails[0].segmentationId
                ) !== undefined &&
                window.services?.measurementService?.getMeasurements?.().length === 0
            ) {
                const displaySet = window.services.displaySetService.getDisplaySetByUID(
                    segmentationDetails[0].segmentationId
                );
                if (
                    displaySet?.segMetadata?.data?.length > 1 &&
                    displaySet.segMetadata.data[1].SegmentDescription !== undefined
                ) {
                    for (const data of displaySet.segMetadata.data) {
                        if (data === undefined) {
                            continue;
                        }
                        const prompts = JSON.parse(data.SegmentDescription);
                        const SegmentNumber = data.SegmentNumber;
                        const segmentationId = segmentationDetails[0].segmentationId;
                        const posPoints = prompts.pos_points;
                        const negPoints = prompts.neg_points;
                        const pos_boxes = prompts.pos_boxes;
                        const neg_boxes = prompts.neg_boxes;
                        const pos_scribbles = prompts.pos_scribbles;
                        const neg_scribbles = prompts.neg_scribbles;
                        const pos_lassos = prompts.pos_lassos;
                        const neg_lassos = prompts.neg_lassos;
                        const toolGroup = getToolGroupForViewport(viewport.id);
                        if (posPoints?.length) {
                            const posPointTool = toolGroup.getToolInstance('Probe2');
                            if (posPointTool) {
                                for (const posPos of posPoints) {
                                    const annotation = posPointTool._addNewAnnotationFromIndex(
                                        element,
                                        posPos,
                                        false,
                                        SegmentNumber,
                                        segmentationId
                                    );
                                    setAnnotationSelected(annotation.annotationUID);
                                }
                            }
                        }
                        if (negPoints?.length) {
                            const negPointTool = toolGroup.getToolInstance('Probe2');
                            if (negPointTool) {
                                for (const negPos of negPoints) {
                                    const annotation = negPointTool._addNewAnnotationFromIndex(
                                        element,
                                        negPos,
                                        true,
                                        SegmentNumber,
                                        segmentationId
                                    );
                                    setAnnotationSelected(annotation.annotationUID);
                                }
                            }
                        }
                        if (pos_boxes?.length) {
                            const bboxTool = toolGroup.getToolInstance('RectangleROI2');
                            if (bboxTool) {
                                for (const box of pos_boxes) {
                                    const annotation = bboxTool._addNewAnnotationFromIndex(
                                        element,
                                        box,
                                        false,
                                        SegmentNumber,
                                        segmentationId
                                    );
                                    setAnnotationSelected(annotation.annotationUID);
                                }
                            }
                        }
                        if (neg_boxes?.length) {
                            const bboxTool = toolGroup.getToolInstance('RectangleROI2');
                            if (bboxTool) {
                                for (const box of neg_boxes) {
                                    const annotation = bboxTool._addNewAnnotationFromIndex(
                                        element,
                                        box,
                                        true,
                                        SegmentNumber,
                                        segmentationId
                                    );
                                    setAnnotationSelected(annotation.annotationUID);
                                }
                            }
                        }
                        if (pos_lassos?.length) {
                            const freehandTool = toolGroup.getToolInstance('PlanarFreehandROI3');
                            if (freehandTool) {
                                for (const spline of pos_lassos) {
                                    const annotation = freehandTool._addNewAnnotationFromIndex(
                                        element,
                                        spline,
                                        true,
                                        false,
                                        SegmentNumber,
                                        segmentationId
                                    );
                                    setAnnotationSelected(annotation.annotationUID);
                                }
                            }
                        }
                        if (neg_lassos?.length) {
                            const freehandTool = toolGroup.getToolInstance('PlanarFreehandROI3');
                            if (freehandTool) {
                                for (const spline of neg_lassos) {
                                    const annotation = freehandTool._addNewAnnotationFromIndex(
                                        element,
                                        spline,
                                        true,
                                        true,
                                        SegmentNumber,
                                        segmentationId
                                    );
                                    setAnnotationSelected(annotation.annotationUID);
                                }
                            }
                        }
                        if (pos_scribbles?.length) {
                            const freehandTool = toolGroup.getToolInstance('PlanarFreehandROI2');
                            if (freehandTool) {
                                for (const polyline of pos_scribbles) {
                                    const annotation = freehandTool._addNewAnnotationFromIndex(
                                        element,
                                        polyline,
                                        false,
                                        false,
                                        SegmentNumber,
                                        segmentationId
                                    );
                                    setAnnotationSelected(annotation.annotationUID);
                                }
                            }
                        }
                        if (neg_scribbles?.length) {
                            const freehandTool = toolGroup.getToolInstance('PlanarFreehandROI2');
                            if (freehandTool) {
                                for (const polyline of neg_scribbles) {
                                    const annotation = freehandTool._addNewAnnotationFromIndex(
                                        element,
                                        polyline,
                                        false,
                                        true,
                                        SegmentNumber,
                                        segmentationId
                                    );
                                    setAnnotationSelected(annotation.annotationUID);
                                }
                            }
                        }
                    }
                }
            }

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
function triggerSegmentationRender(viewportId) {
    segmentationRenderingEngine.renderSegmentationsForViewport(viewportId);
}
function triggerSegmentationRenderBySegmentationId(segmentationId) {
    segmentationRenderingEngine.renderSegmentation(segmentationId);
}
const segmentationRenderingEngine = new SegmentationRenderingEngine();
export { triggerSegmentationRender, triggerSegmentationRenderBySegmentationId, segmentationRenderingEngine, };
