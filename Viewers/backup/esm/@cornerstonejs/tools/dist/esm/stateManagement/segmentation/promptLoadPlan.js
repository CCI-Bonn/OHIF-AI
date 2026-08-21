const AI_PROMPT_TYPES = [
    { key: 'pos_points', toolName: 'Probe2', neg: false, kind: 'point' },
    { key: 'neg_points', toolName: 'Probe2', neg: true, kind: 'point' },
    { key: 'pos_boxes', toolName: 'RectangleROI2', neg: false, kind: 'box' },
    { key: 'neg_boxes', toolName: 'RectangleROI2', neg: true, kind: 'box' },
    { key: 'pos_scribbles', toolName: 'PlanarFreehandROI2', neg: false, kind: 'polyline', closed: false },
    { key: 'neg_scribbles', toolName: 'PlanarFreehandROI2', neg: true, kind: 'polyline', closed: false },
    { key: 'pos_lassos', toolName: 'PlanarFreehandROI3', neg: false, kind: 'polyline', closed: true },
    { key: 'neg_lassos', toolName: 'PlanarFreehandROI3', neg: true, kind: 'polyline', closed: true },
];
const PLANAR_K_EPSILON = 0.5;
function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}
function makeWorldFromIndex(imageIds, imageToWorldCoords) {
    const maxK = imageIds.length - 1;
    return (i, j, k) => {
        const kClamped = clamp(k, 0, maxK);
        const k0 = Math.floor(kClamped);
        const imageCoords = [i + 0.5, j + 0.5];
        const world = imageToWorldCoords(imageIds[k0], imageCoords);
        const frac = kClamped - k0;
        if (frac === 0) {
            return world;
        }
        const worldNext = imageToWorldCoords(imageIds[k0 + 1], imageCoords);
        return world.map((value, axis) => value + frac * (worldNext[axis] - value));
    };
}
function fitPolylineNormal(points) {
    const a = points[0];
    const sub = (p, q) => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
    const cross = (u, v) => [
        u[1] * v[2] - u[2] * v[1],
        u[2] * v[0] - u[0] * v[2],
        u[0] * v[1] - u[1] * v[0],
    ];
    const lengthSq = v => v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
    let b = a;
    let bDistSq = 0;
    for (const p of points) {
        const distSq = lengthSq(sub(p, a));
        if (distSq > bDistSq) {
            b = p;
            bDistSq = distSq;
        }
    }
    const ab = sub(b, a);
    let normal = null;
    let normalLenSq = 0;
    for (const p of points) {
        const candidate = cross(ab, sub(p, a));
        const candidateLenSq = lengthSq(candidate);
        if (candidateLenSq > normalLenSq) {
            normal = candidate;
            normalLenSq = candidateLenSq;
        }
    }
    if (!normal || normalLenSq === 0) {
        return null;
    }
    const len = Math.sqrt(normalLenSq);
    return normal.map(value => value / len);
}
function parsePrompts(segmentDescription) {
    if (segmentDescription === undefined || segmentDescription === null) {
        return null;
    }
    let prompts = segmentDescription;
    if (typeof prompts === 'string') {
        try {
            prompts = JSON.parse(prompts);
        }
        catch (error) {
            return null;
        }
    }
    if (!prompts || typeof prompts !== 'object') {
        return null;
    }
    return prompts;
}
function buildMetadata(indexPoints, opts) {
    const { frameOfReferenceUID, imageIds, worldFromIndex } = opts;
    const worldPoints = indexPoints.map(([i, j, k]) => worldFromIndex(i, j, k));
    const ks = indexPoints.map(([, , k]) => k);
    const kSpread = Math.max(...ks) - Math.min(...ks);
    const metadata = { FrameOfReferenceUID: frameOfReferenceUID };
    // Every prompt gets a referencedImageId so measurement mapping stays on the
    // imageId path — the volumeId lookup path throws when the viewport's volume
    // id does not embed a display set uid. Acquisition-planar prompts reference
    // their own slice; non-planar (MPR-drawn) polylines fall back to the first
    // point's slice and, when the points aren't collinear, carry the fitted
    // plane normal so slice filtering keeps them on their original plane.
    if (kSpread < PLANAR_K_EPSILON) {
        const kMid = clamp(Math.round((Math.max(...ks) + Math.min(...ks)) / 2), 0, imageIds.length - 1);
        metadata.referencedImageId = imageIds[kMid];
    }
    else {
        metadata.referencedImageId = imageIds[clamp(Math.round(ks[0]), 0, imageIds.length - 1)];
        const viewPlaneNormal = fitPolylineNormal(worldPoints);
        if (viewPlaneNormal) {
            metadata.viewPlaneNormal = viewPlaneNormal;
        }
    }
    return { worldPoints, metadata };
}
function buildPromptLoadPlan(segMetadataData, opts) {
    const { segmentationId, imageIds, flipped } = opts;
    const plan = [];
    if (!Array.isArray(segMetadataData) || !imageIds?.length) {
        return plan;
    }
    for (const segmentInfo of segMetadataData) {
        if (!segmentInfo) {
            continue;
        }
        const prompts = parsePrompts(segmentInfo.SegmentDescription);
        if (!prompts) {
            continue;
        }
        const parsedSegmentNumber = Number(segmentInfo.SegmentNumber);
        const SegmentNumber = Number.isNaN(parsedSegmentNumber)
            ? segmentInfo.SegmentNumber
            : parsedSegmentNumber;
        for (const promptType of AI_PROMPT_TYPES) {
            const entries = prompts[promptType.key];
            if (!Array.isArray(entries) || !entries.length) {
                continue;
            }
            for (const entry of entries) {
                let indexPoints;
                if (promptType.kind === 'point') {
                    indexPoints = [entry];
                }
                else if (promptType.kind === 'box') {
                    const [p0, p1] = entry;
                    // Box corners come from pointsInShape pointIJK, which is raw
                    // volume ijk — unlike the other prompt types, capture never
                    // flips it into display-set slice order.
                    const k = flipped ? imageIds.length - 1 - p0[2] : p0[2];
                    indexPoints = [
                        [p0[0], p0[1], k],
                        [p1[0], p0[1], k],
                        [p0[0], p1[1], k],
                        [p1[0], p1[1], k],
                    ];
                }
                else {
                    indexPoints = entry;
                }
                if (!Array.isArray(indexPoints) || !indexPoints.length || !Array.isArray(indexPoints[0])) {
                    continue;
                }
                const { worldPoints, metadata } = buildMetadata(indexPoints, opts);
                const descriptor = {
                    toolName: promptType.toolName,
                    neg: promptType.neg,
                    SegmentNumber,
                    segmentationId,
                    worldPoints,
                    metadata,
                };
                if (promptType.kind === 'polyline') {
                    descriptor.closed = promptType.closed;
                }
                plan.push(descriptor);
            }
        }
    }
    return plan;
}
export { buildPromptLoadPlan, makeWorldFromIndex };
