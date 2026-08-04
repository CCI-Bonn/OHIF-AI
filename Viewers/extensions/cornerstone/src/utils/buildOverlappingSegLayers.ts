import type { LabelmapBlock } from '../../../default/src/utils/labelmapBlocks';
import { segmentBlockRange } from '../../../default/src/utils/labelmapBlocks';

/**
 * Normalizes a DICOM-SEG display set into the canonical per-segment multi-block
 * labelmap representation used by AI segmentations: block b holds only segment
 * b+1's voxels (pixel value = segment index), blocks ordered by segment. Blocks are
 * z-cropped to the segment's own extent, so a block is generally SHORTER than the
 * series and its length varies per segment; `LabelmapBlock.referencedImageIds` is
 * what says where it sits. Applies to multi-layer SEGs (overlapping segments) and to
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
 * Layers that already hold a single segment supply that segment's block, but as a SLICED
 * copy — the decoded layer is full length, so it is cut down to the segment's z-range
 * (the layer's own images are left untouched; segDisplaySet.images is built from them).
 * Only packed layers allocate new derived images (via createDerivedImages). Segments
 * declared in metadata but empty in pixels get a minimum-size empty block so block
 * indices stay aligned with segment indices.
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
  blocks: LabelmapBlock[];
}

export async function buildOverlappingSegLayers({
  segmentationId,
  labelMapImages,
  sourceImageIds,
  sortedMatchesDisplay = null,
  segmentIndices = [],
  createDerivedImages,
}: {
  segmentationId: string;
  labelMapImages: SegLayerImage[][];
  sourceImageIds: string[];
  /** Whether cornerstone's sorted volume order matches display order; null means unknown. */
  sortedMatchesDisplay?: boolean | null;
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
  //
  // sourceExtents records each segment's TRUE extent across ALL layers, before any
  // blocksBySegment ownership guard. This is kept permanently: it is the only way to
  // detect DROPPED VOXELS — any check that measures the assembled block agrees with it
  // even when the block is missing data, because the block is what was built.
  const sourceExtents = new Map<number, { lo: number; hi: number }>();
  const noteSourceSlice = (segmentIndex: number, z: number) => {
    const e = sourceExtents.get(segmentIndex);
    if (!e) {
      sourceExtents.set(segmentIndex, { lo: z, hi: z });
      return;
    }
    if (z < e.lo) e.lo = z;
    if (z > e.hi) e.hi = z;
  };

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
          noteSourceSlice(value, z);
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

  // OWNERSHIP: the FIRST layer (in layer order) that contains a segment is the one whose voxels are
  // kept — the assembly loop below claims a segment into blocksBySegment on first sight and every
  // later layer skips it, whether it is single-segment or packed. Extent recording must follow the
  // same rule, or segmentExtents describes a layer whose voxels were never written to any block.
  const ownerLayerForSegment = new Map<number, number>();
  for (let layerIndex = 0; layerIndex < layerSegmentSets.length; layerIndex++) {
    for (const segmentIndex of layerSegmentSets[layerIndex]) {
      if (!ownerLayerForSegment.has(segmentIndex)) {
        ownerLayerForSegment.set(segmentIndex, layerIndex);
      }
    }
  }

  // Per-segment display-space extent, inclusive, of the OWNING layer only — i.e. the extent of the
  // voxels that are actually kept. lo = -1 means the segment has no voxels at all.
  // Derived from scans that already happen: a single-segment layer's slice flags ARE that segment's
  // extent, and packed layers get theirs from the voxel loop that is already running.
  const segmentExtents = new Map<number, { lo: number; hi: number }>();
  const noteSlice = (segmentIndex: number, z: number) => {
    const e = segmentExtents.get(segmentIndex);
    if (!e) {
      segmentExtents.set(segmentIndex, { lo: z, hi: z });
      return;
    }
    if (z < e.lo) e.lo = z;
    if (z > e.hi) e.hi = z;
  };

  for (let layerIndex = 0; layerIndex < labelMapImages.length; layerIndex++) {
    const layerSegments = layerSegmentSets[layerIndex];
    if (layerSegments.size !== 1) continue;
    const [only] = layerSegments;
    // Same ownership rule Pass A applies to packed layers: an earlier layer already owns this
    // segment, so this layer's voxels go to no block and must not widen its extent. Without this,
    // a segment split across two layers had segmentExtents silently cover BOTH — which both
    // over-sized the owning block and made the data-loss check below unable to see the loss.
    if (ownerLayerForSegment.get(only) !== layerIndex) continue;
    const flags = layerSliceHasSegment[layerIndex];
    for (let z = 0; z < flags.length; z++) {
      if (flags[z]) noteSlice(only, z);
    }
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
    // NOTE: a single-segment SEG never reaches the block-building code below, so it gets NO
    // sparse blocks from this work — it uses the legacy full-length flat representation.
    return null;
  }

  // Assemble one block per segment index. Single-segment layers are reused as-is;
  // packed layers are split into fresh per-segment blocks; declared-but-empty
  // segments get an empty block to preserve block index === segmentIndex - 1.
  const blocksBySegment = new Map<number, SegLayerImage[]>();
  // Display-space slice offset of each split block, i.e. the block's own `sliceStart`. The split
  // pass writes by ABSOLUTE slice index z, so it needs this to translate z into a block index.
  // Presence in this map also marks a block as "already allocated cropped", which the assembly
  // loop below uses to tell it apart from a full-length reused layer that still needs slicing.
  const splitBlockOffsets = new Map<number, number>();
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
      const sliceHasSegment = layerSliceHasSegment[layerIndex];

      // A packed layer's per-segment extents are not known before this point: a single-segment
      // layer's slice flags ARE its segment's extent, but a packed layer's flags say only that
      // SOME segment is present. So the voxels must be read twice — once to size the blocks, once
      // to fill them. Merging the two would allocate against an empty extent map, silently giving
      // every packed segment a MIN_BLOCK_SLICES block and dropping most of its mask.
      // Packed layers are the minority of SEG reloads; correctness beats the saved scan.

      // PASS A — extents only. Must complete before allocation: block size depends on it.
      for (let z = 0; z < sliceCount; z++) {
        if (!sliceHasSegment[z]) {
          continue;
        }
        const sourceData = labelMapImages[layerIndex][z].voxelManager?.getScalarData();
        if (!sourceData) {
          continue;
        }
        for (let i = 0; i < sourceData.length; i++) {
          const value = sourceData[i] as number;
          // The `has` guard mirrors Pass B's skip: a segment already owned by an earlier layer
          // keeps that layer's block, so this layer's voxels must not widen its extent. Equivalent
          // to the pre-pass's ownerLayerForSegment test — blocksBySegment holds exactly the
          // segments claimed by layers before this one.
          if (value !== 0 && !blocksBySegment.has(value)) {
            noteSlice(value, z);
          }
        }
      }

      // PASS B — allocate each segment's block over its own cropped range.
      const splitBlocks = new Map<number, SegLayerImage[]>();
      for (const segmentIndex of layerSegments) {
        if (blocksBySegment.has(segmentIndex)) {
          continue;
        }
        const sExt = segmentExtents.get(segmentIndex) ?? { lo: -1, hi: -1 };
        const sRange = segmentBlockRange(sExt.lo, sExt.hi, sliceCount, sortedMatchesDisplay);
        const blockImages = await createDerivedImages(
          sourceImageIds.slice(sRange.sliceStart, sRange.sliceEnd)
        );
        splitBlocks.set(segmentIndex, blockImages);
        blocksBySegment.set(segmentIndex, blockImages);
        splitBlockOffsets.set(segmentIndex, sRange.sliceStart);
      }

      // PASS C — copy voxels, indexing each block through its own offset.
      for (let z = 0; z < sliceCount; z++) {
        // All-zero source slice: nothing to copy, target blocks stay zeroed.
        if (!sliceHasSegment[z]) {
          continue;
        }
        const sourceData = labelMapImages[layerIndex][z].voxelManager?.getScalarData();
        if (!sourceData) {
          continue;
        }
        // Dense value-indexed lookup — cheaper than a Map.get per nonzero voxel. A segment whose
        // block does not cover this slice is left undefined, so its voxels here are skipped.
        const targetByValue: (ArrayLike<number> | undefined)[] = new Array(maxSegmentIndex + 1);
        for (const [segmentIndex, blockImages] of splitBlocks) {
          const ai = z - (splitBlockOffsets.get(segmentIndex) ?? 0);
          targetByValue[segmentIndex] =
            ai >= 0 && ai < blockImages.length
              ? blockImages[ai].voxelManager?.getScalarData()
              : undefined;
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
          const ai = z - (splitBlockOffsets.get(segmentIndex) ?? 0);
          if (ai >= 0 && ai < blockImages.length && targetByValue[segmentIndex]) {
            blockImages[ai].voxelManager?.setScalarData?.(targetByValue[segmentIndex]);
          }
        }
      }
    }
  }

  // Segments declared in metadata but absent from pixels get an explicit empty extent, so the
  // block-assembly loop below has one uniform source of truth to consult.
  for (let segmentIndex = 1; segmentIndex <= maxSegmentIndex; segmentIndex++) {
    if (!segmentExtents.has(segmentIndex)) {
      segmentExtents.set(segmentIndex, { lo: -1, hi: -1 });
    }
  }

  const labelmaps: Record<string, object> = {};
  const segmentBindings: Record<number, { labelmapId: string; labelValue: number }> = {};
  const allImageIds: string[] = [];
  const blocks: LabelmapBlock[] = [];
  const primaryLabelmapId = `${segmentationId}-storage-0`;
  let primaryImageIds: string[] = [];

  for (let segmentIndex = 1; segmentIndex <= maxSegmentIndex; segmentIndex++) {
    // The block's z-crop. Computed from the same inputs the split pass used, so a split block's
    // range here is by construction the one it was allocated at.
    const ext = segmentExtents.get(segmentIndex) ?? { lo: -1, hi: -1 };
    const range = segmentBlockRange(ext.lo, ext.hi, sliceCount, sortedMatchesDisplay);

    let blockImages = blocksBySegment.get(segmentIndex);
    if (!blockImages) {
      // Declared-but-empty segment: the smallest legal block, not a full-series slab of zeros.
      blockImages = await createDerivedImages(
        sourceImageIds.slice(range.sliceStart, range.sliceEnd)
      );
    } else if (splitBlockOffsets.has(segmentIndex)) {
      // Already allocated at the cropped size by the split loop — take as-is.
    } else {
      // Reused decoded layer: it is full length, so slice it down. Never reallocate or reverse in
      // place — these images belong to the display set (segDisplaySet.images is built from them).
      // The out-of-range images stay in cache for that reason, so this frees no image memory; the
      // win is the per-block MPR volume, which is built from exactly these ids.
      blockImages = blockImages.slice(range.sliceStart, range.sliceEnd);
    }
    const blockImageIds = blockImages.map(image => image.imageId);

    // Cornerstone maps labelmap image k -> referencedImageIds[k] by index, so derive
    // the reference list from each block image's own referencedImageId (order-safe); fall back to
    // the block's OWN display slice range if any is missing. The whole-series list is not a legal
    // substitute for a cropped block — it would pair block slice 0 with display slice 0 and render
    // the mask at the wrong depth, so the fallback is per-block.
    //
    // Only `refIds.every(Boolean)` does any work here: `refIds` is `blockImages.map(...)` on the
    // line above, so the length comparison against `blockImages` is a tautology. It is kept purely
    // to mirror `refIdsFor` in the AI path (commandsModule), where the two arrays have independent
    // origins and the length test is real — do not read it as a per-block length check.
    const refIds = blockImages.map(image => image.referencedImageId);
    const referencedImageIds =
      refIds.length === blockImages.length && refIds.every(Boolean)
        ? (refIds as string[])
        : sourceImageIds.slice(range.sliceStart, range.sliceEnd);

    // Normalise the cropped block to WORKING order, so its array index equals the cornerstone
    // volume z index. imageIds and referencedImageIds reverse together to stay index-aligned.
    const orderedImageIds = range.reverse ? blockImageIds.slice().reverse() : blockImageIds;
    const orderedRefIds = range.reverse
      ? (referencedImageIds as string[]).slice().reverse()
      : (referencedImageIds as string[]);

    const labelmapId =
      segmentIndex === 1 ? primaryLabelmapId : `${segmentationId}-private-${segmentIndex}`;
    labelmaps[labelmapId] = {
      labelmapId,
      type: 'stack',
      imageIds: orderedImageIds,
      referencedImageIds: orderedRefIds,
      labelToSegmentIndex: {},
    };
    segmentBindings[segmentIndex] = { labelmapId, labelValue: segmentIndex };

    blocks.push({
      segmentIndex,
      z0: range.z0,
      imageIds: orderedImageIds,
      referencedImageIds: orderedRefIds,
    });

    if (segmentIndex === 1) {
      primaryImageIds = orderedImageIds;
    }
    allImageIds.push(...orderedImageIds);

    // Permanent data-loss check: kept while everything around it was removed because it is the only
    // check that can detect dropped voxels. Any check that measures the assembled block agrees with
    // it even when the block is missing data — sourceExtents is recorded before ANY ownership
    // guard, so it captures what the source contained, while segmentExtents records only the
    // OWNING layer, i.e. what was kept. The two diverge exactly when voxels are lost.
    // A segment present in multiple layers has its voxels from every layer after the first written
    // to no block, so its mask renders cut off in z.
    // This fires for all three orderings — single+single, packed-then-single, single-then-packed —
    // because both the packed Pass A guard and the single-segment pre-pass now apply the same
    // first-layer ownership rule.
    //
    // LIMIT worth knowing: an extent comparison can only see loss that CHANGES the z-range. If a
    // later layer's copy of the segment falls entirely INSIDE the owner's z-range, its voxels are
    // dropped by the same ownership rule and this check stays silent. So a clean run means no
    // segment lost slices at its ends -- not that no voxels were lost at all.
    const se = sourceExtents.get(segmentIndex);
    const be = segmentExtents.get(segmentIndex);
    if (se && be && be.lo >= 0 && (se.lo < be.lo || se.hi > be.hi)) {
      console.error(
        `SEG reload: segment ${segmentIndex} has voxels in source slices [${se.lo}..${se.hi}] ` +
        `but only [${be.lo}..${be.hi}] was kept — the z-extent of the layer that OWNS this ` +
        `segment. Slices outside that range were dropped. Cause: segment appears in multiple ` +
        `layers; only the first layer's voxels are kept. (The allocated block is the grid-snapped ` +
        `form of the owning extent and so is usually wider; enlarging it would not recover them.)`
      );
    }
  }

  return {
    labelmaps,
    segmentBindings,
    primaryLabelmapId,
    primaryImageIds,
    allImageIds,
    blocks,
    firstSegmentedSliceImageId,
  };
}
