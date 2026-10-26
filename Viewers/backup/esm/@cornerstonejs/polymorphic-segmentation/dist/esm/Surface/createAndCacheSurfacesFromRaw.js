import { Enums, cache, geometryLoader } from '@cornerstonejs/core';
import * as cornerstoneTools from '@cornerstonejs/tools';
const { getSegmentation } = cornerstoneTools.segmentation.state;
const { getSegmentIndexColor } = cornerstoneTools.segmentation.config.color;
// PROJECT OVERRIDE. After every inference the app drops `representationData.Surface` so the 3D
// viewport rebuilds its meshes from the refined labelmap. Upstream's rebuild goes through
// geometryLoader.createAndCacheGeometry, which RETURNS THE CACHED GEOMETRY when one already exists
// under the same id — so the freshly extracted points were discarded and the mesh stayed at
// whatever the first extraction produced. The only path that wrote into an existing geometry was
// the 300ms-debounced SEGMENTATION_DATA_MODIFIED listener, and it bails unless the (async, worker-
// backed) rebuild has already re-added the Surface data by the time it fires: a race the 3D view
// lost whenever extraction took longer than the debounce.
//
// Fix: when a geometry already exists for the segment, write the new points/polys into it (the
// same thing updateSurfaceData does) instead of returning the stale one.
export async function createAndCacheSurfacesFromRaw(segmentationId, rawSurfacesData, options = {}) {
    const segmentation = getSegmentation(segmentationId);
    const geometryIds = new Map();
    const promises = Object.keys(rawSurfacesData).map(async (index) => {
        const rawSurfaceData = rawSurfacesData[index];
        const segmentIndex = rawSurfaceData.segmentIndex;
        const color = getSegmentIndexColor(options.viewport.id, segmentation.segmentationId, segmentIndex).slice(0, 3);
        if (!color) {
            throw new Error('No color found for segment index, unable to create surface');
        }
        if (!rawSurfaceData.data?.points) {
            throw new Error('No points found for surface');
        }
        const geometryId = `segmentation_${segmentation.segmentationId}_surface_${segmentIndex}`;
        geometryIds.set(segmentIndex, geometryId);
        const existing = cache.getGeometry(geometryId);
        if (existing?.data) {
            const surface = existing.data;
            surface.points = rawSurfaceData.data.points;
            surface.polys = rawSurfaceData.data.polys;
            return existing;
        }
        const closedSurface = {
            id: geometryId,
            color,
            frameOfReferenceUID: 'test-frameOfReferenceUID',
            points: rawSurfaceData.data.points,
            polys: rawSurfaceData.data.polys,
            segmentIndex,
        };
        return geometryLoader.createAndCacheGeometry(geometryId, {
            type: Enums.GeometryType.SURFACE,
            geometryData: closedSurface,
        });
    });
    await Promise.all(promises);
    return {
        geometryIds,
    };
}
