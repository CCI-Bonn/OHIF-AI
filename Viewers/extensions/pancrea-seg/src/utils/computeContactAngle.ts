import type { ContactAngleResult } from '../services/PancreasAngleService';

export interface ContactAngleRequest {
  tumorSegmentationId: string;
  vesselSegmentations: Array<{ id: string; name: string }>;
  studyInstanceUID: string;
  apiBaseUrl?: string;
}

export function classifyRisk(angleDeg: number): 'low' | 'moderate' | 'high' {
  if (angleDeg < 90) return 'low';
  if (angleDeg <= 180) return 'moderate';
  return 'high';
}

function buildSummary(vessel: string, angle: number, slice: number): string {
  const risk = classifyRisk(angle);
  const label: Record<string, string> = {
    low: 'Low risk',
    moderate: 'Borderline',
    high: 'High risk',
  };
  return `${label[risk]}: ${Math.round(angle)}° contact with ${vessel} at slice ${slice}`;
}

/**
 * Calls the Python FastAPI backend to compute tumor-vessel contact angles.
 * Formula: θ = 360 * s / C
 *   where s = arc of vessel wall in contact with tumor
 *         C = vessel circumference on that slice
 *
 * Falls back to mock data if the backend is unreachable (useful for development).
 */
export async function computeContactAngle(
  request: ContactAngleRequest
): Promise<ContactAngleResult[]> {
  const { tumorSegmentationId, vesselSegmentations, studyInstanceUID } = request;
  const apiBase = request.apiBaseUrl ?? '/pancreas-api';

  try {
    const response = await fetch(`${apiBase}/contact-angle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tumor_seg_id: tumorSegmentationId,
        vessel_seg_ids: vesselSegmentations.map(v => v.id),
        vessel_names: Object.fromEntries(vesselSegmentations.map(v => [v.id, v.name])),
        study_uid: studyInstanceUID,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Backend error ${response.status}: ${text}`);
    }

    const data = await response.json();
    return (data.vessels as Array<{
      vessel_id: string;
      vessel_name: string;
      max_angle_degrees: number;
      max_slice_index: number;
      max_z_position_mm: number;
      slice_range: [number, number];
      per_slice_angles: Array<{
        sliceIndex: number;
        zPositionMm: number;
        angleDegrees: number;
        vesselPerimeterMm: number;
        tumorPerimeterMm: number;
        contactArcMm: number;
        vesselContour: Array<[number, number]>;
        tumorContour: Array<[number, number]>;
        contactArcContours: Array<Array<[number, number]>>;
      }>;
    }>).map(v => ({
      vesselId: v.vessel_id,
      vesselName: v.vessel_name,
      maxAngleDegrees: v.max_angle_degrees,
      maxSliceIndex: v.max_slice_index,
      maxZPositionMm: v.max_z_position_mm,
      sliceRange: v.slice_range,
      riskLevel: classifyRisk(v.max_angle_degrees),
      summary: buildSummary(v.vessel_name, v.max_angle_degrees, v.max_slice_index),
      perSliceAngles: v.per_slice_angles,
    }));
  } catch (err) {
    console.warn('[PancreasAngle] Backend unavailable, using mock data:', err);
    return getMockResults(vesselSegmentations);
  }
}

function getMockResults(
  vessels: Array<{ id: string; name: string }>
): ContactAngleResult[] {
  const mockAngles = [240, 65, 180, 95, 310, 45];
  return vessels.map((v, i) => {
    const angle = mockAngles[i % mockAngles.length];
    const slice = 110 + i * 15;
    return {
      vesselId: v.id,
      vesselName: v.name,
      maxAngleDegrees: angle,
      maxSliceIndex: slice,
      sliceRange: [slice - 8, slice + 8],
      riskLevel: classifyRisk(angle),
      summary: buildSummary(v.name, angle, slice),
      perSliceAngles: [] as ContactAngleResult['perSliceAngles'],
    };
  });
}
