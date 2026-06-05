import math
import numpy as np
import signal
from contextlib import contextmanager

def clean_and_densify_polyline(polyline, max_segment_length=1):
    if not polyline or len(polyline) < 2:
        return []

    cleaned = []

    for i in range(len(polyline)):
        x1, y1, z = polyline[i]
        x2, y2, _ = polyline[(i + 1) % len(polyline)]  # wrap to start

        if x1 == x2 and y1 == y2:
            continue  # skip duplicate

        if not cleaned or (cleaned[-1][0] != x1 or cleaned[-1][1] != y1):
            cleaned.append([x1, y1, z])

        dx = x2 - x1
        dy = y2 - y1
        dist = math.hypot(dx, dy)

        if dist > max_segment_length:
            steps = math.floor(dist)
            for j in range(1, steps):
                t = j / steps
                px = round(x1 + dx * t)
                py = round(y1 + dy * t)

                last = cleaned[-1]
                if last[0] != px or last[1] != py:
                    cleaned.append([px, py, z])

    if not cleaned:
        return []

    first_x, first_y, _ = cleaned[0]
    last_x, last_y, _ = cleaned[-1]
    if first_x != last_x or first_y != last_y:
        cleaned.append([first_x, first_y, z])

    return cleaned

def get_scanline_filled_points_3d(polyline):
    if not polyline or len(polyline) < 3:
        return []

    points = []

    min_x = min(pt[0] for pt in polyline)
    max_x = max(pt[0] for pt in polyline)

    z = polyline[0][2]  # Assume same z for all

    for x in range(math.floor(min_x), math.ceil(max_x) + 1):
        intersections = []

        for i in range(len(polyline)):
            x1, y1, _ = polyline[i]
            x2, y2, _ = polyline[(i + 1) % len(polyline)]

            if x1 == x2:
                continue  # skip vertical edges

            if (x1 <= x < x2) or (x2 <= x < x1):
                t = (x - x1) / (x2 - x1)
                y = y1 + t * (y2 - y1)
                intersections.append(y)

        intersections.sort()

        for j in range(0, len(intersections) - 1, 2):
            y_start = math.ceil(intersections[j])
            y_end = math.floor(intersections[j + 1])
            for y in range(y_start, y_end + 1):
                points.append([x, y, z])

    return points

# Sphere mask of radius = 1
def spherical_kernel(radius=1):
    size = 2 * radius + 1  # → 3 for radius=1
    center = radius
    zz, yy, xx = np.ogrid[:size, :size, :size]
    dist = np.sqrt((zz - center)**2 + (yy - center)**2 + (xx - center)**2)
    return (dist <= radius).astype(np.uint8)


def scribble_constant_axis(filled_indices):
    """If the polyline lies in an axis-aligned plane return that axis (0=x,1=y,2=z), else None."""
    if filled_indices.size == 0:
        return None
    for axis in (0, 1, 2):
        if np.unique(filled_indices[:, axis]).size == 1:
            return axis
    return None


def scribble_mask_tight_bbox_zyx(scribble_mask, flat_axis, filled_indices):
    """Tight half-open bbox [[z0,z1],[y0,y1],[x0,x1]] from nonzero voxels (scribble_mask is [z,y,x])."""
    coords = np.nonzero(scribble_mask)
    if coords[0].size == 0:
        return None
    z_idx, y_idx, x_idx = coords
    if flat_axis == 0:
        x_idx = filled_indices[:, 0]
    elif flat_axis == 1:
        y_idx = filled_indices[:, 1]
    elif flat_axis == 2:
        z_idx = filled_indices[:, 2]
    return [
        [int(z_idx.min()), int(z_idx.max()) + 1],
        [int(y_idx.min()), int(y_idx.max()) + 1],
        [int(x_idx.min()), int(x_idx.max()) + 1],
    ]


def crop_scribble_mask_xyz_bbox(scribble_mask, interaction_bbox):
    """Crop [z,y,x] mask to bbox; return array in (x,y,z) order for add_scribble_interaction."""
    z0, z1 = interaction_bbox[0]
    y0, y1 = interaction_bbox[1]
    x0, x1 = interaction_bbox[2]
    return scribble_mask[z0:z1, y0:y1, x0:x1]


