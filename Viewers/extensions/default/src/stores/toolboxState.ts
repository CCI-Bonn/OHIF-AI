// Simple global state for toolbox settings
// Default to true for live mode
let liveMode = true;
let posNeg = false;
let refineNew = false;
let nnInterSam2 = false; // Add new state for nnInter/SAM2 toggle
let medSam2 = false; // Add new state for MedSAM2 toggle
let currentActiveSegment = 1;

export const toolboxState = {
  getLiveMode: () => liveMode,
  setLiveMode: (enabled: boolean) => {
    liveMode = enabled;
  },
  getPosNeg: () => posNeg,
  setPosNeg: (enabled: boolean) => {
    posNeg = enabled;
  },
  getRefineNew: () => refineNew,
  setRefineNew: (enabled: boolean) => {
    refineNew = enabled;
    if (enabled) {
        commandsManager.run('resetNninter');
        toolboxState.setPosNeg(false);
    }
  },
  // Add new methods for nnInter/SAM2 toggle
  getNnInterSam2: () => nnInterSam2,
  setNnInterSam2: (enabled: boolean) => {
    nnInterSam2 = enabled;
  },
  getMedSam2: () => medSam2,
  setMedSam2: (enabled: boolean) => {
    medSam2 = enabled;
  },
  getCurrentActiveSegment: () => currentActiveSegment,
  setCurrentActiveSegment: (segment: number) => {
    currentActiveSegment = segment;
  },
}; 