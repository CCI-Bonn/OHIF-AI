# Copyright (c) MONAI Consortium
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#     http://www.apache.org/licenses/LICENSE-2.0
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

import copy
import hashlib
import logging
import os
import time
from datetime import datetime
from abc import abstractmethod
from concurrent.futures import ThreadPoolExecutor
from enum import Enum
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple, Union

from glob import glob as glob
import SimpleITK as sitk
import numpy as np
import nibabel as nib

import torch
from monai.data import decollate_batch
from monai.inferers import Inferer, SimpleInferer, SlidingWindowInferer
from monai.utils import deprecated

import pathlib
from pydicom.filereader import dcmread
import traceback

from monailabel.interfaces.exception import MONAILabelError, MONAILabelException
from monailabel.interfaces.tasks.infer_v2 import InferTask, InferType
from monailabel.interfaces.utils.transform import dump_data, run_transforms
from monailabel.transform.cache import CacheTransformDatad
from monailabel.transform.writer import ClassificationWriter, DetectionWriter, Writer
from monailabel.utils.others.generic import device_list, device_map, name_to_device
from monailabel.utils.others.helper import (
    get_scanline_filled_points_3d,
    clean_and_densify_polyline,
    spherical_kernel,
    calculate_dice,
    timeout_context,
    scribble_constant_axis,
    prepare_scribble_interaction_payload,
    prepare_lasso_interaction_payload,
)
from monailabel.utils.others.medgemma import encode_slice_to_jpeg_bytes, window_mri, window, _encode
from sam2.build_sam import build_sam2_video_predictor, build_sam2_video_predictor_npz

from sam3.model_builder import build_sam3_video_model

#from mmdet.apis import DetInferencer
#from mmdet.evaluation import get_classes
#from mmcv.visualization import imshow_bboxes

import requests
from PIL import Image
#from transformers import AutoProcessor, AutoModelForZeroShotObjectDetection 

sam2_checkpoint = "/code/checkpoints/sam2.1_hiera_tiny.pt"
model_cfg = "configs/sam2.1/sam2.1_hiera_t.yaml"
medsam2_checkpoint = "/code/checkpoints/MedSAM2_latest.pt"
medsam2_model_cfg = "configs/sam2.1/sam2.1_hiera_t512.yaml"

sam3_checkpoint = "/code/checkpoints/sam3.pt"

#from transformers import BertConfig, BertModel
#from transformers import AutoTokenizer

#import nltk
#nltk.download('punkt', download_dir='/root/nltk_data')
#nltk.download('punkt_tab', download_dir='/root/nltk_data')
#nltk.download('averaged_perceptron_tagger_eng', download_dir='/root/nltk_data')
#nltk.download('averaged_perceptron_tagger', download_dir='/root/nltk_data')

#os.environ["QT_QPA_PLATFORM"] = "offscreen"
#
#config = BertConfig.from_pretrained("bert-base-uncased")
#model = BertModel.from_pretrained("bert-base-uncased", add_pooling_layer=False, config=config)
#tokenizer = AutoTokenizer.from_pretrained("bert-base-uncased")
#
#config.save_pretrained("code/bert-base-uncased")
#model.save_pretrained("code/bert-base-uncased")
#tokenizer.save_pretrained("code/bert-base-uncased")

from huggingface_hub import snapshot_download

REPO_ID = "nnInteractive/nnInteractive"
MODEL_NAME = "nnInteractive_v1.0"  # Updated models may be available in the future
DOWNLOAD_DIR = "/code/checkpoints"  # Specify the download directory

download_path = snapshot_download(
    repo_id=REPO_ID,
    allow_patterns=[f"{MODEL_NAME}/*"],
    local_dir=DOWNLOAD_DIR
)

VOX_MODEL_NAME = "voxtell_v1.1" # Updated models may be available in the future

vox_download_path = snapshot_download(
      repo_id="mrokuss/VoxTell",
      allow_patterns=[f"{VOX_MODEL_NAME}/*", "*.json"],
      local_dir=DOWNLOAD_DIR
)
vox_model_path = os.path.join(DOWNLOAD_DIR, VOX_MODEL_NAME)
from voxtell.inference.predictor import VoxTellPredictor
vox_predictor = VoxTellPredictor(model_dir=vox_model_path, device=torch.device("cuda:0"))

from nnInteractive.inference.inference_session import nnInteractiveInferenceSession

session = nnInteractiveInferenceSession(
    device=torch.device("cuda:0"),
    use_torch_compile=True,
    verbose=True,
    torch_n_threads=os.cpu_count(),
    do_autozoom=True,
)

model_path = os.path.join(DOWNLOAD_DIR, MODEL_NAME)
session.initialize_from_trained_model_folder(model_path)

# Warmup: trigger torch.compile JIT at startup so the first real inference is fast.
# session.warmup() uses the correct patch_size from the model plan — no set_image needed.
try:
    import threading
    def _warmup_session():
        import logging
        _wlog = logging.getLogger(__name__)
        _wlog.info("nnInteractive warmup: starting...")
        ran = session.warmup()
        _wlog.info(f"nnInteractive warmup: {'done' if ran else 'skipped (torch.compile not enabled)'}.")
    threading.Thread(target=_warmup_session, daemon=True).start()
except Exception as _warmup_err:
    print(f"nnInteractive warmup failed (non-fatal): {_warmup_err}")

# Config for the text prompt detector, it is disabled for now
#config_path = '/code/dino_configs/dino.py'
# Setup a checkpoint file to load
#checkpoint = '/code/checkpoints/best_coco_bbox_mAP_epoch_11_dilated_b_l_k_curr_teach_7+5.pth'
#checkpoint = '/code/checkpoints/grounding_dino_swin-t_pretrain_obj365_goldg_grit9m_v3det_20231204_095047-b448804b.pth'
# Initialize the DetInferencer
#inferencer = DetInferencer(model=config_path, weights=checkpoint, palette='random')

predictor_sam2 = build_sam2_video_predictor(model_cfg, sam2_checkpoint, vos_optimized=False)

if os.path.exists(sam3_checkpoint):
    sam3_model = build_sam3_video_model(checkpoint_path=sam3_checkpoint)
    predictor_sam3 = sam3_model.tracker
    predictor_sam3.backbone = sam3_model.detector.backbone
else:
    print(f"Warning: SAM3 checkpoint not found at {sam3_checkpoint}, skipping SAM3 model initialization")
    sam3_model = None
    predictor_sam3 = None

predictor_med = build_sam2_video_predictor_npz(medsam2_model_cfg, medsam2_checkpoint, vos_optimized=False)

import transformers

_MEDGEMMA_HF_1_5_4B = "google/medgemma-1.5-4b-it"
_MEDGEMMA_HF_27B_IT = "google/medgemma-27b-it"

_medgemma_loaded_id: Optional[str] = None
_medgemma_processor: Any = None
_medgemma_model: Any = None

logger = logging.getLogger(__name__)


def _medgemma_resolve_hf_model_id(data: Dict[str, Any]) -> str:
    """Map ``medgemma_variant`` / ``medgemma_model`` to a Hugging Face model id (default 1.5-4B)."""
    raw = (
        str(data.get("medgemma_variant") or data.get("medgemma_model") or "1.5-4b")
    ).strip()
    if raw.startswith("google/"):
        return raw
    raw_l = raw.lower()
    if raw_l in (
        "27b",
        "27",
        "medgemma-27b-it",
    ):
        return _MEDGEMMA_HF_27B_IT
    if raw_l in (
        "1.5-4b",
        "1.5",
        "4b",
        "1.5-4b-it",
        "google/medgemma-1.5-4b-it",
        "medgemma-1.5-4b-it",
    ):
        return _MEDGEMMA_HF_1_5_4B
    return _MEDGEMMA_HF_1_5_4B


def _medgemma_get_processor_and_model(model_id: str) -> Tuple[Any, Any]:
    """Load (or swap) MedGemma weights on ``cuda:1``; only one variant resident at a time."""
    global _medgemma_loaded_id, _medgemma_processor, _medgemma_model
    if _medgemma_loaded_id == model_id and _medgemma_processor is not None and _medgemma_model is not None:
        return _medgemma_processor, _medgemma_model
    if _medgemma_model is not None:
        try:
            del _medgemma_model
            del _medgemma_processor
        except Exception:
            pass
        _medgemma_model = None
        _medgemma_processor = None
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    gem_model_kwargs = dict(
        dtype=torch.bfloat16,
        device_map="auto",
        max_memory={0: "40GiB", 1: "40GiB"},
        offload_buffers=True,
    )
    logger.info("Loading MedGemma model %s ...", model_id)
    _medgemma_processor = transformers.AutoProcessor.from_pretrained(
        model_id, use_fast=True, **gem_model_kwargs
    )
    _medgemma_model = transformers.AutoModelForImageTextToText.from_pretrained(
        model_id, **gem_model_kwargs
    )
    _medgemma_loaded_id = model_id
    return _medgemma_processor, _medgemma_model



def _resolve_hf_token(data: Dict[str, Any]) -> str:
    """Request HF_TOKEN."""
    return os.environ.get("HF_TOKEN", "").strip()


