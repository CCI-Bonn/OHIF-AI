import dcmjs from 'dcmjs';
import { classes, Types } from '@ohif/core';
import { cache, metaData, imageLoader } from '@cornerstonejs/core';
import { segmentation as cornerstoneToolsSegmentation } from '@cornerstonejs/tools';
import { adaptersRT, helpers, adaptersSEG } from '@cornerstonejs/adapters';
import { createReportDialogPrompt } from '@ohif/extension-default';
import { DicomMetadataStore } from '@ohif/core';

import PROMPT_RESPONSES from '../../default/src/utils/_shared/PROMPT_RESPONSES';

const { datasetToBlob } = dcmjs.data;

const getTargetViewport = ({ viewportId, viewportGridService }) => {
  const { viewports, activeViewportId } = viewportGridService.getState();
  const targetViewportId = viewportId || activeViewportId;

  const viewport = viewports.get(targetViewportId);

  return viewport;
};

const {
  Cornerstone3D: {
    Segmentation: { generateSegmentation },
  },
} = adaptersSEG;

const {
  Cornerstone3D: {
    RTSS: { generateRTSSFromSegmentations },
  },
} = adaptersRT;

const { downloadDICOMData } = helpers;

const commandsModule = ({
  servicesManager,
  extensionManager,
}: Types.Extensions.ExtensionParams): Types.Extensions.CommandsModule => {
  const { segmentationService, displaySetService, viewportGridService, toolGroupService } =
    servicesManager.services as AppTypes.Services;

  const actions = {
    /**
     * Loads segmentations for a specified viewport.
     * The function prepares the viewport for rendering, then loads the segmentation details.
     * Additionally, if the segmentation has scalar data, it is set for the corresponding label map volume.
     *
     * @param {Object} params - Parameters for the function.
     * @param params.segmentations - Array of segmentations to be loaded.
     * @param params.viewportId - the target viewport ID.
     *
     */
    loadSegmentationsForViewport: async ({ segmentations, viewportId }) => {
      // Todo: handle adding more than one segmentation
      const viewport = getTargetViewport({ viewportId, viewportGridService });
      const displaySetInstanceUID = viewport.displaySetInstanceUIDs[0];

      const segmentation = segmentations[0];
      const segmentationId = segmentation.segmentationId;
      const label = segmentation.config.label;
      const segments = segmentation.config.segments;

      const displaySet = displaySetService.getDisplaySetByUID(displaySetInstanceUID);

      await segmentationService.createLabelmapForDisplaySet(displaySet, {
        segmentationId,
        segments,
        label,
      });

      segmentationService.addOrUpdateSegmentation(segmentation);

      await segmentationService.addSegmentationRepresentation(viewport.viewportId, {
        segmentationId,
      });

      return segmentationId;
    },
    /**
     * Generates a segmentation from a given segmentation ID.
     * This function retrieves the associated segmentation and
     * its referenced volume, extracts label maps from the
     * segmentation volume, and produces segmentation data
     * alongside associated metadata.
     *
     * @param {Object} params - Parameters for the function.
     * @param params.segmentationId - ID of the segmentation to be generated.
     * @param params.options - Optional configuration for the generation process.
     *
     * @returns Returns the generated segmentation data.
     */
    generateSegmentation: async ({ segmentationId, options = {} }) => {
      const segmentation = cornerstoneToolsSegmentation.state.getSegmentation(segmentationId);

      const { imageIds, labelmaps } = segmentation.representationData.Labelmap;

      // Primary block images — used for CT slice ordering and referencedImageIds
      const segImages = imageIds.map(imageId => cache.getImage(imageId));

      // Collect all referenced image IDs (maintaining array structure to match segImages)
      const referencedImageIds = segImages.map(image => image?.referencedImageId);

      // Load all referenced images that exist but may not be in cache yet
      // This is necessary because lazy loading may not have loaded all slices yet
      await Promise.all(
        referencedImageIds.map(referencedImageId => {
          if (!referencedImageId) {
            return Promise.resolve(null);
          }
          // Check if already in cache
          const cachedImage = cache.getImage(referencedImageId);
          if (cachedImage) {
            return Promise.resolve(cachedImage);
          }
          // Load if not in cache
          return imageLoader.loadAndCacheImage(referencedImageId).catch(error => {
            console.warn(`Failed to load referenced image ${referencedImageId}:`, error);
            return null;
          });
        })
      );

      // Now get all referenced images from cache, maintaining the same order as segImages
      const referencedImages = segImages.map(image => {
        if (!image?.referencedImageId) {
          return null;
        }
        return cache.getImage(image.referencedImageId);
      });

      const N = imageIds.length;
      const isMultiBlock = labelmaps && Object.keys(labelmaps).length > 1;

      // Compute sort permutation matching the dcmjs SEGImageNormalizer (descending by scan-axis
      // distance). The normalizer sorts CT datasets descending before building ReferencedInstanceSequence,
      // so labelmaps2D[sortedIdx] must correspond to the CT slice at normalizer's sorted position sortedIdx.
      const computeSortPerm = (): number[] => {
        const firstImg = referencedImages.find(Boolean) as any;
        if (!firstImg) return Array.from({ length: N }, (_, i) => i);
        const pm0 = metaData.get('imagePlaneModule', firstImg.imageId);
        if (!pm0?.imagePositionPatient || !pm0?.rowCosines) return Array.from({ length: N }, (_, i) => i);
        const row: number[] = pm0.rowCosines;
        const col: number[] = pm0.columnCosines;
        const scanAxis = [
          row[1] * col[2] - row[2] * col[1],
          row[2] * col[0] - row[0] * col[2],
          row[0] * col[1] - row[1] * col[0],
        ];
        const refPos: number[] = pm0.imagePositionPatient;
        const distances = referencedImages.map((img: any) => {
          if (!img) return -Infinity;
          const pm = metaData.get('imagePlaneModule', img.imageId);
          const pos: number[] = pm?.imagePositionPatient ?? refPos;
          return (pos[0] - refPos[0]) * scanAxis[0] + (pos[1] - refPos[1]) * scanAxis[1] + (pos[2] - refPos[2]) * scanAxis[2];
        });
        // sortPerm[sortedIdx] = origIdx (descending distance = normalizer order)
        return Array.from({ length: N }, (_, i) => i).sort((a, b) => distances[b] - distances[a]);
      };

      const sortPerm = computeSortPerm();
      const origToSorted = new Array(N);
      sortPerm.forEach((origIdx, sortedIdx) => { origToSorted[origIdx] = sortedIdx; });

      // Re-index arr[origIdx] → result[sortedIdx]
      const applySortPerm = (arr: any[]): any[] => {
        const result: any[] = new Array(N);
        for (let i = 0; i < N; i++) result[origToSorted[i]] = arr[i];
        return result;
      };

      // Build per-segment metadata upfront
      const segmentationInOHIF = segmentationService.getSegmentation(segmentationId);
      const representations = segmentationService.getRepresentationsForSegmentation(segmentationId);
      const allSegmentMetadata: Record<number, any> = {};

      Object.entries(segmentationInOHIF.segments).forEach(([segmentIndexStr, segment]) => {
        if (!segment) return;
        const segmentIndex = Number(segmentIndexStr);
        const { label } = segment;

        const firstRepresentation = representations[0];
        const color = segmentationService.getSegmentColor(
          firstRepresentation.viewportId,
          segmentationId,
          segment.segmentIndex
        );

        const RecommendedDisplayCIELabValue = dcmjs.data.Colors.rgb2DICOMLAB(
          color.slice(0, 3).map(value => value / 255)
        ).map(value => Math.round(value));

        let segmentMetadata: any = {};
        if (segmentation.cachedStats.data !== undefined && segmentation.cachedStats.data.length > 1) {
          segmentMetadata = segmentation.cachedStats.data
            .filter(e => e !== undefined && e !== null)
            .find(e => e.SegmentNumber == segmentIndex);
          if (segmentMetadata !== undefined && Object.keys(segmentMetadata).length !== 0) {
            segmentMetadata.SegmentNumber = segmentIndex.toString();
            segmentMetadata.SegmentLabel = label;
            segmentMetadata.RecommendedDisplayCIELabValue = RecommendedDisplayCIELabValue;
            segmentMetadata.SegmentAlgorithmType = segmentation.cachedStats.seriesInstanceUid;
          }
        }

        if (segmentMetadata === undefined || Object.keys(segmentMetadata).length === 0) {
          segmentMetadata = {
            SegmentNumber: segmentIndex.toString(),
            SegmentLabel: label,
            SegmentAlgorithmType: segment?.algorithmType || 'MANUAL',
            SegmentAlgorithmName: segment?.algorithmName || 'OHIF Brush',
            RecommendedDisplayCIELabValue,
            SegmentedPropertyCategoryCodeSequence: {
              CodeValue: 'T-D0050',
              CodingSchemeDesignator: 'SRT',
              CodeMeaning: 'Tissue',
            },
            SegmentedPropertyTypeCodeSequence: {
              CodeValue: 'T-D0050',
              CodingSchemeDesignator: 'SRT',
              CodeMeaning: 'Tissue',
            },
          };
        }
        if (segment.cachedStats.description !== undefined) {
          segmentMetadata.SegmentDescription = segment.cachedStats.description;
        }
        if (segment.cachedStats.algorithmName !== undefined) {
          segmentMetadata.SegmentAlgorithmName = segment.cachedStats.algorithmName;
        }
        if (segment.cachedStats.algorithmType !== undefined) {
          segmentMetadata.SegmentAlgorithmType = segment.cachedStats.algorithmType;
        }
        if (segmentation.cachedStats.seriesInstanceUid !== undefined) {
          segmentMetadata.SegmentAlgorithmType = segmentation.cachedStats.seriesInstanceUid;
        }

        allSegmentMetadata[segmentIndex] = segmentMetadata;
      });

      let generatedSegmentation;

      if (isMultiBlock) {
        // Multi-block: one labelmap3D per block so each segment's pixels are handled independently.
        // dcmjs _addSegmentPixelDataFromLabelmaps checks labelmap[i] === segmentIndex, so each
        // block's raw pixel values (0 or segmentIndex) correctly produce binary frames per segment,
        // and overlapping pixels are preserved across blocks.
        const labelmaps3DArray: any[] = [];

        for (const [, layer] of Object.entries(labelmaps as Record<string, any>)) {
          const layerLabelmaps2D: any[] = new Array(N);

          for (let z = 0; z < N; z++) {
            const primaryImage = segImages[z];
            if (!primaryImage || !layer.imageIds?.[z]) continue;
            const { rows, columns } = primaryImage;
            const layerImage = cache.getImage(layer.imageIds[z]);
            if (!layerImage) continue;
            const pixelData = layerImage.getPixelData();
            const segmentsOnLabelmap = new Set<number>();
            for (let i = 0; i < pixelData.length; i++) {
              if (pixelData[i] !== 0) segmentsOnLabelmap.add(pixelData[i]);
            }
            if (segmentsOnLabelmap.size > 0) {
              layerLabelmaps2D[z] = { segmentsOnLabelmap: Array.from(segmentsOnLabelmap), pixelData, rows, columns };
            }
          }

          const layerSegments = Array.from(
            new Set(layerLabelmaps2D.filter(Boolean).flatMap((l: any) => l.segmentsOnLabelmap))
          );
          if (layerSegments.length === 0) continue;

          const layerMetadata: any[] = [];
          for (const segIdx of layerSegments) {
            layerMetadata[segIdx] = allSegmentMetadata[segIdx];
          }

          labelmaps3DArray.push({
            segmentsOnLabelmap: layerSegments,
            metadata: layerMetadata,
            labelmaps2D: applySortPerm(layerLabelmaps2D),
          });
        }

        generatedSegmentation = generateSegmentation(referencedImages, labelmaps3DArray, metaData, options);
      } else {
        const labelmaps2D: any[] = new Array(N);

        for (let z = 0; z < N; z++) {
          const primaryImage = segImages[z];
          if (!primaryImage) continue;
          const { rows, columns } = primaryImage;
          const pixelData = primaryImage.getPixelData();
          const segmentsOnLabelmap = new Set<number>();
          for (let i = 0; i < pixelData.length; i++) {
            if (pixelData[i] !== 0) segmentsOnLabelmap.add(pixelData[i]);
          }
          labelmaps2D[z] = { segmentsOnLabelmap: Array.from(segmentsOnLabelmap), pixelData, rows, columns };
        }

        const allSegments = Array.from(
          new Set(labelmaps2D.filter(Boolean).flatMap((l: any) => l.segmentsOnLabelmap))
        );
        const metadata: any[] = [];
        for (const segIdx of allSegments) metadata[segIdx] = allSegmentMetadata[segIdx];

        generatedSegmentation = generateSegmentation(
          referencedImages,
          { segmentsOnLabelmap: allSegments, metadata, labelmaps2D: applySortPerm(labelmaps2D) },
          metaData,
          options
        );
      }

      return generatedSegmentation;
    },
    /**
     * Downloads a segmentation based on the provided segmentation ID.
     * This function retrieves the associated segmentation and
     * uses it to generate the corresponding DICOM dataset, which
     * is then downloaded with an appropriate filename.
     *
     * @param {Object} params - Parameters for the function.
     * @param params.segmentationId - ID of the segmentation to be downloaded.
     *
     */
    downloadSegmentation: async ({ segmentationId }) => {
      const segmentationInOHIF = segmentationService.getSegmentation(segmentationId);
      const generatedSegmentation = await actions.generateSegmentation({
        segmentationId,
      });

      downloadDICOMData(generatedSegmentation.dataset, `${segmentationInOHIF.label}`);
    },
    /**
     * Stores a segmentation based on the provided segmentationId into a specified data source.
     * The SeriesDescription is derived from user input or defaults to the segmentation label,
     * and in its absence, defaults to 'Research Derived Series'.
     *
     * @param {Object} params - Parameters for the function.
     * @param params.segmentationId - ID of the segmentation to be stored.
     * @param params.dataSource - Data source where the generated segmentation will be stored.
     *
     * @returns {Object|void} Returns the naturalized report if successfully stored,
     * otherwise throws an error.
     */
    storeSegmentation: async ({ segmentationId, dataSource }) => {
      const segmentation = segmentationService.getSegmentation(segmentationId);

      if (!segmentation) {
        throw new Error('No segmentation found');
      }

      const { label } = segmentation;
      const defaultDataSource = dataSource ?? extensionManager.getActiveDataSource();

      const {
        value: reportName,
        dataSourceName: selectedDataSource,
        action,
      } = await createReportDialogPrompt({
        servicesManager,
        extensionManager,
        title: 'Store Segmentation',
      });

      if (action === PROMPT_RESPONSES.CREATE_REPORT) {
        try {
          const selectedDataSourceConfig = selectedDataSource
            ? extensionManager.getDataSources(selectedDataSource)[0]
            : defaultDataSource;

          const generatedData = await actions.generateSegmentation({
            segmentationId,
            options: {
              SeriesDescription: reportName || label || 'Research Derived Series',
            },
          });

          if (!generatedData || !generatedData.dataset) {
            throw new Error('Error during segmentation generation');
          }

          const { dataset: naturalizedReport } = generatedData;
          let selectedDataSourceConfig_new = undefined;
          if (selectedDataSourceConfig.store == undefined) {
            selectedDataSourceConfig_new = selectedDataSourceConfig[0];
          } else {
            selectedDataSourceConfig_new = selectedDataSourceConfig;
          }
          
          await selectedDataSourceConfig_new.store.dicom(naturalizedReport);
          
          // add the information for where we stored it to the instance as well
          naturalizedReport.wadoRoot = selectedDataSourceConfig_new.getConfig().wadoRoot;

          DicomMetadataStore.addInstances([naturalizedReport], true);

          return naturalizedReport;
        } catch (error) {
          console.debug('Error storing segmentation:', error);
          throw error;
        }
      }
    },
    /**
     * Converts segmentations into RTSS for download.
     * This sample function retrieves all segentations and passes to
     * cornerstone tool adapter to convert to DICOM RTSS format. It then
     * converts dataset to downloadable blob.
     *
     */
    downloadRTSS: async ({ segmentationId }) => {
      const segmentations = segmentationService.getSegmentation(segmentationId);

      // inject colors to the segmentIndex
      const firstRepresentation =
        segmentationService.getRepresentationsForSegmentation(segmentationId)[0];
      Object.entries(segmentations.segments).forEach(([segmentIndex, segment]) => {
        segment.color = segmentationService.getSegmentColor(
          firstRepresentation.viewportId,
          segmentationId,
          segmentIndex
        );
      });

      const RTSS = await generateRTSSFromSegmentations(
        segmentations,
        classes.MetadataProvider,
        DicomMetadataStore
      );

      try {
        const reportBlob = datasetToBlob(RTSS);

        //Create a URL for the binary.
        const objectUrl = URL.createObjectURL(reportBlob);
        window.location.assign(objectUrl);
      } catch (e) {
        console.warn(e);
      }
    },
  };

  const definitions = {
    loadSegmentationsForViewport: {
      commandFn: actions.loadSegmentationsForViewport,
    },

    generateSegmentation: {
      commandFn: actions.generateSegmentation,
    },
    downloadSegmentation: {
      commandFn: actions.downloadSegmentation,
    },
    storeSegmentation: {
      commandFn: actions.storeSegmentation,
    },
    downloadRTSS: {
      commandFn: actions.downloadRTSS,
    },
  };

  return {
    actions,
    definitions,
    defaultContext: 'SEGMENTATION',
  };
};

export default commandsModule;
