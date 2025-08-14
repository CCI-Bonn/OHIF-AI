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

import json
import secrets
import logging
import os
import pathlib
import shutil
import tempfile
import time
from enum import Enum
from datetime import date
from typing import Optional
from glob import glob as glob
import io
from copy import deepcopy
import gzip
import SimpleITK as sitk
import numpy as np

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.background import BackgroundTasks
from fastapi.responses import FileResponse, Response
from requests_toolbelt import MultipartEncoder

import pydicom
from pydicom.filereader import dcmread
from pydicom.sr.codedict import codes
from pydicom.uid import generate_uid

from monailabel.config import RBAC_USER, settings
from monailabel.datastore.dicom import DICOMWebDatastore
from monailabel.datastore.utils.convert import binary_to_image, nifti_to_dicom_seg, itk_image_to_dicom_seg
from monailabel.endpoints.user.auth import RBAC, User
from monailabel.interfaces.app import MONAILabelApp
from monailabel.interfaces.utils.app import app_instance
from monailabel.utils.others.generic import get_mime_type, remove_file

from monailabel.datastore.utils.dicom import dicom_web_upload_dcm

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/infer",
    tags=["Infer"],
    responses={
        404: {"description": "Not found"},
        200: {
            "description": "OK",
            "content": {
                "multipart/form-data": {
                    "schema": {
                        "type": "object",
                        "properties": {
                            "points": {
                                "type": "string",
                                "description": "Reserved for future; Currently it will be empty",
                            },
                            "file": {
                                "type": "string",
                                "format": "binary",
                                "description": "The result NIFTI image which will have segmentation mask",
                            },
                        },
                    },
                    "encoding": {
                        "points": {"contentType": "text/plain"},
                        "file": {"contentType": "application/octet-stream"},
                    },
                },
                "application/json": {"schema": {"type": "string", "example": "{}"}},
                "application/octet-stream": {"schema": {"type": "string", "format": "binary"}},
                "application/dicom": {"schema": {"type": "string", "format": "binary"}},
            },
        },
    },
)


class ResultType(str, Enum):
    image = "image"
    json = "json"
    all = "all"
    dicom_seg = "dicom_seg"


def send_response(datastore, result, output, background_tasks):
    res_img = result.get("file") if result.get("file") else result.get("label")
    res_tag = result.get("tag")
    res_json = result.get("params")

    if res_img:
        if not os.path.exists(res_img):
            res_img = datastore.get_label_uri(res_img, res_tag)
        else:
            background_tasks.add_task(remove_file, res_img)

    if output == "json":
        return res_json

    m_type = get_mime_type(res_img)

    if output == "image":
        return FileResponse(res_img, media_type=m_type, filename=os.path.basename(res_img))

    if output == "dicom_seg":
        start = time.time()
        res_dicom_seg = result.get("dicom_seg")
        res_prompt_info = json.dumps(result.get("params").get("prompt_info"))
        res_flipped = json.dumps(result.get("params").get("flipped"))
        res_nninter_elapsed = json.dumps(result.get("params").get("nninter_elapsed"))
        res_label_name = result.get("params").get("label_name")
        if res_dicom_seg is None:
            logger.info("No dicom_seg?")
            raise HTTPException(status_code=500, detail="Error processing inference")
        else:
            logger.info("File response!")
            if type(res_dicom_seg) != str:
                logger.info(f"Prompt info: {res_prompt_info}")
                logger.info(f"Flipped: {res_flipped}")
                logger.info(f"NNinter elapsed: {res_nninter_elapsed}")
                logger.info(f"Label name: {res_label_name}")

                fields = {
                    "prompt_info": res_prompt_info,
                    "flipped": res_flipped,
                    "nninter_elapsed": res_nninter_elapsed,
                    "label_name": res_label_name
                }
                
                boundary = f"monai-{secrets.token_hex(12)}"
                meta_json = json.dumps(fields, separators=(",", ":"))

                    # Build multipart body
                CRLF = "\r\n"
                head_meta = (
                    f"--{boundary}{CRLF}"
                    f'Content-Disposition: form-data; name="meta"; filename="meta.json"{CRLF}'
                    f"Content-Type: application/json{CRLF}{CRLF}"
                    f"Content-Encoding: gzip{CRLF}{CRLF}"
                ).encode("utf-8")

                head_seg = (
                    f"--{boundary}{CRLF}"
                    f'Content-Disposition: form-data; name="seg"; filename="seg.bin"{CRLF}'
                    f"Content-Type: application/octet-stream{CRLF}{CRLF}"
                    f"Content-Encoding: gzip{CRLF}{CRLF}"
                ).encode("utf-8")

                tail = f"{CRLF}--{boundary}--{CRLF}".encode("utf-8")

                body = b"".join([head_meta, gzip.compress(meta_json.encode("utf-8")), CRLF.encode("utf-8"),head_seg, gzip.compress(res_dicom_seg),CRLF.encode("utf-8"), tail])

                logger.info(f"Just before Response: {time.time()-start} secs")
                return Response(content=body, media_type=f"multipart/form-data; boundary={boundary}"
                )
            else:
                logger.info("No prompt info?")
                return Response(res_dicom_seg, media_type="application/json")
            #return FileResponse(res_dicom_seg, media_type="application/dicom", filename=os.path.basename(res_dicom_seg))

    res_fields = dict()
    res_fields["params"] = (None, json.dumps(res_json), "application/json")
    if res_img and os.path.exists(res_img):
        res_fields["image"] = (os.path.basename(res_img), open(res_img, "rb"), m_type)
    else:
        logger.info(f"Return only Result Json as Result Image is not available: {res_img}")
        return res_json

    return_message = MultipartEncoder(fields=res_fields)
    return Response(content=return_message.to_string(), media_type=return_message.content_type)


