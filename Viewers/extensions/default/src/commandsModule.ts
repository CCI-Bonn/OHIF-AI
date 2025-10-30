import { utils, Types, DicomMetadataStore } from '@ohif/core';

import { ContextMenuController } from './CustomizableContextMenu';
import DicomTagBrowser from './DicomTagBrowser/DicomTagBrowser';
import reuseCachedLayouts from './utils/reuseCachedLayouts';
import findViewportsByPosition, {
  findOrCreateViewport as layoutFindOrCreate,
} from './findViewportsByPosition';

import { ContextMenuProps } from './CustomizableContextMenu/types';
import { NavigateHistory } from './types/commandModuleTypes';
import { history } from '@ohif/app';
import { useViewportGridStore } from './stores/useViewportGridStore';
import { useDisplaySetSelectorStore } from './stores/useDisplaySetSelectorStore';
import { useHangingProtocolStageIndexStore } from './stores/useHangingProtocolStageIndexStore';
import { useToggleHangingProtocolStore } from './stores/useToggleHangingProtocolStore';
import { useViewportsByPositionStore } from './stores/useViewportsByPositionStore';
import { useToggleOneUpViewportGridStore } from './stores/useToggleOneUpViewportGridStore';
import requestDisplaySetCreationForStudy from './Panels/requestDisplaySetCreationForStudy';
import promptSaveReport from './utils/promptSaveReport';

import { Enums as csToolsEnums, Types as cstTypes, segmentation as csToolsSegmentation } from '@cornerstonejs/tools';
import { updateLabelmapSegmentationImageReferences } from '@cornerstonejs/tools/segmentation/updateLabelmapSegmentationImageReferences';
import { cache, imageLoader, metaData, Types as csTypes, utilities as csUtils } from '@cornerstonejs/core';
import { adaptersSEG } from '@cornerstonejs/adapters';
const LABELMAP = csToolsEnums.SegmentationRepresentations.Labelmap;
import MonaiLabelClient from '../../monai-label/src/services/MonaiLabelClient';
import { updateSegmentationStats } from '../../cornerstone/src/utils/updateSegmentationStats';
import axios from 'axios';
import { toolboxState } from './stores/toolboxState';
import { parseMultipart } from './utils/multipart';


export type HangingProtocolParams = {
  protocolId?: string;
  stageIndex?: number;
  activeStudyUID?: string;
  stageId?: string;
  reset?: false;
};

export type UpdateViewportDisplaySetParams = {
  direction: number;
  excludeNonImageModalities?: boolean;
};