def build_scribble_mask(volume_shape_zyx, filled_indices, kernel_radius=1):
    """Stamp a spherical kernel along polyline points using vectorized binary dilation.
    filled_indices columns are [x, y, z]; returned mask is indexed [z, y, x].
    3-D fallback (rare): uses a 2×2×2 cube kernel to match the 2-pixel target width.
    """
    from scipy.ndimage import binary_dilation
    if filled_indices.size == 0:
        return np.zeros(volume_shape_zyx, dtype=np.uint8)
    # 2×2×2 cube gives ~2 px effective width in 3D, matching the 2D fast-path kernel.
    kernel = np.ones((2, 2, 2), dtype=np.uint8)
    point_mask = np.zeros(volume_shape_zyx, dtype=bool)
    x_arr, y_arr, z_arr = filled_indices[:, 0], filled_indices[:, 1], filled_indices[:, 2]
    valid = (
        (x_arr >= 0) & (x_arr < volume_shape_zyx[2]) &
        (y_arr >= 0) & (y_arr < volume_shape_zyx[1]) &
        (z_arr >= 0) & (z_arr < volume_shape_zyx[0])
    )
    point_mask[z_arr[valid], y_arr[valid], x_arr[valid]] = True
    return binary_dilation(point_mask, structure=kernel).astype(np.uint8)


def build_scribble_payload_2d(volume_shape_zyx, filled_indices, flat_axis, kernel_radius=1):
    """Fast path for planar scribbles: work entirely in 2-D, skip full 3-D volume allocation.

    binary_dilation on a 512×512 slice is ~200-300× faster than on a 512×512×300 volume.
    Returns (crop_zyx, interaction_bbox) ready for add_scribble_interaction.
    filled_indices columns: [x, y, z]; flat_axis: 0=sagittal(x const), 1=coronal(y const), 2=axial(z const).

    Scribble width is fixed at 2 pixels: each path point is stamped with a 2×2 kernel.
    Symmetric odd-radius kernels produce 1, 3, 5 … px; the 2×2 kernel is the only clean
    way to achieve exactly 2 px without directional bias.  No performance cost vs. 3×3.
    """
    from scipy.ndimage import binary_dilation
    # 2-pixel-wide scribble: 2×2 stamp per path point.
    # (The kernel_radius param is kept for signature compatibility but ignored here.)
    kernel_2d = np.ones((2, 2), dtype=bool)
    x_arr, y_arr, z_arr = filled_indices[:, 0], filled_indices[:, 1], filled_indices[:, 2]
    D, H, W = volume_shape_zyx  # ZYX

    if flat_axis == 2:          # axial: z constant, 2-D plane is (H, W)
        z_val = int(z_arr[0])
        mask = np.zeros((H, W), dtype=bool)
        valid = (x_arr >= 0) & (x_arr < W) & (y_arr >= 0) & (y_arr < H)
        mask[y_arr[valid], x_arr[valid]] = True
        dil = binary_dilation(mask, structure=kernel_2d)
        ri, ci = np.where(np.any(dil, axis=1))[0], np.where(np.any(dil, axis=0))[0]
        y0, y1 = int(ri.min()), int(ri.max()) + 1
        x0, x1 = int(ci.min()), int(ci.max()) + 1
        crop = dil[y0:y1, x0:x1].astype(np.uint8)[np.newaxis, :, :]   # (1, dy, dx)
        bbox = [[z_val, z_val + 1], [y0, y1], [x0, x1]]

    elif flat_axis == 1:        # coronal: y constant, 2-D plane is (D, W)
        y_val = int(y_arr[0])
        mask = np.zeros((D, W), dtype=bool)
        valid = (x_arr >= 0) & (x_arr < W) & (z_arr >= 0) & (z_arr < D)
        mask[z_arr[valid], x_arr[valid]] = True
        dil = binary_dilation(mask, structure=kernel_2d)
        ri, ci = np.where(np.any(dil, axis=1))[0], np.where(np.any(dil, axis=0))[0]
        z0, z1 = int(ri.min()), int(ri.max()) + 1
        x0, x1 = int(ci.min()), int(ci.max()) + 1
        crop = dil[z0:z1, x0:x1].astype(np.uint8)[:, np.newaxis, :]   # (dz, 1, dx)
        bbox = [[z0, z1], [y_val, y_val + 1], [x0, x1]]

    else:                       # flat_axis == 0: sagittal: x constant, 2-D plane is (D, H)
        x_val = int(x_arr[0])
        mask = np.zeros((D, H), dtype=bool)
        valid = (y_arr >= 0) & (y_arr < H) & (z_arr >= 0) & (z_arr < D)
        mask[z_arr[valid], y_arr[valid]] = True
        dil = binary_dilation(mask, structure=kernel_2d)
        ri, ci = np.where(np.any(dil, axis=1))[0], np.where(np.any(dil, axis=0))[0]
        z0, z1 = int(ri.min()), int(ri.max()) + 1
        y0, y1 = int(ci.min()), int(ci.max()) + 1
        crop = dil[z0:z1, y0:y1].astype(np.uint8)[:, :, np.newaxis]   # (dz, dy, 1)
        bbox = [[z0, z1], [y0, y1], [x_val, x_val + 1]]

    return crop, bbox


