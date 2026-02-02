import io
import base64

import numpy as np
import PIL.Image


def norm(ct_vol: np.ndarray, min: float, max: float) -> np.ndarray:
  """Window and normalize CT imaging Houndsfield values to values 0 - 255."""
  ct_vol = np.clip(ct_vol, min, max)  # Clip the imaging value range
  ct_vol = ct_vol.astype(np.float32)
  ct_vol -= min
  ct_vol /= (max - min) # Norm to values between 0 - 1.0
  ct_vol *= 255.0  # Norm to values been 0 - 255.0
  return ct_vol


def window(ct_vol: np.ndarray) -> np.ndarray:
  # Window CT slice imaging with three windows (wide, mediastinum(chest), brain)
  # Imaging will appear color when visualized, RGB channels contain different
  # representations of the data.
  window_clips = [(-1024, 1024), (-135, 215), (0, 80)]
  return np.stack([norm(ct_vol, clip[0], clip[1]) for clip in window_clips], axis=-1)


def norm_mri(mri_vol: np.ndarray, min=None, max=None) -> np.ndarray:
  """Normalize MRI imaging values to 0-255 integer.
  If min and max are provided: window/level normalization (clip then normalize).
  Otherwise: z-score normalization."""
  mri_vol = mri_vol.astype(np.float32)
  
  if min is None or max is None:
    # Z-score normalization: (x - mean) / std
    mean = np.mean(mri_vol)
    std = np.std(mri_vol)
    
    # Avoid division by zero
    if std == 0:
      mri_vol_normalized = np.zeros_like(mri_vol)
    else:
      mri_vol_normalized = (mri_vol - mean) / std
    
    # Clip z-scores to reasonable range (±3 standard deviations) to handle outliers
    # This is necessary for proper remapping, not window/level clipping like CT
    mri_vol_normalized = np.clip(mri_vol_normalized, -3.0, 3.0)
    
    # Linearly remap from [-3, 3] to [0, 255]
    mri_vol_normalized = (mri_vol_normalized + 3.0) / 6.0  # Map to [0, 1]
    mri_vol_normalized = mri_vol_normalized * 255.0  # Map to [0, 255]
  else:
    # Window/level normalization: clip then normalize (similar to CT norm function)
    np.clip(mri_vol, min, max, out=mri_vol)
    mri_vol_normalized = (mri_vol - min) / (max - min) * 255.0
  
  return mri_vol_normalized.astype(np.uint8)


def window_mri(mri_vol: np.ndarray, min: float=None, max: float=None) -> np.ndarray:
  """Normalize MRI slice imaging using z-score normalization.
  Returns RGB representation (same channel stacked 3 times) remapped to 0-255.
  This matches the structure of window() for CT images."""
  normalized = norm_mri(mri_vol, min, max)
  # Stack the same channel three times to create RGB (for consistency with CT window function)
  return np.stack([normalized, normalized, normalized], axis=-1)

def _encode(data: np.ndarray) -> str:
  """Encode CT slice imaging inline in prompt."""
  # Image format to encode ct slice images as.
  # options: "jpeg" or "png"
  format = "jpeg"
  with io.BytesIO() as img_bytes:
    with PIL.Image.fromarray(data) as img:
      img.save(img_bytes, format=format)
    img_bytes.seek(0)
    encoded_string = base64.b64encode(img_bytes.getbuffer()).decode("utf-8")
  return f"data:image/{format};base64,{encoded_string}"
  