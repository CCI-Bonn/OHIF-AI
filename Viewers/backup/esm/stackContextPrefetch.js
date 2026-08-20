import { imageLoader, Enums, eventTarget, imageLoadPoolManager, cache, metaData, utilities, triggerEvent, } from '@cornerstonejs/core';
import { addToolState, getToolState } from './state';
import { getStackData, requestType, clearFromImageIds, getPromiseRemovedHandler, } from './stackPrefetchUtils';
import { Events } from '../../enums';
const { imageRetrieveMetadataProvider } = utilities;

// OHIF-AI LEAK FIX (upstream @cornerstonejs/tools bug).
// getPromiseRemovedHandler(element) returns a NEW function on every call, but both the
// enable path and disable() called it and then passed the result to removeEventListener —
// which can never match a previously-added listener. So enabling added one more
// IMAGE_CACHE_IMAGE_REMOVED listener to the global eventTarget and disabling removed none.
// MEASURED: +1 per study open/close cycle, monotonic, each a distinct closure.
// Cache one stable handler per element (WeakMap so detached elements are still collectable).
const _promiseRemovedHandlers = new WeakMap();
function _stablePromiseRemovedHandler(element) {
    let handler = _promiseRemovedHandlers.get(element);
    if (!handler) {
        handler = getPromiseRemovedHandler(element);
        _promiseRemovedHandlers.set(element, handler);
    }
    return handler;
}