def _rasterize_polygon_2d(rows, cols, H, W):
    """Rasterize a closed polygon onto a (H, W) bool mask and fill its interior.

    clean_and_densify_polyline only densifies in x-y space, so for coronal/sagittal
    planes the projected perimeter can have large gaps in the z-direction.  Drawing
    explicit line segments between consecutive projected vertices (via np.linspace)
    guarantees a gap-free closed boundary before binary_fill_holes is applied.
    """
    from scipy.ndimage import binary_fill_holes

    mask = np.zeros((H, W), dtype=bool)
    n = len(rows)
    for i in range(n):
        r0, c0 = int(rows[i]),           int(cols[i])
        r1, c1 = int(rows[(i + 1) % n]), int(cols[(i + 1) % n])
        steps = max(abs(r1 - r0), abs(c1 - c0)) + 1
        rs = np.round(np.linspace(r0, r1, steps)).astype(int)
        cs = np.round(np.linspace(c0, c1, steps)).astype(int)
        v = (rs >= 0) & (rs < H) & (cs >= 0) & (cs < W)
        mask[rs[v], cs[v]] = True
    return binary_fill_holes(mask)


def build_lasso_payload_2d(volume_shape_zyx, perim_arr, flat_axis):
    """Fast 2D path for lasso: rasterize closed polygon edges in the projection
    plane then fill interior with binary_fill_holes, then crop to tight bbox.

    Handles all three axis-aligned planes (axial/coronal/sagittal), matching
    the same structure as build_scribble_payload_2d.

    perim_arr: integer [x, y, z] array of densified perimeter (z already flipped).
    flat_axis: 0=sagittal (x const), 1=coronal (y const), 2=axial (z const).
    Returns (crop_zyx, interaction_bbox) or (None, None) if mask is empty.
    """
    D, H, W = volume_shape_zyx
    x_p, y_p, z_p = perim_arr[:, 0], perim_arr[:, 1], perim_arr[:, 2]

    if flat_axis == 2:          # axial: z constant, plane is (H, W) → (row=y, col=x)
        z_val = int(z_p[0])
        filled = _rasterize_polygon_2d(y_p, x_p, H, W)
        if not filled.any():
            return None, None
        ri, ci = np.where(np.any(filled, axis=1))[0], np.where(np.any(filled, axis=0))[0]
        y0, y1 = int(ri.min()), int(ri.max()) + 1
        x0, x1 = int(ci.min()), int(ci.max()) + 1
        crop = filled[y0:y1, x0:x1].astype(np.uint8)[np.newaxis, :, :]   # (1, dy, dx)
        return crop, [[z_val, z_val + 1], [y0, y1], [x0, x1]]

    elif flat_axis == 1:        # coronal: y constant, plane is (D, W) → (row=z, col=x)
        y_val = int(y_p[0])
        filled = _rasterize_polygon_2d(z_p, x_p, D, W)
        if not filled.any():
            return None, None
        ri, ci = np.where(np.any(filled, axis=1))[0], np.where(np.any(filled, axis=0))[0]
        z0, z1 = int(ri.min()), int(ri.max()) + 1
        x0, x1 = int(ci.min()), int(ci.max()) + 1
        crop = filled[z0:z1, x0:x1].astype(np.uint8)[:, np.newaxis, :]   # (dz, 1, dx)
        return crop, [[z0, z1], [y_val, y_val + 1], [x0, x1]]

    else:                       # flat_axis == 0: sagittal: x constant, plane is (D, H) → (row=z, col=y)
        x_val = int(x_p[0])
        filled = _rasterize_polygon_2d(z_p, y_p, D, H)
        if not filled.any():
            return None, None
        ri, ci = np.where(np.any(filled, axis=1))[0], np.where(np.any(filled, axis=0))[0]
        z0, z1 = int(ri.min()), int(ri.max()) + 1
        y0, y1 = int(ci.min()), int(ci.max()) + 1
        crop = filled[z0:z1, y0:y1].astype(np.uint8)[:, :, np.newaxis]   # (dz, dy, 1)
        return crop, [[z0, z1], [y0, y1], [x_val, x_val + 1]]


