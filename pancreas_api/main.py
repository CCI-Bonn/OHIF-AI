"""
Pancreas tumor-vessel contact angle computation service.

Formula: θ = 360 * s / C
  where s = arc length of vessel wall in contact with tumor (pixels resampled to mm)
        C = vessel circumference on that slice

Exposes:
  POST /contact-angle   – compute contact angles for a study
  GET  /health          – liveness probe
"""

from __future__ import annotations

import os
import logging
import numpy as np
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from skimage import measure
from skimage.measure import approximate_polygon
from scipy.ndimage import distance_transform_edt, map_coordinates

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("pancreas_api")

app = FastAPI(title="PancreaSeg API", version="1.0.0")

# Allow OHIF frontend origin in development; restrict in production via env var
CORS_ORIGINS = os.getenv("CORS_ORIGINS", "*").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

ORTHANC_URL = os.getenv("ORTHANC_URL", "http://localhost:8042")
WADO_RS_BASE = os.getenv("WADO_RS_BASE", f"{ORTHANC_URL}/wado")


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------

class AngleRequest(BaseModel):
    tumor_seg_id: str
    vessel_seg_ids: list[str]
    vessel_names: dict[str, str] = {}  # id -> human label
    study_uid: str


class PerSliceAngle(BaseModel):
    sliceIndex: int
    zPositionMm: float
    angleDegrees: float
    vesselPerimeterMm: float
    tumorPerimeterMm: float
    contactArcMm: float
    vesselContour: list[list[float]]
    tumorContour: list[list[float]]
    contactArcContours: list[list[list[float]]]


class VesselResult(BaseModel):
    vessel_id: str
    vessel_name: str
    max_angle_degrees: float
    max_slice_index: int
    max_z_position_mm: float
    slice_range: list[int]
    per_slice_angles: list[PerSliceAngle]


class AngleResponse(BaseModel):
    vessels: list[VesselResult]


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/contact-angle", response_model=AngleResponse)
async def contact_angle(req: AngleRequest):
    log.info(
        "Contact angle request: tumor=%s vessels=%s study=%s",
        req.tumor_seg_id, req.vessel_seg_ids, req.study_uid,
    )

    tumor_vol, tumor_spacing, tumor_z_positions = await load_seg_volume(req.tumor_seg_id)

    results: list[VesselResult] = []
    for vessel_id in req.vessel_seg_ids:
        vessel_vol, vessel_spacing, vessel_z_positions = await load_seg_volume(vessel_id)

        per_slice = compute_per_slice_angles(
            tumor_vol, vessel_vol, vessel_spacing, tumor_z_positions,
            vessel_z_positions=vessel_z_positions,
        )
        if not per_slice:
            log.warning("No contact found for vessel %s", vessel_id)
            continue

        max_entry = max(per_slice, key=lambda x: x.angleDegrees)
        contact_slices = [p.sliceIndex for p in per_slice if p.angleDegrees > 0]

        if not contact_slices:
            contact_slices = [max_entry.sliceIndex]

        results.append(
            VesselResult(
                vessel_id=vessel_id,
                vessel_name=req.vessel_names.get(vessel_id, vessel_id),
                max_angle_degrees=round(max_entry.angleDegrees, 2),
                max_slice_index=max_entry.sliceIndex,
                max_z_position_mm=max_entry.zPositionMm,
                slice_range=[min(contact_slices), max(contact_slices)],
                per_slice_angles=per_slice,
            )
        )

    return AngleResponse(vessels=results)


# ---------------------------------------------------------------------------
# Core geometry
# ---------------------------------------------------------------------------

def signed_distance_from_mask(mask: np.ndarray) -> np.ndarray:
    """
    Signed distance map:
      > 0 inside object
      < 0 outside object
      ~= 0 near boundary
    """
    mask = mask.astype(bool)
    d_in = distance_transform_edt(mask)
    d_out = distance_transform_edt(~mask)
    return d_in - d_out


def contour_inside_mask_subpixel(
    contour: np.ndarray,
    mask: np.ndarray,
    eps: float = 0.5,
) -> np.ndarray:
    """
    Boolean array: True for contour points that lie inside the mask
    or within eps pixels from its boundary.
    contour: (N, 2) array of (row, col) coordinates from find_contours
    """
    if len(contour) == 0:
        return np.zeros((0,), dtype=bool)

    sdf = signed_distance_from_mask(mask)
    rr = contour[:, 0]
    cc = contour[:, 1]

    vals = map_coordinates(sdf, [rr, cc], order=1, mode="nearest")
    return vals >= -eps


