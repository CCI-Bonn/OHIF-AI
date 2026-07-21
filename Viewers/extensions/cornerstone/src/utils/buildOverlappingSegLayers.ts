/**
 * Builds a multi-block labelmap representation for a DICOM-SEG display set whose
 * adapter returned multiple overlap layers (labelMapImages.length > 1).
 *
 * The SEG adapter packs overlapping segments into layers, each layer holding one
 * derived labelmap image per source slice (pixel value = segment index). Flattening
 * those layers into a single labelmap makes cornerstone's volume path merge them
 * into one value-per-voxel volume, which destroys overlaps in MPR. Registering each
 * layer as its own labelmap block (same scheme buildMultiBlockLabelmapRepresentation
 * uses for AI segmentations) lets the volume render plan mount one volume per layer,
 * preserving overlaps.
 */

interface SegLayerImage {
  imageId: string;
  referencedImageId?: string;
  voxelManager?: {
    getScalarData: () => ArrayLike<number>;
    setScalarData?: (data) => void;
  };
}

interface OverlappingSegLayerResult {
  labelmaps: Record<string, object>;
  segmentBindings: Record<number, { labelmapId: string; labelValue: number }>;
  primaryLabelmapId: string;
  primaryImageIds: string[];
  allImageIds: string[];
  firstSegmentedSliceImageId: string | null;
}

export function buildOverlappingSegLayers({
  segmentationId,
  labelMapImages,
  sourceImageIds,
}: {
  segmentationId: string;
  labelMapImages: SegLayerImage[][];
  sourceImageIds: string[];
}): OverlappingSegLayerResult | null {
  if (!labelMapImages || labelMapImages.length <= 1) {
    return null;
  }

  const primaryLabelmapId = `${segmentationId}-storage-0`;
  const labelmaps: Record<string, object> = {};
  const segmentBindings: Record<number, { labelmapId: string; labelValue: number }> = {};
  const allImageIds: string[] = [];
  let primaryImageIds: string[] = [];
  let firstSegmentedSliceImageId: string | null = null;

  labelMapImages.forEach((layerImages, layerIndex) => {
    const labelmapId =
      layerIndex === 0 ? primaryLabelmapId : `${segmentationId}-seg-layer-${layerIndex}`;
    const layerImageIds: string[] = [];
    const layerSegments = new Set<number>();

    for (const image of layerImages) {
      layerImageIds.push(image.imageId);
      const voxelManager = image.voxelManager;
      if (!voxelManager) {
        continue;
      }
      const scalarData = voxelManager.getScalarData();
      voxelManager.setScalarData?.(scalarData);

      let sliceHasSegment = false;
      for (let i = 0; i < scalarData.length; i++) {
        const value = scalarData[i] as number;
        if (value !== 0) {
          layerSegments.add(value);
          sliceHasSegment = true;
        }
      }
      if (sliceHasSegment && !firstSegmentedSliceImageId) {
        firstSegmentedSliceImageId = image.referencedImageId ?? null;
      }
    }

    // Cornerstone maps labelmap image k -> referencedImageIds[k] by index, so derive
    // the reference list from each layer image's own referencedImageId (order-safe);
    // fall back to the source ordering if any is missing.
    const refIds = layerImages.map(image => image.referencedImageId);
    const referencedImageIds =
      refIds.length === sourceImageIds.length && refIds.every(Boolean)
        ? (refIds as string[])
        : sourceImageIds;

    labelmaps[labelmapId] = {
      labelmapId,
      type: 'stack',
      imageIds: layerImageIds,
      referencedImageIds,
      labelToSegmentIndex: {},
    };

    if (layerIndex === 0) {
      primaryImageIds = layerImageIds;
    }
    allImageIds.push(...layerImageIds);

    for (const segmentIndex of layerSegments) {
      // A segment lives wholly in one layer; keep the first binding if ever duplicated.
      if (!segmentBindings[segmentIndex]) {
        segmentBindings[segmentIndex] = { labelmapId, labelValue: segmentIndex };
      }
    }
  });

  return {
    labelmaps,
    segmentBindings,
    primaryLabelmapId,
    primaryImageIds,
    allImageIds,
    firstSegmentedSliceImageId,
  };
}
