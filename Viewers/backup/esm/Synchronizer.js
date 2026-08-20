import { getRenderingEngine, getEnabledElement, eventTarget, Enums, getEnabledElementByViewportId, } from '@cornerstonejs/core';
class Synchronizer {
    constructor(synchronizerId, eventName, eventHandler, options) {
        this._viewportOptions = {};
        this._onEvent = (evt) => {
            if (this._ignoreFiredEvents === true) {
                return;
            }
            if (!this._targetViewports.length) {
                return;
            }
            const enabledElement = this._eventSource === 'element'
                ? getEnabledElement(evt.currentTarget)
                : getEnabledElementByViewportId(evt.detail?.viewportId);
            if (!enabledElement) {
                return;
            }
            const { renderingEngineId, viewportId } = enabledElement;
            if (!this._sourceViewports.find((s) => s.viewportId === viewportId)) {
                return;
            }
            this.fireEvent({
                renderingEngineId,
                viewportId,
            }, evt);
        };
        this._enabled = true;
        this._eventName = eventName;
        this._eventHandler = eventHandler;
        this._ignoreFiredEvents = false;
        this._sourceViewports = [];
        this._targetViewports = [];
        this._options = options || {};
        this._eventSource = this._options.eventSource || 'element';
        this._auxiliaryEvents = this._options.auxiliaryEvents || [];
        this.id = synchronizerId;
    }
    isDisabled() {
        return !this._enabled || !this._hasSourceElements();
    }
    setOptions(viewportId, options = {}) {
        this._viewportOptions[viewportId] = options;
    }
    setEnabled(enabled) {
        this._enabled = enabled;
    }
    getOptions(viewportId) {
        return this._viewportOptions[viewportId];
    }
    add(viewportInfo) {
        this.addTarget(viewportInfo);
        this.addSource(viewportInfo);
    }
    addSource(viewportInfo) {
        if (_containsViewport(this._sourceViewports, viewportInfo)) {
            return;
        }
        const { renderingEngineId, viewportId } = viewportInfo;
        const viewport = getRenderingEngine(renderingEngineId).getViewport(viewportId);
        if (!viewport) {
            console.warn(`Synchronizer.addSource: No viewport for ${renderingEngineId} ${viewportId}`);
            return;
        }
        const eventSource = this._eventSource === 'element' ? viewport.element : eventTarget;
        // OHIF-AI LEAK FIX: `this._onEvent.bind(this)` created a NEW function object on every
        // call, so removeEventListener could never match it. Worse, removeSource() below removed
        // `this._eventHandler` — a DIFFERENT function entirely (the synchronizer's callback,
        // not this internal dispatcher). `_onEvent` is already an instance arrow function
        // (see constructor), so it is stable and the bind was redundant as well as harmful.
        // MEASURED: +5 SEGMENTATION_REPRESENTATION_MODIFIED listeners per MPR cycle.
        eventSource.addEventListener(this._eventName, this._onEvent);
        this._auxiliaryEvents.forEach(({ name, source = 'element' }) => {
            const target = source === 'element' ? viewport.element : eventTarget;
            target.addEventListener(name, this._onEvent);
        });
        this._updateDisableHandlers();
        this._sourceViewports.push(viewportInfo);
    }
    addTarget(viewportInfo) {
        if (_containsViewport(this._targetViewports, viewportInfo)) {
            return;
        }
        this._targetViewports.push(viewportInfo);
        this._updateDisableHandlers();
    }
    getSourceViewports() {
        return this._sourceViewports;
    }
    getTargetViewports() {
        return this._targetViewports;
    }
    destroy() {
        // Iterate over COPIES: removeSource/removeTarget splice the very arrays being
        // iterated, so forEach over the live arrays skips elements (upstream bug — it
        // meant destroy() left viewports attached).
        [...this._sourceViewports].forEach((s) => this.removeSource(s));
        [...this._targetViewports].forEach((t) => this.removeTarget(t));
        // OHIF-AI LEAK FIX: with the stable handler above, remove+add is idempotent while
        // the synchronizer is alive — but on teardown the viewport lists are emptied FIRST,
        // so _updateDisableHandlers iterates nothing and the last-added global listener is
        // orphaned. Element-scoped listeners die with their element; the global eventTarget
        // one must be removed explicitly or every destroyed synchronizer leaks exactly one.
        if (this._disableHandler) {
            eventTarget.removeEventListener(Enums.Events.ELEMENT_DISABLED, this._disableHandler);
            this._disableHandler = null;
        }
        // OHIF-AI LEAK FIX (part 2). removeSource() only unregisters this._eventHandler when it
        // can still find the viewport in _sourceViewports AND getEventSource() resolves — at
        // teardown either can fail (viewport already spliced, rendering engine gone), leaving the
        // handler attached to the GLOBAL eventTarget. Measured: SynchronizerManager.destroy() was
        // confirmed to RUN on mode exit (onModeExit fired, destroy called) yet
        // SEGMENTATION_REPRESENTATION_MODIFIED listeners did not drop — +5 per MPR cycle,
        // registration site confirmed as Synchronizer.addSource via captured stack traces.
        // Remove unconditionally; removeEventListener is a no-op if it was already taken off.
        try {
            eventTarget.removeEventListener(this._eventName, this._onEvent);
            (this._auxiliaryEvents || []).forEach(({ name }) => {
                eventTarget.removeEventListener(name, this._onEvent);
            });
        }
        catch (error) {
            /* nothing attached */
        }
    }
    remove(viewportInfo) {
        this.removeTarget(viewportInfo);
        this.removeSource(viewportInfo);
    }
    removeSource(viewportInfo) {
        const index = _getViewportIndex(this._sourceViewports, viewportInfo);
        if (index === -1) {
            return;
        }
        const eventSource = this._eventSource === 'element'
            ? this.getViewportElement(viewportInfo)
            : eventTarget;
        this._sourceViewports.splice(index, 1);
        // OHIF-AI LEAK FIX: was removing `this._eventHandler`, which is NOT what addSource
        // registered — addSource attaches `this._onEvent`. Removing the wrong function is a
        // silent no-op, so every source added here leaked its listener.
        eventSource?.removeEventListener(this._eventName, this._onEvent);
        this._auxiliaryEvents.forEach(({ name, source }) => {
            const target = source === 'element'
                ? this.getViewportElement(viewportInfo)
                : eventTarget;
            target?.removeEventListener(name, this._onEvent);
        });
        this._updateDisableHandlers();
    }
    removeTarget(viewportInfo) {
        const index = _getViewportIndex(this._targetViewports, viewportInfo);
        if (index === -1) {
            return;
        }
        this._targetViewports.splice(index, 1);
        this._updateDisableHandlers();
    }
    hasSourceViewport(renderingEngineId, viewportId) {
        return _containsViewport(this._sourceViewports, {
            renderingEngineId,
            viewportId,
        });
    }
    hasTargetViewport(renderingEngineId, viewportId) {
        return _containsViewport(this._targetViewports, {
            renderingEngineId,
            viewportId,
        });
    }
    fireEvent(sourceViewport, sourceEvent) {
        if (this.isDisabled() || this._ignoreFiredEvents) {
            return;
        }
        this._ignoreFiredEvents = true;
        const promises = [];
        try {
            for (let i = 0; i < this._targetViewports.length; i++) {
                const targetViewport = this._targetViewports[i];
                const targetIsSource = sourceViewport.viewportId === targetViewport.viewportId;
                if (targetIsSource) {
                    continue;
                }
                const result = this._eventHandler(this, sourceViewport, targetViewport, sourceEvent, this._options);
                if (result instanceof Promise) {
                    promises.push(result);
                }
            }
        }
        catch (ex) {
            console.warn(`Synchronizer, for: ${this._eventName}`, ex);
        }
        finally {
            if (promises.length) {
                Promise.allSettled(promises).then(() => {
                    this._ignoreFiredEvents = false;
                });
            }
            else {
                this._ignoreFiredEvents = false;
            }
        }
    }
    _hasSourceElements() {
        return this._sourceViewports.length !== 0;
    }
    _updateDisableHandlers() {
        const viewports = _getUniqueViewports(this._sourceViewports, this._targetViewports);
        // OHIF-AI LEAK FIX (upstream @cornerstonejs/tools bug).
        // `disableHandler` used to be a FRESH closure created on every call, so the
        // removeEventListener below could never match a previously-added listener — the
        // remove-then-add idiom only works with a STABLE reference. Every call therefore
        // added one more ELEMENT_DISABLED listener to the (global) eventTarget and removed
        // none. _updateDisableHandlers is called from add/removeSource/removeTarget/destroy,
        // so even tearing a synchronizer down leaked more listeners.
        // MEASURED before this fix: +3 ELEMENT_DISABLED listeners per study open/close
        // cycle, monotonic (6 -> 9 -> 12 -> 15 -> 18 over 4 cycles), never reclaimed.
        // Caching the handler on the instance makes remove+add idempotent.
        if (!this._disableHandler) {
            const _remove = this.remove.bind(this);
            this._disableHandler = (elementDisabledEvent) => {
                _remove(elementDisabledEvent.detail.element);
            };
        }
        const disableHandler = this._disableHandler;
        viewports.forEach((vp) => {
            const eventSource = this.getEventSource(vp);
            if (!eventSource) {
                return;
            }
            eventSource.removeEventListener(Enums.Events.ELEMENT_DISABLED, disableHandler);
            eventSource.addEventListener(Enums.Events.ELEMENT_DISABLED, disableHandler);
        });
    }
    getEventSource(viewportInfo) {
        return this._eventSource === 'element'
            ? this.getViewportElement(viewportInfo)
            : eventTarget;
    }
    getViewportElement(viewportInfo) {
        const { renderingEngineId, viewportId } = viewportInfo;
        const renderingEngine = getRenderingEngine(renderingEngineId);
        if (!renderingEngine) {
            return null;
        }
        const viewport = renderingEngine.getViewport(viewportId);
        if (!viewport) {
            return null;
        }
        return viewport.element;
    }
}
function _getUniqueViewports(vp1, vp2) {
    const unique = [];
    const vps = vp1.concat(vp2);
    for (let i = 0; i < vps.length; i++) {
        const vp = vps[i];
        if (!unique.some((u) => vp.renderingEngineId === u.renderingEngineId &&
            vp.viewportId === u.viewportId)) {
            unique.push(vp);
        }
    }
    return unique;
}
function _getViewportIndex(arr, vp) {
    return arr.findIndex((ar) => vp.renderingEngineId === ar.renderingEngineId &&
        vp.viewportId === ar.viewportId);
}
function _containsViewport(arr, vp) {
    return arr.some((ar) => ar.renderingEngineId === vp.renderingEngineId &&
        ar.viewportId === vp.viewportId);
}
export default Synchronizer;
