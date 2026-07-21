/**
 * Normalizes a DICOM-SEG display set into the canonical per-segment multi-block
 * labelmap representation used by AI segmentations: block b holds only segment
 * b+1's voxels (N images per block, pixel value = segment index), blocks ordered
 * by segment. Applies to multi-layer SEGs (overlapping segments) and to
 * single-layer SEGs whose one layer packs multiple segments (or a segment
 * numbered != 1); only a single layer holding exactly segment 1 keeps the
 * legacy flat representation.
 *
 * The SEG adapter packs overlapping segments into layers greedily — a layer may hold
 * several non-colliding segments, and layerCount != segmentCount. Registering those
 * layers directly breaks two things: the MPR volume path merges a single flat layer
 * into one value-per-voxel volume (overlaps destroyed), and the nnInteractive refine
 * flow assumes block b <-> segment b+1 when it clears/replaces the active segment's
 * block. Splitting packed layers into per-segment blocks fixes both: MPR mounts one
 * volume per block, and refine/undo/export see the exact structure
 * buildMultiBlockLabelmapRepresentation produces.
 *
 * Layers that already hold a single segment are reused as that segment's block;
 * only packed layers allocate new derived images (via createDerivedImages). Segments
 * declared in metadata but empty in pixels get an empty block so block indices stay
 * aligned with segment indices.
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

export async function buildOverlappingSegLayers({
  segmentationId,
  labelMapImages,
  sourceImageIds,
  segmentIndices = [],
  createDerivedImages,
}: {
  segmentationId: string;
  labelMapImages: SegLayerImage[][];
  sourceImageIds: string[];
  segmentIndices?: number[];
  createDerivedImages: (sourceImageIds: string[]) => Promise<SegLayerImage[]> | SegLayerImage[];
}): Promise<OverlappingSegLayerResult | null> {
  if (!labelMapImages?.length) {
    return null;
  }

  const sliceCount = sourceImageIds.length;
  if (labelMapImages.some(layerImages => layerImages.length !== sliceCount)) {
    // Unexpected adapter output — fall back to the legacy flat path rather than
    // build blocks with a broken image->slice mapping.
    return null;
  }

  // Scan each layer once: which segments it holds, and the first segmented slice
  // in adapter (layer-major) order — parity with the legacy hydration loop.
  const layerSegmentSets: Set<number>[] = [];
  let firstSegmentedSliceImageId: string | null = null;
  // Per layer, per slice: whether the slice holds any segment voxels. Lets the
  // split pass below skip all-zero slices instead of re-reading them.
  const layerSliceHasSegment: boolean[][] = [];
  for (const layerImages of labelMapImages) {
    const layerSegments = new Set<number>();
    const sliceHasSegmentFlags: boolean[] = new Array(layerImages.length).fill(false);
    for (let z = 0; z < layerImages.length; z++) {
      const image = layerImages[z];
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
      sliceHasSegmentFlags[z] = sliceHasSegment;
      if (sliceHasSegment && !firstSegmentedSliceImageId) {
        firstSegmentedSliceImageId = image.referencedImageId ?? null;
      }
    }
    layerSegmentSets.push(layerSegments);
    layerSliceHasSegment.push(sliceHasSegmentFlags);
  }

  const maxSegmentIndex = Math.max(
    0,
    ...segmentIndices.filter(index => Number.isFinite(index) && index > 0),
    ...layerSegmentSets.flatMap(set => Array.from(set))
  );
  if (maxSegmentIndex === 0) {
    return null;
  }

  // A single layer holding only segment 1 already satisfies the canonical
  // block b <-> segment b+1 invariant — keep the legacy path. Any other single
  // layer (multiple segments packed together, or one segment numbered != 1)
  // must be split: the refine flow clears/replaces block segmentNumber-1, so a
  // shared block makes refines stack on top of the old mask (segment >= 2) or
  // wipe the other segments (segment 1).
  if (labelMapImages.length === 1 && maxSegmentIndex <= 1) {
    return null;
  }

  // Assemble one block per segment index. Single-segment layers are reused as-is;
  // packed layers are split into fresh per-segment blocks; declared-but-empty
  // segments get an empty block to preserve block index === segmentIndex - 1.
  const blocksBySegment = new Map<number, SegLayerImage[]>();
  for (let layerIndex = 0; layerIndex < labelMapImages.length; layerIndex++) {
    const layerSegments = layerSegmentSets[layerIndex];
    if (layerSegments.size === 1) {
      const [segmentIndex] = layerSegments;
      if (!blocksBySegment.has(segmentIndex)) {
        blocksBySegment.set(segmentIndex, labelMapImages[layerIndex]);
      }
      continue;
    }
    if (layerSegments.size > 1) {
      const splitBlocks = new Map<number, SegLayerImage[]>();
      for (const segmentIndex of layerSegments) {
        if (!blocksBySegment.has(segmentIndex)) {
          const blockImages = await createDerivedImages(sourceImageIds);
          splitBlocks.set(segmentIndex, blockImages);
          blocksBySegment.set(segmentIndex, blockImages);
        }
      }
      const sliceHasSegment = layerSliceHasSegment[layerIndex];
      for (let z = 0; z < sliceCount; z++) {
        // All-zero source slice: nothing to copy, target blocks stay zeroed.
        if (!sliceHasSegment[z]) {
          continue;
        }
        const sourceData = labelMapImages[layerIndex][z].voxelManager?.getScalarData();
        if (!sourceData) {
          continue;
        }
        // Dense value-indexed lookup — cheaper than a Map.get per nonzero voxel.
        const targetByValue: (ArrayLike<number> | undefined)[] = new Array(maxSegmentIndex + 1);
        for (const [segmentIndex, blockImages] of splitBlocks) {
          targetByValue[segmentIndex] = blockImages[z].voxelManager?.getScalarData();
        }
        for (let i = 0; i < sourceData.length; i++) {
          const value = sourceData[i] as number;
          if (value !== 0) {
            const target = targetByValue[value];
            if (target) {
              (target as number[])[i] = value;
            }
          }
        }
        for (const [segmentIndex, blockImages] of splitBlocks) {
          if (targetByValue[segmentIndex]) {
            blockImages[z].voxelManager?.setScalarData?.(targetByValue[segmentIndex]);
          }
        }
      }
    }
  }

  const labelmaps: Record<string, object> = {};
  const segmentBindings: Record<number, { labelmapId: string; labelValue: number }> = {};
  const allImageIds: string[] = [];
  const primaryLabelmapId = `${segmentationId}-storage-0`;
  let primaryImageIds: string[] = [];

  for (let segmentIndex = 1; segmentIndex <= maxSegmentIndex; segmentIndex++) {
    let blockImages = blocksBySegment.get(segmentIndex);
    if (!blockImages) {
      blockImages = await createDerivedImages(sourceImageIds);
    }
    const blockImageIds = blockImages.map(image => image.imageId);

    // Cornerstone maps labelmap image k -> referencedImageIds[k] by index, so derive
    // the reference list from each block image's own referencedImageId (order-safe);
    // fall back to the source ordering if any is missing.
    const refIds = blockImages.map(image => image.referencedImageId);
    const referencedImageIds =
      refIds.length === sliceCount && refIds.every(Boolean)
        ? (refIds as string[])
        : sourceImageIds;

    const labelmapId =
      segmentIndex === 1 ? primaryLabelmapId : `${segmentationId}-private-${segmentIndex}`;
    labelmaps[labelmapId] = {
      labelmapId,
      type: 'stack',
      imageIds: blockImageIds,
      referencedImageIds,
      labelToSegmentIndex: {},
    };
    segmentBindings[segmentIndex] = { labelmapId, labelValue: segmentIndex };

    if (segmentIndex === 1) {
      primaryImageIds = blockImageIds;
    }
    allImageIds.push(...blockImageIds);
  }

  return {
    labelmaps,
    segmentBindings,
    primaryLabelmapId,
    primaryImageIds,
    allImageIds,
    firstSegmentedSliceImageId,
  };
}
