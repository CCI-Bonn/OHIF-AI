import { id } from './id';
import initToolGroups from './initToolGroups';
import toolbarButtons from '../../longitudinal/src/toolbarButtons';

// Reuse shared namespace constants from mode-basic to avoid string duplication
const ohif = {
  layout: '@ohif/extension-default.layoutTemplateModule.viewerLayout',
  sopClassHandler: '@ohif/extension-default.sopClassHandlerModule.stack',
  thumbnailList: '@ohif/extension-default.panelModule.seriesList',
};

const cornerstone = {
  viewport: '@ohif/extension-cornerstone.viewportModule.cornerstone',
  segmentation: '@ohif/extension-cornerstone.panelModule.panelSegmentationWithTools',
};

const dicomSeg = {
  sopClassHandler: '@ohif/extension-cornerstone-dicom-seg.sopClassHandlerModule.dicom-seg',
  viewport: '@ohif/extension-cornerstone-dicom-seg.viewportModule.dicom-seg',
};

const dicomRT = {
  viewport: '@ohif/extension-cornerstone-dicom-rt.viewportModule.dicom-rt',
  sopClassHandler: '@ohif/extension-cornerstone-dicom-rt.sopClassHandlerModule.dicom-rt',
};

const pancreasExt = {
  panel: '@ohif/extension-pancrea-seg.panelModule.panelPancreasAngle',
};

const extensionDependencies = {
  '@ohif/extension-default': '^3.0.0',
  '@ohif/extension-cornerstone': '^3.0.0',
  '@ohif/extension-cornerstone-dicom-seg': '^3.0.0',
  '@ohif/extension-cornerstone-dicom-rt': '^3.0.0',
  '@ohif/extension-pancrea-seg': '^3.0.0',
};

function modeFactory({ modeConfiguration }) {
  const _unsubscriptions: Array<() => void> = [];

  return {
    id,
    routeName: 'pancreas',
    displayName: 'Pancreas Segmentation',

    onModeEnter: ({
      servicesManager,
      extensionManager,
      commandsManager,
    }: AppTypes.Managers) => {
      const {
        measurementService,
        toolbarService,
        toolGroupService,
      } = servicesManager.services as any;

      measurementService.clearMeasurements();
      initToolGroups(extensionManager, toolGroupService, commandsManager);

      toolbarService.addButtons(toolbarButtons);

      toolbarService.createButtonSection('primary', [
        'WindowLevel',
        'Pan',
        'Zoom',
        'Angle',
        'Capture',
        'Layout',
        'Crosshairs',
        'MoreTools',
      ]);

      toolbarService.createButtonSection('MoreTools', [
        'Reset',
        'rotate-right',
        'flipHorizontal',
        'StackScroll',
        'invert',
        'Cine',
        'Magnify',
        'TagBrowser',
      ]);

      // AI interactive tools (point click, bbox, lasso for SAM3 tumor seg)
      toolbarService.createButtonSection('aiToolBox', ['aiToolBoxContainer']);
      toolbarService.createButtonSection('aiToolBoxSection', [
        'Probe2',
        'PlanarFreehandROI2',
        'PlanarFreehandROI3',
        'RectangleROI2',
        'nninter',
      ]);
    },

    onModeExit: ({ servicesManager }: AppTypes.Managers) => {
      const {
        toolGroupService,
        syncGroupService,
        cornerstoneViewportService,
        uiDialogService,
        uiModalService,
        pancreasAngleService,
      } = servicesManager.services as any;

      _unsubscriptions.forEach(unsub => unsub());
      _unsubscriptions.length = 0;

      uiDialogService?.hideAll?.();
      uiModalService?.hide?.();
      toolGroupService.destroy();
      syncGroupService?.destroy?.();
      cornerstoneViewportService.destroy();
      pancreasAngleService?.clearResults?.();
    },

    validationTags: {
      study: [],
      series: [],
    },

    isValidMode: ({ modalities }: { modalities: string }) => {
      return {
        valid: true,
        description: 'Pancreas mode supports all modalities',
      };
    },

    routes: [
      {
        path: 'pancreas',
        layoutTemplate: () => ({
          id: ohif.layout,
          props: {
            leftPanels: [ohif.thumbnailList],
            leftPanelResizable: true,
            rightPanels: [pancreasExt.panel, cornerstone.segmentation],
            rightPanelResizable: true,
            viewports: [
              {
                namespace: cornerstone.viewport,
                displaySetsToDisplay: [ohif.sopClassHandler],
              },
              {
                namespace: dicomSeg.viewport,
                displaySetsToDisplay: [dicomSeg.sopClassHandler],
              },
              {
                namespace: dicomRT.viewport,
                displaySetsToDisplay: [dicomRT.sopClassHandler],
              },
            ],
          },
        }),
      },
    ],

    extensions: extensionDependencies,
    hangingProtocol: ['@ohif/mnGrid'],
    sopClassHandlers: [ohif.sopClassHandler, dicomSeg.sopClassHandler, dicomRT.sopClassHandler],
  };
}

const mode = {
  id,
  modeFactory,
  extensionDependencies,
};

export default mode;
