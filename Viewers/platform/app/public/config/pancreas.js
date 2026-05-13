/** @type {AppTypes.Config} */
window.config = {
  name: 'config/pancreas.js',
  routerBasename: null,
  extensions: [],
  modes: [],
  customizationService: {},
  showStudyList: true,
  maxNumberOfWebWorkers: 3,
  showWarningMessageForCrossOrigin: true,
  showCPUFallbackMessage: true,
  showLoadingIndicator: true,
  strictZSpacingForVolumeViewport: true,
  groupEnabledModesFirst: true,
  allowMultiSelectExport: false,

  pancreasApiBase: '/pancreas-api',
  // pancreasApiBase: 'http://localhost:8000',

  monaiLabelServerUrl: '/monai-label',
  // monaiLabelServerUrl: 'http://localhost:8002',

  maxNumRequests: {
    interaction: 100,
    thumbnail: 75,
    prefetch: 25,
  },

  defaultDataSourceName: 'orthanc',

  dataSources: [
    {
      namespace: '@ohif/extension-default.dataSourcesModule.dicomweb',
      sourceName: 'orthanc',
      configuration: {
        dicomUploadEnabled: true,
        friendlyName: 'Orthanc PACS',
        name: 'orthanc',
        qidoRoot: '/pacs/dicom-web',
        wadoRoot: '/pacs/dicom-web',
        wadoUriRoot: '/pacs/dicom-web',
        qidoSupportsIncludeField: false,
        imageRendering: 'wadors',
        thumbnailRendering: 'wadors',
        enableStudyLazyLoad: true,
        supportsFuzzyMatching: false,
        supportsWildcard: true,
      },
    },
  ],

  httpErrorHandler: error => {
    const { request, response } = error;
    if (response) {
      console.warn('HTTP error', response.status, request?.url);
    } else {
      console.warn('Network error', request?.url);
    }
  },
};