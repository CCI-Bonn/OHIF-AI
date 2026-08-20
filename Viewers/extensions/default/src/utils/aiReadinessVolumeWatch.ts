import { cache, eventTarget, Enums } from '@cornerstonejs/core';
import { toolboxState } from '../stores/toolboxState';
import { AI_VOLUME_TOAST_ID, AI_CLIENT_TOAST_TITLE, refreshAiToolbar } from './aiReadiness';

const TICK_MS = 500;
const PROGRESS_STEP = 10; // only re-toast on moves of > 10 percentage points

// ---------------------------------------------------------------------------
// Volume-readiness watch (flag duty only — no toast)
// ---------------------------------------------------------------------------

let _watch: {
  volumeId: string;
  intervalId: ReturnType<typeof setInterval>;
  listener: (evt) => void;
} | null = null;

export function stopAiVolumeWatch() {
  if (!_watch) {
    return;
  }
  clearInterval(_watch.intervalId);
  eventTarget.removeEventListener(
    Enums.Events.IMAGE_VOLUME_LOADING_COMPLETED,
    _watch.listener
  );
  _watch = null;
}

function markLoaded(servicesManager) {
  stopAiVolumeWatch();
  if (!toolboxState.getAiVolumeLoaded()) {
    toolboxState.setAiVolumeLoaded(true);
    refreshAiToolbar(servicesManager);
  }
}

/**
 * Track client-side streaming progress for the active series' source volume.
 * Called from initNninter on every trigger; safe to call repeatedly.
 * This function only manages the aiVolumeLoaded flag — toast duties belong to
 * watchAiClientDownload.
 */
export function watchAiVolumeReadiness({ displaySet, servicesManager }) {
  const volumeId = `cornerstoneStreamingImageVolume:${displaySet.displaySetInstanceUID}`;
  const volume = cache.getVolume(volumeId);

  // Stack viewports have no streaming volume — nothing client-side to wait on
  // (the server segments its own full copy; prompt coordinates are geometric).
  if (!volume || volume.loadStatus?.loaded) {
    markLoaded(servicesManager);
    return;
  }

  if (_watch?.volumeId === volumeId) {
    return; // already watching this volume
  }

  stopAiVolumeWatch();
  toolboxState.setAiVolumeLoaded(false);
  refreshAiToolbar(servicesManager);

  const listener = evt => {
    if (evt?.detail?.volumeId === volumeId) {
      markLoaded(servicesManager);
    }
  };
  eventTarget.addEventListener(Enums.Events.IMAGE_VOLUME_LOADING_COMPLETED, listener);

  const intervalId = setInterval(() => {
    const v = cache.getVolume(volumeId);
    if (!v || v.loadStatus?.loaded) {
      markLoaded(servicesManager);
    }
  }, TICK_MS);

  _watch = { volumeId, intervalId, listener };
}

// ---------------------------------------------------------------------------
// Client slice-download ticker (display-only — never touches readiness flags)
// ---------------------------------------------------------------------------

let _download: {
  key: string;
  intervalId: ReturnType<typeof setInterval>;
  lastShownPct: number;
} | null = null;

export function stopAiClientDownload(uiNotificationService?) {
  if (!_download) {
    return;
  }
  clearInterval(_download.intervalId);
  uiNotificationService?.hide(AI_VOLUME_TOAST_ID);
  _download = null;
}

function downloadPct(imageIds) {
  const loaded = imageIds.filter(id => cache.getImage(id)).length;
  return Math.floor((100 * loaded) / imageIds.length);
}

function showDownloadToast(uiNotificationService, pct) {
  uiNotificationService.show({
    id: AI_VOLUME_TOAST_ID,
    title: AI_CLIENT_TOAST_TITLE,
    message: `Caching images… ${pct}%`,
    type: 'info',
    duration: Infinity,
  });
}

/**
 * Display-only slice ticker: shows caching progress ONLY while the client side
 * actually gates segmentation — i.e. while `aiVolumeLoaded` is false (an MPR
 * volume actively streaming). Stack view lazy-loads slices by design, so a
 * partially-filled cache there is normal and gets no toast. Never touches
 * readiness flags.
 */
export function watchAiClientDownload({ imageIds, servicesManager }) {
  const { uiNotificationService } = servicesManager.services;
  if (!imageIds?.length) {
    stopAiClientDownload(uiNotificationService);
    return;
  }
  if (toolboxState.getAiVolumeLoaded()) {
    // Client isn't blocking anything; lazy loading is intentional — stay quiet.
    stopAiClientDownload(uiNotificationService);
    return;
  }
  const key = `${imageIds.length}:${imageIds[0]}:${imageIds[imageIds.length - 1]}`;
  if (_download?.key === key) {
    return; // same series, already ticking
  }
  stopAiClientDownload(uiNotificationService);

  const initialPct = downloadPct(imageIds);
  if (initialPct >= 100) {
    return; // fully cached — nothing to show
  }
  showDownloadToast(uiNotificationService, initialPct);

  const intervalId = setInterval(() => {
    if (toolboxState.getAiVolumeLoaded()) {
      // The volume finished (or the viewport stopped gating) — purpose served.
      stopAiClientDownload(uiNotificationService);
      return;
    }
    const pct = downloadPct(imageIds);
    if (pct >= 100) {
      stopAiClientDownload(uiNotificationService);
      return;
    }
    if (_download && pct > _download.lastShownPct + PROGRESS_STEP) {
      _download.lastShownPct = pct;
      showDownloadToast(uiNotificationService, pct);
    }
  }, TICK_MS);

  _download = { key, intervalId, lastShownPct: initialPct };
}
