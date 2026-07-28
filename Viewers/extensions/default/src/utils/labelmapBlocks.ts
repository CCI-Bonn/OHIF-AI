/**
 * Pure block-list and index math for the multi-block labelmap scheme.
 *
 * Each AI segment owns a BLOCK: a contiguous run of derived labelmap images covering the slices
 * its mask touches. Blocks used to be uniform — every segment allocated one image per series slice
 * (~84 MB) though a typical mask covers ~40 of 321 — so block boundaries could be recovered by
 * arithmetic (`Math.floor(i / N)`). They can be z-cropped now, so the block list is the source of
 * truth and that arithmetic is gone.
 *
 * This module deliberately imports NOTHING: it is the only part of the scheme that is unit-testable
 * in isolation, and pulling in OHIF or Cornerstone would break that.
 *
 * TWO COORDINATE SPACES, never conflated:
 *   working — index into a block's imageIds array, and the Cornerstone volume's z index. The server's
 *             crop geometry (segZ0/segZ1) is in working indices INTO THE FULL SERIES.
 *   display — index into the source series imageIds. z_range and cachedStats.dirtySlices use this.
 * They differ only for a flipped series, where `w = N - 1 - d`. N is ALWAYS the full series length,
 * never a block's length.
 */

export type LabelmapBlock = {
  /** Segment this block holds the mask for. */
  segmentIndex: number;
  /** Working-order index of the block's first slice within the full series. */
  z0: number;
  /** Derived labelmap image ids, in working order. */
  imageIds: string[];
  /**
   * The block's SOURCE (series) slices, in WORKING order and index-aligned with `imageIds`.
   *
   * Cornerstone pairs labelmap image k with referencedImageIds[k] strictly by index, so this is the
   * ground truth for where the block sits in the series. It is carried on the block because the only
   * other source — each cached labelmap image's own `referencedImageId` — disappears if those images
   * are LRU-purged, and the whole-series list is NOT a safe substitute for a z-cropped block (it
   * would pair block slice 0 with display slice 0 and render the mask at the wrong depth).
   */
  referencedImageIds?: string[];
};

/**
 * Shortest block we will allocate. calculateSpacingBetweenImageIds cannot derive z-spacing from a
 * single image and falls back to sliceThickness, which can disagree with the series' real spacing
 * and mis-size the volume. Two slices let it measure the gap.
 */
export const MIN_BLOCK_SLICES = 2;

/**
 * Grid that fresh block bounds snap to. Allocating a block to the mask's EXACT extent meant an
 * nnInteractive mask — which grows a little on each refine — outgrew its block every time, and each
 * reallocation changes imageIds, which forces a remount, which builds a new MPR volume and orphans
 * the old one. Rounding out to a grid keeps that growth inside the block the segment already has.
 * 32 slices is a bounded waste (<32 per side) against a typical ~40-slice mask, and it makes block
 * lengths cluster on a handful of values rather than taking arbitrary ones.
 */
export const BLOCK_GRID_SLICES = 32;

/**
 * Snap a working range outward onto a fixed grid, so a slowly-growing mask keeps fitting the
 * block it already has instead of reallocating (and remounting, and orphaning an MPR volume)
 * on every refine. Lower bound rounds DOWN to a multiple of `grid`, upper bound rounds UP.
 * Result is clamped to [0, sourceCount] and is always a superset of the input range.
 *
 * This is for ALLOCATION only. Containment must still be tested against the mask's own range:
 * an existing block can legitimately cover the mask without covering the whole grid cell, and
 * testing the snapped range would reallocate in exactly the case this function exists to avoid.
 */
export function snapRangeToGrid(
  w0: number,
  w1: number,
  sourceCount: number,
  grid: number
): [number, number] {
  const count = Math.max(0, sourceCount);
  const a = Math.max(0, Math.min(w0, count));
  const b = Math.max(a, Math.min(w1, count));
  // An unusable grid degrades to the clamped input rather than producing NaN bounds — the caller
  // has already applied MIN_BLOCK_SLICES, so the range is still allocatable.
  if (!Number.isFinite(grid) || grid <= 0) {
    return [a, b];
  }
  // A series shorter than one cell has nothing to snap to; take the whole thing.
  if (count <= grid) {
    return [0, count];
  }
  // The extra floor/ceil keep the bounds integral for a non-integer grid, and only ever widen.
  const lo = Math.max(0, Math.floor(Math.floor(a / grid) * grid));
  const hi = Math.min(count, Math.ceil(Math.ceil(b / grid) * grid));
  return [lo, hi];
}

