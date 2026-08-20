import { ActorRenderMode, Enums, cache, utilities, } from '@cornerstonejs/core';
import { createLabelmapRepresentationUID } from '../labelmapRepresentationUID';
function isPlanarNextVolumeViewport(viewport) {
    const genericViewport = viewport;
    return (genericViewport.type === Enums.ViewportType.PLANAR_NEXT &&
        typeof genericViewport.getVolumeId === 'function' &&
        typeof genericViewport.getViewReference === 'function' &&
        typeof genericViewport.getViewState === 'function' &&
        typeof genericViewport.addDisplaySet === 'function' &&
        typeof genericViewport.setDisplaySetPresentation === 'function' &&
        typeof genericViewport.setViewReference === 'function');
}
// PROJECT OVERRIDE. Upstream seeds each overlay display set with
// `initialImageIdIndex = min(viewport current index, layer length - 1)` — an index into the
// VIEWPORT'S source stack clamped into the LAYER'S own imageIds. That only lines up when the
// layer spans the source stack 1:1; a z-cropped block (160 of 694 slices) gets an unrelated
// block-local slice. The current source image is instead mapped through the layer's
// referencedImageIds; when the block does not cover the current slice the index is omitted,
// which the planar viewport supports (setViewReference below places the overlay
// geometrically). Layers without referencedImageIds keep upstream's behavior.
async function addLabelmapToPlanarGenericViewport(args) {
    const { blendMode, labelmapLayers, segmentationId, viewport, visibility } = args;
    const sourceVolumeRenderMode = getPlanarNextVolumeRenderMode(viewport);
    if (!sourceVolumeRenderMode) {
        return;
    }
    const sourceVolumeId = viewport.getVolumeId();
    const sourceViewReference = sourceVolumeId
        ? viewport.getViewReference({ volumeId: sourceVolumeId })
        : viewport.getViewReference();
    const requestedOrientation = viewport.getViewState().orientation;
    const currentImageIdIndex = Math.max(0, viewport.getCurrentImageIdIndex?.() ?? 0);
    const currentSourceImageId = viewport.getCurrentImageId?.();
    let firstActorEntry;
    for (const layer of labelmapLayers) {
        if (!layer.volumeId) {
            continue;
        }
        const volume = cache.getVolume(layer.volumeId);
        if (!volume) {
            throw new Error(`imageVolume with id: ${layer.volumeId} does not exist, you need to create/allocate the volume first`);
        }
        const representationUID = createLabelmapRepresentationUID({
            segmentationId,
            referencedId: layer.labelmapId,
        });
        const dataId = representationUID;
        const referencedImageIds = layer.referencedImageIds;
        let initialImageIdIndex;
        if (Array.isArray(referencedImageIds) && referencedImageIds.length) {
            const mappedIndex = currentSourceImageId
                ? referencedImageIds.indexOf(currentSourceImageId)
                : -1;
            initialImageIdIndex = mappedIndex >= 0 ? mappedIndex : undefined;
        }
        else {
            initialImageIdIndex = Math.min(currentImageIdIndex, Math.max(volume.imageIds.length - 1, 0));
        }
        utilities.genericViewportDataSetMetadataProvider.add(dataId, {
            kind: 'planar',
            imageIds: volume.imageIds,
            initialImageIdIndex,
            reference: {
                kind: 'segmentation',
                segmentationId,
                representationUID,
                labelmapId: layer.labelmapId,
            },
            volumeId: layer.volumeId,
        });
        await viewport.addDisplaySet(dataId, {
            orientation: requestedOrientation,
            role: 'overlay',
        });
        viewport.setDisplaySetPresentation(dataId, {
            blendMode,
            visible: visibility,
        });
        firstActorEntry ||= viewport
            .getActors?.()
            .find((actorEntry) => actorEntry.representationUID === representationUID);
    }
    viewport.setViewReference(sourceViewReference);
    viewport.render?.();
    if (firstActorEntry) {
        return {
            uid: firstActorEntry.uid,
            actor: firstActorEntry.actor,
        };
    }
}
function getPlanarNextVolumeRenderMode(viewport) {
    const renderMode = viewport.getDefaultActor?.()?.actorMapper?.renderMode;
    if (renderMode === ActorRenderMode.CPU_VOLUME ||
        renderMode === ActorRenderMode.VTK_VOLUME_SLICE) {
        return renderMode;
    }
}
export { addLabelmapToPlanarGenericViewport, isPlanarNextVolumeViewport, };
