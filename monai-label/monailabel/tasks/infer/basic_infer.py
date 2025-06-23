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
import logging
import os
import time
from abc import abstractmethod
from enum import Enum
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple, Union

from glob import glob as glob
import SimpleITK as sitk
import numpy as np

import torch
from monai.data import decollate_batch
from monai.inferers import Inferer, SimpleInferer, SlidingWindowInferer
from monai.utils import deprecated

import pathlib
from pydicom.filereader import dcmread

from monailabel.interfaces.exception import MONAILabelError, MONAILabelException
from monailabel.interfaces.tasks.infer_v2 import InferTask, InferType
from monailabel.interfaces.utils.transform import dump_data, run_transforms
from monailabel.transform.cache import CacheTransformDatad
from monailabel.transform.writer import ClassificationWriter, DetectionWriter, Writer
from monailabel.utils.others.generic import device_list, device_map, name_to_device
from monailabel.utils.others.helper import get_scanline_filled_points_3d, clean_and_densify_polyline
#from sam2.build_sam import build_sam2_video_predictor

#from mmdet.apis import DetInferencer
#from mmdet.evaluation import get_classes
#from mmcv.visualization import imshow_bboxes

import requests
from PIL import Image
#from transformers import AutoProcessor, AutoModelForZeroShotObjectDetection 

#sam2_checkpoint = "/code/checkpoints/sam2_hiera_large.pt"
#model_cfg = "sam2_hiera_l.yaml"

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
from nnInteractive.inference.inference_session import nnInteractiveInferenceSession

session = nnInteractiveInferenceSession(
    device=torch.device("cuda:0"),  # Set inference device
    use_torch_compile=False,  # Experimental: Not tested yet
    verbose=False,
    torch_n_threads=os.cpu_count(),  # Use available CPU cores
    do_autozoom=True,  # Enables AutoZoom for better patching
    use_pinned_memory=True,  # Optimizes GPU memory transfers
)

model_path = os.path.join(DOWNLOAD_DIR, MODEL_NAME)
session.initialize_from_trained_model_folder(model_path)

# Choose to use a config
config_path = '/code/dino_configs/dino.py'
# Setup a checkpoint file to load
checkpoint = '/code/checkpoints/best_coco_bbox_mAP_epoch_11_dilated_b_l_k_curr_teach_7+5.pth'
#checkpoint = '/code/checkpoints/grounding_dino_swin-t_pretrain_obj365_goldg_grit9m_v3det_20231204_095047-b448804b.pth'
# Initialize the DetInferencer
#inferencer = DetInferencer(model=config_path, weights=checkpoint, palette='random')

#predictor = build_sam2_video_predictor(model_cfg, sam2_checkpoint)

