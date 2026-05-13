import { PubSubService } from '@ohif/core';

export interface ContactAngleResult {
  vesselId: string;
  vesselName: string;
  maxAngleDegrees: number;
  maxSliceIndex: number;
  maxZPositionMm: number;
  sliceRange: [number, number];
  riskLevel: 'low' | 'moderate' | 'high';
  summary: string;
  perSliceAngles: Array<{
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
}

const EVENTS = {
  RESULTS_UPDATED: 'event::pancreasAngle_results_updated',
  COMPUTATION_STARTED: 'event::pancreasAngle_computation_started',
  COMPUTATION_ERROR: 'event::pancreasAngle_computation_error',
};

class PancreasAngleService extends PubSubService {
  static REGISTRATION = {
    name: 'pancreasAngleService',
    altName: 'PancreasAngleService',
    create: (): PancreasAngleService => new PancreasAngleService(),
  };

  private results: ContactAngleResult[] = [];
  private loading = false;
  private lastError: string | null = null;

  constructor() {
    super(EVENTS);
  }

  getResults(): ContactAngleResult[] {
    return this.results;
  }

  isLoading(): boolean {
    return this.loading;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  setLoading(loading: boolean): void {
    this.loading = loading;
    if (loading) {
      this.lastError = null;
      this._broadcastEvent(EVENTS.COMPUTATION_STARTED, {});
    }
  }

  setResults(results: ContactAngleResult[]): void {
    this.loading = false;
    this.lastError = null;
    this.results = results;
    this._broadcastEvent(EVENTS.RESULTS_UPDATED, { results });
  }

  setError(error: string): void {
    this.loading = false;
    this.lastError = error;
    this._broadcastEvent(EVENTS.COMPUTATION_ERROR, { error });
  }

  clearResults(): void {
    this.results = [];
    this.lastError = null;
    this._broadcastEvent(EVENTS.RESULTS_UPDATED, { results: [] });
  }
}

export { PancreasAngleService, EVENTS as PancreasAngleServiceEvents };
export default PancreasAngleService;