def prepare_lasso_interaction_payload(volume_shape_zyx, perim_arr):
    """Return (lasso_image, interaction_bbox) for add_lasso_interaction.

    For planar lassos uses the 2-D fast path (build_lasso_payload_2d).
    For 3-D lassos falls back to full-volume scanline fill with no bbox.
    """
    flat_axis = scribble_constant_axis(perim_arr)
    if flat_axis is not None:
        return build_lasso_payload_2d(volume_shape_zyx, perim_arr, flat_axis)
    # 3-D fallback: full-volume scanline fill (original approach)
    D, H, W = volume_shape_zyx
    filled_3d = get_scanline_filled_points_3d(perim_arr)
    if not filled_3d:
        return None, None
    filled_arr = np.asarray(filled_3d)
    x = filled_arr[:, 0].astype(int)
    y = filled_arr[:, 1].astype(int)
    z = filled_arr[:, 2].astype(int)
    valid = (x >= 0) & (x < W) & (y >= 0) & (y < H) & (z >= 0) & (z < D)
    lasso_mask = np.zeros((D, H, W), dtype=np.uint8)
    lasso_mask[z[valid], y[valid], x[valid]] = 1
    return lasso_mask, None


def prepare_scribble_interaction_payload(volume_shape_zyx, filled_indices, flat_axis):
    """Return (scribble_image, interaction_bbox) for add_scribble_interaction.

    For planar scribbles uses the 2-D fast path (build_scribble_payload_2d).
    For 3-D scribbles falls back to full-volume binary_dilation with no bbox.
    """
    if flat_axis is not None:
        return build_scribble_payload_2d(volume_shape_zyx, filled_indices, flat_axis)
    # 3-D fallback: build full volume mask, no crop
    scribble_mask = build_scribble_mask(volume_shape_zyx, filled_indices)
    return scribble_mask, None

# Calculate Dice coefficient between prediction and ground truth
def calculate_dice(pred_mask, gt_mask, smooth=1e-6):
    """
    Calculate Dice coefficient between two binary masks
    Args:
        pred_mask: prediction mask (numpy array)
        gt_mask: ground truth mask (numpy array)
        smooth: smoothing factor to avoid division by zero
    Returns:
        dice_score: float between 0 and 1
    """
    # Flatten arrays
    pred_flat = pred_mask.flatten()
    gt_flat = gt_mask.flatten()

    logger.info(f"Pred: {pred_flat.sum()}")
    logger.info(f"GT: {gt_flat.sum()}")
    
    # Comprehensive intersection analysis
    # Method 1: Traditional intersection (both masks have same non-zero value)
    intersection_traditional = (pred_flat * gt_flat).sum()
    
    # Method 2: Any overlap (both masks are non-zero, regardless of exact value)
    pred_nonzero = (pred_flat > 0).astype(np.float32)
    gt_nonzero = (gt_flat > 0).astype(np.float32)
    intersection_any_overlap = (pred_nonzero * gt_nonzero).sum()
    
    # Method 3: Exact value matches
    exact_matches = (pred_mask == gt_mask).sum()
    
    # Method 4: Check specific overlapping regions
    overlap_indices = np.where((pred_mask > 0) & (gt_mask > 0))
    overlap_count = len(overlap_indices[0])
    
    logger.info(f"Traditional intersection (same values): {intersection_traditional}")
    logger.info(f"Any overlap (both non-zero): {intersection_any_overlap}")
    logger.info(f"Exact value matches: {exact_matches}")
    logger.info(f"Overlapping voxels count: {overlap_count}")
    
    if overlap_count > 0:
        # Sample overlapping voxels to see what values they have
        sample_size = min(10, overlap_count)
        sample_indices = np.random.choice(overlap_count, sample_size, replace=False)
        
        pred_values = pred_mask[overlap_indices[0][sample_indices], 
                                overlap_indices[1][sample_indices], 
                                overlap_indices[2][sample_indices]]
        gt_values = gt_mask[overlap_indices[0][sample_indices], 
                            overlap_indices[1][sample_indices], 
                            overlap_indices[2][sample_indices]]
        
        logger.info(f"Sample overlapping voxel values:")
        for i in range(sample_size):
            logger.info(f"  Index {sample_indices[i]}: Pred={pred_values[i]}, GT={gt_values[i]}")
    
    # Use any overlap for Dice calculation (more meaningful for segmentation)
    dice_score = (2.0 * intersection_any_overlap + smooth) / (pred_nonzero.sum() + gt_nonzero.sum() + smooth)
    
    return dice_score

class TimeoutError(Exception):
    """Custom timeout exception"""
    pass

@contextmanager
def timeout_context(seconds):
    """Context manager for timeout protection using signal.alarm"""
    def timeout_handler(signum, frame):
        raise TimeoutError(f"Operation timed out after {seconds} seconds")
    
    old_handler = signal.signal(signal.SIGALRM, timeout_handler)
    signal.alarm(seconds)
    
    try:
        yield
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, old_handler)
