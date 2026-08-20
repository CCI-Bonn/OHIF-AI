const checkHasOverlapping = _ref => {
  let largerArray = _ref.largerArray,
    currentTestedArray = _ref.currentTestedArray,
    newArray = _ref.newArray;
  return largerArray.some((_, currentImageIndex) => {
    const originalImagePixelData = currentTestedArray[currentImageIndex];
    const newImagePixelData = newArray[currentImageIndex];
    if (!originalImagePixelData || !newImagePixelData) {
      return false;
    }
    return originalImagePixelData.some((originalPixel, currentPixelIndex) => {
      const newPixel = newImagePixelData[currentPixelIndex];
      return originalPixel && newPixel;
    });
  });
};
const compactMergeSegmentDataWithoutInformationLoss = _ref2 => {
  let arrayOfSegmentData = _ref2.arrayOfSegmentData,
    newSegmentData = _ref2.newSegmentData;
  if (arrayOfSegmentData.length === 0) {
    arrayOfSegmentData.push(newSegmentData);
    return;
  }
  for (let currentTestedIndex = 0; currentTestedIndex < arrayOfSegmentData.length; currentTestedIndex++) {
    const currentTestedArray = arrayOfSegmentData[currentTestedIndex];
    const originalArrayIsLarger = currentTestedArray.length > newSegmentData.length;
    const largerArray = originalArrayIsLarger ? currentTestedArray : newSegmentData;
    const hasOverlapping = checkHasOverlapping({
      currentTestedArray,
      largerArray,
      newArray: newSegmentData
    });
    if (hasOverlapping) {
      continue;
    }
    // OHIF-AI: iterate the index RANGE, not `largerArray`'s populated entries.
    //
    // getSegmentData() returns a SPARSE array — segmentData[i] is assigned only for images
    // that actually hold voxels — and Array.prototype.forEach SKIPS HOLES. So the original
    // `largerArray.forEach(...)` visited only the indices where largerArray had data. When the
    // EXISTING layer is the longer one, that is the existing layer's index set, and every
    // slice where only the NEW segment has data was never visited, and was silently dropped.
    //
    // Real case: reloading a DICOM-SEG whose segment 3 spans images [375..525] (length 526)
    // and segment 4 spans [241..453] (length 454). Segment 4 does not collide in-plane with
    // segment 3, so it merges into segment 3's layer; largerArray became segment 3, and
    // segment 4 came back as only [375..453] — 213 slices cut to 79. The survivor was always
    // seg3.start..seg4.end no matter how far segment 4 extended below it, which is why masks
    // of different sizes all collapsed to the same 79.
    //
    // `checkHasOverlapping` above iterates the same way but is CORRECT: an overlap needs both
    // arrays populated at the same index, so a hole in either can never be an overlap.
    const mergeLength = Math.max(currentTestedArray.length, newSegmentData.length);
    for (let currentImageIndex = 0; currentImageIndex < mergeLength; currentImageIndex++) {
      const originalImagePixelData = currentTestedArray[currentImageIndex];
      const newImagePixelData = newSegmentData[currentImageIndex];
      if (!newImagePixelData) {
        continue;
      }
      if (!originalImagePixelData) {
        currentTestedArray[currentImageIndex] = newImagePixelData;
        continue;
      }
      const mergedPixelData = originalImagePixelData.map((originalPixel, currentPixelIndex) => {
        const newPixel = newImagePixelData[currentPixelIndex];
        return originalPixel || newPixel;
      });
      currentTestedArray[currentImageIndex] = mergedPixelData;
    }
    return;
  }
  arrayOfSegmentData.push(newSegmentData);
};

export { compactMergeSegmentDataWithoutInformationLoss };
