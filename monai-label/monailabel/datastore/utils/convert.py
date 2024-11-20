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
import logging
import os
import pathlib
import tempfile
import time

import numpy as np
import pydicom
import pydicom_seg
from pydicom import config

import SimpleITK

from monai.transforms import LoadImage
from pydicom.filereader import dcmread

from monailabel.datastore.utils.colors import GENERIC_ANATOMY_COLORS
from monailabel.transform.writer import write_itk
from monailabel.utils.others.generic import run_command

logger = logging.getLogger(__name__)


def dicom_to_nifti(series_dir, is_seg=False):
    start = time.time()

    if is_seg:
        output_file = dicom_seg_to_itk_image(series_dir)
    else:
        # https://simpleitk.readthedocs.io/en/master/link_DicomConvert_docs.html
        if os.path.isdir(series_dir) and len(os.listdir(series_dir)) > 1:
            reader = SimpleITK.ImageSeriesReader()
            dicom_names = reader.GetGDCMSeriesFileNames(series_dir)
            dicom_names_sorted = sorted(
            dicom_names,
            key=lambda filename: int(SimpleITK.ReadImage(filename).GetMetaData("0020|0013")), # Sort by InstanceNumber tag ("0020|0013")
            reverse=True
            )
            reader.SetFileNames(dicom_names_sorted)
            image = reader.Execute()
        else:
            dicom_names = (
                series_dir if not os.path.isdir(series_dir) else os.path.join(series_dir, os.listdir(series_dir)[0])
            )

            file_reader = SimpleITK.ImageFileReader()
            file_reader.SetImageIO("GDCMImageIO")
            file_reader.SetFileName(dicom_names)
            image = file_reader.Execute()

        logger.info(f"Image size: {image.GetSize()}")
        
        output_file = series_dir+".nii.gz"
        SimpleITK.WriteImage(image, output_file)

    logger.info(f"dicom_to_nifti latency : {time.time() - start} (sec)")
    return output_file


def binary_to_image(reference_image, label, dtype=np.uint8, file_ext=".nii.gz"):
    start = time.time()

    image_np, meta_dict = LoadImage(image_only=False)(reference_image)
    label_np = np.fromfile(label, dtype=dtype)

    logger.info(f"Image: {image_np.shape}")
    logger.info(f"Label: {label_np.shape}")

    label_np = label_np.reshape(image_np.shape, order="F")
    logger.info(f"Label (reshape): {label_np.shape}")

    output_file = tempfile.NamedTemporaryFile(suffix=file_ext).name
    affine = meta_dict.get("affine")
    write_itk(label_np, output_file, affine=affine, dtype=None, compress=True)

    logger.info(f"binary_to_image latency : {time.time() - start} (sec)")
    return output_file


def nifti_to_dicom_seg(series_dir, label, label_info, file_ext="*", use_itk=True) -> str:
    start = time.time()

    # Read source Images
    series_dir = pathlib.Path(series_dir)
    image_files = series_dir.glob(file_ext)
    image_datasets = [dcmread(str(f), stop_before_pixels=True) for f in image_files]
    logger.info(f"Total Source Images: {len(image_datasets)}")
    
    if 0x0008103e in image_datasets[0].keys():
        image_series_desc = image_datasets[0][0x0008103e].value
    else:
        image_series_desc = ""

    label_np, meta_dict = LoadImage(image_only=False)(label)
    unique_labels = np.unique(label_np.flatten()).astype(np.int_)
    unique_labels = unique_labels[unique_labels != 0]

    info = label_info[0] if label_info and 0 < len(label_info) else {}
    #model_name = info.get("model_name", "Totalsegmentor")
    if "sam" in label:
        label_names = ["sam_label"]
        image_series_desc = "SAM2_"+ image_series_desc
    else:
        label_names = np.load('/code/labelname.npy').tolist()
        image_series_desc = "Total_"+ image_series_desc
    segment_attributes = []

    for i, idx in enumerate(unique_labels):
        info = label_info[i] if label_info and i < len(label_info) else {}
        name = label_names[i]
        description = info.get("description", "Unknown")
        rgb = list(np.random.random(size=3) * 256)
        rgb = [int(x) for x in rgb]

        logger.info(f"{i} => {idx} => {name}")

        segment_attribute = info.get(
            "segmentAttribute",
            {
                "labelID": int(idx),
                "SegmentLabel": name,
                "SegmentDescription": description,
                "SegmentAlgorithmType": "AUTOMATIC",
                "SegmentAlgorithmName": "MONAILABEL",
                "SegmentedPropertyCategoryCodeSequence": {
                    "CodeValue": "123037004",
                    "CodingSchemeDesignator": "SCT",
                    "CodeMeaning": "Anatomical Structure",
                },
                "SegmentedPropertyTypeCodeSequence": {
                    "CodeValue": "78961009",
                    "CodingSchemeDesignator": "SCT",
                    "CodeMeaning": name,
                },
                "recommendedDisplayRGBValue": rgb,
            },
        )
        segment_attributes.append(segment_attribute)

    template = {
        "ContentCreatorName": "Reader1",
        "ClinicalTrialSeriesID": "Session1",
        "ClinicalTrialTimePointID": "1",
        "SeriesDescription": image_series_desc,
        "SeriesNumber": "300",
        "InstanceNumber": "1",
        "segmentAttributes": [segment_attributes],
        "ContentLabel": "SEGMENTATION",
        "ContentDescription": "MONAI Label - Image segmentation",
        "ClinicalTrialCoordinatingCenterName": "MONAI",
        "BodyPartExamined": "",
    }