def _gemini_generate_content_config(req: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Plain dict for generate_content(..., config={...}). None = omit thinking_config (Gemini 3.x defaults)."""
    raw = (str(req.get("gemini_thinking_level") or "")).strip().lower()
    if not raw:
        return None
    valid = ("low", "medium", "high")
    if raw not in valid:
        raise ValueError(
            f"Invalid gemini_thinking_level {raw!r}; use one of: {', '.join(valid)}"
        )
    return {"thinking_config": {"thinking_level": raw}}


def _vlm_prepare_medical_slices(
    data: Dict[str, Any],
    img_np: np.ndarray,
    modality_type: str,
    contrast_center: Any,
    contrast_window: Any,
    instanceNumber: Any,
    instanceNumber2: Any,
) -> Tuple[str, str, List[int], List[np.ndarray]]:
    """
    Shared CT/MR slice extraction, windowing, and ordering for VLMs (MedGemma, Gemini, ...).
    Returns: query, instruction, slice_indices (0-based), normalized_img_list (RGB uint8 per slice).
    """
    query = data["texts"][0]
    logger.info(f"img_np shape: {img_np.shape}")
    num_axial_slices = img_np.shape[0]
    logger.info(f"num_axial_slices: {num_axial_slices}")

    start_slice = data.get("startSlice")
    end_slice = data.get("endSlice")

    if start_slice is not None or end_slice is not None:
        start_idx = int(start_slice) - 1 if start_slice is not None else 0
        end_idx = int(end_slice) if end_slice is not None else num_axial_slices
        start_idx = max(0, min(start_idx, num_axial_slices - 1))
        end_idx = max(start_idx + 1, min(end_idx, num_axial_slices))
        slice_indices = list(range(start_idx, end_idx))
        logger.info(
            f"Using user-specified slice range: {start_idx + 1} to {end_idx} (1-indexed, inclusive)"
        )
    else:
        slice_indices = list(range(num_axial_slices))
        logger.info(f"Using all slices: 1 to {num_axial_slices} (1-indexed)")

    if instanceNumber is not None and instanceNumber2 is not None and instanceNumber > instanceNumber2:
        slice_indices = [num_axial_slices - 1 - idx for idx in slice_indices]
        logger.info(
            f"Reversed slice indices due to instanceNumber > instanceNumber2: {slice_indices}"
        )

    img_list = [img_np[i] for i in slice_indices]

    normalized_img_list: List[np.ndarray] = []
    if modality_type == "CT":
        for ct_slice in img_list:
            windowed_slice = window(ct_slice)
            windowed_slice = np.round(windowed_slice, 0).astype(np.uint8)
            normalized_img_list.append(windowed_slice)
    else:
        for mr_slice in img_list:
            if contrast_window is not None and contrast_center is not None:
                windowed_slice = window_mri(
                    mr_slice,
                    contrast_center - contrast_window / 2,
                    contrast_center + contrast_window / 2,
                )
            else:
                windowed_slice = window_mri(mr_slice)
            windowed_slice = np.round(windowed_slice, 0).astype(np.uint8)
            normalized_img_list.append(windowed_slice)

    instruction = (
        data["instruction"]
        if data.get("instruction")
        else (
            "You are an instructor teaching medical students. You are "
            "analyzing the following CT slices. Please review the slices provided below "
            "carefully."
        )
    )
    return query, instruction, slice_indices, normalized_img_list


def _vlm_medgemma_content_from_slices(
    instruction: str,
    slice_indices: List[int],
    normalized_img_list: List[np.ndarray],
    query: str,
) -> List[Dict[str, Any]]:
    content: List[Dict[str, Any]] = []
    content.append({"type": "text", "text": instruction})
    for slice_idx, ct_slice in zip(slice_indices, normalized_img_list):
        actual_slice_number = slice_idx + 1
        content.append({"type": "image", "image": _encode(ct_slice)})
        content.append({"type": "text", "text": f"SLICE {actual_slice_number}"})
    content.append({"type": "text", "text": query})
    return content


def _vlm_gemini_contents_from_medgemma_encoding(
    instruction: str,
    slice_indices: List[int],
    normalized_img_list: List[np.ndarray],
    query: str,
) -> List[Any]:
    """
    Gemini `generate_content` input: same multimodal order as MedGemma (instruction →
    per-slice image + SLICE label → query). Slices are JPEG-encoded with the same
    PIL pipeline as MedGemma (:func:`encode_slice_to_jpeg_bytes`), passed as
    ``types.Part.from_bytes`` without base64 round-trip.
    """
    from google.genai import types

    content_parts: List[Any] = [instruction]
    for slice_idx, slc in zip(slice_indices, normalized_img_list):
        raw = encode_slice_to_jpeg_bytes(slc)
        content_parts.append(types.Part.from_bytes(data=raw, mime_type="image/jpeg"))
        content_parts.append(f"SLICE {slice_idx + 1}")
    content_parts.append(query)
    return content_parts


def _vlm_openai_responses_content(
    instruction: str,
    slice_indices: List[int],
    normalized_img_list: List[np.ndarray],
    query: str,
) -> List[Dict[str, Any]]:
    """Build OpenAI Responses API multimodal ``content`` (input_text / input_image)."""
    content: List[Dict[str, Any]] = [{"type": "input_text", "text": instruction}]
    for slice_idx, slc in zip(slice_indices, normalized_img_list):
        content.append({"type": "input_text", "text": f"SLICE {slice_idx + 1}:"})
        content.append({"type": "input_image", "image_url": _encode(slc)})
    content.append({"type": "input_text", "text": query})
    return content


def _vlm_kimi_hf_chat_content(
    instruction: str,
    slice_indices: List[int],
    normalized_img_list: List[np.ndarray],
    query: str,
) -> List[Dict[str, Any]]:
    """OpenAI-compatible chat ``content`` for Hugging Face router (text + image_url data URLs)."""
    content: List[Dict[str, Any]] = [{"type": "text", "text": instruction}]
    for slice_idx, slc in zip(slice_indices, normalized_img_list):
        content.append({"type": "text", "text": f"SLICE {slice_idx + 1}:"})
        content.append(
            {
                "type": "image_url",
                "image_url": {"url": _encode(slc)},
            }
        )
    content.append({"type": "text", "text": query})
    return content


# Same OpenAI chat multimodal layout as Kimi (HF router).
_vlm_qwen_hf_chat_content = _vlm_kimi_hf_chat_content


def _infer_request_bool(val: Any, default: bool = True) -> bool:
    if val is None:
        return default
    if isinstance(val, bool):
        return val
    s = str(val).strip().lower()
    if s in ("true", "1", "yes", "on"):
        return True
    if s in ("false", "0", "no", "off"):
        return False
    return default


def _kimi_optional_extra_body(req: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Moonshot-compatible thinking toggle via extra_body (HF router / Kimi vLLM)."""
    if _infer_request_bool(req.get("kimi_disable_thinking"), default=False):
        return {"thinking": {"type": "disabled"}}
    return None


_KIMI_DEFAULT_MAX_TOKENS = 32768

_QWEN_DEFAULT_MAX_TOKENS = 32768


def _qwen_effective_max_tokens(req: Dict[str, Any]) -> int:
    raw = req.get("qwen_max_tokens")
    if raw is None or raw == "":
        return _QWEN_DEFAULT_MAX_TOKENS
    try:
        return max(1, int(raw))
    except (TypeError, ValueError):
        return _QWEN_DEFAULT_MAX_TOKENS


def _qwen_hf_router_extra_body(req: Dict[str, Any]) -> Dict[str, Any]:
    """HF OpenAI router / Qwen vLLM: ``extra_body`` ``top_k``; optional ``chat_template_kwargs`` for thinking.

    Prefer ``qwen_thinking_enabled`` from OHIF (bool). Alternatively set only one of
    ``qwen_enable_thinking`` or ``qwen_disable_thinking``.
    """
    try:
        top_k = max(1, int(req.get("qwen_top_k", 20)))
    except (TypeError, ValueError):
        top_k = 20
    eb: Dict[str, Any] = {"top_k": top_k}

    if req.get("qwen_thinking_enabled") is not None:
        te = _infer_request_bool(req.get("qwen_thinking_enabled"), default=True)
        eb["chat_template_kwargs"] = {"enable_thinking": te}
        return eb

    en = _infer_request_bool(req.get("qwen_enable_thinking"), default=False)
    dis = _infer_request_bool(req.get("qwen_disable_thinking"), default=False)
    if en and dis:
        raise MONAILabelError(
            "Use only one of qwen_enable_thinking or qwen_disable_thinking"
        )
    if en:
        eb["chat_template_kwargs"] = {"enable_thinking": True}
    elif dis:
        eb["chat_template_kwargs"] = {"enable_thinking": False}
    return eb


def _qwen_disable_thinking_effective(req: Dict[str, Any]) -> bool:
    """True when the no-thinking sampling profile should be used (matches ``qwen_disable_thinking``)."""
    if req.get("qwen_thinking_enabled") is not None:
        return not _infer_request_bool(req.get("qwen_thinking_enabled"), default=True)
    return _infer_request_bool(req.get("qwen_disable_thinking"), default=False)


def _qwen_hf_router_sampling_kwargs(req: Dict[str, Any]) -> Dict[str, Any]:
    """Sampling for Qwen on HF router; fixed profile when thinking is disabled."""
    if _qwen_disable_thinking_effective(req):
        return {
            "temperature": 0.7,
            "top_p": 0.8,
            "presence_penalty": 1.5,
        }
    try:
        t = float(req.get("qwen_temperature", 0.6))
    except (TypeError, ValueError):
        t = 0.6
    try:
        tp = float(req.get("qwen_top_p", 0.95))
    except (TypeError, ValueError):
        tp = 0.95
    d: Dict[str, Any] = {"temperature": t, "top_p": tp}
    pp = req.get("qwen_presence_penalty")
    if pp is not None and pp != "":
        try:
            d["presence_penalty"] = float(pp)
        except (TypeError, ValueError):
            pass
    return d


_GEMMA_HF_DEFAULT_MAX_TOKENS = 8192


def _gemma_hf_effective_max_tokens(req: Dict[str, Any]) -> int:
    raw = req.get("gemma_max_tokens")
    if raw is None or raw == "":
        return _GEMMA_HF_DEFAULT_MAX_TOKENS
    try:
        return max(1, int(raw))
    except (TypeError, ValueError):
        return _GEMMA_HF_DEFAULT_MAX_TOKENS


def _gemma_hf_router_extra_body(req: Dict[str, Any]) -> Dict[str, Any]:
    """Gemma 4 on Hugging Face OpenAI router: ``top_k`` + ``chat_template_kwargs`` (same pattern as Qwen)."""
    try:
        top_k = max(1, int(req.get("gemma4_top_k", 64)))
    except (TypeError, ValueError):
        top_k = 64
    proxy: Dict[str, Any] = {
        "qwen_thinking_enabled": _infer_request_bool(
            req.get("gemma_thinking_enabled", True), default=True
        ),
        "qwen_top_k": top_k,
    }
    return _qwen_hf_router_extra_body(proxy)


def _gemma_hf_router_sampling_kwargs(req: Dict[str, Any]) -> Dict[str, Any]:
    """Same sampling as vLLM Gemma (``gemma4_temperature`` / ``gemma4_top_p``)."""
    try:
        t = float(req.get("gemma4_temperature", 1.0))
    except (TypeError, ValueError):
        t = 1.0
    try:
        tp = float(req.get("gemma4_top_p", 0.95))
    except (TypeError, ValueError):
        tp = 0.95
    return {"temperature": t, "top_p": tp}


# vLLM (OpenAI-compatible) — local or remote server; see OHIF toolbox / vllm_* request fields.
INTERNVL_VLLM_THINKING_SYSTEM_PROMPT = """
You are an AI assistant that rigorously follows this response protocol:

1. First, conduct a detailed analysis of the question. Consider different angles, potential solutions, and reason through the problem step-by-step. Enclose this entire thinking process within <think> and </think> tags.

2. After the thinking section, provide a clear, concise, and direct answer to the user's question. Separate the answer from the think section with a newline.

Ensure that the thinking process is thorough but remains focused on the query. The final answer should be standalone and not reference the thinking section.
""".strip()


def _vllm_thinking_level(data: Dict[str, Any]) -> str:
    """``vllm_thinking_level``: ``on`` / ``off``; if omitted, ``vllm_thinking_enabled`` (default on)."""
    raw = (str(data.get("vllm_thinking_level") or "")).strip().lower()
    if raw in ("off", "false", "0", "no"):
        return "off"
    if raw in ("on", "true", "1", "yes"):
        return "on"
    if raw:
        return "off"
    return "on" if _infer_request_bool(data.get("vllm_thinking_enabled", True), default=True) else "off"


def _vllm_thinking_on(level: str) -> bool:
    return level == "on"


def _vllm_internvl_system_text(level: str) -> str:
    if level != "on":
        return ""
    return INTERNVL_VLLM_THINKING_SYSTEM_PROMPT


def _vllm_id_matches_family(model_id: str, family: str) -> bool:
    mid = model_id.lower()
    if family == "internvl":
        return "internvl" in mid or "intern_vl" in mid
    if family == "qwen":
        return "qwen" in mid
    if family == "kimi":
        return "kimi" in mid or "moonshot" in mid
    if family == "gemma":
        return "gemma" in mid
    return False


def _vllm_resolve_family(default_model_id: str, override: str) -> str:
    """Resolve routing family from the server's default model id and optional ``vllm_family``.

    When ``vllm_family`` is set, ``default_model_id`` must contain that family (substring check).
    """
    o = (override or "").strip().lower()
    valid = ("internvl", "qwen", "kimi", "gemma")
    if o:
        if o not in valid:
            raise MONAILabelError(
                f"vllm_family must be one of {', '.join(valid)}; got {override!r}"
            )
        if not _vllm_id_matches_family(default_model_id, o):
            raise MONAILabelError(
                f"vLLM default model id {default_model_id!r} does not match requested "
                f"vllm_family={o!r}; use a server whose first listed model id contains that family."
            )
        return o
    mid = default_model_id.lower()
    if "internvl" in mid or "intern_vl" in mid:
        return "internvl"
    if "qwen" in mid:
        return "qwen"
    if "kimi" in mid or "moonshot" in mid:
        return "kimi"
    if "gemma" in mid:
        return "gemma"
    raise MONAILabelError(
        f"vLLM default model id {default_model_id!r} does not match InternVL, Qwen, Kimi, or Gemma; "
        "set vllm_family in the infer request if the id is non-standard."
    )


def _vllm_openai_messages(
    family: str,
    level: str,
    user_blocks: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    if family in ("qwen", "kimi", "gemma"):
        return [{"role": "user", "content": user_blocks}]
    if not _vllm_thinking_on(level):
        return [{"role": "user", "content": user_blocks}]
    sys_text = _vllm_internvl_system_text(level)
    return [
        {"role": "system", "content": [{"type": "text", "text": sys_text}]},
        {"role": "user", "content": user_blocks},
    ]


def _vllm_extra_body_for_create(
    family: str, level: str, data: Dict[str, Any]
) -> Optional[Dict[str, Any]]:
    thinking_on = _vllm_thinking_on(level)
    if family == "gemma":
        try:
            g_top_k = max(1, int(data.get("gemma4_top_k", 64)))
        except (TypeError, ValueError):
            g_top_k = 64
        proxy: Dict[str, Any] = {
            "qwen_thinking_enabled": thinking_on,
            "qwen_top_k": g_top_k,
        }
        return _qwen_hf_router_extra_body(proxy)
    if family == "qwen":
        proxy = {
            "qwen_thinking_enabled": thinking_on,
            "qwen_top_k": data.get("vllm_top_k", 20),
        }
        return _qwen_hf_router_extra_body(proxy)
    if family == "kimi":
        if not thinking_on:
            return {"thinking": {"type": "disabled"}}
        return None
    return None


def _vllm_sampling_kwargs_create(
    family: str, level: str, data: Dict[str, Any]
) -> Dict[str, Any]:
    if family == "gemma":
        try:
            t = float(data.get("gemma4_temperature", 1.0))
        except (TypeError, ValueError):
            t = 1.0
        try:
            tp = float(data.get("gemma4_top_p", 0.95))
        except (TypeError, ValueError):
            tp = 0.95
        return {"temperature": t, "top_p": tp}
    if family == "qwen":
        proxy = {
            "qwen_thinking_enabled": _vllm_thinking_on(level),
            "qwen_top_k": data.get("vllm_top_k", 20),
            "qwen_temperature": data.get("vllm_temperature", 0.6),
            "qwen_top_p": data.get("vllm_top_p", 0.95),
            "qwen_presence_penalty": data.get("vllm_presence_penalty"),
            "qwen_disable_thinking": not _vllm_thinking_on(level),
        }
        return _qwen_hf_router_sampling_kwargs(proxy)
    if family == "internvl" and not _vllm_thinking_on(level):
        return {"temperature": 0.0}
    if family == "internvl" and _vllm_thinking_on(level):
        return {"temperature": 0.6, "top_p": 0.95}
    out: Dict[str, Any] = {}
    if data.get("vllm_temperature") is not None:
        try:
            out["temperature"] = float(data.get("vllm_temperature"))
        except (TypeError, ValueError):
            pass
    return out


def _qwen_stream_collect_text(stream: Any) -> str:
    """Concatenate streamed chat completion deltas into one string."""
    full = ""
    for chunk in stream:
        choices = getattr(chunk, "choices", None) or ()
        if not choices:
            continue
        delta = getattr(choices[0], "delta", None)
        if delta is None:
            continue
        piece = getattr(delta, "content", None)
        if piece:
            full += piece
    return full


def _data_url_mime_and_b64_payload(data_url: str) -> Tuple[str, str]:
    """Split MedGemma-style ``data:<mime>;base64,<payload>`` from :func:`_encode`."""
    if not data_url.startswith("data:") or ";base64," not in data_url:
        raise ValueError(
            f"expected data URL from _encode(), got {data_url[:64]!r}..."
        )
    meta, b64 = data_url.split(";base64,", 1)
    mime_type = meta[len("data:") :]
    return mime_type, b64


def _vlm_anthropic_messages_content(
    instruction: str,
    slice_indices: List[int],
    normalized_img_list: List[np.ndarray],
    query: str,
) -> List[Dict[str, Any]]:
    """Anthropic Messages API user ``content`` blocks (text + base64 images, no Files API)."""
    content: List[Dict[str, Any]] = [{"type": "text", "text": instruction}]
    for slice_idx, slc in zip(slice_indices, normalized_img_list):
        content.append({"type": "text", "text": f"SLICE {slice_idx + 1}:"})
        media_type, image_data = _data_url_mime_and_b64_payload(_encode(slc))
        content.append(
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": media_type,
                    "data": image_data,
                },
            }
        )
    content.append({"type": "text", "text": query})
    return content