/**
 * Describe an existing representation as explicit blocks.
 * Falls back to the legacy uniform layout (flat allImageIds in N-sized chunks, optionally with a
 * blockSegments map) so representations built before sparse blocks keep working.
 */
export function describeBlocks(labelmapData: any, sourceCount: number): LabelmapBlock[] {
  if (!labelmapData) {
    return [];
  }
  if (Array.isArray(labelmapData.blocks) && labelmapData.blocks.length) {
    return labelmapData.blocks.map((b: any) => ({
      segmentIndex: b.segmentIndex,
      z0: b.z0 ?? 0,
      imageIds: b.imageIds ?? [],
      // Carried through when the persisted block has it. Left undefined otherwise (a pre-sparse
      // representation), where the block spans the series and the whole-series list is correct.
      referencedImageIds: b.referencedImageIds,
    }));
  }
  const all: string[] = labelmapData.allImageIds ?? labelmapData.imageIds ?? [];
  if (!sourceCount || all.length < sourceCount) {
    return [];
  }
  const count = Math.floor(all.length / sourceCount);
  const segs: number[] =
    labelmapData.blockSegments?.length === count
      ? labelmapData.blockSegments
      : Array.from({ length: count }, (_, b) => b + 1);
  return Array.from({ length: count }, (_, b) => ({
    segmentIndex: segs[b],
    z0: 0,
    imageIds: all.slice(b * sourceCount, (b + 1) * sourceCount),
  }));
}

/** Index of the block holding `segmentIndex`, or -1. */
export function blockIndexForSegment(blocks: LabelmapBlock[], segmentIndex: number): number {
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].segmentIndex === segmentIndex) {
      return i;
    }
  }
  return -1;
}

/** The flat image id list Cornerstone consumes. Derived so the two can never disagree. */
export function flattenBlocks(blocks: LabelmapBlock[]): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    for (const id of b.imageIds) {
      out.push(id);
    }
  }
  return out;
}

/**
 * Convert between display and working order. The mapping is its own inverse, so one function serves
 * both directions. `count` is the FULL series length.
 */
export function flipIndex(i: number, count: number, flipped: boolean): number {
  return flipped ? count - 1 - i : i;
}

/** Does this block cover the whole working range [w0, w1)? */
export function blockContains(block: LabelmapBlock, w0: number, w1: number): boolean {
  return w0 >= block.z0 && w1 <= block.z0 + block.imageIds.length;
}

/**
 * Clamp a working range to the series and widen it to at least `minLength` slices, centred on the
 * original range. Returns the whole series when it is shorter than `minLength`.
 */
export function clampRange(
  w0: number,
  w1: number,
  sourceCount: number,
  minLength: number
): [number, number] {
  if (sourceCount <= minLength) {
    return [0, sourceCount];
  }
  let a = Math.max(0, Math.min(w0, sourceCount));
  let b = Math.max(a, Math.min(w1, sourceCount));
  if (b - a < minLength) {
    const deficit = minLength - (b - a);
    a = Math.max(0, a - Math.ceil(deficit / 2));
    b = Math.min(sourceCount, a + minLength);
    a = Math.max(0, b - minLength);
  }
  return [a, b];
}

/**
 * Which source imageIds back a working range, and whether they need reversing to land in working
 * order. Source imageIds are in DISPLAY order; a flipped series mirrors the range.
 */
export function sourceRangeForWorking(
  w0: number,
  w1: number,
  sourceCount: number,
  flipped: boolean
): { start: number; end: number; reverse: boolean } {
  return flipped
    ? { start: sourceCount - w1, end: sourceCount - w0, reverse: true }
    : { start: w0, end: w1, reverse: false };
}

/** Replace one block, keeping every other block at its position. */
export function replaceBlockAt(
  blocks: LabelmapBlock[],
  index: number,
  block: LabelmapBlock
): LabelmapBlock[] {
  const next = blocks.slice();
  next[index] = block;
  return next;
}

/** Add a block at the end of the list. */
export function appendBlock(blocks: LabelmapBlock[], block: LabelmapBlock): LabelmapBlock[] {
  return [...blocks, block];
}

/** Drop one block. */
export function withoutBlockAt(blocks: LabelmapBlock[], index: number): LabelmapBlock[] {
  return blocks.filter((_, i) => i !== index);
}