#    template = {
#  "ContentCreatorName": "SAM2",
#  "ClinicalTrialSeriesID": "Session1",
#  "ClinicalTrialTimePointID": "1",
#  "SeriesDescription": image_series_desc,
#  "SeriesNumber": "300",
#  "InstanceNumber": "1",
#  "segmentAttributes": [
#    [
#      {
#        "labelID": 1,
#        "SegmentDescription": "bone",
#        "SegmentAlgorithmType": "SEMIAUTOMATIC",
#        "SegmentAlgorithmName": "SAM2",
#        "SegmentedPropertyCategoryCodeSequence": {
#          "CodeValue": "91723000",
#          "CodingSchemeDesignator": "SCT",
#          "CodeMeaning": "Anatomical Structure"
#        },
#        "SegmentedPropertyTypeCodeSequence": {
#          "CodeValue": "818981001",
#          "CodingSchemeDesignator": "SCT",
#          "CodeMeaning": "Abdomen"
#        },
#        "recommendedDisplayRGBValue": [
#          177,
#          122,
#          101
#        ]
#      }
#    ]
#  ],
#  "ContentLabel": "SEGMENTATION",
#  "ContentDescription": "Image segmentation",
#  "ClinicalTrialCoordinatingCenterName": "dcmqi",
#  "BodyPartExamined": ""
#}


    logger.info(json.dumps(template, indent=2))
    if not segment_attributes:
        logger.error("Missing Attributes/Empty Label provided")
        return ""

    use_itk=True
    
    if use_itk:
        output_file = itk_image_to_dicom_seg(label, series_dir, template)
    else:
        template = pydicom_seg.template.from_dcmqi_metainfo(template)
        config.settings.reading_validation_mode = config.IGNORE
        writer = pydicom_seg.MultiClassWriter(
            template=template,
            inplane_cropping=False,
            skip_empty_slices=False,
            skip_missing_segment=False,
        )

        mask = SimpleITK.ReadImage(label)
        mask = SimpleITK.Cast(mask, SimpleITK.sitkUInt16)

        output_file = "/code/test.dcm"
        dcm = writer.write(mask, image_datasets)
        dcm.save_as(output_file)

    logger.info(f"nifti_to_dicom_seg latency : {time.time() - start} (sec)")
    return output_file


def itk_image_to_dicom_seg(label, series_dir, template) -> str:
    output_file = tempfile.NamedTemporaryFile(suffix=".dcm").name
    meta_data = tempfile.NamedTemporaryFile(suffix=".json").name
    with open(meta_data, "w") as fp:
        json.dump(template, fp)

    command = "itkimage2segimage"
    args = [
        "--inputImageList",
        label,
        "--inputDICOMDirectory",
        series_dir,
        "--outputDICOM",
        output_file,
        "--inputMetadata",
        meta_data,
    ]
    run_command(command, args)
    os.unlink(meta_data)
    return output_file


def dicom_seg_to_itk_image(label, output_ext=".seg.nrrd"):
    filename = label if not os.path.isdir(label) else os.path.join(label, os.listdir(label)[0])

    dcm = pydicom.dcmread(filename)
    reader = pydicom_seg.MultiClassReader()
    result = reader.read(dcm)
    image = result.image

    output_file = tempfile.NamedTemporaryFile(suffix=output_ext).name

    SimpleITK.WriteImage(image, output_file, True)

    if not os.path.exists(output_file):
        logger.warning(f"Failed to convert DICOM-SEG {label} to ITK image")
        return None

    logger.info(f"Result/Output File: {output_file}")
    return output_file
