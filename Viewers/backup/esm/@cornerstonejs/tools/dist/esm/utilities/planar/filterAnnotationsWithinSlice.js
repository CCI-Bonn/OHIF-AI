import { vec3 } from 'gl-matrix';
import { CONSTANTS, metaData, utilities } from '@cornerstonejs/core';
const { isEqual } = utilities;
const { EPSILON } = CONSTANTS;
const PARALLEL_THRESHOLD = 1 - EPSILON;
export default function filterAnnotationsWithinSlice(annotations, camera, spacingInNormalDirection) {
    const { viewPlaneNormal } = camera;
    const annotationsWithParallelNormals = annotations.filter((td) => {
        const { planeRestriction, referencedImageId } = td.metadata;
        let { viewPlaneNormal: annotationViewPlaneNormal } = td.metadata;
        if (planeRestriction) {
            const { inPlaneVector1, inPlaneVector2 } = planeRestriction;
            if (inPlaneVector1 &&
                !isEqual(0, vec3.dot(viewPlaneNormal, inPlaneVector1))) {
                return false;
            }
            if (inPlaneVector2 &&
                !isEqual(0, vec3.dot(viewPlaneNormal, inPlaneVector2))) {
                return false;
            }
            return true;
        }
        if (!td.metadata.referencedImageId &&
            !annotationViewPlaneNormal &&
            td.metadata.FrameOfReferenceUID) {
            for (const point of td.data.handles.points) {
                const vector = vec3.sub(vec3.create(), point, camera.focalPoint);
                const dotProduct = vec3.dot(vector, viewPlaneNormal);
                if (!isEqual(dotProduct, 0)) {
                    return false;
                }
            }
            td.metadata.viewPlaneNormal = viewPlaneNormal;
            td.metadata.cameraFocalPoint = camera.focalPoint;
            return true;
        }
        if (!annotationViewPlaneNormal && referencedImageId) {
            // PATCH: guard the metadata lookup. This runs inside the annotation
            // rendering engine's animation-frame callback, and a throw here
            // (e.g. imagePlaneModule unavailable during a hanging protocol
            // switch) leaves _animationFrameSet stuck - annotation rendering
            // dies viewer-wide until a page reload. Skip the annotation instead.
            const imageOrientationPatient = metaData.get('imagePlaneModule', referencedImageId)?.imageOrientationPatient;
            if (!imageOrientationPatient) {
                return false;
            }
            const rowCosineVec = vec3.fromValues(imageOrientationPatient[0], imageOrientationPatient[1], imageOrientationPatient[2]);
            const colCosineVec = vec3.fromValues(imageOrientationPatient[3], imageOrientationPatient[4], imageOrientationPatient[5]);
            annotationViewPlaneNormal = vec3.create();
            vec3.cross(annotationViewPlaneNormal, rowCosineVec, colCosineVec);
            td.metadata.viewPlaneNormal = annotationViewPlaneNormal;
        }
        const isParallel = Math.abs(vec3.dot(viewPlaneNormal, annotationViewPlaneNormal)) >
            PARALLEL_THRESHOLD;
        return annotationViewPlaneNormal && isParallel;
    });
    if (!annotationsWithParallelNormals.length) {
        return [];
    }
    const halfSpacingInNormalDirection = spacingInNormalDirection / 2;
    const { focalPoint } = camera;
    const annotationsWithinSlice = [];
    for (const annotation of annotationsWithParallelNormals) {
        const { data, metadata, isVisible } = annotation;
        if (!isVisible) {
            continue;
        }
        const point = metadata.planeRestriction?.point ||
            data.handles?.points?.[0] ||
            data.contour?.polyline[0];
        if (!point) {
            annotationsWithinSlice.push(annotation);
            continue;
        }
        const dir = vec3.sub(vec3.create(), focalPoint, point);
        const dot = Math.abs(vec3.dot(dir, viewPlaneNormal));
        if (dot < halfSpacingInNormalDirection) {
            annotationsWithinSlice.push(annotation);
        }
    }
    return annotationsWithinSlice;
}
