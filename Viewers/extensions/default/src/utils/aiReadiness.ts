import { toolboxState } from '../stores/toolboxState';

export const AI_SERVER_TOAST_ID = 'ai-server-readiness';
export const AI_VOLUME_TOAST_ID = 'ai-volume-download';
export const AI_SERVER_TOAST_TITLE = 'Server';
export const AI_CLIENT_TOAST_TITLE = 'Client';
export const WARMUP_RETRY_MS = 5000;

const WARMUP_STATUSES = [502, 503, 504];

/** Warm-up = the server is coming up (gateway errors) or unreachable (no HTTP response). */
export function isAiWarmupError(error) {
  const status = error?.response?.status;
  return WARMUP_STATUSES.includes(status) || !error?.response;
}

let _warmupRetryTimer: ReturnType<typeof setTimeout> | null = null;

export function refreshAiToolbar(servicesManager) {
  const { toolbarService, viewportGridService } = servicesManager.services;
  toolbarService.refreshToolbarState({
    viewportId: viewportGridService.getActiveViewportId(),
  });
}

/** Toolbar evaluator body: undefined when ready, else disabled with the reason. */
export function evaluateAiSegmentationReady() {
  if (toolboxState.getAiSegmentationReady()) {
    return undefined;
  }
  return {
    disabled: true,
    disabledText: toolboxState.getAiVolumeLoaded()
      ? 'Server downloading and preparing images…'
      : 'Client caching images…',
  };
}

function cancelWarmupRetry() {
  if (_warmupRetryTimer !== null) {
    clearTimeout(_warmupRetryTimer);
    _warmupRetryTimer = null;
  }
}

export const AI_SERVER_PROGRESS_POLL_MS = 1000;

let _progressPollTimer: ReturnType<typeof setInterval> | null = null;
let _progressEndpointMissing = false; // old server image (404) — off for the session
let _pollGeneration = 0;

export function stopAiServerProgressPolling() {
  if (_progressPollTimer !== null) {
    clearInterval(_progressPollTimer);
    _progressPollTimer = null;
  }
  _pollGeneration++;
}

/** Test-only: clears the session-permanent 404 disable and any live poll timer. */
export function _resetAiServerProgressPollingForTests() {
  stopAiServerProgressPolling();
  _progressEndpointMissing = false;
}

/**
 * Display-only: refines the persistent server toast with real percentages
 * while the init request is in flight. Never touches readiness flags.
 */
export function startAiServerProgressPolling({ seriesUID, servicesManager }) {
  stopAiServerProgressPolling();
  if (_progressEndpointMissing) {
    return;
  }
  const { uiNotificationService } = servicesManager.services;
  _pollGeneration++;
  const gen = _pollGeneration;
  _progressPollTimer = setInterval(async () => {
    try {
      const res = await fetch(`/monai/nninter/session/progress?image=${encodeURIComponent(seriesUID)}`);
      if (gen !== _pollGeneration) {
        return;
      }
      if (res.status === 404) {
        _progressEndpointMissing = true;
        stopAiServerProgressPolling();
        return;
      }
      if (!res.ok) {
        return; // transient (e.g. 502 during warm-up) — keep polling
      }
      const p = await res.json();
      if (gen !== _pollGeneration) {
        return;
      }
      if (seriesUID !== toolboxState.getAiReadinessSeriesUID()) {
        stopAiServerProgressPolling();
        return;
      }
      if (p.phase === 'downloading' && p.total > 0) {
        uiNotificationService.show({
          id: AI_SERVER_TOAST_ID,
          title: AI_SERVER_TOAST_TITLE,
          message: `Downloading images… ${Math.floor((100 * p.fetched) / p.total)}%`,
          type: 'info',
          duration: Infinity,
        });
      } else if (p.phase === 'preparing') {
        uiNotificationService.show({
          id: AI_SERVER_TOAST_ID,
          title: AI_SERVER_TOAST_TITLE,
          message: 'Preparing images…',
          type: 'info',
          duration: Infinity,
        });
      }
      // 'unknown' → leave the current message as-is
    } catch (e) {
      stopAiServerProgressPolling(); // network error — static message stands
    }
  }, AI_SERVER_PROGRESS_POLL_MS);
}

