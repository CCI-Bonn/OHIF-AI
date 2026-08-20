import vtkDataArray from '@kitware/vtk.js/Common/Core/DataArray';
import vtkImageData from '@kitware/vtk.js/Common/DataModel/ImageData';
import { ActorRenderMode, cache, utilities, } from '@cornerstonejs/core';
import { triggerSegmentationRender } from '../../../stateManagement/segmentation/SegmentationRenderingEngine';
import { updateLabelmapSegmentationImageReferences } from '../../../stateManagement/segmentation/updateLabelmapSegmentationImageReferences';
import { getCurrentLabelmapImageIdsForViewport } from '../../../stateManagement/segmentation/getCurrentLabelmapImageIdForViewport';
import { getLabelmapActorEntries } from '../../../stateManagement/segmentation/helpers/getSegmentationActor';
import getViewportLabelmapRenderMode from '../../../stateManagement/segmentation/helpers/getViewportLabelmapRenderMode';
import { createLabelmapRepresentationUID } from './labelmapRepresentationUID';
import removeLabelmapRepresentationData from './removeLabelmapRepresentationData';
// PROJECT OVERRIDE. Upstream stamped every layer's vtkImageData with the CURRENTLY VIEWED
// slice's origin (imageData.setOrigin(currentOrigin)) and never revisited an actor's origin
// on update. Both are only correct when the resolved labelmap image really belongs to the
// current slice; whenever the resolver hands back an image for a different slice (its
// isReferenceViewable fallback can), the overlay is drawn at the wrong z — the "ghost copy"
// failure mode of z-cropped multi-block labelmaps. A derived labelmap image carries its own
// referenced slice's plane metadata, so its own origin is always the right one: identical to
// currentOrigin in the healthy case, and the true position (instead of a ghost) otherwise.
export function syncStackLabelmapActors(viewport, segmentationId) {
    if (typeof viewport
        .getCurrentImageId !== 'function') {
        return;
    }
    const currentImageId = viewport.getCurrentImageId();
    if (!currentImageId) {
        return;
    }
    updateLabelmapSegmentationImageReferences(viewport.id, segmentationId);
    const derivedImageIds = getCurrentLabelmapImageIdsForViewport(viewport.id, segmentationId) ?? [];
    const derivedImageIdSet = new Set(derivedImageIds);
    const labelmapActorEntries = getLabelmapActorEntries(viewport.id, segmentationId) ?? [];
    const staleActorEntries = labelmapActorEntries.filter((actorEntry) => !derivedImageIdSet.has(actorEntry.referencedId));
    let shouldTriggerSegmentationRender = false;
    let shouldRenderViewport = staleActorEntries.length > 0;
    if (staleActorEntries.length) {
        const legacyActorEntryUIDs = [];
        staleActorEntries.forEach((actorEntry) => {
            if (removeLabelmapRepresentationData(viewport, segmentationId, actorEntry)) {
                return;
            }
            legacyActorEntryUIDs.push(actorEntry.uid);
        });
        if (legacyActorEntryUIDs.length) {
            viewport.removeActors(legacyActorEntryUIDs);
        }
        shouldTriggerSegmentationRender = true;
    }
    const renderMode = getViewportLabelmapRenderMode(viewport);
    const defaultActorRenderMode = viewport.getDefaultActor()?.actorMapper
        ?.renderMode;
    derivedImageIds.forEach((derivedImageId) => {
        const derivedImage = cache.getImage(derivedImageId);
        if (!derivedImage) {
            console.warn('No derived image found in the cache for segmentation representation', { segmentationId, derivedImageId });
            return;
        }
        const segmentationActorEntry = getLabelmapActorEntries(viewport.id, segmentationId)?.find((actorEntry) => actorEntry.referencedId === derivedImageId);
        if (!segmentationActorEntry) {
            const representationUID = createLabelmapRepresentationUID({
                segmentationId,
                referencedId: derivedImage.imageId,
            });
            if (renderMode === 'image' &&
                defaultActorRenderMode === ActorRenderMode.CPU_IMAGE) {
                viewport.addImages([
                    {
                        dataId: representationUID,
                        imageId: derivedImageId,
                        reference: {
                            kind: 'segmentation',
                            segmentationId,
                            representationUID,
                            labelmapId: derivedImage.imageId,
                        },
                        representationUID,
                    },
                ]);
            }
            else {
                const { dimensions, spacing, direction, origin } = viewport.getImageDataMetadata(derivedImage);
                const constructor = derivedImage.voxelManager.getConstructor();
                const newPixelData = derivedImage.voxelManager.getScalarData();
                const values = new constructor(newPixelData);
                const scalarArray = vtkDataArray.newInstance({
                    dataType: vtkDataArray.getDataType(values),
                    name: 'Pixels',
                    numberOfComponents: 1,
                    values,
                });
                const imageData = vtkImageData.newInstance();
                imageData.setDimensions(dimensions[0], dimensions[1], 1);
                imageData.setSpacing(spacing);
                imageData.setDirection(direction);
                imageData.setOrigin(origin);
                imageData.getPointData().setScalars(scalarArray);
                imageData.modified();
                viewport.addImages([
                    {
                        dataId: representationUID,
                        imageId: derivedImageId,
                        reference: {
                            kind: 'segmentation',
                            segmentationId,
                            representationUID,
                            labelmapId: derivedImage.imageId,
                        },
                        representationUID,
                        callback: ({ imageActor }) => {
                            imageActor.getMapper().setInputData(imageData);
                        },
                    },
                ]);
            }
            shouldTriggerSegmentationRender = true;
            shouldRenderViewport = true;
            return;
        }
        const actorMapper = segmentationActorEntry.actorMapper;
        const mapper = actorMapper?.mapper
            ? actorMapper.mapper
            : segmentationActorEntry.actor.getMapper();
        const segmentationImageData = mapper.getInputData();
        segmentationImageData.modified();
        if (segmentationImageData.setDerivedImage) {
            segmentationImageData.setDerivedImage(derivedImage);
        }
        else {
            utilities.updateVTKImageDataWithCornerstoneImage(segmentationImageData, derivedImage);
            const { origin } = viewport.getImageDataMetadata(derivedImage);
            segmentationImageData.setOrigin(origin);
        }
        shouldRenderViewport = true;
    });
    if (shouldTriggerSegmentationRender) {
        triggerSegmentationRender(viewport.id);
    }
    if (shouldRenderViewport) {
        viewport.render();
    }
}