// OHIF-AI LEAK FIX (part 2). Making the handler stable is not enough on its own, because
// nothing ever calls disable(): OHIF tears viewports down wholesale and never invokes
// per-viewport teardown, so each new viewport element left its listener behind forever
// (measured +1 per study open/close cycle even after the stable-handler fix).
// Self-clean instead of depending on a caller: register ONE global ELEMENT_DISABLED listener
// (once per module, not per element) and drop the element's prefetch registration when
// cornerstone disables it. Bounded: exactly one extra listener for the app's lifetime.
let _elementDisabledCleanupRegistered = false;
function _ensureElementDisabledCleanup() {
    if (_elementDisabledCleanupRegistered) {
        return;
    }
    _elementDisabledCleanupRegistered = true;
    eventTarget.addEventListener(Enums.Events.ELEMENT_DISABLED, (evt) => {
        const element = evt?.detail?.element;
        if (!element || !_promiseRemovedHandlers.has(element)) {
            return;
        }
        try {
            disable(element);
        }
        catch (error) {
            // teardown hygiene must never break element disposal
            console.debug('stackContextPrefetch self-cleanup failed', error);
        }
    });
}
let configuration = {
    maxImagesToPrefetch: Infinity,
    minBefore: 2,
    maxAfter: 2,
    directionExtraImages: 10,
    preserveExistingPool: false,
};
let resetPrefetchTimeout;
const resetPrefetchDelay = 5;
const priorities = {};
const enable = (element, priority = 0) => {
    const stack = getStackData(element);
    if (!stack) {
        return;
    }
    if (!stack.imageIds?.length) {
        console.warn('CornerstoneTools.stackPrefetch: No images in stack.');
        return;
    }
    updateToolState(element);
    priorities[element] = priority;
    prefetch(element, priority);
    element.removeEventListener(Enums.Events.STACK_NEW_IMAGE, onImageUpdated);
    element.addEventListener(Enums.Events.STACK_NEW_IMAGE, onImageUpdated);
    _ensureElementDisabledCleanup();
    const promiseRemovedHandler = _stablePromiseRemovedHandler(element);
    eventTarget.removeEventListener(Enums.Events.IMAGE_CACHE_IMAGE_REMOVED, promiseRemovedHandler);
    eventTarget.addEventListener(Enums.Events.IMAGE_CACHE_IMAGE_REMOVED, promiseRemovedHandler);
};
function prefetch(element, priority = 0) {
    const stack = getStackData(element);
    if (!stack) {
        return;
    }
    if (!stack?.imageIds?.length) {
        console.warn('CornerstoneTools.stackPrefetch: No images in stack.');
        return;
    }
    const stackPrefetchData = getToolState(element);
    if (!stackPrefetchData) {
        return;
    }
    const stackPrefetch = (stackPrefetchData || {});
    stackPrefetch.enabled =
        stackPrefetch.enabled && (stackPrefetch.indicesToRequest?.length ?? 0) > 0;
    if (stackPrefetch.enabled === false) {
        return;
    }
    function removeFromList(imageIdIndex) {
        const index = stackPrefetch.indicesToRequest.indexOf(imageIdIndex);
        if (index > -1) {
            stackPrefetch.indicesToRequest.splice(index, 1);
        }
    }
    const indicesToRequestCopy = stackPrefetch.indicesToRequest.slice();
    const { currentImageIdIndex } = stack;
    indicesToRequestCopy.forEach((imageIdIndex) => {
        const imageId = stack.imageIds[imageIdIndex];
        if (!imageId) {
            return;
        }
        const distance = Math.abs(currentImageIdIndex - imageIdIndex);
        const imageCached = distance < 6
            ? cache.getImageLoadObject(imageId)
            : cache.isLoaded(imageId);
        if (imageCached) {
            removeFromList(imageIdIndex);
        }
    });
    if (!stackPrefetch.indicesToRequest.length) {
        return;
    }
    if (!configuration.preserveExistingPool) {
        imageLoadPoolManager.filterRequests(clearFromImageIds(stack));
    }
    function doneCallback(imageId) {
        const imageIdIndex = stack.imageIds.indexOf(imageId);
        removeFromList(imageIdIndex);
        const image = cache.getCachedImageBasedOnImageURI(imageId);
        const { stats } = stackPrefetch;
        const decodeTimeInMS = image?.image?.decodeTimeInMS || 0;
        if (decodeTimeInMS) {
            stats.imageIds.set(imageId, decodeTimeInMS);
            stats.decodeTimeInMS += decodeTimeInMS;
            const loadTimeInMS = image?.image?.loadTimeInMS || 0;
            stats.loadTimeInMS += loadTimeInMS;
        }
        if (!stackPrefetch.indicesToRequest.length) {
            if (image?.sizeInBytes) {
                const { sizeInBytes } = image;
                const usage = cache.getMaxCacheSize() / 4 / sizeInBytes;
                if (!stackPrefetch.cacheFill) {
                    stats.initialTime = Date.now() - stats.start;
                    stats.initialSize = stats.imageIds.size;
                    updateToolState(element, usage);
                    prefetch(element, priority);
                }
                else if (stats.imageIds.size) {
                    stats.fillTime = Date.now() - stats.start;
                    const { size } = stats.imageIds;
                    stats.fillSize = size;
                }
            }
        }
        if (stackPrefetch.indicesToRequest.length === 0) {
            const eventDetail = {
                element: element,
                lastPrefetchedImageId: imageId,
            };
            triggerEvent(eventTarget, Events.STACK_PREFETCH_COMPLETE, eventDetail);
        }
    }
    const requestFn = (imageId, options) => {
        const { retrieveOptions = {} } = metaData.get(imageRetrieveMetadataProvider.IMAGE_RETRIEVE_CONFIGURATION, imageId, 'stack') || {};
        options.retrieveOptions = {
            ...options.retrieveOptions,
            ...(retrieveOptions.default || Object.values(retrieveOptions)?.[0] || {}),
        };
        return imageLoader
            .loadAndCacheImage(imageId, options)
            .then(() => doneCallback(imageId));
    };
    stackPrefetch.indicesToRequest.forEach((imageIdIndex) => {
        const imageId = stack.imageIds[imageIdIndex];
        const options = {
            requestType,
        };
        imageLoadPoolManager.addRequest(requestFn.bind(null, imageId, options), requestType, {
            imageId,
        }, priority);
    });
}
function onImageUpdated(e) {
    clearTimeout(resetPrefetchTimeout);
    resetPrefetchTimeout = setTimeout(function () {
        const element = e.target;
        try {
            updateToolState(element);
            prefetch(element, priorities[element]);
        }
        catch (error) {
            return;
        }
    }, resetPrefetchDelay);
}
const signum = (x) => (x < 0 ? -1 : 1);
const updateToolState = (element, usage) => {
    const stack = getStackData(element);
    if (!stack) {
        return;
    }
    if (!stack.imageIds?.length) {
        console.warn('CornerstoneTools.stackPrefetch: No images in stack.');
        return;
    }
    const { currentImageIdIndex } = stack;
    let { maxAfter = 2, minBefore = 2 } = configuration;
    const { directionExtraImages = 10 } = configuration;
    const stackPrefetchData = getToolState(element) ||
        {
            indicesToRequest: [],
            currentImageIdIndex,
            stackCount: 0,
            enabled: true,
            direction: 1,
            stats: {
                start: Date.now(),
                imageIds: new Map(),
                decodeTimeInMS: 0,
                loadTimeInMS: 0,
                totalBytes: 0,
            },
        };
    const delta = currentImageIdIndex - stackPrefetchData.currentImageIdIndex;
    stackPrefetchData.direction = signum(delta);
    stackPrefetchData.currentImageIdIndex = currentImageIdIndex;
    stackPrefetchData.enabled = true;
    if (stackPrefetchData.stackCount < 100) {
        stackPrefetchData.stackCount += directionExtraImages;
    }
    if (Math.abs(delta) > maxAfter || !delta) {
        stackPrefetchData.stackCount = 0;
        if (usage) {
            const positionFraction = currentImageIdIndex / stack.imageIds.length;
            minBefore = Math.ceil(usage * positionFraction);
            maxAfter = Math.ceil(usage * (1 - positionFraction));
            stackPrefetchData.cacheFill = true;
        }
        else {
            stackPrefetchData.cacheFill = false;
        }
    }
    else if (delta < 0) {
        minBefore += stackPrefetchData.stackCount;
        maxAfter = 0;
    }
    else {
        maxAfter += stackPrefetchData.stackCount;
        minBefore = 0;
    }
    const minIndex = Math.max(0, currentImageIdIndex - minBefore);
    const maxIndex = Math.min(stack.imageIds.length - 1, currentImageIdIndex + maxAfter);
    const indicesToRequest = [];
    for (let i = currentImageIdIndex + 1; i <= maxIndex; i++) {
        indicesToRequest.push(i);
    }
    for (let i = currentImageIdIndex - 1; i >= minIndex; i--) {
        indicesToRequest.push(i);
    }
    stackPrefetchData.indicesToRequest = indicesToRequest;
    addToolState(element, stackPrefetchData);
};
function disable(element) {
    clearTimeout(resetPrefetchTimeout);
    element.removeEventListener(Enums.Events.STACK_NEW_IMAGE, onImageUpdated);
    const promiseRemovedHandler = _stablePromiseRemovedHandler(element);
    eventTarget.removeEventListener(Enums.Events.IMAGE_CACHE_IMAGE_REMOVED, promiseRemovedHandler);
    _promiseRemovedHandlers.delete(element);
    const stackPrefetchData = getToolState(element);
    if (stackPrefetchData) {
        stackPrefetchData.enabled = false;
    }
}
function getConfiguration() {
    return configuration;
}
function setConfiguration(config) {
    configuration = config;
}
const stackContextPrefetch = {
    enable,
    disable,
    getConfiguration,
    setConfiguration,
};
export default stackContextPrefetch;
