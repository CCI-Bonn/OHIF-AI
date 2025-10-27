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
