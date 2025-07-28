// Simple global state for toolbox settings
let liveMode = false;
let posNeg = false;
let refineNew = false;

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
    }
  },
}; 