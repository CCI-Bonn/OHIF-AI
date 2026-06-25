var _a;
import { vec2, vec3 } from 'gl-matrix';
import { getEnabledElement, utilities as csUtils, getEnabledElementByViewportId, utilities, } from '@cornerstonejs/core';
import { getCalibratedLengthUnitsAndScale } from '../../utilities/getCalibratedUnits';
import { AnnotationTool } from '../base';
import throttle from '../../utilities/throttle';
import { addAnnotation, getAnnotations, removeAnnotation, } from '../../stateManagement/annotation/annotationState';
import { isAnnotationLocked } from '../../stateManagement/annotation/annotationLocking';
import { isAnnotationVisible } from '../../stateManagement/annotation/annotationVisibility';
import { triggerAnnotationCompleted, triggerAnnotationModified, } from '../../stateManagement/annotation/helpers/state';
import { drawLine as drawLineSvg, drawHandles as drawHandlesSvg, } from '../../drawingSvg';
import { state } from '../../store/state';
import { ChangeTypes, Events, MeasurementType } from '../../enums';
import { getViewportIdsWithToolToRender } from '../../utilities/viewportFilters';
import * as lineSegment from '../../utilities/math/line';
import { resetElementCursor, hideElementCursor, } from '../../cursors/elementCursor';
import triggerAnnotationRenderForViewportIds from '../../utilities/triggerAnnotationRenderForViewportIds';
import { getStyleProperty } from '../../stateManagement/annotation/config/helpers';
const { transformWorldToIndex } = csUtils;
class BidirectionalTool extends AnnotationTool {
    constructor(toolProps = {}, defaultToolProps = {
        supportedInteractionTypes: ['Mouse', 'Touch'],
        configuration: {
            preventHandleOutsideImage: false,
            getTextLines: defaultGetTextLines,
        },
    }) {
        super(toolProps, defaultToolProps);
        this.isPointNearTool = (element, annotation, canvasCoords, proximity) => {
            const enabledElement = getEnabledElement(element);
            const { viewport } = enabledElement;
            const { data } = annotation;
            const { points } = data.handles;
            let canvasPoint1 = viewport.worldToCanvas(points[0]);
            let canvasPoint2 = viewport.worldToCanvas(points[1]);
            let line = {
                start: {
                    x: canvasPoint1[0],
                    y: canvasPoint1[1],
                },
                end: {
                    x: canvasPoint2[0],
                    y: canvasPoint2[1],
                },
            };
            let distanceToPoint = lineSegment.distanceToPoint([line.start.x, line.start.y], [line.end.x, line.end.y], [canvasCoords[0], canvasCoords[1]]);
            if (distanceToPoint <= proximity) {
                return true;
            }
            canvasPoint1 = viewport.worldToCanvas(points[2]);
            canvasPoint2 = viewport.worldToCanvas(points[3]);
            line = {
                start: {
                    x: canvasPoint1[0],
                    y: canvasPoint1[1],
                },
                end: {
                    x: canvasPoint2[0],
                    y: canvasPoint2[1],
                },
            };
            distanceToPoint = lineSegment.distanceToPoint([line.start.x, line.start.y], [line.end.x, line.end.y], [canvasCoords[0], canvasCoords[1]]);
            if (distanceToPoint <= proximity) {
                return true;
            }
            return false;
        };
        this.toolSelectedCallback = (evt, annotation) => {
            const eventDetail = evt.detail;
            const { element } = eventDetail;
            annotation.highlighted = true;
            const viewportIdsToRender = getViewportIdsWithToolToRender(element, this.getToolName());
            this.editData = {
                annotation,
                viewportIdsToRender,
                movingTextBox: false,
            };
            this._activateModify(element);
            const enabledElement = getEnabledElement(element);
            const { renderingEngine } = enabledElement;
            triggerAnnotationRenderForViewportIds(viewportIdsToRender);
            hideElementCursor(element);
            evt.preventDefault();
        };
        this.handleSelectedCallback = (evt, annotation, handle) => {
            const eventDetail = evt.detail;
            const { element } = eventDetail;
            const data = annotation.data;
            annotation.highlighted = true;
            let movingTextBox = false;
            let handleIndex;
            if (handle.worldPosition) {
                movingTextBox = true;
            }
            else {
                handleIndex = data.handles.points.findIndex((p) => p === handle);
            }
            const viewportIdsToRender = getViewportIdsWithToolToRender(element, this.getToolName());
            hideElementCursor(element);
            this.editData = {
                annotation,
                viewportIdsToRender,
                handleIndex,
                movingTextBox,
            };
            this._activateModify(element);
            const enabledElement = getEnabledElement(element);
            const { renderingEngine } = enabledElement;
            triggerAnnotationRenderForViewportIds(viewportIdsToRender);
            evt.preventDefault();
        };
        this._endCallback = (evt) => {
            const eventDetail = evt.detail;
            const { element } = eventDetail;
            const { annotation, viewportIdsToRender, newAnnotation, hasMoved } = this.editData;
            const { data } = annotation;
            if (newAnnotation && !hasMoved) {
                return;
            }
            this.doneEditMemo();
            data.handles.activeHandleIndex = null;
            this._deactivateModify(element);
            this._deactivateDraw(element);
            resetElementCursor(element);
            const { renderingEngine } = getEnabledElement(element);
            if (this.editData.handleIndex !== undefined) {
                const { points } = data.handles;
                const firstLineSegmentLength = vec3.distance(points[0], points[1]);
                const secondLineSegmentLength = vec3.distance(points[2], points[3]);
                if (secondLineSegmentLength > firstLineSegmentLength) {
                    const longAxis = [[...points[2]], [...points[3]]];
                    const shortAxisPoint0 = [...points[0]];
                    const shortAxisPoint1 = [...points[1]];
                    const longAxisVector = vec2.create();
                    vec2.set(longAxisVector, longAxis[1][0] - longAxis[0][0], longAxis[1][1] - longAxis[0][1]);
                    const counterClockWisePerpendicularToLongAxis = vec2.create();
                    vec2.set(counterClockWisePerpendicularToLongAxis, -longAxisVector[1], longAxisVector[0]);
                    const currentShortAxisVector = vec2.create();
                    vec2.set(currentShortAxisVector, shortAxisPoint1[0] - shortAxisPoint0[0], shortAxisPoint1[1] - shortAxisPoint0[1]);
                    let shortAxis;
                    if (vec2.dot(currentShortAxisVector, counterClockWisePerpendicularToLongAxis) > 0) {
                        shortAxis = [shortAxisPoint0, shortAxisPoint1];
                    }
                    else {
                        shortAxis = [shortAxisPoint1, shortAxisPoint0];
                    }
                    data.handles.points = [
                        longAxis[0],
                        longAxis[1],
                        shortAxis[0],
                        shortAxis[1],
                    ];
                }
            }
            if (this.isHandleOutsideImage &&
                this.configuration.preventHandleOutsideImage) {
                removeAnnotation(annotation.annotationUID);
            }
            triggerAnnotationRenderForViewportIds(viewportIdsToRender);
            if (newAnnotation) {
                triggerAnnotationCompleted(annotation);
            }
            this.editData = null;
            this.isDrawing = false;
        };
        this._dragDrawCallback = (evt) => {
            this.isDrawing = true;
            const eventDetail = evt.detail;
            const { currentPoints, element } = eventDetail;
            const enabledElement = getEnabledElement(element);
            const { viewport } = enabledElement;
            const { worldToCanvas } = viewport;
            const { annotation, viewportIdsToRender, handleIndex, newAnnotation } = this.editData;
            this.createMemo(element, annotation, { newAnnotation });
            const { data } = annotation;
            const worldPos = currentPoints.world;
            data.handles.points[handleIndex] = [...worldPos];
            const canvasCoordPoints = data.handles.points.map(worldToCanvas);
            const canvasCoords = {
                longLineSegment: {
                    start: {
                        x: canvasCoordPoints[0][0],
                        y: canvasCoordPoints[0][1],
                    },
                    end: {
                        x: canvasCoordPoints[1][0],
                        y: canvasCoordPoints[1][1],
                    },
                },
                shortLineSegment: {
                    start: {
                        x: canvasCoordPoints[2][0],
                        y: canvasCoordPoints[2][1],
                    },
                    end: {
                        x: canvasCoordPoints[3][0],
                        y: canvasCoordPoints[3][1],
                    },
                },
            };
            const dist = vec2.distance(canvasCoordPoints[0], canvasCoordPoints[1]);
            const shortAxisDistFromCenter = dist / 3;
            const dx = canvasCoords.longLineSegment.start.x - canvasCoords.longLineSegment.end.x;
            const dy = canvasCoords.longLineSegment.start.y - canvasCoords.longLineSegment.end.y;
            const length = Math.sqrt(dx * dx + dy * dy);
            const vectorX = dx / length;
            const vectorY = dy / length;
            const xMid = (canvasCoords.longLineSegment.start.x +
                canvasCoords.longLineSegment.end.x) /
                2;
            const yMid = (canvasCoords.longLineSegment.start.y +
                canvasCoords.longLineSegment.end.y) /
                2;
            const startX = xMid + shortAxisDistFromCenter * vectorY;
            const startY = yMid - shortAxisDistFromCenter * vectorX;
            const endX = xMid - shortAxisDistFromCenter * vectorY;
            const endY = yMid + shortAxisDistFromCenter * vectorX;
            data.handles.points[2] = viewport.canvasToWorld([startX, startY]);
            data.handles.points[3] = viewport.canvasToWorld([endX, endY]);
            annotation.invalidated = true;
            triggerAnnotationRenderForViewportIds(viewportIdsToRender);
            triggerAnnotationModified(annotation, element, ChangeTypes.HandlesUpdated);
            this.editData.hasMoved = true;
        };
        this._dragModifyCallback = (evt) => {
            this.isDrawing = true;
            const eventDetail = evt.detail;
            const { element } = eventDetail;
            const { annotation, viewportIdsToRender, handleIndex, movingTextBox, newAnnotation, } = this.editData;
            this.createMemo(element, annotation, { newAnnotation });
            const { data } = annotation;
            if (movingTextBox) {
                const { deltaPoints } = eventDetail;
                const worldPosDelta = deltaPoints.world;
                const { textBox } = data.handles;
                const { worldPosition } = textBox;
                worldPosition[0] += worldPosDelta[0];
                worldPosition[1] += worldPosDelta[1];
                worldPosition[2] += worldPosDelta[2];
                textBox.hasMoved = true;
            }
            else if (handleIndex === undefined) {
                const { deltaPoints } = eventDetail;
                const worldPosDelta = deltaPoints.world;
                const points = data.handles.points;
                points.forEach((point) => {
                    point[0] += worldPosDelta[0];
                    point[1] += worldPosDelta[1];
                    point[2] += worldPosDelta[2];
                });
                annotation.invalidated = true;
            }
            else {
                this._dragModifyHandle(evt);
                annotation.invalidated = true;
            }
            triggerAnnotationRenderForViewportIds(viewportIdsToRender);
            if (annotation.invalidated) {
                triggerAnnotationModified(annotation, element, ChangeTypes.HandlesUpdated);
            }
        };
        this._dragModifyHandle = (evt) => {
            const eventDetail = evt.detail;
            const { currentPoints, element } = eventDetail;
            const enabledElement = getEnabledElement(element);
            const { viewport } = enabledElement;
            const { annotation, handleIndex: movingHandleIndex } = this.editData;
            const { data } = annotation;
            const worldPos = currentPoints.world;
            const canvasCoordHandlesCurrent = [
                viewport.worldToCanvas(data.handles.points[0]),
                viewport.worldToCanvas(data.handles.points[1]),
                viewport.worldToCanvas(data.handles.points[2]),
                viewport.worldToCanvas(data.handles.points[3]),
            ];
            const firstLineSegment = {
                start: {
                    x: canvasCoordHandlesCurrent[0][0],
                    y: canvasCoordHandlesCurrent[0][1],
                },
                end: {
                    x: canvasCoordHandlesCurrent[1][0],
                    y: canvasCoordHandlesCurrent[1][1],
                },
            };
            const secondLineSegment = {
                start: {
                    x: canvasCoordHandlesCurrent[2][0],
                    y: canvasCoordHandlesCurrent[2][1],
                },
                end: {
                    x: canvasCoordHandlesCurrent[3][0],
                    y: canvasCoordHandlesCurrent[3][1],
                },
            };
            const proposedPoint = [...worldPos];
            const proposedCanvasCoord = viewport.worldToCanvas(proposedPoint);
            if (movingHandleIndex === 0 || movingHandleIndex === 1) {
                const fixedHandleIndex = movingHandleIndex === 0 ? 1 : 0;
                const fixedHandleCanvasCoord = canvasCoordHandlesCurrent[fixedHandleIndex];
                const fixedHandleToProposedCoordVec = vec2.set(vec2.create(), proposedCanvasCoord[0] - fixedHandleCanvasCoord[0], proposedCanvasCoord[1] - fixedHandleCanvasCoord[1]);
                const fixedHandleToOldCoordVec = vec2.set(vec2.create(), canvasCoordHandlesCurrent[movingHandleIndex][0] -
                    fixedHandleCanvasCoord[0], canvasCoordHandlesCurrent[movingHandleIndex][1] -
                    fixedHandleCanvasCoord[1]);
                vec2.normalize(fixedHandleToProposedCoordVec, fixedHandleToProposedCoordVec);
                vec2.normalize(fixedHandleToOldCoordVec, fixedHandleToOldCoordVec);
                const proposedFirstLineSegment = {
                    start: {
                        x: fixedHandleCanvasCoord[0],
                        y: fixedHandleCanvasCoord[1],
                    },
                    end: {
                        x: proposedCanvasCoord[0],
                        y: proposedCanvasCoord[1],
                    },
                };
                if (this._movingLongAxisWouldPutItThroughShortAxis(proposedFirstLineSegment, secondLineSegment)) {
                    return;
                }
                const centerOfRotation = fixedHandleCanvasCoord;
                const angle = this._getSignedAngle(fixedHandleToOldCoordVec, fixedHandleToProposedCoordVec);
                let firstPointX = canvasCoordHandlesCurrent[2][0];
                let firstPointY = canvasCoordHandlesCurrent[2][1];
                let secondPointX = canvasCoordHandlesCurrent[3][0];
                let secondPointY = canvasCoordHandlesCurrent[3][1];
                firstPointX -= centerOfRotation[0];
                firstPointY -= centerOfRotation[1];
                secondPointX -= centerOfRotation[0];
                secondPointY -= centerOfRotation[1];
                const rotatedFirstPoint = firstPointX * Math.cos(angle) - firstPointY * Math.sin(angle);
                const rotatedFirstPointY = firstPointX * Math.sin(angle) + firstPointY * Math.cos(angle);
                const rotatedSecondPoint = secondPointX * Math.cos(angle) - secondPointY * Math.sin(angle);
                const rotatedSecondPointY = secondPointX * Math.sin(angle) + secondPointY * Math.cos(angle);
                firstPointX = rotatedFirstPoint + centerOfRotation[0];
                firstPointY = rotatedFirstPointY + centerOfRotation[1];
                secondPointX = rotatedSecondPoint + centerOfRotation[0];
                secondPointY = rotatedSecondPointY + centerOfRotation[1];
                const newFirstPoint = viewport.canvasToWorld([firstPointX, firstPointY]);
                const newSecondPoint = viewport.canvasToWorld([
                    secondPointX,
                    secondPointY,
                ]);
                data.handles.points[movingHandleIndex] = proposedPoint;
                data.handles.points[2] = newFirstPoint;
                data.handles.points[3] = newSecondPoint;
            }
            else {
                const translateHandleIndex = movingHandleIndex === 2 ? 3 : 2;
                const canvasCoordsCurrent = {
                    longLineSegment: {
                        start: firstLineSegment.start,
                        end: firstLineSegment.end,
                    },
                    shortLineSegment: {
                        start: secondLineSegment.start,
                        end: secondLineSegment.end,
                    },
                };
                const longLineSegmentVec = vec2.subtract(vec2.create(), [
                    canvasCoordsCurrent.longLineSegment.end.x,
                    canvasCoordsCurrent.longLineSegment.end.y,
                ], [
                    canvasCoordsCurrent.longLineSegment.start.x,
                    canvasCoordsCurrent.longLineSegment.start.y,
                ]);
                const longLineSegmentVecNormalized = vec2.normalize(vec2.create(), longLineSegmentVec);
                const proposedToCurrentVec = vec2.subtract(vec2.create(), [proposedCanvasCoord[0], proposedCanvasCoord[1]], [
                    canvasCoordHandlesCurrent[movingHandleIndex][0],
                    canvasCoordHandlesCurrent[movingHandleIndex][1],
                ]);
                const movementLength = vec2.length(proposedToCurrentVec);
                const angle = this._getSignedAngle(longLineSegmentVecNormalized, proposedToCurrentVec);
                const movementAlongLineSegmentLength = Math.cos(angle) * movementLength;
                const newTranslatedPoint = vec2.scaleAndAdd(vec2.create(), [
                    canvasCoordHandlesCurrent[translateHandleIndex][0],
                    canvasCoordHandlesCurrent[translateHandleIndex][1],
                ], longLineSegmentVecNormalized, movementAlongLineSegmentLength);
                if (this._movingLongAxisWouldPutItThroughShortAxis({
                    start: {
                        x: proposedCanvasCoord[0],
                        y: proposedCanvasCoord[1],
                    },
                    end: {
                        x: newTranslatedPoint[0],
                        y: newTranslatedPoint[1],
                    },
                }, {
                    start: {
                        x: canvasCoordsCurrent.longLineSegment.start.x,
                        y: canvasCoordsCurrent.longLineSegment.start.y,
                    },
                    end: {
                        x: canvasCoordsCurrent.longLineSegment.end.x,
                        y: canvasCoordsCurrent.longLineSegment.end.y,
                    },
                })) {
                    return;
                }
                const intersectionPoint = lineSegment.intersectLine([proposedCanvasCoord[0], proposedCanvasCoord[1]], [newTranslatedPoint[0], newTranslatedPoint[1]], [firstLineSegment.start.x, firstLineSegment.start.y], [firstLineSegment.end.x, firstLineSegment.end.y]);
                if (!intersectionPoint) {
                    return;
                }
                data.handles.points[translateHandleIndex] = viewport.canvasToWorld(newTranslatedPoint);
                data.handles.points[movingHandleIndex] = proposedPoint;
            }
        };
        this.cancel = (element) => {
            if (this.isDrawing) {
                this.isDrawing = false;
                this._deactivateDraw(element);
                this._deactivateModify(element);
                resetElementCursor(element);
                const { annotation, viewportIdsToRender, newAnnotation } = this.editData;
                const { data } = annotation;
                annotation.highlighted = false;
                data.handles.activeHandleIndex = null;
                triggerAnnotationRenderForViewportIds(viewportIdsToRender);
                if (newAnnotation) {
                    triggerAnnotationCompleted(annotation);
                }
                this.editData = null;
                return annotation.annotationUID;
            }
        };
        this._activateDraw = (element) => {
            state.isInteractingWithTool = true;
            element.addEventListener(Events.MOUSE_UP, this._endCallback);
            element.addEventListener(Events.MOUSE_DRAG, this._dragDrawCallback);
            element.addEventListener(Events.MOUSE_MOVE, this._dragDrawCallback);
            element.addEventListener(Events.MOUSE_CLICK, this._endCallback);
            element.addEventListener(Events.TOUCH_TAP, this._endCallback);
            element.addEventListener(Events.TOUCH_END, this._endCallback);
            element.addEventListener(Events.TOUCH_DRAG, this._dragDrawCallback);
        };
        this._deactivateDraw = (element) => {
            state.isInteractingWithTool = false;
            element.removeEventListener(Events.MOUSE_UP, this._endCallback);
            element.removeEventListener(Events.MOUSE_DRAG, this._dragDrawCallback);
            element.removeEventListener(Events.MOUSE_MOVE, this._dragDrawCallback);
            element.removeEventListener(Events.MOUSE_CLICK, this._endCallback);
            element.removeEventListener(Events.TOUCH_TAP, this._endCallback);
            element.removeEventListener(Events.TOUCH_END, this._endCallback);
            element.removeEventListener(Events.TOUCH_DRAG, this._dragDrawCallback);
        };
        this._activateModify = (element) => {
            state.isInteractingWithTool = true;
            element.addEventListener(Events.MOUSE_UP, this._endCallback);
            element.addEventListener(Events.MOUSE_DRAG, this._dragModifyCallback);
            element.addEventListener(Events.MOUSE_CLICK, this._endCallback);
            element.addEventListener(Events.TOUCH_END, this._endCallback);
            element.addEventListener(Events.TOUCH_DRAG, this._dragModifyCallback);
            element.addEventListener(Events.TOUCH_TAP, this._endCallback);
        };
        this._deactivateModify = (element) => {
            state.isInteractingWithTool = false;
            element.removeEventListener(Events.MOUSE_UP, this._endCallback);
            element.removeEventListener(Events.MOUSE_DRAG, this._dragModifyCallback);
            element.removeEventListener(Events.MOUSE_CLICK, this._endCallback);
            element.removeEventListener(Events.TOUCH_END, this._endCallback);
            element.removeEventListener(Events.TOUCH_DRAG, this._dragModifyCallback);
            element.removeEventListener(Events.TOUCH_TAP, this._endCallback);
        };
        this.renderAnnotation = (enabledElement, svgDrawingHelper) => {
            let renderStatus = true;
            const { viewport } = enabledElement;
            const { element } = viewport;
            let annotations = getAnnotations(this.getToolName(), element);
            if (!annotations?.length) {
                return renderStatus;
            }
            annotations = this.filterInteractableAnnotationsForElement(element, annotations);
            if (!annotations?.length) {
                return renderStatus;
            }
            const targetId = this.getTargetId(viewport);
            const renderingEngine = viewport.getRenderingEngine();
            const styleSpecifier = {
                toolGroupId: this.toolGroupId,
                toolName: this.getToolName(),
                viewportId: enabledElement.viewport.id,
            };
            for (let i = 0; i < annotations.length; i++) {
                const annotation = annotations[i];
                const { annotationUID, data } = annotation;
                const { points, activeHandleIndex } = data.handles;
                const canvasCoordinates = points.map((p) => viewport.worldToCanvas(p));
                styleSpecifier.annotationUID = annotationUID;
                const { color, lineWidth, lineDash, shadow } = this.getAnnotationStyle({
                    annotation,
                    styleSpecifier,
                });
                if (!data.cachedStats[targetId] ||
                    data.cachedStats[targetId].unit == null) {
                    data.cachedStats[targetId] = {
                        length: null,
                        width: null,
                        unit: null,
                    };
                    this._calculateCachedStats(annotation, renderingEngine, enabledElement);
                }
                else if (annotation.invalidated) {
                    this._throttledCalculateCachedStats(annotation, renderingEngine, enabledElement);
                }
                if (!viewport.getRenderingEngine()) {
                    console.warn('Rendering Engine has been destroyed');
                    return renderStatus;
                }
                let activeHandleCanvasCoords;
                if (!isAnnotationVisible(annotationUID)) {
                    continue;
                }
                if (!isAnnotationLocked(annotationUID) &&
                    !this.editData &&
                    activeHandleIndex !== null) {
                    activeHandleCanvasCoords = [canvasCoordinates[activeHandleIndex]];
                }
                const showHandlesAlways = Boolean(getStyleProperty('showHandlesAlways', {}));
                if (activeHandleCanvasCoords || showHandlesAlways) {
                    const handleGroupUID = '0';
                    drawHandlesSvg(svgDrawingHelper, annotationUID, handleGroupUID, showHandlesAlways ? canvasCoordinates : activeHandleCanvasCoords, {
                        color,
                    });
                }
                const dataId1 = `${annotationUID}-line-1`;
                const dataId2 = `${annotationUID}-line-2`;
                const lineUID = '0';
                drawLineSvg(svgDrawingHelper, annotationUID, lineUID, canvasCoordinates[0], canvasCoordinates[1], {
                    color,
                    lineDash,
                    lineWidth,
                    shadow,
                }, dataId1);
                const secondLineUID = '1';
                drawLineSvg(svgDrawingHelper, annotationUID, secondLineUID, canvasCoordinates[2], canvasCoordinates[3], {
                    color,
                    lineDash,
                    lineWidth,
                    shadow,
                }, dataId2);
                renderStatus = true;
                const textLines = this.configuration.getTextLines(data, targetId);
                if (!textLines || textLines.length === 0) {
                    continue;
                }
                if (!this.renderLinkedTextBoxAnnotation({
                    enabledElement,
                    svgDrawingHelper,
                    annotation,
                    styleSpecifier,
                    textLines,
                    canvasCoordinates,
                })) {
                    continue;
                }
            }
            return renderStatus;
        };
        this._movingLongAxisWouldPutItThroughShortAxis = (firstLineSegment, secondLineSegment) => {
            const vectorInSecondLineDirection = vec2.create();
            vec2.set(vectorInSecondLineDirection, secondLineSegment.end.x - secondLineSegment.start.x, secondLineSegment.end.y - secondLineSegment.start.y);
            vec2.normalize(vectorInSecondLineDirection, vectorInSecondLineDirection);
            const extendedSecondLineSegment = {
                start: {
                    x: secondLineSegment.start.x - vectorInSecondLineDirection[0] * 10,
                    y: secondLineSegment.start.y - vectorInSecondLineDirection[1] * 10,
                },
                end: {
                    x: secondLineSegment.end.x + vectorInSecondLineDirection[0] * 10,
                    y: secondLineSegment.end.y + vectorInSecondLineDirection[1] * 10,
                },
            };
            const proposedIntersectionPoint = lineSegment.intersectLine([extendedSecondLineSegment.start.x, extendedSecondLineSegment.start.y], [extendedSecondLineSegment.end.x, extendedSecondLineSegment.end.y], [firstLineSegment.start.x, firstLineSegment.start.y], [firstLineSegment.end.x, firstLineSegment.end.y]);
            const wouldPutThroughShortAxis = !proposedIntersectionPoint;
            return wouldPutThroughShortAxis;
        };
        this._calculateCachedStats = (annotation, renderingEngine, enabledElement) => {
            const { data } = annotation;
            const { element } = enabledElement.viewport;
            const worldPos1 = data.handles.points[0];
            const worldPos2 = data.handles.points[1];
            const worldPos3 = data.handles.points[2];
            const worldPos4 = data.handles.points[3];
            const { cachedStats } = data;
            const targetIds = Object.keys(cachedStats);
            for (let i = 0; i < targetIds.length; i++) {
                const targetId = targetIds[i];
                const image = this.getTargetImageData(targetId);
                if (!image) {
                    continue;
                }
                const { imageData, dimensions } = image;
                const handles = data.handles.points.map((point) => imageData.worldToIndex(point));
                const handles1 = handles.slice(0, 2);
                const handles2 = handles.slice(2, 4);
                const calibrate = getCalibratedLengthUnitsAndScale(image, handles);
                const dist1 = _a.calculateLengthInIndex(calibrate, handles1);
                const dist2 = _a.calculateLengthInIndex(calibrate, handles2);
                const { unit } = calibrate;
                const length = dist1 > dist2 ? dist1 : dist2;
                const width = dist1 > dist2 ? dist2 : dist1;
                const widthUnit = unit;
                this.isHandleOutsideImage = !_a.isInsideVolume(dimensions, handles);
                cachedStats[targetId] = {
                    length,
                    width,
                    unit,
                    widthUnit,
                    statsArray: [
                        {
                            value: length,
                            name: 'height',
                            unit,
                            type: MeasurementType.Linear,
                        },
                        {
                            value: width,
                            name: 'width',
                            unit,
                            type: MeasurementType.Linear,
                        },
                    ],
                };
            }
            const invalidated = annotation.invalidated;
            annotation.invalidated = false;
            if (invalidated) {
                triggerAnnotationModified(annotation, element, ChangeTypes.StatsUpdated);
            }
            return cachedStats;
        };
        this._getSignedAngle = (vector1, vector2) => {
            return Math.atan2(vector1[0] * vector2[1] - vector1[1] * vector2[0], vector1[0] * vector2[0] + vector1[1] * vector2[1]);
        };
        this._throttledCalculateCachedStats = throttle(this._calculateCachedStats, 100, { trailing: true });
    }
    addNewAnnotation(evt) {
        const eventDetail = evt.detail;
        const { currentPoints, element } = eventDetail;
        const worldPos = currentPoints.world;
        this.isDrawing = true;
        const annotation = this.createAnnotation(evt, [
            [...worldPos],
            [...worldPos],
            [...worldPos],
            [...worldPos],
        ]);
        addAnnotation(annotation, element);
        const viewportIdsToRender = getViewportIdsWithToolToRender(element, this.getToolName());
        this.editData = {
            annotation,
            viewportIdsToRender,
            handleIndex: 1,
            movingTextBox: false,
            newAnnotation: true,
            hasMoved: false,
        };
        this._activateDraw(element);
        hideElementCursor(element);
        evt.preventDefault();
        triggerAnnotationRenderForViewportIds(viewportIdsToRender);
        return annotation;
    }
}
_a = BidirectionalTool;
BidirectionalTool.toolName = 'Bidirectional';
BidirectionalTool.hydrate = (viewportId, axis, options) => {
    const enabledElement = getEnabledElementByViewportId(viewportId);
    if (!enabledElement) {
        return;
    }
    const { FrameOfReferenceUID, referencedImageId, viewPlaneNormal, instance, viewport, } = _a.hydrateBase(_a, enabledElement, axis[0], options);
    const [majorAxis, minorAxis] = axis;
    const [major0, major1] = majorAxis;
    const [minor0, minor1] = minorAxis;
    const points = [major0, major1, minor0, minor1];
    const { toolInstance, ...serializableOptions } = options || {};
    const annotation = {
        annotationUID: options?.annotationUID || utilities.uuidv4(),
        data: {
            handles: {
                points,
                activeHandleIndex: null,
                textBox: {
                    hasMoved: false,
                    worldPosition: [0, 0, 0],
                    worldBoundingBox: {
                        topLeft: [0, 0, 0],
                        topRight: [0, 0, 0],
                        bottomLeft: [0, 0, 0],
                        bottomRight: [0, 0, 0],
                    },
                },
            },
            cachedStats: {},
        },
        highlighted: false,
        autoGenerated: false,
        invalidated: false,
        isLocked: false,
        isVisible: true,
        metadata: {
            toolName: instance.getToolName(),
            viewPlaneNormal,
            FrameOfReferenceUID,
            referencedImageId,
            ...serializableOptions,
        },
    };
    addAnnotation(annotation, viewport.element);
    triggerAnnotationRenderForViewportIds([viewport.id]);
    return annotation;
};
function defaultGetTextLines(data, targetId) {
    const { cachedStats, label } = data;
    const { length, width, unit } = cachedStats[targetId];
    const textLines = [];
    if (label) {
        textLines.push(label);
    }
    if (length === undefined) {
        return textLines;
    }
    textLines.push(`L: ${csUtils.roundNumber(length)} ${unit || unit}`, `W: ${csUtils.roundNumber(width)} ${unit}`);
    return textLines;
}
export default BidirectionalTool;