def _anthropic_assistant_text(message: Any) -> str:
    """Concatenate user-visible ``text`` blocks from a Messages API response."""
    parts: List[str] = []
    for block in getattr(message, "content", None) or ():
        if getattr(block, "type", None) == "text":
            parts.append(getattr(block, "text", "") or "")
    return "".join(parts)


_CLAUDE_DEFAULT_MAX_TOKENS = 8192


def _claude_messages_create_extra_kwargs(req: Dict[str, Any]) -> Dict[str, Any]:
    """Extra kwargs for ``messages.create``: adaptive thinking when ``claude_thinking_effort`` is set.

    Effort must use ``output_config.effort`` (not ``thinking.adaptive.effort``).
    """
    effort = (str(req.get("claude_thinking_effort") or "")).strip().lower()
    if not effort:
        return {}
    valid = ("low", "medium", "high", "max")
    if effort not in valid:
        raise MONAILabelError(
            f"Invalid claude_thinking_effort {effort!r}; use one of: {', '.join(valid)}"
        )
    return {
        "thinking": {"type": "adaptive"},
        "output_config": {"effort": effort},
    }


class CallBackTypes(str, Enum):
    PRE_TRANSFORMS = "PRE_TRANSFORMS"
    INFERER = "INFERER"
    INVERT_TRANSFORMS = "INVERT_TRANSFORMS"
    POST_TRANSFORMS = "POST_TRANSFORMS"
    WRITER = "WRITER"