logger = logging.getLogger(__name__)


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

        self._session_used_interactions = {
            "pos_points": [],
            "neg_points": [],
            "boxes": [],
            "lassos": [],
            "scribbles": [],
            "objects": [],
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

        start = time.time()
        result_json = {}
        nnInter = True

        if nnInter:
            dicom_dir = data['image'].split('.nii.gz')[0]

            reader = sitk.ImageSeriesReader()
            dicom_filenames = reader.GetGDCMSeriesFileNames(dicom_dir)
            dcm_img_sample = dcmread(dicom_filenames[0], stop_before_pixels=True)
            dcm_img_sample_2 = dcmread(dicom_filenames[1], stop_before_pixels=True)
            
            instanceNumber = None
            instanceNumber2 = None

            if 0x00200013 in dcm_img_sample.keys():
                instanceNumber = dcm_img_sample[0x00200013].value
            logger.info(f"Prompt First InstanceNumber: {instanceNumber}")
            if 0x00200013 in dcm_img_sample_2.keys():
                instanceNumber2 = dcm_img_sample_2[0x00200013].value
            logger.info(f"Prompt Second InstanceNumber: {instanceNumber2}")

            # --- Load Input Image (Example with SimpleITK) ---
            reader.SetFileNames(dicom_filenames)
            #reader.SetOutputPixelType(SimpleITK.sitkUInt16) 
            img = reader.Execute()

            rescale_slope = float(img.GetMetaData("0028|1053")) if img.HasMetaDataKey("0028|1053") else 1.0
            rescale_intercept = float(img.GetMetaData("0028|1052")) if img.HasMetaDataKey("0028|1052") else 0.0

            logger.info(f"rescale_slope: {rescale_slope}")
            logger.info(f"rescale_intercept: {rescale_intercept}")
            #img = sitk.ReadImage(data['image'])
            img_np = sitk.GetArrayFromImage(img)[None]  # Ensure shape (1, x, y, z)
            if rescale_slope != 1.0 or rescale_intercept != 0.0:
                img_np = img_np * rescale_slope + rescale_intercept
            logger.info(f"img shape {img_np.shape}")
            #img = np.random.rand(1, 3, 128, 160).astype(np.float32)
            # Validate input dimensions
            if img_np.ndim != 4:
                raise ValueError("Input image must be 4D with shape (1, x, y, z)")
            
            if session.original_image_shape == None or not np.array_equal(img_np.shape,session.original_image_shape):
                session.set_image(img_np)
                session.set_target_buffer(torch.zeros(img_np.shape[1:], dtype=torch.uint8))
                logger.info("Only first time, no image at nnInter or iamge changed")
                if 1 not in self._session_used_interactions["objects"]:
                    for key, lst in self._session_used_interactions.items():
                        lst.clear()
                    session.reset_interactions()
                    logger.info("Only for first object")
                    self._session_used_interactions["objects"].append(1)
            elif 'nextObj' not in data:
                if 1 not in self._session_used_interactions["objects"]:
                    for key, lst in self._session_used_interactions.items():
                        lst.clear()
                    session.reset_interactions()
                    logger.info("Only for first object")
                    self._session_used_interactions["objects"].append(1)         
            elif data['nextObj'] not in self._session_used_interactions["objects"]:
                for key, lst in self._session_used_interactions.items():
                    lst.clear()
                session.reset_interactions()
                logger.info("From second object")
                self._session_used_interactions["objects"].append(data['nextObj'])


            # --- Define Output Buffer ---

            # --- Interacting with the Model ---
            # Interactions can be freely chained and mixed in any order. Each interaction refines the segmentation.
            # The model updates the segmentation mask in the target buffer after every interaction.

            # Example: Add a point interaction
            # POINT_COORDINATES should be a tuple (x, y, z) specifying the point location.
            logger.info(f"neg_points: {data['neg_points']}")
            logger.info(f"neg_point type: {type(data['neg_points'])}")
            result_json["pos_points"]=copy.deepcopy(data["pos_points"])
            result_json["neg_points"]=copy.deepcopy(data["neg_points"])
            
            for point in data['pos_points']:
                if instanceNumber > instanceNumber2:
                    point[2]=img_np.shape[1]-1-point[2]
                if not any(np.array_equal(point[::-1], x) for x in self._session_used_interactions["pos_points"]):
                    session.add_point_interaction(tuple(point[::-1]), include_interaction=True)
                    logger.info("Add pos points")
                    self._session_used_interactions["pos_points"].append(point[::-1])            
                
            for point in data['neg_points']:
                if instanceNumber > instanceNumber2:
                    point[2]=img_np.shape[1]-1-point[2]
                if not any(np.array_equal(point[::-1],x) for x in self._session_used_interactions["neg_points"]):
                    session.add_point_interaction(tuple(point[::-1]), include_interaction=False)
                    logger.info("Add neg points")
                    self._session_used_interactions["neg_points"].append(point[::-1])

            if len(data['boxes'])!=0:
                result_json["boxes"]=copy.deepcopy(data["boxes"])
                logger.info(f"prompt boxes: {data['boxes']}")
                for box in data['boxes']:
                    if instanceNumber > instanceNumber2:
                        box[0][2]=img_np.shape[1]-1-box[0][2]
                        box[1][2]=img_np.shape[1]-1-box[1][2]
                    box[0]=box[0][::-1]
                    box[1]=box[1][::-1]
                    if not any(np.array_equal([[box[0][0],box[1][0]+1],[box[0][1],box[1][1]],[box[0][2],box[1][2]]], x) for x in self._session_used_interactions["boxes"]):
                        session.add_bbox_interaction([[box[0][0],box[1][0]+1],[box[0][1],box[1][1]],[box[0][2],box[1][2]]], include_interaction=True)
                        logger.info("Add a box")
                        self._session_used_interactions["boxes"].append([[box[0][0],box[1][0]+1],[box[0][1],box[1][1]],[box[0][2],box[1][2]]])            
                    
            if len(data['lassos'])!=0:
                result_json["lassos"]=copy.deepcopy(data["lassos"])
                logger.info(f"prompt lassos: {data['lassos']}")
                for lasso in data['lassos']:
                    lasso = get_scanline_filled_points_3d(clean_and_densify_polyline(lasso))
                    lassoMask = np.zeros(img_np.shape[1:], dtype=np.uint8)
                    filled_indices = np.asarray(lasso)
                    if instanceNumber > instanceNumber2:
                        filled_indices[:, 2]=img_np.shape[1]-1 - filled_indices[:, 2]
                    x, y, z = filled_indices[:, 0], filled_indices[:, 1], filled_indices[:, 2]
                    valid = (
                        (x >= 0) & (x < img_np.shape[3]) &
                        (y >= 0) & (y < img_np.shape[2]) &
                        (z >= 0) & (z < img_np.shape[1])
                    )
                    # Apply only valid indices
                    lassoMask[z[valid], y[valid], x[valid]] = 1
                    if not any(np.array_equal(lassoMask,x) for x in self._session_used_interactions["lassos"]):
                        session.add_lasso_interaction(lassoMask, include_interaction=True)
                        logger.info("Add a lasso")
                        self._session_used_interactions["lassos"].append(lassoMask)                
                    
            
            if len(data['scribbles'])!=0:
                result_json["scribbles"]=copy.deepcopy(data["scribbles"])
                logger.info(f"prompt scribbles: {data['scribbles']}")
                for scribble in data['scribbles']:
                    scribble = clean_and_densify_polyline(scribble)
                    scribbleMask = np.zeros(img_np.shape[1:], dtype=np.uint8)
                    filled_indices = np.asarray(scribble)
                    if instanceNumber > instanceNumber2:
                        filled_indices[:, 2]=img_np.shape[1]-1 - filled_indices[:, 2]
                    x, y, z = filled_indices[:, 0], filled_indices[:, 1], filled_indices[:, 2]
                    valid = (
                        (x >= 0) & (x < img_np.shape[3]) &
                        (y >= 0) & (y < img_np.shape[2]) &
                        (z >= 0) & (z < img_np.shape[1])
                    )
                    # Apply only valid indices
                    scribbleMask[z[valid], y[valid], x[valid]] = 1
                    if not any(np.array_equal(scribbleMask,x) for x in self._session_used_interactions["scribbles"]):
                        session.add_scribble_interaction(scribbleMask, include_interaction=True)
                        logger.info("Add a scribble")
                        self._session_used_interactions["scribbles"].append(scribbleMask)

            # Example: Add a bounding box interaction
            # BBOX_COORDINATES must be specified as [[x1, x2], [y1, y2], [z1, z2]] (half-open intervals).
            # Note: nnInteractive pre-trained models currently only support **2D bounding boxes**.
            # This means that **one dimension must be [d, d+1]** to indicate a single slice.

            # Example of a 2D bounding box in the axial plane (XY slice at depth Z)
            # BBOX_COORDINATES = [[30, 80], [40, 100], [10, 11]]  # X: 30-80, Y: 40-100, Z: slice 10

            #session.add_bbox_interaction(BBOX_COORDINATES, include_interaction=True)

            # Example: Add a scribble interaction
            # - A 3D image of the same shape as img where one slice (any axis-aligned orientation) contains a hand-drawn scribble.
            # - Background must be 0, and scribble must be 1.
            # - Use session.preferred_scribble_thickness for optimal results.
            #session.add_scribble_interaction(SCRIBBLE_IMAGE, include_interaction=True)

            # Example: Add a lasso interaction
            # - Similarly to scribble a 3D image with a single slice containing a **closed contour** representing the selection.
            #session.add_lasso_interaction(LASSO_IMAGE, include_interaction=True)

            # You can combine any number of interactions as needed. 
            # The model refines the segmentation result incrementally with each new interaction.

            # --- Retrieve Results ---
            # The target buffer holds the segmentation result.
            results = session.target_buffer.clone()
            # OR (equivalent)
            #results = target_tensor.clone()

            # Cloning is required because the buffer will be **reused** for the next object.
            # Alternatively, set a new target buffer for each object:
            #session.set_target_buffer(torch.zeros(img_np.shape[1:], dtype=torch.uint8))

            # --- Start a New Object Segmentation ---
            #session.reset_interactions()  # Clears the target buffer and resets interactions

            # Now you can start segmenting the next object in the image.

            # --- Set a New Image ---
            # Setting a new image also requires setting a new matching target buffer
            #session.set_image(NEW_IMAGE)
            #session.set_target_buffer(torch.zeros(NEW_IMAGE.shape[1:], dtype=torch.uint8))

            # Enjoy!
            pred = results.numpy()

            pred_itk = sitk.GetImageFromArray(pred)
            pred_itk.CopyInformation(img)
            
            gt_itk = sitk.ReadImage('/code/data/100101A_BraTS-seg.nii.gz')
            gt = sitk.GetArrayFromImage(gt_itk)
            

            # Calculate Dice coefficient between prediction and ground truth
            def calculate_dice(pred_mask, gt_mask, smooth=1e-6):
                """
                Calculate Dice coefficient between two binary masks
                Args:
                    pred_mask: prediction mask (numpy array)
                    gt_mask: ground truth mask (numpy array)
                    smooth: smoothing factor to avoid division by zero
                Returns:
                    dice_score: float between 0 and 1
                """
                # Flatten arrays
                pred_flat = pred_mask.flatten()
                gt_flat = gt_mask.flatten()
                
                # Calculate intersection and union
                intersection = (pred_flat * gt_flat).sum()
                dice_score = (2.0 * intersection + smooth) / (pred_flat.sum() + gt_flat.sum() + smooth)
                
                return dice_score
            
            # Calculate Dice for each class/label if multi-class, or overall if binary
            if len(np.unique(pred)) > 2 or len(np.unique(gt)) > 2:
                # Multi-class case - calculate Dice for each class
                unique_labels = np.unique(np.concatenate([pred.flatten(), gt.flatten()]))
                unique_labels = unique_labels[unique_labels > 0]  # exclude background
                
                dice_scores = {}
                for label in unique_labels:
                    pred_binary = (pred == label).astype(np.float32)
                    gt_binary = (gt == label).astype(np.float32)
                    dice_score = calculate_dice(pred_binary, gt_binary)
                    dice_scores[f'class_{int(label)}'] = dice_score
                    logger.info(f"Dice score for class {int(label)}: {dice_score:.4f}")
                
                # Calculate mean Dice across all classes
                mean_dice = np.mean(list(dice_scores.values()))
                logger.info(f"Mean Dice score: {mean_dice:.4f}")
                
            else:
                # Binary case
                pred_binary = (pred > 0).astype(np.float32)
                gt_binary = (gt > 0).astype(np.float32)
                dice_score = calculate_dice(pred_binary, gt_binary)
                logger.info(f"Dice score: {dice_score:.4f}")

            sitk.WriteImage(pred_itk, '/code/sam.nii.gz')


            
            logger.info(f"Prompt info: {result_json}")
            # result_json contains prompt information

            return '/code/sam.nii.gz', result_json

        
        if "pos_points" in data:

            result_json["pos_points"]=data["pos_points"]
            #SAM2
            img = sitk.ReadImage(data['image'])
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

            contrast_center = None
            contrast_window = None
            

            if 0x00281050 in dcm_img_sample.keys():
                contrast_center = dcm_img_sample[0x00281050].value
            
            if 0x00281051 in dcm_img_sample.keys():
                contrast_window = dcm_img_sample[0x00281051].value
            

            if contrast_window != None and contrast_center !=None:
                #breakpoint()
                if contrast_window.__class__.__name__ == 'MultiValue':
                    contrast_window = contrast_window[0]
                if contrast_center.__class__.__name__ == 'MultiValue':
                    contrast_center = contrast_center[0]

                # Check for cats and remote controls
                # VERY important: text queries need to be lowercased + end with a dot
                if len(data['texts'])==1 and data['texts'][0]!='':
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
                    logger.info(f"Post point: {data['pos_points'][0]}")
                    img_np_2d = img_np_3d[img_z-1-data['pos_points'][0][2]]
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

                inference_state = predictor.init_state(video_path=data['image'], clip_low=contrast_center-contrast_window/2, clip_high=contrast_center+contrast_window/2)
            else:    
                inference_state = predictor.init_state(video_path=data['image'])
            #predictor.reset_state(inference_state)
            #breakpoint()
            ann_obj_id = 1
            video_segments = {}  # video_segments contains the per-frame segmentation results
            
            ann_frame_list = np.unique(np.array(list(map(lambda x: x[2], data['pos_points'])), dtype=np.int16))
                        
            if len(data['boxes'])!=0:
                result_json["boxes"]=data["boxes"]
                logger.info(f"prompt boxes: {data['boxes']}")
                # Temp remove pos points
                data['pos_points']=[]
                ann_frame_list_box = np.unique(np.array(list(map(lambda x: x[2], [x for xs in data['boxes'] for x in xs])), dtype=np.int16))
                ann_frame_list = np.unique(np.concatenate((ann_frame_list, ann_frame_list_box)))

            for i in range(len(ann_frame_list)):

                reader = sitk.ImageSeriesReader()
                dicom_filenames = reader.GetGDCMSeriesFileNames(dicom_dir)
                dcm_img_sample = dcmread(dicom_filenames[0], stop_before_pixels=True)
                dcm_img_sample_2 = dcmread(dicom_filenames[1], stop_before_pixels=True)
                
                instanceNumber = None
                instanceNumber2 = None

                if 0x00200013 in dcm_img_sample.keys():
                    instanceNumber = dcm_img_sample[0x00200013].value
                logger.info(f"Prompt First InstanceNumber: {instanceNumber}")
                if 0x00200013 in dcm_img_sample_2.keys():
                    instanceNumber2 = dcm_img_sample_2[0x00200013].value
                logger.info(f"Prompt Second InstanceNumber: {instanceNumber2}")

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
                pos_points = np.array([i[0:2] for i in data['pos_points'] if i[2]==value], dtype=np.int16)
                neg_points = np.array([i[0:2] for i in data['neg_points'] if i[2]==value], dtype=np.int16)
                pre_boxes = np.array([i for i in data['boxes'] if i[0][2]==value], dtype=np.int16)

                if len(neg_points) >0:
                    result_json["neg_points"]=data["neg_points"]
                    #breakpoint()
                    points = np.concatenate((pos_points, neg_points), axis=0)
                    # for labels, `1` means positive click and `0` means negative click        
                    labels = np.array([1]*len(pos_points) + [0]*len(neg_points), np.int32)
                else:
                    points = pos_points
                    labels = np.array([1]*len(points), np.int32)

                if len(pre_boxes)!=0:
                    boxes = pre_boxes[:,:,:-1].reshape(pre_boxes.shape[0],-1)

                    _, out_obj_ids, out_mask_logits = predictor.add_new_points_or_box(
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
                    )

                if "one" in data:
                    video_segments[ann_frame_idx] = {
                        out_obj_id: (out_mask_logits[i] > 0.0).cpu().numpy()
                        for i, out_obj_id in enumerate(out_obj_ids)
                    }
            if "one" not in data:
                for out_frame_idx, out_obj_ids, out_mask_logits in predictor.propagate_in_video(inference_state, reverse=False):
                    video_segments[out_frame_idx] = {
                        out_obj_id: (out_mask_logits[i] > 0.0).cpu().numpy()
                        for i, out_obj_id in enumerate(out_obj_ids)
                    }
                for out_frame_idx, out_obj_ids, out_mask_logits in predictor.propagate_in_video(inference_state, reverse=True):
                    video_segments[out_frame_idx] = {
                        out_obj_id: (out_mask_logits[i] > 0.0).cpu().numpy()
                        for i, out_obj_id in enumerate(out_obj_ids)
                    }

            pred = np.zeros((len_z, len_y, len_x))

            for i in video_segments.keys():
                pred[i]=video_segments[i][1][0].astype(int)
            pred_itk = sitk.GetImageFromArray(pred)
            pred_itk.CopyInformation(img)
            
            sitk.WriteImage(pred_itk, '/code/sam.nii.gz')

            
            logger.info(f"Prompt info: {result_json}")
            # result_json contains prompt information

            return '/code/sam.nii.gz', result_json

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