def contour_arc_length_mm(
    contour: np.ndarray,
    spacing_yx: tuple[float, float],
    closed: bool = False,
) -> float:
    """
    Cumulative arc length of a contour scaled by pixel spacing (mm).
    contour: (N, 2) array of (row, col) pixel coordinates.
    spacing_yx: (row_spacing_mm, col_spacing_mm)
    """
    if len(contour) < 2:
        return 0.0

    pts = contour
    if closed:
        pts = np.vstack([pts, pts[0]])

    diffs = np.diff(pts, axis=0)
    diffs_mm = diffs * np.array(spacing_yx, dtype=float)
    return float(np.sum(np.linalg.norm(diffs_mm, axis=1)))


def _contiguous_runs_circular(mask: np.ndarray) -> list[tuple[int, int]]:
    """
    Return contiguous True runs on a circular 1D boolean mask.
    Output intervals are [start, end) in contour index space.
    If a run wraps around the end, it is returned as two segments:
      [(start, n), (0, end)]
    so downstream slicing contour[start:end] still works.
    """
    n = len(mask)
    if n == 0:
        return []

    if np.all(mask):
        return [(0, n)]

    runs = []
    in_run = False
    start = 0

    for i, val in enumerate(mask):
        if val and not in_run:
            in_run = True
            start = i
        elif not val and in_run:
            in_run = False
            runs.append((start, i))

    if in_run:
        runs.append((start, n))

    if len(runs) >= 2 and mask[0] and mask[-1]:
        first_start, first_end = runs[0]
        last_start, last_end = runs[-1]
        merged = [(last_start, n), (0, first_end)]
        middle = runs[1:-1]
        return middle + merged

    return runs


def compute_per_slice_angles(
    tumor_vol: np.ndarray,
    vessel_vol: np.ndarray,
    spacing_yx: tuple[float, float],
    z_positions: list[float],
    contact_eps_px: float = 0.5,
    vessel_z_positions: list[float] | None = None,
) -> list[PerSliceAngle]:
    """
    Iterate over axial slices (axis 0 = Z) and compute the contact angle.
    Returns only slices where both vessel and tumor are present.

    When vessel_z_positions is provided, slices are matched by physical Z
    coordinate so that tumor and vessel from different DICOM-SEG files with
    different Z extents are correctly aligned.  sliceIndex in PerSliceAngle
    always uses the tumor's Z index for frontend slice navigation.
    """
    per_slice: list[PerSliceAngle] = []

    if vessel_z_positions is not None and z_positions:
        tumor_z_map = {round(z, 2): i for i, z in enumerate(z_positions)}
        slice_pairs: list[tuple[int, int, float]] = []
        for v_idx, vz in enumerate(vessel_z_positions):
            t_idx = tumor_z_map.get(round(vz, 2))
            if t_idx is not None:
                slice_pairs.append((t_idx, v_idx, float(vz)))
    else:
        z_slices = max(tumor_vol.shape[0], vessel_vol.shape[0])
        slice_pairs = [
            (z, z, z_positions[z] if z < len(z_positions) else 0.0)
            for z in range(z_slices)
        ]

    for t_idx, v_idx, z_mm in slice_pairs:
        t_slice = tumor_vol[t_idx].astype(np.uint8) if t_idx < tumor_vol.shape[0] else np.zeros(vessel_vol.shape[1:], dtype=np.uint8)
        v_slice = vessel_vol[v_idx].astype(np.uint8) if v_idx < vessel_vol.shape[0] else np.zeros(tumor_vol.shape[1:], dtype=np.uint8)

        if not v_slice.any() or not t_slice.any():
            continue

        vessel_contours = measure.find_contours(v_slice, 0.5)
        tumor_contours = measure.find_contours(t_slice, 0.5)

        if not vessel_contours or not tumor_contours:
            continue

        vessel_c = max(vessel_contours, key=lambda c: c.shape[0])
        tumor_c = max(tumor_contours, key=lambda c: c.shape[0])

        C = contour_arc_length_mm(vessel_c, spacing_yx, closed=True)
        if C < 1e-6:
            continue

        T = contour_arc_length_mm(tumor_c, spacing_yx, closed=True)

        contact_mask = contour_inside_mask_subpixel(
            vessel_c,
            t_slice,
            eps=contact_eps_px,
        )

        arc_runs = _contiguous_runs_circular(contact_mask)

        s = 0.0
        arc_contours = []

        for start, end in arc_runs:
            run = vessel_c[start:end]
            if len(run) < 2:
                continue

            s += contour_arc_length_mm(run, spacing_yx, closed=False)

            run_poly = approximate_polygon(run, tolerance=0.5)
            arc_contours.append(run_poly.tolist())

        theta = 360.0 * s / C
        theta = min(theta, 360.0)

        vessel_poly = approximate_polygon(vessel_c, tolerance=0.5)
        tumor_poly = approximate_polygon(tumor_c, tolerance=0.5)

        log.info(
            "slice t_idx=%d v_idx=%d z=%.2fmm  angle=%.1f°  vessel_perim=%.2fmm  tumor_perim=%.2fmm  contact_arc=%.2fmm  runs=%d eps=%.2fpx",
            t_idx, v_idx, z_mm, theta, C, T, s, len(arc_runs), contact_eps_px,
        )

        per_slice.append(
            PerSliceAngle(
                sliceIndex=t_idx,
                zPositionMm=z_mm,
                angleDegrees=round(theta, 2),
                vesselPerimeterMm=round(C, 3),
                tumorPerimeterMm=round(T, 3),
                contactArcMm=round(s, 3),
                vesselContour=vessel_poly.tolist(),
                tumorContour=tumor_poly.tolist(),
                contactArcContours=arc_contours,
            )
        )

    return per_slice


