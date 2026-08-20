import * as cornerstone from '@cornerstonejs/core';

/**
 * It checks if the imageId is provided then it uses it to query
 * the metadata and get the SOPInstanceUID, SeriesInstanceUID and StudyInstanceUID.
 * If the imageId is not provided then undefined is returned.
 * @param {string} imageId The image id of the referenced image
 * @returns
 */
export default function getSOPInstanceAttributes(imageId, displaySetService, annotation) {
  if (imageId) {
    return _getUIDFromImageID(imageId);
  }

  const { metadata } = annotation;
  const { volumeId } = metadata;

  if (!volumeId) {
    return {
      SOPInstanceUID: undefined,
      SeriesInstanceUID: undefined,
      StudyInstanceUID: undefined,
    };
  }

  const displaySet = displaySetService.getDisplaySetsBy(displaySet =>
    volumeId.includes(displaySet.uid)
  )[0];
  const { StudyInstanceUID, SeriesInstanceUID } = displaySet;

  return {
    SOPInstanceUID: undefined,
    SeriesInstanceUID,
    StudyInstanceUID,
  };
}

function _getUIDFromImageID(imageId) {
  const instance = cornerstone.metaData.get('instance', imageId);

  // `metaData.get` returns undefined when the referenced image's metadata is no longer
  // registered — e.g. an annotation event fires for a study whose metadata has already been
  // torn down. Reading through it threw
  //   "Cannot read properties of undefined (reading 'SOPInstanceUID')"
  // which MeasurementService catches, logs as "Failed to map", and then RETHROWS from inside
  // an event dispatch — aborting the remaining listeners for that annotation event.
  // Returning undefined UIDs is the contract this function already uses for its other
  // unresolvable case (the no-volumeId branch above), and the caller in SegmentBidirectional
  // already guards with `if (SOPInstanceUID)`.
  if (!instance) {
    return {
      SOPInstanceUID: undefined,
      SeriesInstanceUID: undefined,
      StudyInstanceUID: undefined,
      frameNumber: 1,
    };
  }

  return {
    SOPInstanceUID: instance.SOPInstanceUID,
    SeriesInstanceUID: instance.SeriesInstanceUID,
    StudyInstanceUID: instance.StudyInstanceUID,
    frameNumber: instance.frameNumber || 1,
  };
}
