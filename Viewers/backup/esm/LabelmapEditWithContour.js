import { Events, SegmentationRepresentations } from '../../enums';
import { eventTarget, utilities, getRenderingEngine, } from '@cornerstonejs/core';
import PlanarFreehandContourSegmentationTool from '../annotation/PlanarFreehandContourSegmentationTool';
import BrushTool from './BrushTool';
import * as segmentation from '../../stateManagement/segmentation';
import { getSegmentationRepresentationsBySegmentationId } from '../../stateManagement/segmentation/getSegmentationRepresentation';
class LabelMapEditWithContourTool extends PlanarFreehandContourSegmentationTool {
    constructor(toolProps = {}) {
        const initialProps = utilities.deepMerge({
            configuration: {
                calculateStats: false,
                allowOpenContours: false,
            },
        }, toolProps);
        super(initialProps);
        this.onViewportAddedToToolGroupBinded =
            this.onViewportAddedToToolGroup.bind(this);
        this.onSegmentationModifiedBinded = this.onSegmentationModified.bind(this);
    }
    initializeListeners() {
        LabelMapEditWithContourTool.annotationsToViewportMap.clear();
        LabelMapEditWithContourTool.viewportIdsChecked = [];
        eventTarget.addEventListener(Events.ANNOTATION_MODIFIED, this.annotationModified);
        eventTarget.addEventListener(Events.ANNOTATION_COMPLETED, this.annotationCompleted);
        eventTarget.addEventListener(Events.TOOLGROUP_VIEWPORT_ADDED, this.onViewportAddedToToolGroupBinded);
        eventTarget.addEventListener(Events.SEGMENTATION_MODIFIED, this.onSegmentationModifiedBinded);
        eventTarget.addEventListener(Events.SEGMENTATION_REPRESENTATION_MODIFIED, this.onSegmentationModifiedBinded);
    }
    cleanUpListeners() {
        LabelMapEditWithContourTool.annotationsToViewportMap.clear();
        LabelMapEditWithContourTool.viewportIdsChecked = [];
        eventTarget.removeEventListener(Events.ANNOTATION_MODIFIED, this.annotationModified);
        eventTarget.removeEventListener(Events.ANNOTATION_COMPLETED, this.annotationCompleted);
        // OHIF-AI LEAK FIX (upstream @cornerstonejs/tools bug).
        // initializeListeners() ADDS the stored bound references (this.onViewportAddedToToolGroupBinded /
        // this.onSegmentationModifiedBinded), but these three removals used `.bind(this)`, which creates a
        // BRAND NEW function every call — so removeEventListener could never match what was added and the
        // listeners accumulated on the global eventTarget forever.
        // Proof it is exactly this: ANNOTATION_MODIFIED / ANNOTATION_COMPLETED above use the SAME reference
        // on both sides and were measured perfectly flat, while these two grew +1 per study open/close cycle.
        eventTarget.removeEventListener(Events.TOOLGROUP_VIEWPORT_ADDED, this.onViewportAddedToToolGroupBinded);
        eventTarget.removeEventListener(Events.SEGMENTATION_MODIFIED, this.onSegmentationModifiedBinded);
        eventTarget.removeEventListener(Events.SEGMENTATION_REPRESENTATION_MODIFIED, this.onSegmentationModifiedBinded);
    }
    async checkContourSegmentation(viewportId) {
        if (LabelMapEditWithContourTool.viewportIdsChecked.includes(viewportId)) {
            return;
        }
        const activeSeg = segmentation.getActiveSegmentation(viewportId);
        if (!activeSeg) {
            console.log('No active segmentation detected');
            return false;
        }
        const segmentationId = activeSeg.segmentationId;
        if (!activeSeg.representationData.Contour) {
            LabelMapEditWithContourTool.viewportIdsChecked.push(viewportId);
            await segmentation.addContourRepresentationToViewport(viewportId, [
                {
                    segmentationId,
                    type: SegmentationRepresentations.Contour,
                },
            ]);
            segmentation.addRepresentationData({
                segmentationId,
                type: SegmentationRepresentations.Contour,
                data: {},
            });
        }
        else {
            LabelMapEditWithContourTool.viewportIdsChecked.push(viewportId);
        }
        return true;
    }
    onViewportAddedToToolGroup(evt) {
        const { toolGroupId, viewportId } = evt.detail;
        if (toolGroupId !== this.toolGroupId) {
            return;
        }
        this.checkContourSegmentation(viewportId);
    }
    onSegmentationModified(evt) {
        const { segmentationId } = evt.detail || {};
        if (!segmentationId) {
            return;
        }
        const representations = getSegmentationRepresentationsBySegmentationId(segmentationId);
        if (!representations) {
            return;
        }
        representations.forEach(async ({ viewportId }) => await this.checkContourSegmentation(viewportId));
    }
    onSetToolEnabled() {
        this.initializeListeners();
    }
    onSetToolActive() {
        this.initializeListeners();
    }
    onSetToolDisabled() {
        this.cleanUpListeners();
    }
    annotationModified(evt) {
        const { annotation, renderingEngineId, viewportId } = evt.detail;
        const viewport = getRenderingEngine(renderingEngineId)?.getViewport(viewportId);
        if (!viewport) {
            return;
        }
        LabelMapEditWithContourTool.annotationsToViewportMap.set(annotation.annotationUID, viewport);
    }
    annotationCompleted(evt) {
        const { annotation } = evt.detail;
        const { polyline } = annotation.data?.contour || {};
        if (annotation?.metadata?.toolName !== LabelMapEditWithContourTool.toolName) {
            return;
        }
        if (!polyline) {
            return;
        }
        if (LabelMapEditWithContourTool.annotationsToViewportMap.has(annotation.annotationUID)) {
            const viewport = LabelMapEditWithContourTool.annotationsToViewportMap.get(annotation.annotationUID);
            if (polyline.length > 3) {
                BrushTool.viewportContoursToLabelmap(viewport);
            }
        }
    }
}
LabelMapEditWithContourTool.toolName = 'LabelMapEditWithContour';
LabelMapEditWithContourTool.annotationsToViewportMap = new Map();
LabelMapEditWithContourTool.viewportIdsChecked = [];
export default LabelMapEditWithContourTool;