class BasicInferTask(InferTask):
    """
    Basic Inference Task Helper
    """

    def __init__(
        self,
        path: Union[None, str, Sequence[str]],
        network: Union[None, Any],
        type: Union[str, InferType],
        labels: Union[str, None, Sequence[str], Dict[Any, Any]],
        dimension: int,
        description: str,
        model_state_dict: str = "model",
        input_key: str = "image",
        output_label_key: str = "pred",
        output_json_key: str = "result",
        config: Union[None, Dict[str, Any]] = None,
        load_strict: bool = True,
        roi_size=None,
        preload=False,
        train_mode=False,
        skip_writer=False,
    ):
        """
        :param path: Model File Path. Supports multiple paths to support versions (Last item will be picked as latest)
        :param network: Model Network (e.g. monai.networks.xyz).  None in case if you use TorchScript (torch.jit).
        :param type: Type of Infer (segmentation, deepgrow etc..)
        :param labels: Labels associated to this Infer
        :param dimension: Input dimension
        :param description: Description
        :param model_state_dict: Key for loading the model state from checkpoint
        :param input_key: Input key for running inference
        :param output_label_key: Output key for storing result/label of inference
        :param output_json_key: Output key for storing result/label of inference
        :param config: K,V pairs to be part of user config
        :param load_strict: Load model in strict mode
        :param roi_size: ROI size for scanning window inference
        :param preload: Preload model/network on all available GPU devices
        :param train_mode: Run in Train mode instead of eval (when network has dropouts)
        :param skip_writer: Skip Writer and return data dictionary
        """

        super().__init__(type, labels, dimension, description, config)

        self.path = [] if not path else [path] if isinstance(path, str) else path
        self.network = network
        self.model_state_dict = model_state_dict
        self.input_key = input_key
        self.output_label_key = output_label_key
        self.output_json_key = output_json_key
        self.load_strict = load_strict
        self.roi_size = roi_size
        self.train_mode = train_mode
        self.skip_writer = skip_writer

        self._session_image: Dict[str, Any] = {
            "dicom_dir": None,        # normalised path MONAI served (level-1 key: exact path match)
            "seriesInstanceUID": None, # DICOM tag (0020,000E) UID (level-2 key: works if path changes)
            "img_np": None,           # cached [1,z,y,x] array; populated on init, reused for interactions
            "instanceNumber": None,   # first DICOM file's InstanceNumber (used for flip detection)
            "instanceNumber2": None,  # second DICOM file's InstanceNumber
        }


        self._session_used_interactions = {
            "pos_points": set(),
            "neg_points": set(),
            "pos_boxes": set(),
            "neg_boxes": set(),
            "pos_lassos": set(),
            "neg_lassos": set(),
            "pos_scribbles": set(),
            "neg_scribbles": set(),
        }

        self._networks: Dict = {}

        self._config.update(
            {
                "device": device_list(),
                # "result_extension": None,
                # "result_dtype": None,
                # "result_compress": False
                # "roi_size": self.roi_size,
                # "sw_batch_size": 1,
                # "sw_overlap": 0.25,
            }
        )

        if config:
            self._config.update(config)

        if preload:
            for device in device_map().values():
                logger.info(f"Preload Network for device: {device}")
                self._get_network(device, None)

    def info(self) -> Dict[str, Any]:
        return {
            "type": self.type,
            "labels": self.labels,
            "dimension": self.dimension,
            "description": self.description,
            "config": self.config(),
        }

    def config(self) -> Dict[str, Any]:
        return self._config

    def is_valid(self) -> bool:
        if self.network or self.type == InferType.SCRIBBLES:
            return True

        paths = self.path
        for path in reversed(paths):
            if path and os.path.exists(path):
                return True
        return False

    def get_path(self, validate=True):
        if not self.path:
            return None

        paths = self.path
        for path in reversed(paths):
            if path:
                if not validate or os.path.exists(path):
                    return path
        return None

    @deprecated(since="0.8.0", msg_suffix="This feature is not supported anymore")
    def add_cache_transform(self, t, data, keys=("image", "image_meta_dict"), hash_key=("image_path", "model")):
        pass
        # if data and data.get("cache_transforms", False):
        #     in_memory = data.get("cache_transforms_in_memory", True)
        #     ttl = data.get("cache_transforms_ttl", 300)
        #
        #     t.append(CacheTransformDatad(keys=keys, hash_key=hash_key, in_memory=in_memory, ttl=ttl))

    @abstractmethod
    def pre_transforms(self, data=None) -> Sequence[Callable]:
        """
        Provide List of pre-transforms

        :param data: current data dictionary/request which can be helpful to define the transforms per-request basis

            For Example::

                return [
                    monai.transforms.LoadImaged(keys='image'),
                    monai.transforms.EnsureChannelFirstd(keys='image', channel_dim='no_channel'),
                    monai.transforms.Spacingd(keys='image', pixdim=[1.0, 1.0, 1.0]),
                    monai.transforms.ScaleIntensityRanged(keys='image',
                        a_min=-57, a_max=164, b_min=0.0, b_max=1.0, clip=True),
                ]

        """
        pass

    def inverse_transforms(self, data=None) -> Union[None, Sequence[Callable]]:
        """
        Provide List of inverse-transforms.  They are normally subset of pre-transforms.
        This task is performed on output_label (using the references from input_key)

        :param data: current data dictionary/request which can be helpful to define the transforms per-request basis

        Return one of the following.
            - None: Return None to disable running any inverse transforms (default behavior).
            - Empty: Return [] to run all applicable pre-transforms which has inverse method
            - list: Return list of specific pre-transforms names/classes to run inverse method

            For Example::

                return [
                    monai.transforms.Spacingd,
                ]

        """
        return None

    @abstractmethod
    def post_transforms(self, data=None) -> Sequence[Callable]:
        """
        Provide List of post-transforms

        :param data: current data dictionary/request which can be helpful to define the transforms per-request basis

            For Example::

                return [
                    monai.transforms.EnsureChannelFirstd(keys='pred', channel_dim='no_channel'),
                    monai.transforms.Activationsd(keys='pred', softmax=True),
                    monai.transforms.AsDiscreted(keys='pred', argmax=True),
                    monai.transforms.SqueezeDimd(keys='pred', dim=0),
                    monai.transforms.ToNumpyd(keys='pred'),
                    monailabel.interface.utils.Restored(keys='pred', ref_image='image'),
                    monailabel.interface.utils.ExtremePointsd(keys='pred', result='result', points='points'),
                    monailabel.interface.utils.BoundingBoxd(keys='pred', result='result', bbox='bbox'),
                ]

        """
        pass

    def inferer(self, data=None) -> Inferer:
        input_shape = data[self.input_key].shape if data else None

        roi_size = data.get("roi_size", self.roi_size) if data else self.roi_size
        sw_batch_size = data.get("sw_batch_size", 1) if data else 1
        sw_overlap = data.get("sw_overlap", 0.25) if data else 0.25
        device = data.get("device")

        sliding = False
        if input_shape and roi_size:
            for i in range(len(roi_size)):
                if input_shape[-i] > roi_size[-i]:
                    sliding = True

        if sliding:
            return SlidingWindowInferer(
                roi_size=roi_size,
                overlap=sw_overlap,
                sw_batch_size=sw_batch_size,
                sw_device=device,
                device=device,
            )
        return SimpleInferer()

    def detector(self, data=None) -> Optional[Callable]:
        return None

    # When adding any type of prompt:
    def add_prompt(self, prompt, prompt_type):
        prompt_hash = hashlib.md5(np.array(prompt).tobytes()).hexdigest()
        self._session_used_interactions[prompt_type].add(prompt_hash)

    # When checking any type of prompt:
    def is_prompt_used(self, prompt, prompt_type):
        prompt_hash = hashlib.md5(np.array(prompt).tobytes()).hexdigest()
        return prompt_hash in self._session_used_interactions[prompt_type]

    def __call__(
        self, request, callbacks: Union[Dict[CallBackTypes, Any], None] = None
    ) -> Union[Dict, Tuple[str, Dict[str, Any]]]:
        """
        It provides basic implementation to run the following in order
            - Run Pre Transforms
            - Run Inferer
            - Run Invert Transforms
            - Run Post Transforms
            - Run Writer to save the label mask and result params

        You can provide callbacks which can be useful while writing pipelines to consume intermediate outputs
        Callback function should consume data and return data (modified/updated) e.g. `def my_cb(data): return data`

        Returns: Label (File Path) and Result Params (JSON)
        """
        begin = time.time()
        server_begin_ts = begin  # Unix timestamp; client uses this to estimate network-to-server latency

        # Fast path: reset does not need config merge, image loading, or deep copy
        if request.get('nninter') == "reset":
            for key, lst in self._session_used_interactions.items():
                lst.clear()
            session.reset_interactions()
            # Image cache (_session_image) is intentionally kept: session.reset_interactions()
            # clears the interaction state in nnInteractive but retains the encoded image
            # features, so img_np and dicom_dir remain valid for subsequent interactions.
            logger.info("Reset nninter")
            return f'/code/predictions/reset.nii.gz', {}

        # Fast path: single-level undo of the last interaction (mirrors reset).
        # Returns the restored target_buffer in the same cropped format as a
        # normal interaction so the client can repaint the segment.
        if request.get('nninter') == "undo":
            undo_json = {"nninter_op": "undo"}
            supports_undo = hasattr(session, "undo") and getattr(session, "supports_undo", True)
            if not supports_undo:
                logger.warning("nnInteractive session has no undo()/supports_undo; ignoring undo request")
                undo_json["nninter_op"] = "unsupported"
                undo_json["undone"] = False
                undo_json["server_end_ts"] = time.time()
                return np.zeros((0, 0, 0), dtype=np.uint8), undo_json

            try:
                undone = bool(session.undo())
            except Exception as e:
                logger.error(f"nninter undo() raised: {e}")
                undone = False
            logger.info(f"nninter undo: undone={undone}")
            undo_json["undone"] = undone

            # Restored full object buffer, cropped to its tight non-zero bbox
            # (identical packaging to the normal nninter result path).
            pred = session.target_buffer.clone().numpy()  # (Z, Y, X) uint8
            pred_full_shape = list(pred.shape)
            z_nz = np.where(np.any(pred, axis=(1, 2)))[0]
            if z_nz.size > 0:
                y_nz = np.where(np.any(pred, axis=(0, 2)))[0]
                x_nz = np.where(np.any(pred, axis=(0, 1)))[0]
                z0, z1 = int(z_nz[0]), int(z_nz[-1]) + 1
                y0, y1 = int(y_nz[0]), int(y_nz[-1]) + 1
                x0, x1 = int(x_nz[0]), int(x_nz[-1]) + 1
                pred = pred[z0:z1, y0:y1, x0:x1]
                pred_offset = [z0, y0, x0]
            else:
                # Undid the only interaction: object is now empty. Send an empty
                # crop; the client clears the segment and writes nothing.
                pred = np.zeros((0, 0, 0), dtype=np.uint8)
                pred_offset = [0, 0, 0]

            undo_json["pred_offset"] = pred_offset
            undo_json["pred_full_shape"] = pred_full_shape
            undo_json["pred_crop_shape"] = list(pred.shape)

            _inst = self._session_image.get("instanceNumber")
            _inst2 = self._session_image.get("instanceNumber2")
            undo_json["flipped"] = bool(_inst is not None and _inst2 is not None and _inst > _inst2)

            undo_json["label_name"] = f"nninter_pred_{datetime.now().strftime('%Y%m%d%H%M%S')}"
            undo_json["server_end_ts"] = time.time()
            return pred, undo_json

        # Folded reset: caller needs a segment switch + inference in one round-trip.
        # Resetting here (before image loading) keeps the same semantics as a
        # separate reset call, but saves ~1.4 s of network overhead on slow links.
        if request.get('nninter_reset_first'):
            for key, lst in self._session_used_interactions.items():
                lst.clear()
            session.reset_interactions()
            logger.info("Folded reset before inference")

        req = copy.deepcopy(self._config)
        req.update(request)

        # device
        device = name_to_device(req.get("device", "cuda"))
        req["device"] = device

        logger.setLevel(req.get("logging", "INFO").upper())
        if req.get("image") is not None and isinstance(req.get("image"), str):
            logger.info(f"Infer Request (final): {req}")
            data = copy.deepcopy(req)
            data.update({"image_path": req.get("image")})
        else:
            dump_data(req, logger.level)
            data = req

        # callbacks useful in case of pipeliens to consume intermediate output from each of the following stages
        # callback function should consume data and returns data (modified/updated)
        callbacks = callbacks if callbacks else {}
        callback_run_pre_transforms = callbacks.get(CallBackTypes.PRE_TRANSFORMS)
        callback_run_inferer = callbacks.get(CallBackTypes.INFERER)
        callback_run_invert_transforms = callbacks.get(CallBackTypes.INVERT_TRANSFORMS)
        callback_run_post_transforms = callbacks.get(CallBackTypes.POST_TRANSFORMS)
        callback_writer = callbacks.get(CallBackTypes.WRITER)

        final_result_json = {}
        result_json = {}
        nnInter = data['nninter']

        img = None

        dicom_dir = data['image'].split('.nii.gz')[0].rstrip("/")

        _NNI_EXCLUDE = ("init", "reset",
                        "medGemma", "gemini", "openai", "claude",
                        "kimi", "qwen", "gemma", "vllm")
        _is_nninter_interaction = nnInter and nnInter not in _NNI_EXCLUDE

        logger.info(f"dicom_dir={dicom_dir!r}  cached_dicom_dir={self._session_image['dicom_dir']!r}  cached_uid={self._session_image['seriesInstanceUID']!r}")

        # Level-1: full cache hit — skip GetGDCMSeriesFileNames, dcmread x2,
        # reader.Execute, and sitk.GetArrayFromImage entirely.
        # Key: exact dicom_dir path (stable when MONAI serves the same cached path).
        _img_np_hit = (
            _is_nninter_interaction
            and dicom_dir == self._session_image["dicom_dir"]
            and self._session_image["img_np"] is not None
            and self._session_image["instanceNumber"] is not None
        )

        _pixel_hit = False  # may be set True inside the else branch below
        if _img_np_hit:
            seriesInstanceUID = self._session_image["seriesInstanceUID"]
            instanceNumber    = self._session_image["instanceNumber"]
            instanceNumber2   = self._session_image["instanceNumber2"]
            img_convert_elapsed = 0.0
            logger.info("img_np cache hit — skipping all DICOM I/O")
        else:
            # Full I/O: directory scan + header reads needed for metadata / pixel load.
            reader = sitk.ImageSeriesReader()
            dicom_filenames = reader.GetGDCMSeriesFileNames(dicom_dir)
            dcm_img_sample   = dcmread(dicom_filenames[0], stop_before_pixels=True)
            dcm_img_sample_2 = dcmread(dicom_filenames[1], stop_before_pixels=True)

            # Authoritative UID from DICOM tag (0020,000E); path-derived UID is unreliable
            # when path has trailing slash or a non-UID last component.
            _SERIES_UID_TAG = 0x0020000e
            seriesInstanceUID = (
                str(dcm_img_sample[_SERIES_UID_TAG].value).strip()
                if _SERIES_UID_TAG in dcm_img_sample else path_uid
            )
            logger.info(f"Series Instance UID: {seriesInstanceUID}")

            instanceNumber  = dcm_img_sample[0x00200013].value  if 0x00200013 in dcm_img_sample  else None
            instanceNumber2 = dcm_img_sample_2[0x00200013].value if 0x00200013 in dcm_img_sample_2 else None
            logger.info(f"Prompt First InstanceNumber: {instanceNumber}")
            logger.info(f"Prompt Second InstanceNumber: {instanceNumber2}")

            contrast_center = None
            contrast_window = None
            modality_type   = "Other"

            if 0x00080060 in dcm_img_sample.keys():
                modality = dcm_img_sample[0x00080060].value
                if modality in ("CT", "SC"):
                    modality_type = "CT"
                elif modality == "MR":
                    modality_type = "MR"
                logger.info(f"Modality: {modality_type}")

            if 0x00281050 in dcm_img_sample.keys():
                contrast_center = dcm_img_sample[0x00281050].value
            if 0x00281051 in dcm_img_sample.keys():
                contrast_window = dcm_img_sample[0x00281051].value

            if contrast_window is not None and contrast_center is not None:
                if contrast_window.__class__.__name__ == 'MultiValue':
                    contrast_window = contrast_window[0]
                if contrast_center.__class__.__name__ == 'MultiValue':
                    contrast_center = contrast_center[0]

            image_series_desc = ""
            if 0x0008103e in dcm_img_sample.keys():
                image_series_desc = dcm_img_sample[0x0008103e].value

            # Level-2: path UID may differ (e.g. MONAI changed temp dir) but tag UID matches
            # → skip reader.Execute + sitk.GetArrayFromImage, keep header metadata.
            _pixel_hit = (
                _is_nninter_interaction
                and seriesInstanceUID == self._session_image["seriesInstanceUID"]
                and self._session_image["img_np"] is not None
            )

            if _pixel_hit:
                logger.info("img_np pixel-cache hit (path UID changed) — skipping reader.Execute")
            else:
                if _is_nninter_interaction:
                    cached_uid = self._session_image["seriesInstanceUID"]
                    if cached_uid != seriesInstanceUID:
                        logger.info(f"img_np cache MISS — UID mismatch: cached={cached_uid!r} incoming={seriesInstanceUID!r}")
                    elif self._session_image["img_np"] is None:
                        logger.info("img_np cache MISS — not yet initialised")
                reader.SetFileNames(dicom_filenames)
                img = reader.Execute()
        

        before_nnInter = time.time()
        logger.info(f"Before nnInter: {before_nnInter-begin} secs")
        if nnInter:
            start = time.time()
            nninter_core_elapsed = 0.0          # time inside add_*_interaction calls only
            nninter_first_interaction_ts = None  # wall-clock of first interaction
            prompt_prep_elapsed = 0.0           # lasso/scribble mask building (CPU, excludes model calls)

            if _img_np_hit or _pixel_hit:
                img_np = self._session_image["img_np"]
                img_convert_elapsed = 0.0
            else:
                _t_conv = time.time()
                img_np = sitk.GetArrayFromImage(img)[None]
                img_convert_elapsed = time.time() - _t_conv
            # Validate input dimensions
            if img_np.ndim != 4:
                raise ValueError("Input image must be 4D with shape (1, x, y, z)")
            
            if nnInter == "init":
                if seriesInstanceUID is not None and self._session_image["seriesInstanceUID"] != seriesInstanceUID:
                    self._session_image["dicom_dir"]       = dicom_dir
                    self._session_image["seriesInstanceUID"] = seriesInstanceUID
                    self._session_image["img_np"]          = img_np
                    self._session_image["instanceNumber"]  = instanceNumber
                    self._session_image["instanceNumber2"] = instanceNumber2
                    try:
                        logger.info("Only first time, no image at nnInter or image changed")
                        session.set_image(img_np)
                        session.set_target_buffer(torch.zeros(img_np.shape[1:], dtype=torch.uint8))
                    except Exception as init_error:
                        logger.error(f"Failed to initialize session: {init_error}")
                        logger.info("Prefer fail!!")
                elif self._session_image["img_np"] is None:
                    # Same series but cache was cleared; repopulate
                    self._session_image["dicom_dir"]       = dicom_dir
                    self._session_image["img_np"]          = img_np
                    self._session_image["instanceNumber"]  = instanceNumber
                    self._session_image["instanceNumber2"] = instanceNumber2
                for key, lst in self._session_used_interactions.items():
                    lst.clear()
                session.reset_interactions()
                return f'/code/predictions/init.nii.gz', final_result_json

            logger.info(f"interactions in _session_used_interactions: {self._session_used_interactions}")

            if nnInter in (
                "medGemma",
                "gemini",
                "openai",
                "claude",
                "kimi",
                "qwen",
                "gemma",
                "vllm",
            ):
                if len(data['texts'])==1 and data['texts'][0]!='' and data['texts'][0]!={}:
                    hf_token = (
                        _resolve_hf_token(data)
                        if nnInter in ("kimi", "qwen", "gemma")
                        else None
                    )
                    img_np = img_np[0]
                    query, instruction, slice_indices, normalized_img_list = (
                        _vlm_prepare_medical_slices(
                            data,
                            img_np,
                            modality_type,
                            contrast_center,
                            contrast_window,
                            instanceNumber,
                            instanceNumber2,
                        )
                    )
                    logger.info(f"normalized_img_list count: {len(normalized_img_list)}")

                    if nnInter == "medGemma":
                        model_id = _medgemma_resolve_hf_model_id(data)
                        gem_processor, gem_model = _medgemma_get_processor_and_model(model_id)
                        is_thinking = _infer_request_bool(
                            data.get("medgemma_thinking_enabled", False),
                            default=False,
                        )
                        user_content = _vlm_medgemma_content_from_slices(instruction, slice_indices, normalized_img_list, query)
                        if is_thinking:
                            system_instruction = "SYSTEM INSTRUCTION: think silently if needed. "
                            max_new_tokens = 5000
                            messages = [
                            {
                                "role": "system",
                                "content": [{"type": "text", "text": system_instruction}],
                            },
                            {"role": "user", "content": user_content},
                        ]
                        else:
                            max_new_tokens = 2000
                            messages = [
                            {"role": "user", "content": user_content},
                        ]
                        
                        
                        inputs = gem_processor.apply_chat_template(
                            messages,
                            add_generation_prompt=True,
                            continue_final_message=False,
                            return_tensors="pt",
                            tokenize=True,
                            return_dict=True,
                        )
                        with torch.inference_mode():
                            inputs = inputs.to(gem_model.device, dtype=torch.bfloat16)
                            generated_sequence = gem_model.generate(
                                **inputs,
                                do_sample=is_thinking,
                                max_new_tokens=max_new_tokens,
                            )
                        medgemma_response = gem_processor.post_process_image_text_to_text(
                            generated_sequence, skip_special_tokens=True
                        )
                        decoded_inputs = gem_processor.post_process_image_text_to_text(
                            inputs["input_ids"], skip_special_tokens=True
                        )
                        medgemma_response = medgemma_response[0]
                        index_input_text = medgemma_response.find(decoded_inputs[0])
                        if 0 <= index_input_text and index_input_text <= 2:
                            medgemma_response = medgemma_response[
                                index_input_text + len(decoded_inputs[0]) :
                            ]
                        logger.info(
                            "MedGemma model=%s thinking=%s max_new_tokens=%s",
                            model_id,
                            is_thinking,
                            max_new_tokens,
                        )
                        logger.info(f"MedGemma Generated text: {medgemma_response}")
                        return medgemma_response, final_result_json

                    if nnInter == "gemini":
                        try:
                            from google import genai
                        except ImportError as err:
                            raise MONAILabelError(
                                "Gemini VLM requires the google-genai package: pip install google-genai"
                            ) from err
                        api_key = (
                            data.get("gemini_api_key")
                            or os.environ.get("GEMINI_API_KEY")
                            or ""
                        ).strip()
                        if not api_key:
                            raise MONAILabelError(
                                "Gemini API key missing: pass gemini_api_key in the infer request "
                                "or set GEMINI_API_KEY in the environment."
                            )
                        client = genai.Client(api_key=api_key)
                        contents = _vlm_gemini_contents_from_medgemma_encoding(
                            instruction, slice_indices, normalized_img_list, query
                        )
                        model_name = data.get(
                            "gemini_model", "gemini-3-flash-preview"
                        )
                        gemini_cfg = _gemini_generate_content_config(data)
                        _kw: Dict[str, Any] = {
                            "model": model_name,
                            "contents": contents,
                        }
                        if gemini_cfg is not None:
                            _kw["config"] = gemini_cfg
                        response = client.models.generate_content(**_kw)
                        medgemma_response = response.text
                        logger.info(f"Gemini generated text: {medgemma_response}")
                        return medgemma_response, final_result_json

                    if nnInter == "openai":
                        try:
                            from openai import OpenAI
                        except ImportError as err:
                            raise MONAILabelError(
                                "OpenAI VLM requires the openai package: pip install openai"
                            ) from err
                        api_key = (
                            data.get("openai_api_key")
                            or os.environ.get("OPENAI_API_KEY")
                            or ""
                        ).strip()
                        if not api_key:
                            raise MONAILabelError(
                                "OpenAI API key missing: pass openai_api_key in the infer request "
                                "or set OPENAI_API_KEY in the environment."
                            )
                        oa_content = _vlm_openai_responses_content(
                            instruction, slice_indices, normalized_img_list, query
                        )
                        client = OpenAI(api_key=api_key)
                        model_name = data.get("openai_model", "gpt-5.4")
                        raw_effort = data.get("openai_reasoning_effort")
                        if raw_effort is None or (
                            isinstance(raw_effort, str) and raw_effort.strip() == ""
                        ):
                            oa_effort = "none"
                        else:
                            oa_effort = str(raw_effort).strip()
                        logger.info(
                            f"OpenAI Responses API model={model_name} reasoning.effort={oa_effort}"
                        )
                        response = client.responses.create(
                            model=model_name,
                            input=[{"role": "user", "content": oa_content}],
                            reasoning={"effort": oa_effort},
                        )
                        medgemma_response = response.output_text
                        logger.info(f"OpenAI generated text: {medgemma_response}")
                        return medgemma_response, final_result_json

                    if nnInter == "claude":
                        try:
                            from anthropic import Anthropic
                        except ImportError as err:
                            raise MONAILabelError(
                                "Claude VLM requires the anthropic package: pip install anthropic"
                            ) from err
                        api_key = (
                            data.get("anthropic_api_key")
                            or os.environ.get("ANTHROPIC_API_KEY")
                            or ""
                        ).strip()
                        if not api_key:
                            raise MONAILabelError(
                                "Anthropic API key missing: pass anthropic_api_key in the infer "
                                "request or set ANTHROPIC_API_KEY in the environment."
                            )
                        claude_content = _vlm_anthropic_messages_content(
                            instruction, slice_indices, normalized_img_list, query
                        )
                        model_name = data.get(
                            "claude_model", "claude-sonnet-4-20250514"
                        )
                        client = Anthropic(api_key=api_key, timeout=1200.0)
                        _cc_kw: Dict[str, Any] = {
                            "model": model_name,
                            "max_tokens": _CLAUDE_DEFAULT_MAX_TOKENS,
                            "messages": [{"role": "user", "content": claude_content}],
                        }
                        _cc_kw.update(_claude_messages_create_extra_kwargs(data))
                        message = client.messages.create(**_cc_kw)
                        medgemma_response = _anthropic_assistant_text(message)
                        logger.info(f"Claude generated text: {medgemma_response}")
                        return medgemma_response, final_result_json

                    if nnInter == "kimi":
                        try:
                            from openai import OpenAI
                        except ImportError as err:
                            raise MONAILabelError(
                                "Kimi (HF router) requires the openai package: pip install openai"
                            ) from err
                        if not hf_token:
                            raise MONAILabelError(
                                "Hugging Face token missing: pass huggingface_token in the infer "
                                "request or set HF_TOKEN / HUGGINGFACE_HUB_TOKEN."
                            )
                        kimi_content = _vlm_kimi_hf_chat_content(
                            instruction, slice_indices, normalized_img_list, query
                        )
                        model_name = data.get(
                            "kimi_model", "moonshotai/Kimi-K2.5:novita"
                        )
                        client = OpenAI(
                            base_url="https://router.huggingface.co/v1",
                            api_key=hf_token,
                            timeout=None,
                        )
                        create_kwargs: Dict[str, Any] = {
                            "model": model_name,
                            "messages": [{"role": "user", "content": kimi_content}],
                            "max_tokens": _KIMI_DEFAULT_MAX_TOKENS,
                        }
                        kimi_eb = _kimi_optional_extra_body(data)
                        if kimi_eb is not None:
                            create_kwargs["extra_body"] = kimi_eb
                        logger.info(
                            f"Kimi HF router model={model_name} extra_body="
                            f"{'set' if kimi_eb is not None else 'none'}"
                        )
                        completion = client.chat.completions.create(**create_kwargs)
                        medgemma_response = (
                            completion.choices[0].message.content or ""
                        )
                        logger.info(f"Kimi generated text: {medgemma_response}")
                        return medgemma_response, final_result_json

                    if nnInter == "qwen":
                        try:
                            from openai import OpenAI
                        except ImportError as err:
                            raise MONAILabelError(
                                "Qwen (HF router) requires the openai package: pip install openai"
                            ) from err
                        if not hf_token:
                            raise MONAILabelError(
                                "Hugging Face token missing: pass huggingface_token or set "
                                "HF_TOKEN / HUGGINGFACE_HUB_TOKEN."
                            )
                        qwen_content = _vlm_qwen_hf_chat_content(
                            instruction, slice_indices, normalized_img_list, query
                        )
                        model_name = data.get(
                            "qwen_model", "Qwen/Qwen3.5-397B-A17B:novita"
                        )
                        client = OpenAI(
                            base_url="https://router.huggingface.co/v1",
                            api_key=hf_token,
                            timeout=None,
                        )
                        qwen_max = _qwen_effective_max_tokens(data)
                        qwen_extra = _qwen_hf_router_extra_body(data)
                        sampling = _qwen_hf_router_sampling_kwargs(data)
                        create_kwargs: Dict[str, Any] = {
                            "model": model_name,
                            "messages": [{"role": "user", "content": qwen_content}],
                            "stream": True,
                            "max_tokens": qwen_max,
                            **sampling,
                            "extra_body": qwen_extra,
                        }
                        logger.info(
                            f"Qwen HF router streaming model={model_name} max_tokens={qwen_max}"
                        )
                        stream = client.chat.completions.create(**create_kwargs)
                        medgemma_response = _qwen_stream_collect_text(stream)
                        logger.info(
                            f"Qwen streamed response length={len(medgemma_response)} chars"
                        )
                        return medgemma_response, final_result_json

                    if nnInter == "gemma":
                        try:
                            from openai import OpenAI
                        except ImportError as err:
                            raise MONAILabelError(
                                "Gemma (HF router) requires the openai package: pip install openai"
                            ) from err
                        if not hf_token:
                            raise MONAILabelError(
                                "Hugging Face token missing: pass huggingface_token or set "
                                "HF_TOKEN / HUGGINGFACE_HUB_TOKEN."
                            )
                        gemma_content = _vlm_qwen_hf_chat_content(
                            instruction, slice_indices, normalized_img_list, query
                        )
                        model_name = data.get(
                            "gemma_model", "google/gemma-4-31B-it:novita"
                        )
                        client = OpenAI(
                            base_url="https://router.huggingface.co/v1",
                            api_key=hf_token,
                            timeout=None,
                        )
                        gemma_max = _gemma_hf_effective_max_tokens(data)
                        gemma_extra = _gemma_hf_router_extra_body(data)
                        sampling = _gemma_hf_router_sampling_kwargs(data)
                        create_kwargs: Dict[str, Any] = {
                            "model": model_name,
                            "messages": [{"role": "user", "content": gemma_content}],
                            "max_tokens": gemma_max,
                            **sampling,
                            "extra_body": gemma_extra,
                        }
                        logger.info(
                            f"Gemma HF router model={model_name} max_tokens={gemma_max} "
                            f"extra_body={'set' if gemma_extra else 'none'}"
                        )
                        completion = client.chat.completions.create(**create_kwargs)
                        medgemma_response = (
                            completion.choices[0].message.content or ""
                        )
                        logger.info(
                            f"Gemma generated text length={len(medgemma_response)} chars"
                        )
                        return medgemma_response, final_result_json

                    if nnInter == "vllm":
                        try:
                            from openai import APIConnectionError, OpenAI
                        except ImportError as err:
                            raise MONAILabelError(
                                "vLLM requires the openai package: pip install openai"
                            ) from err
                        # Default reaches the Docker *host* from inside a container (see docker-compose
                        # extra_hosts). 0.0.0.0/127.0.0.1 here would be the container itself, not vLLM on host.
                        _vllm_default_base = (
                            "http://host.docker.internal:8000/v1"
                        )
                        base_url = (
                            data.get("vllm_base_url")
                            or os.environ.get("INTERNVL_VLLM_BASE_URL")
                            or os.environ.get("VLLM_BASE_URL")
                            or _vllm_default_base
                        )
                        base_url = str(base_url).strip() or _vllm_default_base
                        client = OpenAI(api_key="", base_url=base_url, timeout=None)
                        try:
                            listed = getattr(client.models.list(), "data", None) or []
                            if not listed:
                                raise MONAILabelError(
                                    "vLLM: no models returned from the server; check vllm_base_url "
                                    "and that the OpenAI-compatible API is running."
                                )
                            default_id = listed[0].id
                            fam_ov = (str(data.get("vllm_family") or "")).strip().lower()
                            family = _vllm_resolve_family(default_id, fam_ov)
                            model_name = default_id
                            level = _vllm_thinking_level(data)
                            user_blocks = _vlm_kimi_hf_chat_content(
                                instruction, slice_indices, normalized_img_list, query
                            )
                            messages = _vllm_openai_messages(family, level, user_blocks)
                            api_eb = _vllm_extra_body_for_create(family, level, data)
                            try:
                                mt = int(data.get("vllm_max_tokens") or 8192)
                            except (TypeError, ValueError):
                                mt = 8192
                            create_kw: Dict[str, Any] = {
                                "model": model_name,
                                "messages": messages,
                                "max_tokens": max(1, mt),
                            }
                            create_kw.update(
                                _vllm_sampling_kwargs_create(family, level, data)
                            )
                            if api_eb:
                                create_kw["extra_body"] = api_eb
                            logger.info(
                                f"vLLM chat base_url={base_url} model={model_name} family={family} "
                                f"thinking_level={level} extra_body="
                                f"{'set' if create_kw.get('extra_body') else 'none'}"
                            )
                            completion = client.chat.completions.create(**create_kw)
                            medgemma_response = (
                                completion.choices[0].message.content or ""
                            )
                            logger.info(
                                f"vLLM generated text length={len(medgemma_response)} chars"
                            )
                            return medgemma_response, final_result_json
                        except APIConnectionError as conn_err:
                            raise MONAILabelError(
                                f"vLLM: cannot connect to OpenAI-compatible API at {base_url!r} "
                                f"({conn_err}). If MONAI runs in Docker and vLLM on the host, use the host "
                                "from inside the container (e.g. http://host.docker.internal:8000/v1 with "
                                "compose extra_hosts, or http://172.17.0.1:8000/v1 on Linux bridge), not "
                                "0.0.0.0 or 127.0.0.1. Set vllm_base_url or VLLM_BASE_URL."
                            ) from conn_err

            if len(data['texts'])==1 and data['texts'][0]!='' and data['texts'][0]!={}:
                orig_orient = sitk.DICOMOrientImageFilter_GetOrientationFromDirectionCosines(
                    img.GetDirection()
                )
                logger.info(f"Original orientation: {orig_orient}")
                img_ras = sitk.DICOMOrient(img, "RAS")
                img_np = sitk.GetArrayFromImage(img_ras)[None]
                voxtell_seg_np_ras = vox_predictor.predict_single_image(img_np, data['texts'][0])

                voxtell_seg_sitk_ras = sitk.GetImageFromArray(voxtell_seg_np_ras[0])
                voxtell_seg_sitk_ras.CopyInformation(img_ras)

                voxtell_seg_sitk = sitk.DICOMOrient(voxtell_seg_sitk_ras, orig_orient)
                voxtell_seg_np = sitk.GetArrayFromImage(voxtell_seg_sitk)


                voxtell_elapsed = time.time() - start
                logger.info(f"voxtell latency : {voxtell_elapsed} (sec)")
                # final_result_json["dicom_seg"] = raw
                final_result_json["prompt_info"] = result_json
                final_result_json["voxtell_elapsed"] = voxtell_elapsed

                if instanceNumber > instanceNumber2:
                    final_result_json["flipped"] = True
                else:
                    final_result_json["flipped"] = False

                timestamp = datetime.now().strftime("%Y%m%d%H%M%S")
                final_result_json["label_name"] = data['texts'][0]

                logger.info(f"final_result_json info: {final_result_json}")

                return voxtell_seg_np, final_result_json

            def _safe_interaction(perform_callable):
                nonlocal nninter_core_elapsed, nninter_first_interaction_ts
                try:
                    if session.original_image_shape is None or session.preprocessed_image is None:
                        # Edge cases: a) a lot of requests are pending, while changing layouts b) without proper image initialization
                        # For these cases, if possible, directly update the iamge and target buffer on the fly.
                        # If that's not possible, shutdown the executor and assign new one.
                        logger.info(f"Check queue size: {session.executor._work_queue.qsize()}")
                        logger.info("Set image and target buffer before interaction")
                        if seriesInstanceUID is not None and self._session_image["seriesInstanceUID"] != seriesInstanceUID:
                            logger.info("Series Instance UID changed -> update")
                            self._session_image["seriesInstanceUID"] = seriesInstanceUID
                        if session.executor._work_queue.qsize() == 0 and session.preprocess_future is None:
                            session.set_image(img_np)
                            session.set_target_buffer(torch.zeros(img_np.shape[1:], dtype=torch.uint8))

                        # Wait until session.preprocessed_image is not None
                        max_wait_time = 5.0  # Maximum wait time in seconds
                        wait_interval = 0.1   # Check every 100ms
                        waited_time = 0.0

                        while session.preprocessed_image is None and waited_time < max_wait_time:
                            time.sleep(wait_interval)
                            waited_time += wait_interval

                        if session.preprocessed_image is None:
                            logger.warning(f"Session preprocessed_image still None after {max_wait_time}s wait")
                            logger.info(f"Check queue size: {session.executor._work_queue.qsize()}")
                            logger.warning("Shutdown executor and assign again")
                            session.executor.shutdown(wait=False, cancel_futures=True)
                            session.executor = ThreadPoolExecutor(max_workers=2)
                            session._reset_session()
                            logger.info(f"Check queue size: {session.executor._work_queue.qsize()}")
                            return False
                        else:
                            logger.info(f"Session preprocessed_image ready after {waited_time:.2f}s")
                    logger.info(f"Check queue size: {session.executor._work_queue.qsize()}")
                    t_before = time.time()
                    if nninter_first_interaction_ts is None:
                        nninter_first_interaction_ts = t_before
                    with timeout_context(seconds=100):
                        perform_callable()
                    nninter_core_elapsed += time.time() - t_before
                    return True
                except Exception as e:
                    logger.error(f"Error during interaction: {e}")
                    logger.error(f"Full traceback: {traceback.format_exc()}")
                    try:
                        logger.info(f"Check queue size: {session.executor._work_queue.qsize()}")
                        logger.warning("Shutdown executor and assign again")
                        session.executor.shutdown(wait=False, cancel_futures=True)
                        session.executor = ThreadPoolExecutor(max_workers=2)
                        session._reset_session()
                    except Exception as reset_error:
                        logger.error(f"Failed to reset session: {reset_error}")
                    return False
            
            if len(data['pos_points'])!=0:
                result_json["pos_points"]=copy.deepcopy(data["pos_points"])
                
                for point in data['pos_points']:
                    if not self.is_prompt_used(point, "pos_points"):
                        self.add_prompt(point, "pos_points")
                        if instanceNumber > instanceNumber2:
                            point[2]=img_np.shape[1]-1-point[2]
                        if not _safe_interaction(lambda: session.add_point_interaction(tuple(point[::-1]), include_interaction=True)):
                            return f'/code/predictions/reset.nii.gz', final_result_json
                        logger.info("Add pos points")
                                
            if len(data['neg_points'])!=0:
                result_json["neg_points"]=copy.deepcopy(data["neg_points"])
                
                for point in data['neg_points']:
                    if not self.is_prompt_used(point, "neg_points"):
                        self.add_prompt(point, "neg_points")
                        if instanceNumber > instanceNumber2:
                            point[2]=img_np.shape[1]-1-point[2]
                        if not _safe_interaction(lambda: session.add_point_interaction(tuple(point[::-1]), include_interaction=False)):
                            return f'/code/predictions/reset.nii.gz', final_result_json
                        logger.info("Add neg points")

            if len(data['pos_boxes'])!=0:
                result_json["pos_boxes"]=copy.deepcopy(data["pos_boxes"])
                
                for box in data['pos_boxes']:
                    if not self.is_prompt_used(box, "pos_boxes"):
                        self.add_prompt(box, "pos_boxes")
                        if instanceNumber > instanceNumber2:
                            box[0][2]=img_np.shape[1]-1-box[0][2]
                            box[1][2]=img_np.shape[1]-1-box[1][2]
                        box[0]=box[0][::-1]
                        box[1]=box[1][::-1]
                        bbox = [
                            [min(box[0][i], box[1][i]), max(box[0][i], box[1][i]) + 1]
                            for i in range(3)
                        ]
                        if not _safe_interaction(lambda b=bbox: session.add_bbox_interaction(
                            b,
                            include_interaction=True
                        )):
                            return f'/code/predictions/reset.nii.gz', final_result_json
                        logger.info("Add a box")            

            if len(data['neg_boxes'])!=0:
                result_json["neg_boxes"]=copy.deepcopy(data["neg_boxes"])
                
                for box in data['neg_boxes']:
                    if not self.is_prompt_used(box, "neg_boxes"):
                        self.add_prompt(box, "neg_boxes")
                        if instanceNumber > instanceNumber2:
                            box[0][2]=img_np.shape[1]-1-box[0][2]
                            box[1][2]=img_np.shape[1]-1-box[1][2]
                        box[0]=box[0][::-1]
                        box[1]=box[1][::-1]
                        bbox = [
                            [min(box[0][i], box[1][i]), max(box[0][i], box[1][i]) + 1]
                            for i in range(3)
                        ]
                        if not _safe_interaction(lambda b=bbox: session.add_bbox_interaction(
                            b,
                            include_interaction=False
                        )):
                            return f'/code/predictions/reset.nii.gz', final_result_json
                        logger.info("Add a box")            


            if len(data['pos_lassos'])!=0:
                result_json["pos_lassos"]=copy.deepcopy(data["pos_lassos"])

                for lasso_raw in data['pos_lassos']:
                    if not self.is_prompt_used(lasso_raw, "pos_lassos"):
                        self.add_prompt(lasso_raw, "pos_lassos")
                        _t_prep = time.time()
                        perim = clean_and_densify_polyline(lasso_raw)
                        perim_arr = np.round(np.asarray(perim)).astype(int)
                        if instanceNumber > instanceNumber2:
                            perim_arr[:, 2] = img_np.shape[1] - 1 - perim_arr[:, 2]
                        lasso_image, interaction_bbox = prepare_lasso_interaction_payload(img_np.shape[1:], perim_arr)
                        prompt_prep_elapsed += time.time() - _t_prep
                        if lasso_image is None:
                            continue
                        if not _safe_interaction(
                            lambda img=lasso_image, bbox=interaction_bbox: session.add_lasso_interaction(
                                img, include_interaction=True, interaction_bbox=bbox
                            )
                        ):
                            return f'/code/predictions/reset.nii.gz', final_result_json
                        logger.info("Add a lasso")

            if len(data['neg_lassos'])!=0:
                result_json["neg_lassos"]=copy.deepcopy(data["neg_lassos"])

                for lasso_raw in data['neg_lassos']:
                    if not self.is_prompt_used(lasso_raw, "neg_lassos"):
                        self.add_prompt(lasso_raw, "neg_lassos")
                        _t_prep = time.time()
                        perim = clean_and_densify_polyline(lasso_raw)
                        perim_arr = np.round(np.asarray(perim)).astype(int)
                        if instanceNumber > instanceNumber2:
                            perim_arr[:, 2] = img_np.shape[1] - 1 - perim_arr[:, 2]
                        lasso_image, interaction_bbox = prepare_lasso_interaction_payload(img_np.shape[1:], perim_arr)
                        prompt_prep_elapsed += time.time() - _t_prep
                        if lasso_image is None:
                            continue
                        if not _safe_interaction(
                            lambda img=lasso_image, bbox=interaction_bbox: session.add_lasso_interaction(
                                img, include_interaction=False, interaction_bbox=bbox
                            )
                        ):
                            return f'/code/predictions/reset.nii.gz', final_result_json
                        logger.info("Add a lasso")
            
            if len(data['pos_scribbles'])!=0:
                result_json["pos_scribbles"]=copy.deepcopy(data["pos_scribbles"])

                for scribble in data['pos_scribbles']:
                    if not self.is_prompt_used(scribble, "pos_scribbles"):
                        self.add_prompt(scribble, "pos_scribbles")
                        _t_prep = time.time()
                        scribble = clean_and_densify_polyline(scribble)
                        filled_indices = np.round(np.asarray(scribble)).astype(int)
                        if filled_indices.size == 0:
                            continue
                        if instanceNumber > instanceNumber2:
                            filled_indices[:, 2] = img_np.shape[1] - 1 - filled_indices[:, 2]
                        flat_axis = scribble_constant_axis(filled_indices)
                        if flat_axis is not None:
                            logger.info(f"2D scribble on axis {flat_axis}")
                        scribble_image, interaction_bbox = prepare_scribble_interaction_payload(
                            img_np.shape[1:], filled_indices, flat_axis
                        )
                        prompt_prep_elapsed += time.time() - _t_prep
                        scribble_start = time.time()
                        if interaction_bbox is not None:
                            if not _safe_interaction(
                                lambda img=scribble_image, bbox=interaction_bbox: session.add_scribble_interaction(
                                    scribble_image=img, include_interaction=True, interaction_bbox=bbox
                                )
                            ):
                                return f'/code/predictions/reset.nii.gz', final_result_json
                        elif not _safe_interaction(
                            lambda img=scribble_image: session.add_scribble_interaction(
                                scribble_image=img, include_interaction=True
                            )
                        ):
                            return f'/code/predictions/reset.nii.gz', final_result_json
                        logger.info(f"only for add scribble: {time.time()-scribble_start} secs")
                        logger.info(f"just after add scribble: {time.time()-start} secs")
                        logger.info("Add a scribble")

            if len(data['neg_scribbles'])!=0:
                result_json["neg_scribbles"]=copy.deepcopy(data["neg_scribbles"])

                for scribble in data['neg_scribbles']:
                    if not self.is_prompt_used(scribble, "neg_scribbles"):
                        self.add_prompt(scribble, "neg_scribbles")
                        _t_prep = time.time()
                        scribble = clean_and_densify_polyline(scribble)
                        filled_indices = np.round(np.asarray(scribble)).astype(int)
                        if filled_indices.size == 0:
                            continue
                        if instanceNumber > instanceNumber2:
                            filled_indices[:, 2] = img_np.shape[1] - 1 - filled_indices[:, 2]
                        flat_axis = scribble_constant_axis(filled_indices)
                        if flat_axis is not None:
                            logger.info(f"2D scribble on axis {flat_axis}")
                        scribble_image, interaction_bbox = prepare_scribble_interaction_payload(
                            img_np.shape[1:], filled_indices, flat_axis
                        )
                        prompt_prep_elapsed += time.time() - _t_prep
                        if interaction_bbox is not None:
                            if not _safe_interaction(
                                lambda img=scribble_image, bbox=interaction_bbox: session.add_scribble_interaction(
                                    scribble_image=img, include_interaction=False, interaction_bbox=bbox
                                )
                            ):
                                return f'/code/predictions/reset.nii.gz', final_result_json
                        elif not _safe_interaction(
                            lambda img=scribble_image: session.add_scribble_interaction(
                                scribble_image=img, include_interaction=False
                            )
                        ):
                            return f'/code/predictions/reset.nii.gz', final_result_json
                        logger.info("Add a scribble")

            # --- Retrieve Results ---
            _t_result = time.time()
            results = session.target_buffer.clone()
            pred = results.numpy()  # shape (Z, Y, X), dtype uint8

            # Crop to tight non-zero bbox before sending.
            # Reduces wire bytes and compression time proportionally to segmentation size.
            # Client reconstructs full volume using pred_offset + pred_full_shape from meta.
            pred_full_shape = list(pred.shape)
            # np.any along axes is ~10x faster than np.nonzero on large sparse arrays
            # because it short-circuits and reduces 182M elements to three 1-D projections.
            z_any = np.any(pred, axis=(1, 2))
            z_nz  = np.where(z_any)[0]
            if z_nz.size > 0:
                y_nz = np.where(np.any(pred, axis=(0, 2)))[0]
                x_nz = np.where(np.any(pred, axis=(0, 1)))[0]
                z0, z1 = int(z_nz[0]),  int(z_nz[-1])  + 1
                y0, y1 = int(y_nz[0]),  int(y_nz[-1])  + 1
                x0, x1 = int(x_nz[0]),  int(x_nz[-1])  + 1
                pred = pred[z0:z1, y0:y1, x0:x1]
                pred_offset = [z0, y0, x0]
            else:
                pred_offset = [0, 0, 0]
            result_elapsed = time.time() - _t_result

            

            #pred_itk = sitk.GetImageFromArray(pred)
            #pred_itk.CopyInformation(img)
            #pred_itk = sitk.Cast(pred_itk, sitk.sitkUInt8)
            #sitk.WriteImage(pred_itk, f'/code/predictions/nninter_{image_series_desc}.nii.gz')
            nninter_elapsed = time.time() - start
            server_load_elapsed = before_nnInter - begin

            logger.info(
                f"[timing] load={server_load_elapsed:.3f}s  img_convert={img_convert_elapsed:.3f}s  "
                f"prompt_prep={prompt_prep_elapsed:.3f}s  model_core={nninter_core_elapsed:.3f}s  "
                f"result_retrieve={result_elapsed:.3f}s  total_nninter={nninter_elapsed:.3f}s"
            )

            final_result_json["prompt_info"] = result_json
            # --- round-trip timing breakdown ---
            final_result_json["server_begin_ts"] = server_begin_ts          # Unix ts; client computes network-to-server latency
            final_result_json["server_load_elapsed"] = server_load_elapsed  # DICOM read + sitk.Execute
            final_result_json["server_img_convert_elapsed"] = img_convert_elapsed  # sitk → numpy
            final_result_json["server_prompt_prep_elapsed"] = prompt_prep_elapsed  # lasso/scribble mask build
            final_result_json["nninter_core_elapsed"] = nninter_core_elapsed       # GPU add_*_interaction
            final_result_json["server_result_elapsed"] = result_elapsed            # target_buffer → numpy + bbox crop
            final_result_json["nninter_elapsed"] = nninter_elapsed                 # total nnInter block
            final_result_json["pred_offset"] = pred_offset            # [z0, y0, x0] of cropped region in full volume
            final_result_json["pred_full_shape"] = pred_full_shape  # [Z, Y, X] of full volume (before crop)
            final_result_json["pred_crop_shape"] = list(pred.shape) # [cropZ, cropY, cropX] of what is actually sent
            final_result_json["nninter_first_interaction_ts"] = nninter_first_interaction_ts
            final_result_json["server_end_ts"] = time.time()  # wall-clock just before serialization; client uses this to isolate server→client network latency

            if instanceNumber > instanceNumber2:
                final_result_json["flipped"] = True
            else:
                final_result_json["flipped"] = False

            timestamp = datetime.now().strftime("%Y%m%d%H%M%S")
            final_result_json["label_name"] = f"nninter_pred_{timestamp}"

            logger.info(f"final_result_json info: {final_result_json}")
            logger.info(f"just before pred and return: {time.time()-start} secs")
            # result_json contains prompt information
            #f'/code/predictions/nninter_{image_series_desc}.nii.gz'
            return pred, final_result_json

        #SAM2
        if nnInter == False:
            medsam2 = data['medsam2']
            if medsam2 == 'medsam2':
                predictor = predictor_med
            elif medsam2 == 'sam3':
                if predictor_sam3 is None:
                    logger.error(f"SAM3 model not available. Checkpoint not found at {sam3_checkpoint}.")
                    return f"/code/predictions/sam3_not_found.nii.gz", final_result_json
                else:
                    predictor = predictor_sam3
            else:
                predictor = predictor_sam2
            start = time.time()
            #result_json["pos_points"]=data["pos_points"]
            result_json["pos_points"] = copy.deepcopy(data["pos_points"]) if data["pos_points"] else []
            result_json["neg_points"] = copy.deepcopy(data["neg_points"]) if data["neg_points"] else []
            result_json["pos_boxes"] = copy.deepcopy(data["pos_boxes"]) if data["pos_boxes"] else []
            
            len_z = img.GetSize()[2]
            len_y = img.GetSize()[1]
            len_x = img.GetSize()[0]
            logger.info(f"len Z Y X: {len_z}, {len_y}, {len_x}")
            
            file_name = data['image'].split('/')[-1]
            frame_names = []
            for i in range(len_z):
                frame_names.append(f"{file_name}_{i}")
            dicom_dir = data['image'].split('.nii.gz')[0]
            image_files = glob('{}/*'.format(dicom_dir))
            dcm_img_sample = dcmread(image_files[0], stop_before_pixels=True)

            if contrast_window != None and contrast_center !=None:
                # Check for cats and remote controls
                # VERY important: text queries need to be lowercased + end with a dot
                if len(data['texts'])==1 and data['texts'][0]!='' and data['texts'][0]!={}:
                    #model_id = "IDEA-Research/grounding-dino-tiny"
                    #processor = AutoProcessor.from_pretrained(model_id)
                    #model = AutoModelForZeroShotObjectDetection.from_pretrained(model_id).to(device)
                    #logger.info(f"text length: {len(data['texts'])}")

                    text = data["texts"]#]"a organ. a bone. a heart"
                    logger.info(f"text prompt: {text}")

                    img_np_3d = sitk.GetArrayFromImage(img)
                    img_z = img_np_3d.shape[0]
                    img_y = img_np_3d.shape[1]
                    img_x = img_np_3d.shape[2]
                    logger.info(f"len_np Z Y X: {img_z}, {img_y}, {img_x}")
                    logger.info(f"Post point: {result_json['pos_points'][0]}")
                    img_np_2d = img_np_3d[img_z-1-result_json['pos_points'][0][2]]
                    #inputs = torch.from_numpy(img_np_2d)
                    #logger.info(f"tensor shape: {inputs.shape}")
                    img_np_2d = img_np_2d.astype(float)
                    np.clip(img_np_2d, contrast_center-contrast_window/2, contrast_center+contrast_window/2, out=img_np_2d)   
                    img_np_2d = (img_np_2d - (contrast_center-contrast_window/2))/contrast_window * 255
                    img_np_2d = img_np_2d.astype(np.uint8)
                    img_np_2d = np.stack((img_np_2d,) * 3, axis=-1)

                    results = inferencer(img_np_2d, texts=text)

                    image = Image.fromarray(img_np_2d, mode="RGB")
                    image.save("/code/2d_slice.jpeg", format="JPEG")
                    np_bbox = np.array(results['predictions'][0]['bboxes'])
                    imshow_bboxes(img_np_2d, np_bbox[:1,:], show=False, out_file="/code/2d_slice_bbbox.jpeg")
                    #image_url = "http://images.cocodataset.org/val2017/000000039769.jpg"
                    #image = Image.open(requests.get(image_url, stream=True).raw)
                    # Check for cats and remote controls
                    # VERY important: text queries need to be lowercased + end with a dot
                    #text = "a cat. a remote control."
                #    inputs = processor(images=image, text=text, return_tensors="pt").to(device)

                #    logger.info(f"inputs: {inputs}")

                #    with torch.no_grad():
                #        outputs = model(**inputs)


                #    results = processor.post_process_grounded_object_detection(
                #        outputs,
                #        inputs.input_ids,
                #        box_threshold=0.4,
                #        text_threshold=0.3,
                #        target_sizes=[image.size[::-1]]
                #    )
                    logger.info(f"text prompt results: {results}")
                    if len(data['boxes'])==0 and len(results['predictions'][0]['bboxes']) != 0: # From original Grounding SAM DINO group, results[0]['boxes'].numel()
                        int_list = [coord for sublist in results['predictions'][0]['bboxes'] for coord in zip(sublist[::2], sublist[1::2])]#results['predictions'][0]['bboxes'] #.cpu().numpy().astype(int).reshape(-1, 2).tolist()
                        int_list_with_z = [list(pair) + [data['pos_points'][0][2]] for pair in int_list]
                        boxes_text = [int_list_with_z[i:i + 2] for i in range(0, len(int_list_with_z), 2)]
                        logger.info(f"boxes from text: {boxes_text}")
                        data['boxes']=boxes_text[:1]
                with torch.inference_mode(), torch.autocast("cuda", dtype=torch.bfloat16):
                    inference_state = predictor.init_state(video_path=img, clip_low=contrast_center-contrast_window/2, clip_high=contrast_center+contrast_window/2)
            else:    
                with torch.inference_mode(), torch.autocast("cuda", dtype=torch.bfloat16):
                    inference_state = predictor.init_state(video_path=img)
            #predictor.reset_state(inference_state)
            #breakpoint()
            ann_obj_id = 1
            video_segments = {}  # video_segments contains the per-frame segmentation results
            
            ann_frame_list = np.array(list(map(lambda x: x[2], result_json['pos_points'])), dtype=np.int16)
            ann_frame_list_neg = np.array(list(map(lambda x: x[2], result_json['neg_points'])), dtype=np.int16)
            ann_frame_list = np.unique(np.concatenate((ann_frame_list, ann_frame_list_neg)))

            if "pos_boxes" not in result_json:
                result_json["pos_boxes"] = []            
            if len(result_json["pos_boxes"])!=0:
                ann_frame_list_box = np.array(list(map(lambda x: x[2], [x for xs in result_json["pos_boxes"] for x in xs])), dtype=np.int16)
                ann_frame_list = np.unique(np.concatenate((ann_frame_list, ann_frame_list_box)))

            for i in range(len(ann_frame_list)):

                if instanceNumber < instanceNumber2:
                    ann_frame_idx = ann_frame_list[i]
                else:
                    ann_frame_idx = len_z-1-ann_frame_list[i]
            
            #ann_frame_idx = len_z-1-data['pos_points'][0][2]  # the frame index we interact with 
                  # give a unique id to each object we interact with (it can be any integers)
            
            # Let's add a positive click at (x, y) = (210, 350) to get started
            #pos_points = np.array(list(map(lambda x: x[0:2], data['pos_points'])), dtype=np.float32)
                #breakpoint()
                value = ann_frame_list[i]
                logger.info(f"z axis slice: value: {value}")
                pos_points = np.array([i[0:2] for i in result_json['pos_points'] if i[2]==value], dtype=np.int16)
                neg_points = np.array([i[0:2] for i in result_json['neg_points'] if i[2]==value], dtype=np.int16)
                pre_boxes = np.array([i for i in result_json["pos_boxes"] if i[0][2]==value], dtype=np.int16)

                if len(neg_points) >0 and len(pos_points) >0:
                    points = np.concatenate((pos_points, neg_points), axis=0)
                    # for labels, `1` means positive click and `0` means negative click        
                    labels = np.array([1]*len(pos_points) + [0]*len(neg_points), np.int32)
                elif len(pos_points) >0:
                    points = pos_points
                    labels = np.array([1]*len(points), np.int32)
                elif len(neg_points) >0:
                    points = neg_points
                    labels = np.array([0]*len(points), np.int32)
                else:
                    points = np.array([], dtype=np.int16)
                    labels = np.array([], dtype=np.int32)

                if len(pre_boxes)!=0:
                    boxes = pre_boxes[:,:,:-1].reshape(pre_boxes.shape[0],-1)
                    logger.info(f"ann_frame_list: {ann_frame_list}")
                    logger.info(f"ann_frame_idx: {ann_frame_idx}")
                    with torch.inference_mode(), torch.autocast("cuda", dtype=torch.bfloat16):
                        if medsam2 == 'sam3':
                            _, out_obj_ids, _, out_mask_logits = predictor.add_new_points_or_box(
                            inference_state=inference_state,
                            frame_idx=ann_frame_idx,
                            obj_id=ann_obj_id,
                            points=points,
                            labels=labels,
                            box=boxes
                            )
                        else:    
                            _, out_obj_ids, out_mask_logits = predictor.add_new_points_or_box(
                            inference_state=inference_state,
                            frame_idx=ann_frame_idx,
                            obj_id=ann_obj_id,
                            points=points,
                            labels=labels,
                            box=boxes
                            )
                else:
                    with torch.inference_mode(), torch.autocast("cuda", dtype=torch.bfloat16):
                        if medsam2 == 'sam3':
                            _, out_obj_ids, _, out_mask_logits = predictor.add_new_points_or_box(
                            inference_state=inference_state,
                            frame_idx=ann_frame_idx,
                            obj_id=ann_obj_id,
                            points=points,
                            labels=labels,
                            )
                        else:    
                            _, out_obj_ids, out_mask_logits = predictor.add_new_points_or_box(
                            inference_state=inference_state,
                            frame_idx=ann_frame_idx,
                            obj_id=ann_obj_id,
                            points=points,
                            labels=labels,
                            )

                if "one" in data:
                    video_segments[ann_frame_idx] = {
                        out_obj_id: (out_mask_logits[i] > 0.0).cpu().numpy()
                        for i, out_obj_id in enumerate(out_obj_ids)
                    }
            if "one" not in data:
                if medsam2 == 'sam3':
                    with torch.inference_mode(), torch.autocast("cuda", dtype=torch.bfloat16):
                        for out_frame_idx, out_obj_ids, _, out_mask_logits,_ in predictor.propagate_in_video(inference_state, start_frame_idx=0, max_frame_num_to_track=None, reverse=False, propagate_preflight=True):
                            video_segments[out_frame_idx] = {
                                out_obj_id: (out_mask_logits[i] > 0.0).cpu().numpy()
                                for i, out_obj_id in enumerate(out_obj_ids)
                            }
                else:
                    with torch.inference_mode(), torch.autocast("cuda", dtype=torch.bfloat16):
                        for out_frame_idx, out_obj_ids, out_mask_logits in predictor.propagate_in_video(inference_state, start_frame_idx=0, reverse=False):
                            video_segments[out_frame_idx] = {
                                out_obj_id: (out_mask_logits[i] > 0.0).cpu().numpy()
                                for i, out_obj_id in enumerate(out_obj_ids)
                            }

            # Free SAM2 inference state buffers before building the output array
            predictor.reset_state(inference_state)
            del inference_state
            if torch.cuda.is_available():
                torch.cuda.empty_cache()

            pred = np.zeros((len_z, len_y, len_x))

            for i in video_segments.keys():
                pred[i]=video_segments[i][1][0].astype(int)
            #pred_itk = sitk.GetImageFromArray(pred)
            #pred_itk.CopyInformation(img)
            #pred_itk = sitk.Cast(pred_itk, sitk.sitkUInt8)
            #sitk.WriteImage(pred_itk, f'/code/predictions/sam_{image_series_desc}.nii.gz')

            sam_elapsed = time.time() - start
            logger.info(f"sam latency : {sam_elapsed} (sec)")

            final_result_json["prompt_info"] = result_json
            final_result_json["sam_elapsed"] = sam_elapsed
            
            if instanceNumber > instanceNumber2:
                final_result_json["flipped"] = True
            else:
                final_result_json["flipped"] = False

            timestamp = datetime.now().strftime("%Y%m%d%H%M%S")
            if medsam2 == 'medsam2':
                final_result_json["label_name"] = f"medsam2_pred_{timestamp}"
            elif medsam2 == 'sam3':
                final_result_json["label_name"] = f"sam3_pred_{timestamp}"
            else:
                final_result_json["label_name"] = f"sam2_pred_{timestamp}"
            
            logger.info(f"Result json info: {final_result_json}")
            # result_json contains prompt information

            return pred, final_result_json

    def run_pre_transforms(self, data: Dict[str, Any], transforms):
        pre_cache: List[Any] = []
        post_cache: List[Any] = []

        current = pre_cache
        cache_t = None
        for t in transforms:
            if isinstance(t, CacheTransformDatad):
                cache_t = t
                current = post_cache
            else:
                current.append(t)

        if cache_t is not None:

            class LoadFromCache:
                def __call__(self, data):
                    return cache_t.load(data)

            d = run_transforms(data, [LoadFromCache()], log_prefix="PRE", use_compose=False)

            # Failed/Cache-Miss (run everything)
            if d is None:
                return run_transforms(data, transforms, log_prefix="PRE", use_compose=False)
            return run_transforms(d, post_cache, log_prefix="PRE", use_compose=False) if post_cache else d

        return run_transforms(data, transforms, log_prefix="PRE", use_compose=False)

    def run_invert_transforms(self, data: Dict[str, Any], pre_transforms, names):
        if names is None:
            return data

        pre_names = dict()
        transforms = []
        for t in reversed(pre_transforms):
            if hasattr(t, "inverse"):
                pre_names[t.__class__.__name__] = t
                transforms.append(t)

        # Run only selected/given
        if len(names) > 0:
            transforms = [pre_transforms[n if isinstance(n, str) else n.__name__] for n in names]

        d = copy.deepcopy(dict(data))
        d[self.input_key] = data[self.output_label_key]

        d = run_transforms(d, transforms, inverse=True, log_prefix="INV")
        data[self.output_label_key] = d[self.input_key]
        return data

    def run_post_transforms(self, data: Dict[str, Any], transforms):
        return run_transforms(data, transforms, log_prefix="POST")

    def clear_cache(self):
        self._networks.clear()

    def _get_network(self, device, data):
        path = self.get_path()
        logger.info(f"Infer model path: {path}")

        if data and self._config.get("model_filename"):
            model_filename = data.get("model_filename")
            model_filename = model_filename if isinstance(model_filename, str) else model_filename[0]
            user_path = os.path.join(os.path.dirname(self.path[0]), model_filename)
            if user_path and os.path.exists(user_path):
                path = user_path
                logger.info(f"Using <User> provided model_file: {user_path}")
            else:
                logger.info(f"Ignoring <User> provided model_file (not valid): {user_path}")

        if not path and not self.network:
            if self.type == InferType.SCRIBBLES:
                return None

            raise MONAILabelException(
                MONAILabelError.INFERENCE_ERROR,
                f"Model Path ({self.path}) does not exist/valid",
            )

        cached = self._networks.get(device)
        statbuf = os.stat(path) if path else None
        network = None
        if cached:
            if statbuf and statbuf.st_mtime == cached[1]:
                network = cached[0]
            elif statbuf:
                logger.warning(f"Reload model from cache.  Prev ts: {cached[1]}; Current ts: {statbuf.st_mtime}")

        if network is None:
            if self.network:
                network = copy.deepcopy(self.network)
                network.to(torch.device(device))

                if path:
                    checkpoint = torch.load(path, map_location=torch.device(device))
                    model_state_dict = checkpoint.get(self.model_state_dict, checkpoint)

                    if set(self.network.state_dict().keys()) != set(checkpoint.keys()):
                        logger.warning(
                            f"Checkpoint keys don't match network.state_dict()! Items that exist in only one dict"
                            f" but not in the other: {set(self.network.state_dict().keys()) ^ set(checkpoint.keys())}"
                        )
                        logger.warning(
                            "The run will now continue unless load_strict is set to True. "
                            "If loading fails or the network behaves abnormally, please check the loaded weights"
                        )
                    network.load_state_dict(model_state_dict, strict=self.load_strict)
            else:
                network = torch.jit.load(path, map_location=torch.device(device))

            if self.train_mode:
                network.train()
            else:
                network.eval()
            self._networks[device] = (network, statbuf.st_mtime if statbuf else 0)

        return network

    def run_inferer(self, data: Dict[str, Any], convert_to_batch=True, device="cuda"):
        """
        Run Inferer over pre-processed Data.  Derive this logic to customize the normal behavior.
        In some cases, you want to implement your own for running chained inferers over pre-processed data

        :param data: pre-processed data
        :param convert_to_batch: convert input to batched input
        :param device: device type run load the model and run inferer
        :return: updated data with output_key stored that will be used for post-processing
        """

        inferer = self.inferer(data)
        logger.info(f"Inferer:: {device} => {inferer.__class__.__name__} => {inferer.__dict__}")

        network = self._get_network(device, data)
        if network:
            inputs = data[self.input_key]
            inputs = inputs if torch.is_tensor(inputs) else torch.from_numpy(inputs)
            inputs = inputs[None] if convert_to_batch else inputs
            inputs = inputs.to(torch.device(device))

            with torch.no_grad():
                outputs = inferer(inputs, network)

            if device.startswith("cuda"):
                torch.cuda.empty_cache()

            if convert_to_batch:
                if isinstance(outputs, dict):
                    outputs_d = decollate_batch(outputs)
                    outputs = outputs_d[0]
                else:
                    outputs = outputs[0]

            data[self.output_label_key] = outputs
        else:
            # consider them as callable transforms
            data = run_transforms(data, inferer, log_prefix="INF", log_name="Inferer")
        return data

    def run_detector(self, data: Dict[str, Any], convert_to_batch=True, device="cuda"):
        """
        Run Detector over pre-processed Data.  Derive this logic to customize the normal behavior.
        In some cases, you want to implement your own for running chained inferers over pre-processed data

        :param data: pre-processed data
        :param convert_to_batch: convert input to batched input
        :param device: device type run load the model and run inferer
        :return: updated data with output_key stored that will be used for post-processing
        """

        """
        Run Detector over pre-processed Data.  Derive this logic to customize the normal behavior.
        In some cases, you want to implement your own for running chained detector ops over pre-processed data

        :param data: pre-processed data
        :param device: device type run load the model and run inferer
        :return: updated data with output_key stored that will be used for post-processing
        """
        detector = self.detector(data)
        if detector is None:
            raise ValueError("Detector is Not Provided")

        if hasattr(detector, "inferer"):
            logger.info(
                f"Detector Inferer:: {device} => {detector.inferer.__class__.__name__} => {detector.inferer.__dict__}"  # type: ignore
            )

        network = self._get_network(device, data)
        if network:
            inputs = data[self.input_key]
            inputs = inputs if torch.is_tensor(inputs) else torch.from_numpy(inputs)
            inputs = inputs[None] if convert_to_batch else inputs
            inputs = inputs.to(torch.device(device))

            if hasattr(detector, "network"):
                detector.network = network  # type: ignore
            else:
                logger.warning("Detector has no 'network' attribute defined;  Running without pretrained network")

            with torch.no_grad():
                if callable(getattr(detector, "eval", None)):
                    detector.eval()  # type: ignore
                network.eval()
                outputs = detector(inputs, use_inferer=True)

            if device.startswith("cuda"):
                torch.cuda.empty_cache()

            if convert_to_batch:
                if isinstance(outputs, dict):
                    outputs_d = decollate_batch(outputs)
                    outputs = outputs_d[0]
                else:
                    outputs = outputs[0]

            if isinstance(outputs, dict):
                data.update(outputs)
            else:
                data[self.output_label_key] = outputs
        return data

    def writer(self, data: Dict[str, Any], extension=None, dtype=None) -> Tuple[Any, Any]:
        """
        You can provide your own writer.  However, this writer saves the prediction/label mask to file
        and fetches result json

        :param data: typically it is post processed data
        :param extension: output label extension
        :param dtype: output label dtype
        :return: tuple of output_file and result_json
        """
        logger.info("Writing Result...")
        if extension is not None:
            data["result_extension"] = extension
        if dtype is not None:
            data["result_dtype"] = dtype
        if self.labels is not None:
            data["labels"] = self.labels

        if self.type == InferType.CLASSIFICATION:
            if isinstance(self.labels, dict):
                label_names = {v: k for k, v in self.labels.items()}
            else:
                label_names = {v: k for v, k in enumerate(self.labels)} if isinstance(self.labels, Sequence) else None

            cw = ClassificationWriter(label=self.output_label_key, label_names=label_names)
            return cw(data)

        if self.type == InferType.DETECTION:
            dw = DetectionWriter()
            return dw(data)

        writer = Writer(label=self.output_label_key, json=self.output_json_key)
        return writer(data)

    def clear(self):
        self._networks.clear()

    def set_loglevel(self, level: str):
        logger.setLevel(level.upper())