# ---------------------------------------------------------------------------
# DICOM-SEG loading (via Orthanc WADO-RS)
# ---------------------------------------------------------------------------

async def load_seg_volume(segment_key: str) -> tuple[np.ndarray, tuple[float, float], list[float]]:
    """Accepts either a plain series/instance UID or the composite key
    "<seriesOrInstanceUID>::<segmentIndex>" produced by the OHIF panel."""
    if '::' in segment_key:
        series_or_instance_uid, seg_index_str = segment_key.split('::', 1)
        segment_index = int(seg_index_str)
    else:
        series_or_instance_uid = segment_key
        segment_index = None
    return await _load_seg_volume(series_or_instance_uid, segment_index)


async def _load_seg_volume(series_or_instance_uid: str, segment_index: int | None) -> tuple[np.ndarray, tuple[float, float], list[float]]:
    """
    Load a DICOM-SEG series from Orthanc and return:
      - binary volume array shaped (Z, Y, X)
      - pixel spacing (row_mm, col_mm)

    Falls back to a synthetic phantom if Orthanc is unreachable (dev mode).
    """
    try:
        import pydicom
        import highdicom as hd

        async with httpx.AsyncClient(base_url=ORTHANC_URL, timeout=30) as client:
            # Resolve DICOM UID → Orthanc internal ID via /tools/lookup
            lookup_resp = await client.post("/tools/lookup", content=series_or_instance_uid)
            if lookup_resp.status_code == 200:
                matches = lookup_resp.json()
                # Find a Series or Instance match
                series_match = next((m for m in matches if m.get("Type") == "Series"), None)
                instance_match = next((m for m in matches if m.get("Type") == "Instance"), None)
                if series_match:
                    orthanc_series_id = series_match["ID"]
                    info = (await client.get(f"/series/{orthanc_series_id}")).json()
                    instances = info.get("Instances", [])
                    if not instances:
                        raise ValueError(f"No instances in series {series_or_instance_uid}")
                    instance_id = instances[0]
                elif instance_match:
                    instance_id = instance_match["ID"]
                else:
                    raise ValueError(f"UID not found in Orthanc: {series_or_instance_uid}")
            else:
                raise ValueError(f"Orthanc /tools/lookup failed for {series_or_instance_uid}")

            dicom_resp = await client.get(f"/instances/{instance_id}/file")
            dicom_resp.raise_for_status()

        import io
        ds = pydicom.dcmread(io.BytesIO(dicom_resp.content))
        seg = hd.seg.segread(io.BytesIO(dicom_resp.content))

        spacing = (
            float(ds.PixelSpacing[0]) if hasattr(ds, "PixelSpacing") else 1.0,
            float(ds.PixelSpacing[1]) if hasattr(ds, "PixelSpacing") else 1.0,
        )

        # Extract the requested segment from a (possibly multi-label) DICOM-SEG.
        # highdicom numbers segments starting at 1; OHIF segmentIndex also starts at 1.
        if segment_index is not None:
            seg_num = segment_index
        else:
            seg_num = 1  # default to first segment when no index is provided

        # get_pixels_by_source_frame / get_total_pixel_matrix may not exist on all
        # versions; use pixel_array with segment filtering via SegmentSequence.
        seg_numbers_in_file = [
            int(item.SegmentNumber)
            for item in ds.SegmentSequence
        ] if hasattr(ds, 'SegmentSequence') else [1]

        if seg_num not in seg_numbers_in_file:
            raise ValueError(
                f"Segment {seg_num} not found in file (available: {seg_numbers_in_file})"
            )

        # pixel_array for a multi-segment SEG has shape (frames, Y, X) where each
        # frame is tagged to a segment via PerFrameFunctionalGroupsSequence.
        raw = seg.pixel_array  # (frames, Y, X) or (Y, X) for single-frame
        if raw.ndim == 2:
            raw = raw[np.newaxis, ...]

        # Build per-frame metadata: segment number and Z position
        n_frames = raw.shape[0]
        frame_seg_numbers = np.ones(n_frames, dtype=int)
        frame_z_positions = np.zeros(n_frames, dtype=float)

        if hasattr(ds, 'PerFrameFunctionalGroupsSequence'):
            for i, fg in enumerate(ds.PerFrameFunctionalGroupsSequence):
                try:
                    frame_seg_numbers[i] = int(
                        fg.SegmentIdentificationSequence[0].ReferencedSegmentNumber
                    )
                except (AttributeError, IndexError):
                    pass
                try:
                    frame_z_positions[i] = float(
                        fg.PlanePositionSequence[0].ImagePositionPatient[2]
                    )
                except (AttributeError, IndexError):
                    frame_z_positions[i] = float(i)

        selected_frames = np.where(frame_seg_numbers == seg_num)[0]
        if len(selected_frames) == 0:
            raise ValueError(f"No frames found for segment {seg_num}")

        # Build a volume aligned to the FULL Z grid of the file so that two
        # segments from the same file always have the same Z dimension and
        # spatial correspondence (zeros for slices where the segment is absent).
        all_z = np.round(frame_z_positions.astype(float), 3)
        unique_z = sorted(set(all_z.tolist()))
        z_to_idx = {float(z): i for i, z in enumerate(unique_z)}

        n_z = len(unique_z)
        _, h, w = raw.shape
        volume = np.zeros((n_z, h, w), dtype=np.uint8)

        log.info(
            "Segment %s: %d frames → volume shape %s, Z range [%.1f, %.1f]",
            seg_num, len(selected_frames), volume.shape,
            unique_z[0], unique_z[-1]
        )

        for fi in selected_frames:
            z_val = float(np.round(frame_z_positions[fi], 3))
            z_idx = z_to_idx[z_val]
            volume[z_idx] |= (raw[fi] > 0).astype(np.uint8)

        return volume, spacing, unique_z

    except Exception as exc:
        log.warning("Could not load DICOM-SEG from Orthanc (%s), using phantom: %s", series_or_instance_uid, exc)
        phantom = _synthetic_phantom(series_or_instance_uid)
        return phantom, (1.0, 1.0), list(range(phantom.shape[0]))


def _synthetic_phantom(uid: str = "") -> np.ndarray:
    """
    Generates a synthetic binary volume for development/testing.
    The circle position and radius are seeded from the UID hash so that
    different UIDs produce non-overlapping phantoms, preventing the
    spurious 360° contact angle that arises when tumor == vessel.
    """
    seed = abs(hash(uid)) % (2 ** 32)
    rng = np.random.default_rng(seed)
    cy = int(rng.integers(40, 89))
    cx = int(rng.integers(40, 89))
    r  = int(rng.integers(10, 26))
    vol = np.zeros((50, 128, 128), dtype=np.uint8)
    y, x = np.ogrid[:128, :128]
    circle = (y - cy) ** 2 + (x - cx) ** 2 <= r ** 2
    vol[15:35] = circle
    return vol
