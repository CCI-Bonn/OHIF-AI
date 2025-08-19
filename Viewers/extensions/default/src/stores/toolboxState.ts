// Simple global state for toolbox settings
// Default to true for live mode
let liveMode = true;
let posNeg = false;
let refineNew = false;
let nnInterSam2 = false; // Add new state for nnInter/SAM2 toggle

let shownWarning = false;

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
        commandsManager.run('resetNninter', {clearMeasurements: true});
        toolboxState.setPosNeg(false);
        shownWarning = !enabled;
    }
  },
  // Add new methods for nnInter/SAM2 toggle
  getNnInterSam2: () => nnInterSam2,
  setNnInterSam2: (enabled: boolean) => {
    nnInterSam2 = enabled;
  },
  getShownWarning: () => shownWarning,
  markShownWarning: () => {
    shownWarning = true;
  },
}; 