def run_inference(
    background_tasks: BackgroundTasks,
    model: str,
    image: str = "",
    session_id: str = "",
    params: str = Form("{}"),
    file: UploadFile = File(None),
    label: UploadFile = File(None),
    output: Optional[ResultType] = None,
):
    request = {"model": model, "image": image}

    if not file and not image and not session_id:
        raise HTTPException(status_code=500, detail="Neither Image nor File not Session ID input is provided")

    instance: MONAILabelApp = app_instance()

    if file:
        file_ext = "".join(pathlib.Path(file.filename).suffixes) if file.filename else ".nii.gz"
        image_file = tempfile.NamedTemporaryFile(suffix=file_ext).name

        with open(image_file, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
            request["image"] = image_file
            background_tasks.add_task(remove_file, image_file)

    if label:
        file_ext = "".join(pathlib.Path(label.filename).suffixes) if label.filename else ".nii.gz"
        label_file = tempfile.NamedTemporaryFile(suffix=file_ext).name

        with open(label_file, "wb") as buffer:
            shutil.copyfileobj(label.file, buffer)
            background_tasks.add_task(remove_file, label_file)

        # if binary file received, e.g. scribbles from OHIF - then convert using reference image
        if file_ext == ".bin":
            image_uri = instance.datastore().get_image_uri(image)
            label_file = binary_to_image(image_uri, label_file)

        request["label"] = label_file

    config = instance.info().get("config", {}).get("infer", {})
    request.update(config)

    p = json.loads(params) if params else {}
    request.update(p)

    if session_id:
        session = instance.sessions().get_session(session_id)
        if session:
            request["image"] = session.image
            request["session"] = session.to_json()

    logger.info(f"Infer Request: {request}")
    result = instance.infer(request)
    prompt_json = result['params']
    if result is None:
        raise HTTPException(status_code=500, detail="Failed to execute infer")

    # Dicom Seg Integration
    if output == "dicom_seg":
        dicom_seg_file = None
        if not isinstance(instance.datastore(), DICOMWebDatastore):
            raise HTTPException(status_code=500, detail="DICOM SEG format is not supported in a non-DICOM datastore")
        #elif p.get("label_info") is None:
        #    raise HTTPException(status_code=404, detail="Parameters for DICOM SEG inference cannot be empty!")
        # Transform image uri to id (similar to _to_id in local datastore)
        image_path = instance.datastore().get_image_uri(image)
        #suffixes = [".nii", ".nii.gz", ".nrrd"]
        #image_path = [image_uri.replace(suffix, "") for suffix in suffixes if image_uri.endswith(suffix)][0]
        res_img = result.get("file") if result.get("file") else result.get("label")
        if res_img == "/code/predictions/reset.nii.gz" or res_img == "/code/predictions/init.nii.gz":
            result["dicom_seg"] = res_img
            return send_response(instance.datastore(), result, output, background_tasks)
        #dicom_seg_file = nifti_to_dicom_seg(image_path, res_img, prompt_json, use_itk=True)
        #with open(dicom_seg_file, "rb") as f:
        #    dicom_bytes = f.read()
        #result["dicom_seg"] = dicom_bytes
        result["dicom_seg"] = res_img

    return send_response(instance.datastore(), result, output, background_tasks)

def read_seg_file(seg):
    """
    Reads a DICOM-SEG file and extracts the pixel array and segment metadata.
    """
    num_frames = seg.NumberOfFrames
    rows = seg.Rows
    columns = seg.Columns
    num_segments = len(seg.SegmentSequence)

    # Unpack PixelData
    pixel_array = np.unpackbits(np.frombuffer(seg.PixelData, dtype=np.uint8)).reshape(num_frames, rows, columns)

    # Get the SOPInstanceUIDs from ReferencedSeriesSequence
    referenced_instance_uids = [
        item.ReferencedSOPInstanceUID
        for item in seg.ReferencedSeriesSequence[0].ReferencedInstanceSequence
    ]
    # Reorganize pixel array by segment
    frames_per_segment = num_frames // num_segments

    # Filter out empty frames for each segment
    reduced_pixel_array = []
    filtered_frames = []
    total_frame_count=0
    for i in range(num_segments):
        # Extract frames for the current segment
        segment_frames = pixel_array[i * frames_per_segment:(i + 1) * frames_per_segment]
        
        for slice_index, frame in enumerate(segment_frames):
            if np.any(frame > 0):
                reduced_pixel_array.append(frame)
                if len(segment_frames) == len(referenced_instance_uids):
                    filtered_frames.append((i + 1, len(segment_frames)-slice_index, referenced_instance_uids[slice_index]))  # 1-based indexing
                else:
                    filtered_frames.append((i + 1, len(segment_frames)-slice_index, seg.PerFrameFunctionalGroupsSequence[total_frame_count].DerivationImageSequence[0].SourceImageSequence[0].ReferencedSOPInstanceUID))
                total_frame_count+=1
    reduced_pixel_array = np.stack(reduced_pixel_array)
    return reduced_pixel_array, filtered_frames, seg


def save_combined_segmentation(combined_pixel_array, all_segments, combined_frames, metadata_source):
    """
    Saves the combined segmentation as a new DICOM-SEG file by reusing metadata from existing files.
    """
    # Reuse metadata from the source
    combined_segmentation = metadata_source

    # Update metadata for combined segmentation
    combined_segmentation.NumberOfFrames = combined_pixel_array.shape[0]
    combined_segmentation.SegmentSequence = all_segments
    combined_segmentation.SeriesInstanceUID = generate_uid()
    
    # Update PerFrameFunctionalGroupsSequence
    new_per_frame_sequence = []
    for segment_index, slice_index, sop_instance_uid in combined_frames:
        frame = deepcopy(combined_segmentation.PerFrameFunctionalGroupsSequence[0])
        frame.FrameContentSequence[0].DimensionIndexValues = [segment_index, slice_index]
        frame.SegmentIdentificationSequence[0].ReferencedSegmentNumber = segment_index
        # Update ReferencedSOPInstanceUID in DerivationImageSequence
        frame.DerivationImageSequence[0].SourceImageSequence[0].ReferencedSOPInstanceUID = sop_instance_uid
        new_per_frame_sequence.append(frame)
    combined_segmentation.PerFrameFunctionalGroupsSequence = new_per_frame_sequence

    # Pack the combined binary pixel array
    packed_pixel_data = np.packbits(combined_pixel_array.astype(np.uint8), axis=-1)
    combined_segmentation.PixelData = packed_pixel_data.tobytes()
    return combined_segmentation

@router.post("/{model}", summary=f"{RBAC_USER}Run Inference for supported model")
async def api_run_inference(
    background_tasks: BackgroundTasks,
    model: str,
    image: str = "",
    session_id: str = "",
    params: str = Form("{}"),
    file: UploadFile = File(None),
    label: UploadFile = File(None),
    output: Optional[ResultType] = None,
    user: User = Depends(RBAC(settings.MONAI_LABEL_AUTH_ROLE_USER)),
):
    return run_inference(background_tasks, model, image, session_id, params, file, label, output)
