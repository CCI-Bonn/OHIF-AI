import { state } from '../state';
function destroyToolGroup(toolGroupId) {
    const toolGroupIndex = state.toolGroups.findIndex((tg) => tg.id === toolGroupId);
    if (toolGroupIndex > -1) {
        // OHIF-AI LEAK FIX (upstream @cornerstonejs/tools bug).
        // This function used to ONLY splice the tool group out of an array. No tool's
        // disable hook was ever invoked, so tools that registered handlers on the GLOBAL
        // cornerstone eventTarget in onSetToolEnabled/onSetToolActive never ran their
        // onSetToolDisabled cleanup. Those listeners survived every mode exit — and because
        // a listener references the tool instance, the tool objects leaked with them.
        // MEASURED: +1 TOOLGROUP_VIEWPORT_ADDED and +1 SEGMENTATION_REPRESENTATION_MODIFIED
        // listener per study open/close cycle, monotonic, each a distinct closure.
        //
        // We invoke onSetToolDisabled() DIRECTLY rather than calling toolGroup.setToolDisabled(),
        // because the latter also calls _renderViewports() and fires tool-mode-changed events —
        // side effects we do not want while the viewports are being torn down.
        const toolGroup = state.toolGroups[toolGroupIndex];
        const toolInstances = (toolGroup && toolGroup._toolInstances) || {};
        for (const toolName of Object.keys(toolInstances)) {
            const toolInstance = toolInstances[toolName];
            try {
                if (toolInstance && typeof toolInstance.onSetToolDisabled === 'function') {
                    toolInstance.onSetToolDisabled();
                }
            } catch (error) {
                // teardown hygiene must never break tool-group disposal
                console.debug(`destroyToolGroup: ${toolName}.onSetToolDisabled() failed`, error);
            }
        }
        state.toolGroups.splice(toolGroupIndex, 1);
    }
}
export default destroyToolGroup;