const commandsModule = ({
  servicesManager,
  commandsManager,
  extensionManager,
}: Types.Extensions.ExtensionParams): Types.Extensions.CommandsModule => {
  const {
    customizationService,
    measurementService,
    hangingProtocolService,
    uiNotificationService,
    viewportGridService,
    displaySetService,
    multiMonitorService,
  } = servicesManager.services;

  // Listen for measurement added events to trigger nninter() when live mode is enabled
  measurementService.subscribe(
    measurementService.EVENTS.MEASUREMENT_ADDED,
    (evt) => {
      if (toolboxState.getLiveMode() &&
      ['Probe2', 'PlanarFreehandROI2', 'PlanarFreehandROI3', 'RectangleROI2'].includes(
        evt.measurement.toolName
      )) {
        console.log('Live mode enabled, triggering nninter() for new measurement');
        // Use setTimeout to ensure the measurement is fully processed
        setTimeout(() => {
          if (!toolboxState.getNnInterSam2()) {
            commandsManager.run('nninter');
          } else {
            commandsManager.run('sam2');
          }
        }, 50);
      }
    }
  );

  // Define a context menu controller for use with any context menus
  const contextMenuController = new ContextMenuController(servicesManager, commandsManager);

  const actions = {
    /**
     * Runs a command in multi-monitor mode.  No-op if not multi-monitor.
     */
    multimonitor: async options => {
      const { screenDelta, StudyInstanceUID, commands, hashParams } = options;
      if (multiMonitorService.numberOfScreens < 2) {
        return options.fallback?.(options);
      }

      const newWindow = await multiMonitorService.launchWindow(
        StudyInstanceUID,
        screenDelta,
        hashParams
      );

      // Only run commands if we successfully got a window with a commands manager
      if (newWindow && commands) {
        // Todo: fix this properly, but it takes time for the new window to load
        // and then the commandsManager is available for it
        setTimeout(() => {
          multiMonitorService.run(screenDelta, commands, options);
        }, 1000);
      }
    },

    /** Displays a prompt and then save the report if relevant */
    promptSaveReport: props => {
      const { StudyInstanceUID } = props;
      promptSaveReport({ servicesManager, commandsManager, extensionManager }, props, {
        data: { StudyInstanceUID },
      });
    },

    /**
     * Ensures that the specified study is available for display
     * Then, if commands is specified, runs the given commands list/instance
     */
    loadStudy: async options => {
      const { StudyInstanceUID } = options;
      const displaySets = displaySetService.getActiveDisplaySets();
      const isActive = displaySets.find(ds => ds.StudyInstanceUID === StudyInstanceUID);
      if (isActive) {
        return;
      }
      const [dataSource] = extensionManager.getActiveDataSource();
      await requestDisplaySetCreationForStudy(dataSource, displaySetService, StudyInstanceUID);

      const study = DicomMetadataStore.getStudy(StudyInstanceUID);
      hangingProtocolService.addStudy(study);
    },

    /**
     * Show the context menu.
     * @param options.menuId defines the menu name to lookup, from customizationService
     * @param options.defaultMenu contains the default menu set to use
     * @param options.element is the element to show the menu within
     * @param options.event is the event that caused the context menu
     * @param options.selectorProps is the set of selection properties to use
     */
    showContextMenu: (options: ContextMenuProps) => {
      const {
        menuCustomizationId,
        element,
        event,
        selectorProps,
        defaultPointsPosition = [],
      } = options;

      const optionsToUse = { ...options };

      if (menuCustomizationId) {
        Object.assign(optionsToUse, customizationService.getCustomization(menuCustomizationId));
      }

      // TODO - make the selectorProps richer by including the study metadata and display set.
      const { protocol, stage } = hangingProtocolService.getActiveProtocol();
      optionsToUse.selectorProps = {
        event,
        protocol,
        stage,
        ...selectorProps,
      };

      contextMenuController.showContextMenu(optionsToUse, element, defaultPointsPosition);
    },

    /** Close a context menu currently displayed */
    closeContextMenu: () => {
      contextMenuController.closeContextMenu();
    },

    displayNotification: ({ text, title, type }) => {
      uiNotificationService.show({
        title: title,
        message: text,
        type: type,
      });
    },

    clearMeasurements: options => {
      measurementService.clearMeasurements(options.measurementFilter);
    },

    /**
     *  Sets the specified protocol
     *    1. Records any existing state using the viewport grid service
     *    2. Finds the destination state - this can be one of:
     *       a. The specified protocol stage
     *       b. An alternate (toggled or restored) protocol stage
     *       c. A restored custom layout
     *    3. Finds the parameters for the specified state
     *       a. Gets the displaySetSelectorMap
     *       b. Gets the map by position
     *       c. Gets any toggle mapping to map position to/from current view
     *    4. If restore, then sets layout
     *       a. Maps viewport position by currently displayed viewport map id
     *       b. Uses toggle information to map display set id
     *    5. Else applies the hanging protocol
     *       a. HP Service is provided displaySetSelectorMap
     *       b. HP Service will throw an exception if it isn't applicable
     * @param options - contains information on the HP to apply
     * @param options.activeStudyUID - the updated study to apply the HP to
     * @param options.protocolId - the protocol ID to change to
     * @param options.stageId - the stageId to apply
     * @param options.stageIndex - the index of the stage to go to.
     * @param options.reset - flag to indicate if the HP should be reset to its original and not restored to a previous state
     *
     * commandsManager.run('setHangingProtocol', {
     *   activeStudyUID: '1.2.3',
     *   protocolId: 'myProtocol',
     *   stageId: 'myStage',
     *   stageIndex: 0,
     *   reset: false,
     * });
     */
    setHangingProtocol: ({
      activeStudyUID = '',
      StudyInstanceUID = '',
      protocolId,
      stageId,
      stageIndex,
      reset = false,
    }: HangingProtocolParams): boolean => {
      const toUseStudyInstanceUID = activeStudyUID || StudyInstanceUID;
      try {
        // Stores in the state the display set selector id to displaySetUID mapping
        // Pass in viewportId for the active viewport.  This item will get set as
        // the activeViewportId
        const state = viewportGridService.getState();
        const hpInfo = hangingProtocolService.getState();
        reuseCachedLayouts(state, hangingProtocolService);
        const { hangingProtocolStageIndexMap } = useHangingProtocolStageIndexStore.getState();
        const { displaySetSelectorMap } = useDisplaySetSelectorStore.getState();

        if (!protocolId) {
          // Reuse the previous protocol id, and optionally stage
          protocolId = hpInfo.protocolId;
          if (stageId === undefined && stageIndex === undefined) {
            stageIndex = hpInfo.stageIndex;
          }
        } else if (stageIndex === undefined && stageId === undefined) {
          // Re-set the same stage as was previously used
          const hangingId = `${toUseStudyInstanceUID || hpInfo.activeStudyUID}:${protocolId}`;
          stageIndex = hangingProtocolStageIndexMap[hangingId]?.stageIndex;
        }

        const useStageIdx =
          stageIndex ??
          hangingProtocolService.getStageIndex(protocolId, {
            stageId,
            stageIndex,
          });

        const activeStudyChanged = hangingProtocolService.setActiveStudyUID(toUseStudyInstanceUID);

        const storedHanging = `${toUseStudyInstanceUID || hangingProtocolService.getState().activeStudyUID}:${protocolId}:${
          useStageIdx || 0
        }`;

        const { viewportGridState } = useViewportGridStore.getState();
        const restoreProtocol = !reset && viewportGridState[storedHanging];

        if (
          reset ||
          (activeStudyChanged &&
            !viewportGridState[storedHanging] &&
            stageIndex === undefined &&
            stageId === undefined)
        ) {
          // Run the hanging protocol fresh, re-using the existing study data
          // This is done on reset or when the study changes and we haven't yet
          // applied it, and don't specify exact stage to use.
          const displaySets = displaySetService.getActiveDisplaySets();
          const activeStudy = {
            StudyInstanceUID: toUseStudyInstanceUID,
            displaySets,
          };
          hangingProtocolService.run(activeStudy, protocolId);
        } else if (
          protocolId === hpInfo.protocolId &&
          useStageIdx === hpInfo.stageIndex &&
          !toUseStudyInstanceUID
        ) {
          // Clear the HP setting to reset them
          hangingProtocolService.setProtocol(protocolId, {
            stageId,
            stageIndex: useStageIdx,
          });
        } else {
          hangingProtocolService.setProtocol(protocolId, {
            displaySetSelectorMap,
            stageId,
            stageIndex: useStageIdx,
            restoreProtocol,
          });
          if (restoreProtocol) {
            viewportGridService.set(viewportGridState[storedHanging]);
          }
        }
        // Do this after successfully applying the update
        const { setDisplaySetSelector } = useDisplaySetSelectorStore.getState();
        setDisplaySetSelector(
          `${toUseStudyInstanceUID || hpInfo.activeStudyUID}:activeDisplaySet:0`,
          null
        );
        return true;
      } catch (e) {
        console.error(e);
        uiNotificationService.show({
          title: 'Apply Hanging Protocol',
          message: 'The hanging protocol could not be applied.',
          type: 'error',
          duration: 3000,
        });
        return false;
      }
    },

    toggleHangingProtocol: ({ protocolId, stageIndex }: HangingProtocolParams): boolean => {
      const {
        protocol,
        stageIndex: desiredStageIndex,
        activeStudy,
      } = hangingProtocolService.getActiveProtocol();
      const { toggleHangingProtocol, setToggleHangingProtocol } =
        useToggleHangingProtocolStore.getState();
      const storedHanging = `${activeStudy.StudyInstanceUID}:${protocolId}:${stageIndex | 0}`;
      if (
        protocol.id === protocolId &&
        (stageIndex === undefined || stageIndex === desiredStageIndex)
      ) {
        // Toggling off - restore to previous state
        const previousState = toggleHangingProtocol[storedHanging] || {
          protocolId: 'default',
        };
        return actions.setHangingProtocol(previousState);
      } else {
        setToggleHangingProtocol(storedHanging, {
          protocolId: protocol.id,
          stageIndex: desiredStageIndex,
        });
        return actions.setHangingProtocol({
          protocolId,
          stageIndex,
          reset: true,
        });
      }
    },

    deltaStage: ({ direction }) => {
      const { protocolId, stageIndex: oldStageIndex } = hangingProtocolService.getState();
      const { protocol } = hangingProtocolService.getActiveProtocol();
      for (
        let stageIndex = oldStageIndex + direction;
        stageIndex >= 0 && stageIndex < protocol.stages.length;
        stageIndex += direction
      ) {
        if (protocol.stages[stageIndex].status !== 'disabled') {
          return actions.setHangingProtocol({
            protocolId,
            stageIndex,
          });
        }
      }
      uiNotificationService.show({
        title: 'Change Stage',
        message: 'The hanging protocol has no more applicable stages',
        type: 'info',
        duration: 3000,
      });
    },

    /**
     * Changes the viewport grid layout in terms of the MxN layout.
     */
    setViewportGridLayout: ({ numRows, numCols, isHangingProtocolLayout = false }) => {
      const { protocol } = hangingProtocolService.getActiveProtocol();
      const onLayoutChange = protocol.callbacks?.onLayoutChange;
      if (commandsManager.run(onLayoutChange, { numRows, numCols }) === false) {
        // Don't apply the layout if the run command returns false
        return;
      }

      const completeLayout = () => {
        const state = viewportGridService.getState();
        findViewportsByPosition(state, { numRows, numCols });

        const { viewportsByPosition, initialInDisplay } = useViewportsByPositionStore.getState();

        const findOrCreateViewport = layoutFindOrCreate.bind(
          null,
          hangingProtocolService,
          isHangingProtocolLayout,
          { ...viewportsByPosition, initialInDisplay }
        );

        viewportGridService.setLayout({
          numRows,
          numCols,
          findOrCreateViewport,
          isHangingProtocolLayout,
        });
      };
      // Need to finish any work in the callback
      window.setTimeout(completeLayout, 0);
    },

    toggleOneUp() {
      const viewportGridState = viewportGridService.getState();
      const { activeViewportId, viewports, layout, isHangingProtocolLayout } = viewportGridState;
      const { displaySetInstanceUIDs, displaySetOptions, viewportOptions } =
        viewports.get(activeViewportId);

      if (layout.numCols === 1 && layout.numRows === 1) {
        // The viewer is in one-up. Check if there is a state to restore/toggle back to.
        const { toggleOneUpViewportGridStore } = useToggleOneUpViewportGridStore.getState();

        if (!toggleOneUpViewportGridStore) {
          return;
        }
        // There is a state to toggle back to. The viewport that was
        // originally toggled to one up was the former active viewport.
        const viewportIdToUpdate = toggleOneUpViewportGridStore.activeViewportId;

        // We are restoring the previous layout but taking into the account that
        // the current one up viewport might have a new displaySet dragged and dropped on it.
        // updatedViewportsViaHP below contains the viewports applicable to the HP that existed
        // prior to the toggle to one-up - including the updated viewports if a display
        // set swap were to have occurred.
        const updatedViewportsViaHP =
          displaySetInstanceUIDs.length > 1
            ? []
            : displaySetInstanceUIDs
                .map(displaySetInstanceUID =>
                  hangingProtocolService.getViewportsRequireUpdate(
                    viewportIdToUpdate,
                    displaySetInstanceUID,
                    isHangingProtocolLayout
                  )
                )
                .flat();

        // findOrCreateViewport returns either one of the updatedViewportsViaHP
        // returned from the HP service OR if there is not one from the HP service then
        // simply returns what was in the previous state for a given position in the layout.
        const findOrCreateViewport = (position: number, positionId: string) => {
          // Find the viewport for the given position prior to the toggle to one-up.
          const preOneUpViewport = Array.from(toggleOneUpViewportGridStore.viewports.values()).find(
            viewport => viewport.positionId === positionId
          );

          // Use the viewport id from before the toggle to one-up to find any updates to the viewport.
          const viewport = updatedViewportsViaHP.find(
            viewport => viewport.viewportId === preOneUpViewport.viewportId
          );

          return viewport
            ? // Use the applicable viewport from the HP updated viewports
              { viewportOptions, displaySetOptions, ...viewport }
            : // Use the previous viewport for the given position
              preOneUpViewport;
        };

        const layoutOptions = viewportGridService.getLayoutOptionsFromState(
          toggleOneUpViewportGridStore
        );

        // Restore the previous layout including the active viewport.
        viewportGridService.setLayout({
          numRows: toggleOneUpViewportGridStore.layout.numRows,
          numCols: toggleOneUpViewportGridStore.layout.numCols,
          activeViewportId: viewportIdToUpdate,
          layoutOptions,
          findOrCreateViewport,
          isHangingProtocolLayout: true,
        });

        // Reset crosshairs after restoring the layout
        setTimeout(() => {
          commandsManager.runCommand('resetCrosshairs');
        }, 0);
      } else {
        // We are not in one-up, so toggle to one up.

        // Store the current viewport grid state so we can toggle it back later.
        const { setToggleOneUpViewportGridStore } = useToggleOneUpViewportGridStore.getState();
        setToggleOneUpViewportGridStore(viewportGridState);

        // one being toggled to one up.
        const findOrCreateViewport = () => {
          return {
            displaySetInstanceUIDs,
            displaySetOptions,
            viewportOptions,
          };
        };

        // Set the layout to be 1x1/one-up.
        viewportGridService.setLayout({
          numRows: 1,
          numCols: 1,
          findOrCreateViewport,
          isHangingProtocolLayout: true,
        });
      }
    },

    /**
     * Exposes the browser history navigation used by OHIF. This command can be used to either replace or
     * push a new entry into the browser history. For example, the following will replace the current
     * browser history entry with the specified relative URL which changes the study displayed to the
     * study with study instance UID 1.2.3. Note that as a result of using `options.replace = true`, the
     * page prior to invoking this command cannot be returned to via the browser back button.
     *
     * navigateHistory({
     *   to: 'viewer?StudyInstanceUIDs=1.2.3',
     *   options: { replace: true },
     * });
     *
     * @param historyArgs - arguments for the history function;
     *                      the `to` property is the URL;
     *                      the `options.replace` is a boolean indicating if the current browser history entry
     *                      should be replaced or a new entry pushed onto the history (stack); the default value
     *                      for `replace` is false
     */
    navigateHistory(historyArgs: NavigateHistory) {
      history.navigate(historyArgs.to, historyArgs.options);
    },

    openDICOMTagViewer({ displaySetInstanceUID }: { displaySetInstanceUID?: string }) {
      const { activeViewportId, viewports } = viewportGridService.getState();
      const activeViewportSpecificData = viewports.get(activeViewportId);
      const { displaySetInstanceUIDs } = activeViewportSpecificData;

      const displaySets = displaySetService.activeDisplaySets;
      const { UIModalService } = servicesManager.services;

      const defaultDisplaySetInstanceUID = displaySetInstanceUID || displaySetInstanceUIDs[0];
      UIModalService.show({
        content: DicomTagBrowser,
        contentProps: {
          displaySets,
          displaySetInstanceUID: defaultDisplaySetInstanceUID,
        },
        title: 'DICOM Tag Browser',
        containerClassName: 'max-w-3xl',
      });
    },

    async sam2() {
      const overlap = false
      let medsam2 = false;
      if (toolboxState.getMedSam2()) {
        medsam2 = true;
      }
      const start = Date.now();
      
      const segs = servicesManager.services.segmentationService.getSegmentations()
      const { activeViewportId, viewports } = viewportGridService.getState();
      const activeViewportSpecificData = viewports.get(activeViewportId);

      const { setViewportGridState } = useViewportGridStore.getState();
      const currentImageIdIndex = servicesManager.services.cornerstoneViewportService.getCornerstoneViewport(activeViewportId).currentImageIdIndex;
      setViewportGridState('currentImageIdIndex', currentImageIdIndex);
      const { displaySetInstanceUIDs } = activeViewportSpecificData;
      const displaySets = displaySetService.activeDisplaySets;

      const displaySetInstanceUID = displaySetInstanceUIDs[0];
      const currentDisplaySets = displaySets.filter(e => {
        return e.displaySetInstanceUID == displaySetInstanceUID;
      })[0];

      const currentMeasurements = measurementService.getMeasurements()

      const unAssignedMeasurements = currentMeasurements.filter(e => { 
        return e.metadata.SegmentNumber === undefined;
      })
    

    const activeSegmentation = servicesManager.services.segmentationService.getActiveSegmentation(activeViewportId)
    let segmentNumber = 1;
    let segments: { [segmentIndex: string]: cstTypes.Segment } = {};
    let segmentationId = `${csUtils.uuidv4()}`
    if (activeSegmentation !== undefined){
      segments = activeSegmentation.segments;
    if (Object.values(segments).length > 0) {
      // Find the minimum available segment number
      const existingSegmentNumbers = Object.values(segments).map(e => e.segmentIndex).sort((a, b) => a - b);
      let minAvailableNumber = 1;
      // Find the first gap in segment numbers, or use the next number after the highest
      for (let i = 0; i < existingSegmentNumbers.length; i++) {
        if (existingSegmentNumbers[i] !== minAvailableNumber) {
          break;
        }
        minAvailableNumber++;
      }
      segmentNumber = minAvailableNumber;
      if (!toolboxState.getRefineNew()) {
        const activeSegment = servicesManager.services.segmentationService.getActiveSegment(activeViewportId);
        if (activeSegment !== undefined){
          for (let i = 0; i < unAssignedMeasurements.length; i++) {
            const e = unAssignedMeasurements[i];
            e.metadata.SegmentNumber = activeSegment.segmentIndex;
            e.metadata.segmentationId = activeSegmentation.segmentationId;
          }
          segmentNumber = activeSegment.segmentIndex;
          if (toolboxState.getCurrentActiveSegment() !== segmentNumber){
            await commandsManager.run('resetNninter');
            toolboxState.setCurrentActiveSegment(segmentNumber);
          }
        } else {
          uiNotificationService.show({
            title: 'Click Segment to refine',
            message: 'No active segment found, please click segment to refine',
            type: 'warning',
            duration: 4000,
          });
          return
        }
      } else {
        // For new Segment
        for (let i = 0; i < unAssignedMeasurements.length; i++) {
          const e = unAssignedMeasurements[i];
          e.metadata.SegmentNumber = segmentNumber;
          e.metadata.segmentationId = activeSegmentation.segmentationId;
        }
      }
    } else{
      // No existing segments in current active segmentation
      for (let i = 0; i < unAssignedMeasurements.length; i++) {
        const e = unAssignedMeasurements[i];
        e.metadata.SegmentNumber = segmentNumber;
        e.metadata.segmentationId = activeSegmentation.segmentationId;
      }
    }
    
  } else {
    // No existing segmentation
    for (let i = 0; i < unAssignedMeasurements.length; i++) {
      const e = unAssignedMeasurements[i];
      e.metadata.SegmentNumber = segmentNumber;
      e.metadata.segmentationId = segmentationId;
    }
  }

      const pos_points = currentMeasurements
        .filter(e => {
          return e.toolName === 'Probe2' && e.referenceSeriesUID === currentDisplaySets.SeriesInstanceUID && e.metadata.neg === false && e.metadata.SegmentNumber === segmentNumber;
        })
        .map(e => {
          return Object.values(e.data)[0].index;
        });
      const neg_points = currentMeasurements
        .filter(e => {
          return e.toolName === 'Probe2' && e.referenceSeriesUID === currentDisplaySets.SeriesInstanceUID && e.metadata.neg === true && e.metadata.SegmentNumber === segmentNumber;
        })
        .map(e => {
          return Object.values(e.data)[0].index;
        });

      const pos_boxes = currentMeasurements
        .filter(e => { 
          return e.toolName === 'RectangleROI2' && e.referenceSeriesUID === currentDisplaySets.SeriesInstanceUID && e.metadata.neg === false && e.metadata.SegmentNumber === segmentNumber;
        })
        .map(e => { 
          return Object.values(e.data)[0].pointsInShape 
        })
        .map(e => { return [e.at(0).pointIJK, e.at(-1).pointIJK] })



      //Disable text prompts for SAM2
      const text_prompts = []//currentMeasurements
      //.filter(e => { return e.toolName === 'Probe2' && e.referenceSeriesUID === currentDisplaySets.SeriesInstanceUID && e.metadata.neg === false && e.metadata.SegmentNumber === segmentNumber; })
      //.map(e => { return e.label })

      // Hide the measurements after inference
      for (let i = 0; i < currentMeasurements.length; i++) {
        const e = currentMeasurements[i];
        if (e.referenceSeriesUID === currentDisplaySets.SeriesInstanceUID) {
          measurementService.toggleVisibilityMeasurement(e.uid, false);
        }
      }

      // Force a re-render of the segmentation table after a short delay
      setTimeout(() => {
        // This will trigger a re-render of components that depend on measurement state
        const event = new Event('measurement-state-changed');
        document.dispatchEvent(event);
      }, 200);
      if (pos_points.length == 0 && neg_points.length == 0 && pos_boxes.length == 0 && text_prompts.length == 0){
        uiNotificationService.show({
          title: 'Prompt warning',
          message: 'Only pos/neg points and bbox are available for SAM2',
          type: 'warning',
          duration: 4000,
        });
        return;
      }
      let url = `/monai/infer/segmentation?image=${currentDisplaySets.SeriesInstanceUID}&output=dicom_seg`;
      let params = {
        largest_cc: false,
        result_extension: '.nii.gz',
        result_dtype: 'uint16',
        result_compress: false,
        studyInstanceUID: currentDisplaySets.StudyInstanceUID,
        restore_label_idx: false,
        pos_points: pos_points,
        neg_points: neg_points,
        pos_boxes: pos_boxes,
        texts: text_prompts,
        nninter: false,
        medsam2: medsam2,
      };

      let data = MonaiLabelClient.constructFormData(params, null);

      // Create the axios promise
      const segmentationPromise = axios.post(url, data, {
        responseType: 'arraybuffer',
        headers: {
          accept: 'application/json, multipart/form-data',
        },
      });

      // Show notification with promise support
      uiNotificationService.show({
        title: 'MONAI Label',
        message: 'Processing segmentation...',
        type: 'info',
        promise: segmentationPromise,
        promiseMessages: {
          loading: 'Processing segmentation...',
          success: () => 'Run Segmentation - Successful',
          error: (error) => `Run Segmentation - Failed: ${error.message || 'Unknown error'}`,
        },
      });

            try {
        // Process the response
        const response = await segmentationPromise;
        console.debug(response);
        if (response.status === 200) {

          const afterPost = Date.now();
          console.log(`Just after Post request: ${(afterPost - start)/1000} Seconds`);
          const ct = response.headers["content-type"] as string;
          const { meta, seg } = await parseMultipart(response.data, ct);
          console.log(`Just after parseMultipart: ${(Date.now() - start)/1000} Seconds`);
          //const arrayBuffer = response.data
          const flipped = meta.flipped.toLowerCase() === "true"
          const sam_elapsed = meta.sam_elapsed
          const prompt_info = meta.prompt_info
          const label_name = meta.label_name
          const raw = seg
          const new_arrayBuffer = new Uint8Array(raw);

          let imageIds = currentDisplaySets.imageIds
          let existingSegments: { [segmentIndex: string]: cstTypes.Segment } = {};
            
          let segImageIds = [];

          let existing = false;
          // Find existing segmentation with matching seriesInstanceUid
          if (activeSegmentation !== undefined){
            let existingseriesInstanceUid = activeSegmentation.cachedStats?.seriesInstanceUid;
            
            if (existingseriesInstanceUid === undefined) {
              const segments = Object.values(activeSegmentation.segments);
              for (let j = 0; j < segments.length; j++) {
                const segment = segments[j];
                if (segment.cachedStats?.algorithmType !== undefined) {
                  existingseriesInstanceUid = segment.cachedStats.algorithmType;
                }
              }
            }
            
            if (existingseriesInstanceUid === currentDisplaySets.SeriesInstanceUID) {
              existingSegments = activeSegmentation.segments || {};
              segmentationId = activeSegmentation.segmentationId;
              segImageIds = activeSegmentation.representationData.Labelmap.imageIds;
              existing = true;
            }
          }
          
          let merged_derivedImages = [];
          let z_range = [];
          if(overlap){
          let derivedImages_new = await imageLoader.createAndCacheDerivedLabelmapImages(imageIds);
          console.log(`Just after createAndCacheDerivedLabelmapImages: ${(Date.now() - start)/1000} Seconds`);
          let derivedImages = [];
          if (segImageIds.length > 0){
            derivedImages = segImageIds.map(imageId => cache.getImage(imageId));
          }
          if(flipped){
            derivedImages_new.reverse();
          }
          console.log(`After reverse: ${(Date.now() - start)/1000} Seconds`);
          for (let i = 0; i < derivedImages_new.length; i++) {
            const voxelManager = derivedImages_new[i]
              .voxelManager as csTypes.IVoxelManager<number>;
            let scalarData = voxelManager.getScalarData();
            const sliceData = new_arrayBuffer.slice(i * scalarData.length, (i + 1) * scalarData.length);
            if (sliceData.some(v => v === 1)){
              voxelManager.setScalarData(sliceData.map(v => v === 1 ? segmentNumber : v));
              z_range.push(i);
            }
          }
          console.log(`After slice assignment: ${(Date.now() - start)/1000} Seconds`);


          let filteredDerivedImages = []
          const imgLength = imageIds.length;
          let updatedIndices = new Set<number>();

          // If toolboxState.getRefineNew() is false (Refine), exclude derivedImages that contain segmentNumber
          // Each derivedImage is binary mask of a single slice ([0],[0,1],[0,2],[0,3].. etc)
          // derivedImages size is imgLength * the number of segment
          // We need to filter out the derivedImages block that contain segmentNumber (consists of [0] or [0, segmentNumber] masks)
          // If filter out which contains segmentNumber and all [0] masks, it can lead to incorrect calculation of the segment. e.g. bidirectional measurement
          if (!toolboxState.getRefineNew() && derivedImages.length > 0) {
            let addFlag = true;
            for (let i=0; i<derivedImages.length; i++){
              const image = derivedImages[i];
              const voxelManager = image.voxelManager as csTypes.IVoxelManager<number>;
              const scalarData = voxelManager.getScalarData();
              if (scalarData.some(value => value === segmentNumber)){
                const updatedScalarData = scalarData.map(v => v === segmentNumber ? 0 : v)
                voxelManager.setScalarData(updatedScalarData);
                if (addFlag) {
                  for (let j = 0; j < imgLength; j++) {
                    updatedIndices.add(Math.floor(i / imgLength) * imgLength + j);
                  }
                  addFlag = false;
                }

              }
            }
            for (let i = 0; i < derivedImages.length; i++) {
              if (!updatedIndices.has(i)) {
                filteredDerivedImages.push(derivedImages[i]);
              }
            }            
          } else if (derivedImages.length > 0) {
            filteredDerivedImages = derivedImages;
          }
          console.log(`After refinement & filteredDerivedImages: ${(Date.now() - start)/1000} Seconds`);
          merged_derivedImages = [...filteredDerivedImages, ...derivedImages_new]
        } else {
          if (segImageIds.length == 0){
            let derivedImages_new = await imageLoader.createAndCacheDerivedLabelmapImages(imageIds);

            if(flipped){
              derivedImages_new.reverse();
            }
            console.log(`After reverse: ${(Date.now() - start)/1000} Seconds`);
            for (let i = 0; i < derivedImages_new.length; i++) {
              const voxelManager = derivedImages_new[i]
                .voxelManager as csTypes.IVoxelManager<number>;
              let scalarData = voxelManager.getScalarData();
              const sliceData = new_arrayBuffer.slice(i * scalarData.length, (i + 1) * scalarData.length);
              if (sliceData.some(v => v === 1)){
                voxelManager.setScalarData(sliceData.map(v => v === 1 ? segmentNumber : v));
                if (flipped) {
                  z_range.push(derivedImages_new.length - i - 1);
                } else {
                  z_range.push(i);
                }
              }
            }
            merged_derivedImages = derivedImages_new
          } else {
            merged_derivedImages = segImageIds.map(imageId => cache.getImage(imageId));
            for (let i = 0; i < merged_derivedImages.length; i++) {
              const voxelManager = merged_derivedImages[i]
                .voxelManager as csTypes.IVoxelManager<number>;
              let scalarData = voxelManager.getScalarData();
              const sliceData = new_arrayBuffer.slice(i * scalarData.length, (i + 1) * scalarData.length);
              if (sliceData.some(v => v === 1)){
                voxelManager.setScalarData(sliceData.map((v, idx) => v === 1 ? segmentNumber : scalarData[idx]));
                if (flipped) {
                  z_range.push(merged_derivedImages.length - i - 1);
                } else {
                  z_range.push(i);
                }
              }
            }
          }
        }
          
                    
          const derivedImageIds = merged_derivedImages.map(image => image.imageId);  
          console.log(`Just after derivedImageIds: ${(Date.now() - start)/1000} Seconds`);
          segments[segmentNumber] = {
            segmentIndex: segmentNumber,
            label: label_name,
            locked: false,
            active: false,
            cachedStats: {

              modifiedTime: utils.formatDate(Date.now(), 'YYYYMMDD'),

              algorithmType: currentDisplaySets.SeriesInstanceUID,
              algorithmName: "sam2_"+sam_elapsed,
              description: prompt_info,
              center:  z_range.length > 0 ? z_range.reduce((sum, z) => sum + z, 0) / z_range.length : 0
            }
          };

          // Get the representations for the segmentation to recover the visibility of the segments
          const representations = servicesManager.services.segmentationService.getSegmentationRepresentations(activeViewportId, { segmentationId })
          if(segmentNumber === 1 && Object.keys(existingSegments).length === 0 && !existing){
            //servicesManager.services.segmentationService.clearSegmentationRepresentations(activeViewportId);
            csToolsSegmentation.addSegmentations([
              {
                  segmentationId,
                  representation: {
                      type: LABELMAP,
                      data: {
                        imageIds: derivedImageIds,
                        referencedVolumeId: currentDisplaySets.displaySetInstanceUID,
                        referencedImageIds: imageIds,
                      }
                  },
                  config: {
                    cachedStats: {
                      center: z_range.length > 0 ? z_range.reduce((sum, z) => sum + z, 0) / z_range.length : 0
                    },//results.segMetadata,
                    label: currentDisplaySets.SeriesDescription,
                    segments,
                  },
              }
          ]);
          
        }else{
          // Comment out at the moment (necessary for hiding previous segments), may need to uncomment some weird bugs.
          // servicesManager.services.segmentationService.clearSegmentationRepresentations(activeViewportId);
          
          // Update the segmentation data
          csToolsSegmentation.updateSegmentations([
            {
              segmentationId,
              payload: {
                segments: segments,
                representationData: {
                  [LABELMAP]: {
                    imageIds: derivedImageIds,
                    referencedVolumeId: currentDisplaySets.displaySetInstanceUID,
                    referencedImageIds: imageIds,
                  }
                }
              },
            },
          ]);
          }
          servicesManager.services.segmentationService.setActiveSegment(segmentationId, segmentNumber);
          toolboxState.setCurrentActiveSegment(segmentNumber);
          await servicesManager.services.segmentationService.addSegmentationRepresentation(activeViewportId, {
            segmentationId: segmentationId,
          });
          if(toolboxState.getRefineNew()){
            toolboxState.setRefineNew(false);
          }
          // semi-hack: to render segmentation properly on the current image
          let somewhereIndex = 0;
          if(currentImageIdIndex === 0){
            somewhereIndex = 1;
          }
          await servicesManager.services.cornerstoneViewportService.getCornerstoneViewport(activeViewportId).setImageIdIndex(somewhereIndex);
          await servicesManager.services.cornerstoneViewportService.getCornerstoneViewport(activeViewportId).setImageIdIndex(currentImageIdIndex);
          // Recover the visibility of the segments
          for (let i = 0; i < representations.length; i++) {
            const representation = representations[i];
            const segments = Object.values(representation.segments);
            
            if (segments.length > 0) {
              for (let j = 0; j < segments.length; j++) {
                const segment = segments[j];
                servicesManager.services.segmentationService.setSegmentVisibility(activeViewportId, representation.segmentationId, segment.segmentIndex, segment.visible);
              }
            }
          }
          const end = Date.now();
          console.log(`Time taken: ${(end - start)/1000} Seconds`);
          return response;
        }
      } catch (error) {
        console.error('Segmentation error:', error);
        throw error;
      }
    },
    async initNninter( options: {viewportId: string} = {viewportId: undefined} ){

      let { activeViewportId, viewports } = viewportGridService.getState();
      if(options.viewportId !== undefined){
        activeViewportId = options.viewportId;
      }
      const activeViewportSpecificData = viewports.get(activeViewportId);
      if(activeViewportSpecificData === undefined){
        return;
      }
      const { displaySetInstanceUIDs } = activeViewportSpecificData;
      const displaySets = displaySetService.activeDisplaySets;
      const displaySetInstanceUID = displaySetInstanceUIDs[0];
      let currentDisplaySets;
      for (let i = 0; i < displaySets.length; i++) {
        if (displaySets[i].displaySetInstanceUID == displaySetInstanceUID) {
          currentDisplaySets = displaySets[i];
          break; // Exit early once found
        }
      }
      if(currentDisplaySets === undefined || currentDisplaySets.Modality === "SEG"){
        return;
      }
      let url = `/monai/infer/segmentation?image=${currentDisplaySets.SeriesInstanceUID}&output=dicom_seg`;
      let params = {
        largest_cc: false,
        result_extension: '.nii.gz',
        result_dtype: 'uint16',
        result_compress: false,
        studyInstanceUID: currentDisplaySets.StudyInstanceUID,
        restore_label_idx: false,
        nninter: "init",
      };

      let data = MonaiLabelClient.constructFormData(params, null);

      // Create the axios promise
      const initPromise = axios.post(url, data, {
        responseType: 'arraybuffer',
        headers: {
          accept: 'application/json, multipart/form-data',
        },
      });

      // Show notification with promise support
      uiNotificationService.show({
        title: 'NNInit',
        message: 'Initializing nninter...',
        type: 'info',
        promise: initPromise,
        promiseMessages: {
          loading: 'Initializing nninter...',
          success: () => 'Init nninter - Successful',
          error: (error) => `Init nninter - Failed: ${error.message || 'Unknown error'}`,
        },
      });

      try {
        const response = await initPromise;
        if (response.status === 200) {
          return response;
        }
      } catch (error) {
        console.error('Init nninter error:', error);
        throw error;
      }

    },
    async resetNninter(options: {clearMeasurements: boolean} = {clearMeasurements: false}){
      const { activeViewportId, viewports } = viewportGridService.getState();
      const activeViewportSpecificData = viewports.get(activeViewportId);
      const { displaySetInstanceUIDs } = activeViewportSpecificData;
      const displaySets = displaySetService.activeDisplaySets;
      const displaySetInstanceUID = displaySetInstanceUIDs[0];
      const currentDisplaySets = displaySets.filter(e => {
        return e.displaySetInstanceUID == displaySetInstanceUID;
      })[0];
      let url = `/monai/infer/segmentation?image=${currentDisplaySets.SeriesInstanceUID}&output=dicom_seg`;
      let params = {
        largest_cc: false,
        result_extension: '.nii.gz',
        result_dtype: 'uint16',
        result_compress: false,
        studyInstanceUID: currentDisplaySets.StudyInstanceUID,
        restore_label_idx: false,
        nninter: "reset",
      };

      let data = MonaiLabelClient.constructFormData(params, null);

      // Create the axios promise
      const resetPromise = axios.post(url, data, {
        responseType: 'arraybuffer',
        headers: {
          accept: 'application/json, multipart/form-data',
        },
      });

      // Show notification with promise support
      uiNotificationService.show({
        title: 'NNInter',
        message: 'Resetting nninter...',
        type: 'info',
        promise: resetPromise,
        promiseMessages: {
          loading: 'Resetting nninter...',
          success: () => 'Reset nninter - Successful',
          error: (error) => `Reset nninter - Failed: ${error.message || 'Unknown error'}`,
        },
      });

      try {
        const response = await resetPromise;
        if (response.status === 200) {
          if (options.clearMeasurements) {
            commandsManager.run('clearMeasurements')
          }
          return response;
        }
      } catch (error) {
        console.error('Reset nninter error:', error);
        throw error;
      }

    },

    async nninter() {
      const overlap = false
      const start = Date.now();
      
      const { activeViewportId, viewports } = viewportGridService.getState();
      const activeViewportSpecificData = viewports.get(activeViewportId);

      const { setViewportGridState } = useViewportGridStore.getState();
      const currentImageIdIndex = servicesManager.services.cornerstoneViewportService.getCornerstoneViewport(activeViewportId).currentImageIdIndex;
      setViewportGridState('currentImageIdIndex', currentImageIdIndex);
      const { displaySetInstanceUIDs } = activeViewportSpecificData;

      const displaySets = displaySetService.activeDisplaySets;

      const displaySetInstanceUID = displaySetInstanceUIDs[0];
      const currentDisplaySets = displaySets.filter(e => {
        return e.displaySetInstanceUID == displaySetInstanceUID;
      })[0];
      const currentMeasurements = measurementService.getMeasurements()

      const unAssignedMeasurements = currentMeasurements.filter(e => { 
          return e.metadata.SegmentNumber === undefined;
        })
      

      const activeSegmentation = servicesManager.services.segmentationService.getActiveSegmentation(activeViewportId)
      let segmentNumber = 1;
      let segments: { [segmentIndex: string]: cstTypes.Segment } = {};
      let segmentationId = `${csUtils.uuidv4()}`
      if (activeSegmentation !== undefined){
        segments = activeSegmentation.segments;
      if (Object.values(segments).length > 0) {
        // Find the minimum available segment number
        const existingSegmentNumbers = Object.values(segments).map(e => e.segmentIndex).sort((a, b) => a - b);
        let minAvailableNumber = 1;
        // Find the first gap in segment numbers, or use the next number after the highest
        for (let i = 0; i < existingSegmentNumbers.length; i++) {
          if (existingSegmentNumbers[i] !== minAvailableNumber) {
            break;
          }
          minAvailableNumber++;
        }
        segmentNumber = minAvailableNumber;
        if (!toolboxState.getRefineNew()) {
          const activeSegment = servicesManager.services.segmentationService.getActiveSegment(activeViewportId);
          if (activeSegment !== undefined){
            for (let i = 0; i < unAssignedMeasurements.length; i++) {
              const e = unAssignedMeasurements[i];
              e.metadata.SegmentNumber = activeSegment.segmentIndex;
              e.metadata.segmentationId = activeSegmentation.segmentationId;
            }
            segmentNumber = activeSegment.segmentIndex;
            if (toolboxState.getCurrentActiveSegment() !== segmentNumber){
              await commandsManager.run('resetNninter');
              toolboxState.setCurrentActiveSegment(segmentNumber);
            }
          } else {
            uiNotificationService.show({
              title: 'Click Segment to refine',
              message: 'No active segment found, please click segment to refine',
              type: 'warning',
              duration: 4000,
            });
            return
          }
        } else {
          // For new Segment
          for (let i = 0; i < unAssignedMeasurements.length; i++) {
            const e = unAssignedMeasurements[i];
            e.metadata.SegmentNumber = segmentNumber;
            e.metadata.segmentationId = activeSegmentation.segmentationId;
          }
        }
      } else{
        // No existing segments in current active segmentation
        for (let i = 0; i < unAssignedMeasurements.length; i++) {
          const e = unAssignedMeasurements[i];
          e.metadata.SegmentNumber = segmentNumber;
          e.metadata.segmentationId = activeSegmentation.segmentationId;
        }
      }  
    } else {
      // No existing segmentation
      for (let i = 0; i < unAssignedMeasurements.length; i++) {
        const e = unAssignedMeasurements[i];
        e.metadata.SegmentNumber = segmentNumber;
        e.metadata.segmentationId = segmentationId;
      }
    }


      const pos_points = currentMeasurements
        .filter(e => {
          return e.toolName === 'Probe2' && e.referenceSeriesUID === currentDisplaySets.SeriesInstanceUID && e.metadata.neg === false && e.metadata.SegmentNumber === segmentNumber;
        })
        .map(e => {
          return Object.values(e.data)[0].index;
        });
      const neg_points = currentMeasurements
        .filter(e => {
          return e.toolName === 'Probe2'&& e.referenceSeriesUID === currentDisplaySets.SeriesInstanceUID && e.metadata.neg === true && e.metadata.SegmentNumber === segmentNumber;
        })
        .map(e => {
          return Object.values(e.data)[0].index;
        });

      const pos_boxes = currentMeasurements
        .filter(e => { 
          return e.toolName === 'RectangleROI2'&& e.referenceSeriesUID === currentDisplaySets.SeriesInstanceUID && e.metadata.neg === false && e.metadata.SegmentNumber === segmentNumber;
        })
        .map(e => { 
          return Object.values(e.data)[0].pointsInShape 
        })
        .map(e => { return [e.at(0).pointIJK, e.at(-1).pointIJK] })

      const neg_boxes = currentMeasurements
      .filter(e => { 
        return e.toolName === 'RectangleROI2'&& e.referenceSeriesUID === currentDisplaySets.SeriesInstanceUID && e.metadata.neg === true && e.metadata.SegmentNumber === segmentNumber;
      })
      .map(e => { 
        return Object.values(e.data)[0].pointsInShape 
      })
      .map(e => { return [e.at(0).pointIJK, e.at(-1).pointIJK] })

      const pos_lassos = currentMeasurements
        .filter(e => { 
          return e.toolName === 'PlanarFreehandROI3'&& e.referenceSeriesUID === currentDisplaySets.SeriesInstanceUID && e.metadata.neg === false && e.metadata.SegmentNumber === segmentNumber;
        })
        .map(e => { 
          return Object.values(e.data)[0]?.boundary 
      })
      .filter(Boolean)

      const neg_lassos = currentMeasurements
      .filter(e => { 
        return e.toolName === 'PlanarFreehandROI3'&& e.referenceSeriesUID === currentDisplaySets.SeriesInstanceUID && e.metadata.neg === true && e.metadata.SegmentNumber === segmentNumber;
      })
      .map(e => { 
        return Object.values(e.data)[0]?.boundary 
    })
    .filter(Boolean)

      const pos_scribbles = currentMeasurements
        .filter(e => { 
          return e.toolName === 'PlanarFreehandROI2'&& e.referenceSeriesUID === currentDisplaySets.SeriesInstanceUID && e.metadata.neg === false && e.metadata.SegmentNumber === segmentNumber;
        })
        .map(e => { 
          return Object.values(e.data)[0]?.scribble 
      })
      .filter(Boolean)

      const neg_scribbles = currentMeasurements
        .filter(e => { 
          return e.toolName === 'PlanarFreehandROI2'&& e.referenceSeriesUID === currentDisplaySets.SeriesInstanceUID && e.metadata.neg === true && e.metadata.SegmentNumber === segmentNumber;
        })
        .map(e => { 
          return Object.values(e.data)[0]?.scribble 
      })
      .filter(Boolean)

      //Disable text prompts for nninteractive
      const text_prompts = [] //currentMeasurements
      //.filter(e => { return e.toolName === 'Probe' && e.referenceSeriesUID === currentDisplaySets.SeriesInstanceUID})
      //.map(e => { return e.label })

      // Hide the measurements after inference
      for (let i = 0; i < currentMeasurements.length; i++) {
        const e = currentMeasurements[i];
        if (e.referenceSeriesUID === currentDisplaySets.SeriesInstanceUID) {
          measurementService.toggleVisibilityMeasurement(e.uid, false);
        }
      }

      // Force a re-render of the segmentation table after a short delay
      setTimeout(() => {
        // This will trigger a re-render of components that depend on measurement state
        const event = new Event('measurement-state-changed');
        document.dispatchEvent(event);
      }, 200);

      let url = `/monai/infer/segmentation?image=${currentDisplaySets.SeriesInstanceUID}&output=dicom_seg`;
      let params = {
        largest_cc: false,
      //  device: response.data.trainers.segmentation.config.device,
        result_extension: '.nii.gz',
        result_dtype: 'uint16',
        result_compress: false,
        studyInstanceUID: currentDisplaySets.StudyInstanceUID,
        restore_label_idx: false,
        pos_points: pos_points,
        neg_points: neg_points,
        pos_boxes: pos_boxes,
        neg_boxes: neg_boxes,
        pos_lassos: pos_lassos,
        neg_lassos: neg_lassos,
        pos_scribbles: pos_scribbles,
        neg_scribbles: neg_scribbles,
        texts: text_prompts,
        nninter: true,
      };

      if(useToggleHangingProtocolStore.getState().toggleHangingProtocol.nextObj!==undefined){
        params.nextObj = useToggleHangingProtocolStore.getState().toggleHangingProtocol.nextObj
      }

      let data = MonaiLabelClient.constructFormData(params, null);

      
      const beforePost = Date.now();
      console.log(`Before Post request: ${(beforePost - start)/1000} Seconds`);
      // Create the axios promise
      const segmentationPromise = axios.post(url, data, {
        responseType: 'arraybuffer',
        headers: {
          //accept: 'application/json, multipart/form-data',
          accept: 'application/octet-stream',
        },
      });

      // Show notification with promise support
      uiNotificationService.show({
        title: 'MONAI Label',
        message: 'Processing nninter segmentation...',
        type: 'info',
        promise: segmentationPromise,
        promiseMessages: {
          loading: 'Processing nninter segmentation...',
          success: () => 'Run Segmentation - Successful',
          error: (error) => `Run Segmentation - Failed: ${error.message || 'Unknown error'}`,
        },
      });

      try {
        // Process the response
        const response = await segmentationPromise;
        console.debug(response);
        if (response.status === 200) {
            const afterPost = Date.now();
            console.log(`Just after Post request: ${(afterPost - start)/1000} Seconds`);
            const ct = response.headers["content-type"] as string;
            const { meta, seg } = await parseMultipart(response.data, ct);
            console.log(`Just after parseMultipart: ${(Date.now() - start)/1000} Seconds`);
            //const arrayBuffer = response.data
            const flipped = meta.flipped.toLowerCase() === "true"
            const nninter_elapsed = meta.nninter_elapsed
            const prompt_info = meta.prompt_info
            const label_name = meta.label_name
            const raw = seg
            const new_arrayBuffer = new Uint8Array(raw);

            let imageIds = currentDisplaySets.imageIds



            let existingSegments: { [segmentIndex: string]: cstTypes.Segment } = {};
            
            let segImageIds = [];

            let existing = false;
            // Find existing segmentation with matching seriesInstanceUid
            if (activeSegmentation !== undefined){
              let existingseriesInstanceUid = activeSegmentation.cachedStats?.seriesInstanceUid;
              
              if (existingseriesInstanceUid === undefined) {
                const segments = Object.values(activeSegmentation.segments);
                for (let j = 0; j < segments.length; j++) {
                  const segment = segments[j];
                  if (segment.cachedStats?.algorithmType !== undefined) {
                    existingseriesInstanceUid = segment.cachedStats.algorithmType;
                  }
                }
              }
              
              if (existingseriesInstanceUid === currentDisplaySets.SeriesInstanceUID) {
                existingSegments = activeSegmentation.segments || {};
                segmentationId = activeSegmentation.segmentationId;
                segImageIds = activeSegmentation.representationData.Labelmap.imageIds;
                existing = true;
              }
            }


          let merged_derivedImages = [];
          let z_range = [];
          if(overlap){
          let derivedImages_new = await imageLoader.createAndCacheDerivedLabelmapImages(imageIds);
          console.log(`Just after createAndCacheDerivedLabelmapImages: ${(Date.now() - start)/1000} Seconds`);
          let derivedImages = [];
          if (segImageIds.length > 0){
            derivedImages = segImageIds.map(imageId => cache.getImage(imageId));
          }

          // We should parse the segmentation as separate slices to support overlapping segments.
          // This parsing should occur in the CornerstoneJS library adapters.
          if(flipped){
            derivedImages_new.reverse();
          }
          console.log(`After reverse: ${(Date.now() - start)/1000} Seconds`);
          for (let i = 0; i < derivedImages_new.length; i++) {
            const voxelManager = derivedImages_new[i]
              .voxelManager as csTypes.IVoxelManager<number>;
            let scalarData = voxelManager.getScalarData();
            const sliceData = new_arrayBuffer.slice(i * scalarData.length, (i + 1) * scalarData.length);
            if (sliceData.some(v => v === 1)){
              voxelManager.setScalarData(sliceData.map(v => v === 1 ? segmentNumber : v));
              if (flipped) {
                z_range.push(derivedImages_new.length - i - 1);
              } else {
                z_range.push(i);
              }
            }
          }
          console.log(`After slice assignment: ${(Date.now() - start)/1000} Seconds`);


          let filteredDerivedImages = [];
          const imgLength = imageIds.length;
          let updatedIndices = new Set<number>();

          // If toolboxState.getRefineNew() is false (Refine), exclude derivedImages that contain segmentNumber
          // Each derivedImage is binary mask of a single slice ([0],[0,1],[0,2],[0,3].. etc)
          // derivedImages size is imgLength * the number of segment
          // We need to filter out the derivedImages block that contain segmentNumber (consists of [0] or [0, segmentNumber] masks)
          // If filter out which contains segmentNumber and all [0] masks, it can lead to incorrect calculation of the segment. e.g. bidirectional measurement
          if (!toolboxState.getRefineNew() && derivedImages.length > 0) {
            let addFlag = true;
            for (let i = 0; i < derivedImages.length; i++) {
              const image = derivedImages[i];
              const voxelManager = image.voxelManager as csTypes.IVoxelManager<number>;
              const scalarData = voxelManager.getScalarData();
              if (scalarData.some(value => value === segmentNumber)) {
                const updatedScalarData = scalarData.map(v => (v === segmentNumber ? 0 : v));
                voxelManager.setScalarData(updatedScalarData);
                if (addFlag) {
                  for (let j = 0; j < imgLength; j++) {
                    updatedIndices.add(Math.floor(i / imgLength) * imgLength + j);
                  }
                  addFlag = false;
                }
              }
            }
            for (let i = 0; i < derivedImages.length; i++) {
              if (!updatedIndices.has(i)) {
                filteredDerivedImages.push(derivedImages[i]);
              }
            }
          } else if (derivedImages.length > 0) {
            filteredDerivedImages = derivedImages;
          }
          console.log(`After refinement & filteredDerivedImages: ${(Date.now() - start)/1000} Seconds`);

          merged_derivedImages = [...filteredDerivedImages, ...derivedImages_new]
        } else {
          if (segImageIds.length == 0){
            let derivedImages_new = await imageLoader.createAndCacheDerivedLabelmapImages(imageIds);

            if(flipped){
              derivedImages_new.reverse();
            }
            console.log(`After reverse: ${(Date.now() - start)/1000} Seconds`);
            for (let i = 0; i < derivedImages_new.length; i++) {
              const voxelManager = derivedImages_new[i]
                .voxelManager as csTypes.IVoxelManager<number>;
              let scalarData = voxelManager.getScalarData();
              const sliceData = new_arrayBuffer.slice(i * scalarData.length, (i + 1) * scalarData.length);
              if (sliceData.some(v => v === 1)){
                voxelManager.setScalarData(sliceData.map(v => v === 1 ? segmentNumber : v));
                if (flipped) {
                  z_range.push(derivedImages_new.length - i - 1);
                } else {
                  z_range.push(i);
                }
              }
            }
            merged_derivedImages = derivedImages_new
          } else {
            merged_derivedImages = segImageIds.map(imageId => cache.getImage(imageId));
            for (let i = 0; i < merged_derivedImages.length; i++) {
              const voxelManager = merged_derivedImages[i]
                .voxelManager as csTypes.IVoxelManager<number>;
              let scalarData = voxelManager.getScalarData();
              const sliceData = new_arrayBuffer.slice(i * scalarData.length, (i + 1) * scalarData.length);
              if (sliceData.some(v => v === 1)){
                voxelManager.setScalarData(sliceData.map((v, idx) => v === 1 ? segmentNumber : scalarData[idx]));
                if (flipped) {
                  z_range.push(merged_derivedImages.length - i - 1);
                } else {
                  z_range.push(i);
                }
              }
            }

          }
          
        }
          
                    
          const derivedImageIds = merged_derivedImages.map(image => image.imageId);  
          console.log(`Just after derivedImageIds: ${(Date.now() - start)/1000} Seconds`);
          segments[segmentNumber] = {
            segmentIndex: segmentNumber,
            label: label_name,
            locked: false,
            active: false,
            cachedStats: {

              modifiedTime: utils.formatDate(Date.now(), 'YYYYMMDD'),

              algorithmType: currentDisplaySets.SeriesInstanceUID,
              algorithmName: "nninter_"+nninter_elapsed,
              description: prompt_info,
              center:  z_range.length > 0 ? z_range.reduce((sum, z) => sum + z, 0) / z_range.length : 0,
            }
          };
          console.log(`Before add or update segs: ${(Date.now() - start)/1000} Seconds`);
          // Get the representations for the segmentation to recover the visibility of the segments
          const representations = servicesManager.services.segmentationService.getSegmentationRepresentations(activeViewportId, { segmentationId })
          if(segmentNumber === 1 && Object.keys(existingSegments).length === 0 && !existing){
            //servicesManager.services.segmentationService.clearSegmentationRepresentations(activeViewportId);
            csToolsSegmentation.addSegmentations([
              {
                  segmentationId,
                  representation: {
                      type: LABELMAP,
                      data: {
                        imageIds: derivedImageIds,
                        referencedVolumeId: currentDisplaySets.displaySetInstanceUID,
                        referencedImageIds: imageIds,
                      }
                  },
                  config: {
                    cachedStats: {
                      center: z_range.length > 0 ? z_range.reduce((sum, z) => sum + z, 0) / z_range.length : 0
                    },//results.segMetadata,
                    label: currentDisplaySets.SeriesDescription,
                    segments,
                  },
              }
          ]);
          
        }else{
          // Comment out at the moment (necessary for hiding previous segments), may need to uncomment some weird bugs.
          // servicesManager.services.segmentationService.clearSegmentationRepresentations(activeViewportId);
          const readableText = customizationService.getCustomization('panelSegmentation.readableText');

          // Update the segmentation data
          csToolsSegmentation.updateSegmentations([
            {
              segmentationId,
              payload: {
                segments: segments,
                representationData: {
                  [LABELMAP]: {
                    imageIds: derivedImageIds,
                    referencedVolumeId: currentDisplaySets.displaySetInstanceUID,
                    referencedImageIds: imageIds,
                  }
                }
              },
            },
          ]);
          // Update the segmentation stats
          Promise.resolve().then(() => 
            updateSegmentationStats({
              segmentation: activeSegmentation,
              segmentationId,
              readableText,
            })
          ).catch(error => {
            console.warn('Failed to update segmentation stats:', error);
          });  
          }
          console.log(`After add and update segs: ${(Date.now() - start)/1000} Seconds`);
          servicesManager.services.segmentationService.setActiveSegment(segmentationId, segmentNumber);
          toolboxState.setCurrentActiveSegment(segmentNumber);
          await servicesManager.services.segmentationService.addSegmentationRepresentation(activeViewportId, {
            segmentationId: segmentationId,
          });
          if(toolboxState.getRefineNew()){
            toolboxState.setRefineNew(false);
          }
          console.log(`After Reps: ${(Date.now() - start)/1000} Seconds`);
          // semi-hack: to render segmentation properly on the current image
          let somewhereIndex = 0;
          if(currentImageIdIndex === 0){
            somewhereIndex = 1;
          }
          await servicesManager.services.cornerstoneViewportService.getCornerstoneViewport(activeViewportId).setImageIdIndex(somewhereIndex);
          await servicesManager.services.cornerstoneViewportService.getCornerstoneViewport(activeViewportId).setImageIdIndex(currentImageIdIndex);
          console.log(`After semi hack: ${(Date.now() - start)/1000} Seconds`);
          // Recover the visibility of the segments
          for (let i = 0; i < representations.length; i++) {
            const representation = representations[i];
            const segments = Object.values(representation.segments);
            
            if (segments.length > 0) {
              for (let j = 0; j < segments.length; j++) {
                const segment = segments[j];
                servicesManager.services.segmentationService.setSegmentVisibility(activeViewportId, representation.segmentationId, segment.segmentIndex, segment.visible);
              }
            }
          }
          //commandsManager.runCommand('removeSegmentationFromViewport', { segmentationId: segmentationId })
          //await servicesManager.services.segmentationService.addSegmentationRepresentation(activeViewportId, {
          //  segmentationId: segmentationId,
          //});
          const end = Date.now();
          console.log(`Time taken: ${(end - start)/1000} Seconds`);
          return response;
        }
      } catch (error) {
        console.error('Nninter segmentation error:', error);
        throw error;
      }
    },
    jumpToSegment: () => {
      const activeViewportId = viewportGridService.getState().activeViewportId;
      const segmentationService = servicesManager.services.segmentationService;
      const activeSegmentation = segmentationService.getActiveSegmentation(activeViewportId);
      if (activeSegmentation != undefined) {
        segmentationService.jumpToSegmentCenter(activeSegmentation.segmentationId, 1, activeViewportId)
      }
    },
    toggleCurrentSegment: () => {
      const activeViewportId = viewportGridService.getState().activeViewportId;
      const segmentationService = servicesManager.services.segmentationService;
      const activeSegmentation = segmentationService.getActiveSegmentation(activeViewportId);
      if (activeSegmentation != undefined) {
        segmentationService.toggleSegmentationRepresentationVisibility(activeViewportId, {
          segmentationId: activeSegmentation.segmentationId,
          type: csToolsEnums.SegmentationRepresentations.Labelmap
        });
      }
    },

    /**
     * Toggle viewport overlay (the information panel shown on the four corners
     * of the viewport)
     * @see ViewportOverlay and CustomizableViewportOverlay components
     */
    toggleOverlays: () => {
      const overlays = document.getElementsByClassName('viewport-overlay');
      for (let i = 0; i < overlays.length; i++) {
        overlays.item(i).classList.toggle('hidden');
      }
    },

    scrollActiveThumbnailIntoView: () => {
      const { activeViewportId, viewports } = viewportGridService.getState();

      const activeViewport = viewports.get(activeViewportId);
      const activeDisplaySetInstanceUID = activeViewport.displaySetInstanceUIDs[0];

      const thumbnailList = document.querySelector('#ohif-thumbnail-list');

      if (!thumbnailList) {
        return;
      }

      const thumbnailListBounds = thumbnailList.getBoundingClientRect();

      const thumbnail = document.querySelector(`#thumbnail-${activeDisplaySetInstanceUID}`);

      if (!thumbnail) {
        return;
      }

      const thumbnailBounds = thumbnail.getBoundingClientRect();

      // This only handles a vertical thumbnail list.
      if (
        thumbnailBounds.top >= thumbnailListBounds.top &&
        thumbnailBounds.top <= thumbnailListBounds.bottom
      ) {
        return;
      }

      thumbnail.scrollIntoView({ behavior: 'smooth' });
    },

    updateViewportDisplaySet: ({
      direction,
      excludeNonImageModalities,
    }: UpdateViewportDisplaySetParams) => {
      const nonImageModalities = ['SR', 'SEG', 'SM', 'RTSTRUCT', 'RTPLAN', 'RTDOSE'];

      const currentDisplaySets = [...displaySetService.activeDisplaySets];

      const { activeViewportId, viewports, isHangingProtocolLayout } =
        viewportGridService.getState();

      const { displaySetInstanceUIDs } = viewports.get(activeViewportId);

      const activeDisplaySetIndex = currentDisplaySets.findIndex(displaySet =>
        displaySetInstanceUIDs.includes(displaySet.displaySetInstanceUID)
      );

      let displaySetIndexToShow: number;

      for (
        displaySetIndexToShow = activeDisplaySetIndex + direction;
        displaySetIndexToShow > -1 && displaySetIndexToShow < currentDisplaySets.length;
        displaySetIndexToShow += direction
      ) {
        if (
          !excludeNonImageModalities ||
          !nonImageModalities.includes(currentDisplaySets[displaySetIndexToShow].Modality)
        ) {
          break;
        }
      }

      if (displaySetIndexToShow < 0 || displaySetIndexToShow >= currentDisplaySets.length) {
        return;
      }

      const { displaySetInstanceUID } = currentDisplaySets[displaySetIndexToShow];

      let updatedViewports = [];

      try {
        updatedViewports = hangingProtocolService.getViewportsRequireUpdate(
          activeViewportId,
          displaySetInstanceUID,
          isHangingProtocolLayout
        );
      } catch (error) {
        console.warn(error);
        uiNotificationService.show({
          title: 'Navigate Viewport Display Set',
          message:
            'The requested display sets could not be added to the viewport due to a mismatch in the Hanging Protocol rules.',
          type: 'info',
          duration: 3000,
        });
      }

      commandsManager.run('setDisplaySetsForViewports', { viewportsToUpdate: updatedViewports });

      setTimeout(() => actions.scrollActiveThumbnailIntoView(), 0);
    },
  };

  const definitions = {
    multimonitor: actions.multimonitor,
    promptSaveReport: actions.promptSaveReport,
    loadStudy: actions.loadStudy,
    showContextMenu: actions.showContextMenu,
    closeContextMenu: actions.closeContextMenu,
    clearMeasurements: actions.clearMeasurements,
    displayNotification: actions.displayNotification,
    setHangingProtocol: actions.setHangingProtocol,
    toggleHangingProtocol: actions.toggleHangingProtocol,
    navigateHistory: actions.navigateHistory,
    nextStage: {
      commandFn: actions.deltaStage,
      options: { direction: 1 },
    },
    previousStage: {
      commandFn: actions.deltaStage,
      options: { direction: -1 },
    },
    setViewportGridLayout: actions.setViewportGridLayout,
    toggleOneUp: actions.toggleOneUp,
    openDICOMTagViewer: actions.openDICOMTagViewer,
    sam2: actions.sam2,
    initNninter: actions.initNninter,
    resetNninter: actions.resetNninter,
    nninter: actions.nninter,
    jumpToSegment: actions.jumpToSegment,
    toggleCurrentSegment: actions.toggleCurrentSegment,
    updateViewportDisplaySet: actions.updateViewportDisplaySet,
  };

  return {
    actions,
    definitions,
    defaultContext: 'DEFAULT',
  };
};

export default commandsModule;