/** Call from initNninter once the series UID and its change-state are known. */
export function noteAiInitStarted({ seriesUID, seriesChanged, servicesManager }) {
  if (!seriesChanged) {
    return;
  }
  cancelWarmupRetry();
  stopAiServerProgressPolling();
  toolboxState.resetAiReadiness(seriesUID);
  const { uiNotificationService } = servicesManager.services;
  uiNotificationService.hide(AI_VOLUME_TOAST_ID);
  uiNotificationService.show({
    id: AI_SERVER_TOAST_ID,
    title: AI_SERVER_TOAST_TITLE,
    message: 'Downloading and preparing images…',
    type: 'info',
    duration: Infinity,
  });
  refreshAiToolbar(servicesManager);
}

/** Call when the init request resolved successfully (after any session reclaim). */
export function noteAiInitSuccess({ seriesUID, servicesManager }) {
  if (seriesUID !== toolboxState.getAiReadinessSeriesUID()) {
    return; // stale response for a previous series
  }
  cancelWarmupRetry();
  stopAiServerProgressPolling();
  const wasReady = toolboxState.getAiServerReady();
  toolboxState.setAiServerReady(true);
  const { uiNotificationService } = servicesManager.services;
  if (wasReady) {
    return;
  }
  // Same id: sonner replaces the persistent "Preparing…" toast in place.
  uiNotificationService.show({
    id: AI_SERVER_TOAST_ID,
    title: AI_SERVER_TOAST_TITLE,
    message: 'Segmentation ready',
    type: 'success',
    duration: 3000,
  });
  refreshAiToolbar(servicesManager);
}

/**
 * Call when the init request failed. Warm-up failures (gateway 502/503/504 or no
 * HTTP response at all) auto-retry: without this the gated tools could never
 * trigger the old click-to-retry path, deadlocking the UI. Hard failures get an
 * error toast with a manual Retry action instead.
 */
export function noteAiInitError({ error, seriesUID, servicesManager, retry, forceHard = false }) {
  if (seriesUID !== toolboxState.getAiReadinessSeriesUID()) {
    return;
  }
  stopAiServerProgressPolling();
  const { uiNotificationService } = servicesManager.services;
  const isWarmup = forceHard ? false : isAiWarmupError(error);
  if (isWarmup) {
    uiNotificationService.show({
      id: AI_SERVER_TOAST_ID,
      title: AI_SERVER_TOAST_TITLE,
      message: 'Starting up — retrying automatically…',
      type: 'info',
      duration: Infinity,
    });
    cancelWarmupRetry();
    _warmupRetryTimer = setTimeout(() => {
      _warmupRetryTimer = null;
      if (seriesUID === toolboxState.getAiReadinessSeriesUID()) {
        retry();
      }
    }, WARMUP_RETRY_MS);
    return;
  }
  uiNotificationService.hide(AI_SERVER_TOAST_ID);
  uiNotificationService.show({
    title: AI_SERVER_TOAST_TITLE,
    message: `Segmentation setup failed: ${error?.message || 'unknown error'}`,
    type: 'error',
    duration: 8000,
    action: { label: 'Retry', onClick: retry },
  });
}

/**
 * Guard for inference entry points. Hotkeys (P/B/L/S…) bypass toolbar disabling,
 * so the commands themselves must refuse and explain. Returns true to proceed.
 */
export function ensureAiReadyForInference(servicesManager) {
  if (toolboxState.getAiSegmentationReady()) {
    return true;
  }
  const { uiNotificationService } = servicesManager.services;
  const volumeLoaded = toolboxState.getAiVolumeLoaded();
  uiNotificationService.show({
    title: volumeLoaded ? AI_SERVER_TOAST_TITLE : AI_CLIENT_TOAST_TITLE,
    message: volumeLoaded
      ? 'Segmentation not ready — still downloading the images.'
      : 'Segmentation not ready — images still caching.',
    type: 'warning',
    duration: 4000,
  });
  return false;
}

/** Full teardown for mode exit: no AI readiness timer or toast may outlive the mode. */
export function teardownAiReadiness(servicesManager) {
  cancelWarmupRetry();
  stopAiServerProgressPolling();
  const { uiNotificationService } = servicesManager.services;
  uiNotificationService.hide(AI_SERVER_TOAST_ID);
  uiNotificationService.hide(AI_VOLUME_TOAST_ID);
}
