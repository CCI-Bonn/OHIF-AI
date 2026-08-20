import vtkImageMapper from '@kitware/vtk.js/Rendering/Core/ImageMapper';
import vtkImageSlice from '@kitware/vtk.js/Rendering/Core/ImageSlice';
import { ActorRenderMode, Enums } from '@cornerstonejs/core';
import { canRenderVolumeViewportLabelmapAsImage } from '../../../stateManagement/segmentation/helpers/labelmapImageMapperSupport';
import { getLabelmap, getOrCreateLabelmapVolume, getLabelmaps, getLabelmapForImageId, getLabelmapForVolumeId, } from '../../../stateManagement/segmentation/helpers/labelmapSegmentationState';
import { createLabelmapRepresentationUID, isLabelmapRepresentationUID, } from './labelmapRepresentationUID';
import { applyPlanarOverlayDepthOffset, createSliceImageData, getSliceRenderingCamera, getSliceState, } from './volumeLabelmapSliceData';
// PROJECT OVERRIDE. The slice-mapper actor lives in a secondary overlay renderer
// (`<viewportId>::labelmap-image-mapper-overlay`) that is drawn on every viewport render.
// Upstream's removal path is gated on canRenderVolumeViewportLabelmapAsImage — which goes
// FALSE the moment the viewport turns oblique (crosshair rotation), i.e. exactly when the
// render plan flips to legacy-volume and needs the slice actor gone. The fallback removal
// (Viewport.removeActors) only touches the BASE renderer and erases the viewport's actor
// bookkeeping, leaving the slice actor untracked but still drawn in the overlay renderer,
// frozen at its last orthogonal plane. Every oblique<->orthogonal round trip then adds one
// more ghost copy of the segmentation. Two changes:
//   1. removeVolumeLabelmapImageMapperActors gates on the overlay renderer's EXISTENCE, not
//      on renderability, and additionally sweeps the overlay renderer for actors no longer
//      tracked by the viewport — collecting ghosts orphaned before this code runs.
//   2. addVolumeLabelmapImageMapperActors only moves an actor into the overlay renderer if
//      viewport.addActor actually accepted it (it warns and returns on a duplicate UID;
//      moving the refused actor would strand it in the overlay renderer untracked).
const OVERLAY_RENDERER_SUFFIX = 'labelmap-image-mapper-overlay';
function isPlanarSliceRenderingViewport(viewport) {
    const compatibilityViewport = viewport;
    return (compatibilityViewport.type === Enums.ViewportType.PLANAR_NEXT &&
        typeof compatibilityViewport.addImages === 'function' &&
        typeof compatibilityViewport.getCurrentImageId === 'function' &&
        typeof compatibilityViewport.render === 'function');
}
function createActorEntry(args) {
    const mapper = vtkImageMapper.newInstance();
    mapper.setInputData(args.imageData);
    const actor = vtkImageSlice.newInstance();
    actor.setMapper(mapper);
    return {
        uid: args.representationUID,
        actor,
        actorMapper: {
            actor,
            mapper,
            renderMode: ActorRenderMode.VTK_IMAGE,
        },
        referencedId: args.referencedId,
        representationUID: args.representationUID,
    };
}
function getOverlayRendererId(viewportId) {
    return `${viewportId}::${OVERLAY_RENDERER_SUFFIX}`;
}
function getOrCreateOverlayRenderer(viewport) {
    const renderingEngine = viewport.getRenderingEngine();
    const offscreenMultiRenderWindow = renderingEngine.getOffscreenMultiRenderWindow(viewport.id);
    const overlayRendererId = getOverlayRendererId(viewport.id);
    const baseRenderer = viewport.getRenderer();
    const baseViewport = baseRenderer.getViewport();
    let overlayRenderer = offscreenMultiRenderWindow.getRenderer(overlayRendererId);
    if (!overlayRenderer) {
        const renderWindow = offscreenMultiRenderWindow.getRenderWindow();
        if (renderWindow.getNumberOfLayers() < 2) {
            renderWindow.setNumberOfLayers(2);
        }
        offscreenMultiRenderWindow.addRenderer({
            viewport: baseViewport,
            id: overlayRendererId,
            background: [0, 0, 0],
        });
        overlayRenderer = offscreenMultiRenderWindow.getRenderer(overlayRendererId);
        overlayRenderer.setLayer(1);
        overlayRenderer.setPreserveDepthBuffer(false);
    }
    overlayRenderer.setActiveCamera(baseRenderer.getActiveCamera());
    overlayRenderer.setViewport(baseViewport[0], baseViewport[1], baseViewport[2], baseViewport[3]);
    return overlayRenderer;
}
function moveActorToOverlayRenderer(viewport, actorEntry) {
    const baseRenderer = viewport.getRenderer();
    const overlayRenderer = getOrCreateOverlayRenderer(viewport);
    baseRenderer.removeActor(actorEntry.actor);
    overlayRenderer.addActor(actorEntry.actor);
}
export function getVolumeLabelmapImageMapperRepresentationUIDs(viewport, segmentationId, segmentation) {
    if (!canRenderVolumeViewportLabelmapAsImage(viewport)) {
        return [];
    }
    const useStablePlanarUID = isPlanarSliceRenderingViewport(viewport);
    return getLabelmaps(segmentation)
        .map((layer) => {
        const volume = getOrCreateLabelmapVolume(layer);
        if (!volume) {
            return;
        }
        const state = getSliceState(viewport, volume);
        if (!state) {
            return;
        }
        return createLabelmapRepresentationUID({
            segmentationId,
            referencedId: layer.labelmapId,
            ...(useStablePlanarUID ? {} : { sliceStateKey: state.key }),
        });
    })
        .filter((value) => !!value);
}
export async function addVolumeLabelmapImageMapperActors(args) {
    const { viewport, segmentation, segmentationId } = args;
    if (!canRenderVolumeViewportLabelmapAsImage(viewport)) {
        return;
    }
    if (isPlanarSliceRenderingViewport(viewport)) {
        await addPlanarLabelmapImageMapperActors({
            viewport,
            segmentation,
            segmentationId,
        });
        return;
    }
    getLabelmaps(segmentation).forEach((layer) => {
        const volume = getOrCreateLabelmapVolume(layer);
        if (!volume) {
            return;
        }
        const sliceData = createSliceImageData(volume, viewport);
        if (!sliceData) {
            return;
        }
        const representationUID = createLabelmapRepresentationUID({
            segmentationId,
            referencedId: layer.labelmapId,
            sliceStateKey: sliceData.state.key,
        });
        const actorEntry = createActorEntry({
            imageData: sliceData.imageData,
            referencedId: layer.labelmapId,
            representationUID,
        });
        viewport.addActor(actorEntry);
        if (viewport.getActor(actorEntry.uid)?.actor === actorEntry.actor) {
            moveActorToOverlayRenderer(viewport, actorEntry);
        }
    });
}
export function updateVolumeLabelmapImageMapperActors(args) {
    const { viewport, segmentation, segmentationId, actorEntries } = args;
    if (!canRenderVolumeViewportLabelmapAsImage(viewport)) {
        return;
    }
    if (isPlanarSliceRenderingViewport(viewport)) {
        updatePlanarLabelmapImageMapperActors({
            viewport,
            segmentation,
            segmentationId,
            actorEntries,
        });
        return;
    }
    const actorEntriesByLabelmapId = new Map((actorEntries ?? viewport.getActors())
        .filter((actorEntry) => isLabelmapRepresentationUID(actorEntry.representationUID, segmentationId))
        .map((actorEntry) => [actorEntry.referencedId, actorEntry]));
    getLabelmaps(segmentation).forEach((layer) => {
        const actorEntry = actorEntriesByLabelmapId.get(layer.labelmapId);
        if (!actorEntry) {
            return;
        }
        const volume = getOrCreateLabelmapVolume(layer);
        if (!volume) {
            return;
        }
        const sliceData = createSliceImageData(volume, viewport);
        if (!sliceData) {
            return;
        }
        const mapper = actorEntry.actor.getMapper();
        mapper.setInputData(sliceData.imageData);
        mapper.modified();
        actorEntry.actor.modified?.();
    });
}
export function removeVolumeLabelmapImageMapperActors(viewport, segmentationId) {
    if (!(viewport.type === Enums.ViewportType.ORTHOGRAPHIC)) {
        return;
    }
    const renderingEngine = viewport.getRenderingEngine();
    const offscreenMultiRenderWindow = renderingEngine.getOffscreenMultiRenderWindow(viewport.id);
    const overlayRenderer = offscreenMultiRenderWindow.getRenderer(getOverlayRendererId(viewport.id));
    if (!overlayRenderer) {
        return;
    }
    const trackedEntries = viewport.getActors();
    trackedEntries
        .filter((actorEntry) => isLabelmapRepresentationUID(actorEntry.representationUID, segmentationId))
        .forEach((actorEntry) => {
        overlayRenderer.removeActor(actorEntry.actor);
    });
    // An actor the viewport no longer tracks is unreachable by any other removal path, so it
    // is garbage regardless of which segmentation minted it. Actors still tracked under a
    // DIFFERENT segmentation are left alone.
    const trackedActors = new Set(trackedEntries.map((actorEntry) => actorEntry.actor));
    overlayRenderer
        .getActors()
        .filter((actor) => !trackedActors.has(actor))
        .forEach((actor) => {
        overlayRenderer.removeActor(actor);
    });
    if (!overlayRenderer.getActors().length) {
        offscreenMultiRenderWindow.removeRenderer(getOverlayRendererId(viewport.id));
    }
}
export function getLabelmapForActorReference(segmentation, referencedId) {
    if (!referencedId) {
        return;
    }
    return (getLabelmap(segmentation, referencedId) ??
        getLabelmapForImageId(segmentation, referencedId) ??
        getLabelmapForVolumeId(segmentation, referencedId) ??
        getLabelmaps(segmentation).find((layer) => layer.volumeId === referencedId));
}
async function addPlanarLabelmapImageMapperActors(args) {
    const { viewport, segmentation, segmentationId } = args;
    for (const [index, layer] of getLabelmaps(segmentation).entries()) {
        const volume = getOrCreateLabelmapVolume(layer);
        if (!volume) {
            continue;
        }
        const sliceData = createSliceImageData(volume, viewport);
        if (!sliceData) {
            continue;
        }
        const currentImageId = viewport.getCurrentImageId() ??
            volume.imageIds[Math.min(Math.max(sliceData.state.sliceIndex, 0), Math.max(volume.imageIds.length - 1, 0))];
        if (!currentImageId) {
            continue;
        }
        const representationUID = createLabelmapRepresentationUID({
            segmentationId,
            referencedId: layer.labelmapId,
        });
        await viewport.addImages([
            {
                dataId: representationUID,
                imageId: currentImageId,
                imageData: sliceData.imageData,
                reference: {
                    kind: 'segmentation',
                    segmentationId,
                    representationUID,
                    labelmapId: layer.labelmapId,
                },
                useWorldCoordinateImageData: true,
                callback: ({ imageActor }) => {
                    const mapper = imageActor.getMapper();
                    const camera = getSliceRenderingCamera(viewport);
                    mapper.setInputData(sliceData.imageData);
                    mapper.modified();
                    if (camera) {
                        applyPlanarOverlayDepthOffset(imageActor, camera.viewPlaneNormal, index + 1);
                    }
                },
            },
        ]);
    }
    viewport.render();
}
function updatePlanarLabelmapImageMapperActors(args) {
    const { viewport, segmentation, segmentationId, actorEntries } = args;
    const actorEntriesByLabelmapId = new Map((actorEntries ?? viewport.getActors())
        .filter((actorEntry) => isLabelmapRepresentationUID(actorEntry.representationUID, segmentationId))
        .map((actorEntry) => [actorEntry.referencedId, actorEntry]));
    getLabelmaps(segmentation).forEach((layer, index) => {
        const actorEntry = actorEntriesByLabelmapId.get(layer.labelmapId);
        if (!actorEntry) {
            return;
        }
        const volume = getOrCreateLabelmapVolume(layer);
        if (!volume) {
            return;
        }
        const sliceData = createSliceImageData(volume, viewport);
        if (!sliceData) {
            return;
        }
        const mapper = actorEntry.actor.getMapper();
        mapper.setInputData(sliceData.imageData);
        mapper.modified();
        const camera = getSliceRenderingCamera(viewport);
        if (camera) {
            applyPlanarOverlayDepthOffset(actorEntry.actor, camera.viewPlaneNormal, index + 1);
        }
        actorEntry.actor.modified?.();
    });
}
