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
            #dicom_names_sorted = sorted(
            #dicom_names,
            #key=lambda filename: int(SimpleITK.ReadImage(filename).GetMetaData("0020|0013")), # Sort by InstanceNumber tag ("0020|0013")
            #reverse=True
            #)
            reader.SetFileNames(dicom_names)
            #reader.SetOutputPixelType(SimpleITK.sitkUInt16) 
            image = reader.Execute()
        else:
            dicom_names = (
                series_dir if not os.path.isdir(series_dir) else os.path.join(series_dir, os.listdir(series_dir)[0])
            )

            file_reader = SimpleITK.ImageFileReader()
            file_reader.SetImageIO("GDCMImageIO")
            file_reader.SetFileName(dicom_names)
            #file_reader.SetOutputPixelType(SimpleITK.sitkUInt16) 
            image = file_reader.Execute()

        logger.info(f"Image size: {image.GetSize()}")
        
        output_file = series_dir+".nii.gz"

        if image.HasMetaDataKey("0028|0101"):
            logger.info("Bits Stored:", image.GetMetaData("0028|0101"))  # Likely 12
        if image.HasMetaDataKey("0028|0100"):
            logger.info("Bits Allocated:", image.GetMetaData("0028|0100"))  # Likely 16


        pixel_representation = int(image.GetMetaData("0028|0103")) if image.HasMetaDataKey("0028|0103") else 0
        logger.info(f"Pixel Representation: {pixel_representation}")  # 0 = Unsigned, 1 = Signed

        #image_uint16 = SimpleITK.Cast(image, SimpleITK.sitkUInt16)  # Ensure unsigned interpretation
        #image_float32 = SimpleITK.Cast(image_uint16, SimpleITK.sitkFloat32)  # Convert to float to prevent overflow

        rescale_slope = float(image.GetMetaData("0028|1053")) if image.HasMetaDataKey("0028|1053") else 1.0
        rescale_intercept = float(image.GetMetaData("0028|1052")) if image.HasMetaDataKey("0028|1052") else 0.0

        logger.info(f"rescale_slope: {rescale_slope}")
        logger.info(f"rescale_intercept: {rescale_intercept}")
#
        image_array = SimpleITK.GetArrayFromImage(image)  # Convert to NumPy array
        #logger.info(f"NumPy Data Type: {image_array.dtype}")
        #image_array = image_array * rescale_slope + rescale_intercept  # Apply RescaleSlope and RescaleIntercept
        
        #image_array = image_array & 0xFFF

        logger.info(f"Min Intensity: {image_array.min()}")
        logger.info(f"Max Intensity: {image_array.max()}")

        #if image.HasMetaDataKey("0028|1050") and image.HasMetaDataKey("0028|1051"):
        #    logger.info(f"Window Center: {image.GetMetaData("0028|1050")}")
        #    logger.info(f"Window Width: {image.GetMetaData("0028|1051")}")


        #
        ## Convert back to SimpleITK image
        image_corrected = SimpleITK.GetImageFromArray(image_array)
        image_corrected.CopyInformation(image)  # Preserve original metadata

        SimpleITK.WriteImage(image_corrected, output_file)

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


def nifti_to_dicom_seg(series_dir, label, final_result_json, file_ext="*", use_itk=True) -> str:
    start = time.time()
    #reader.SetFileNames(dicom_filenames)
    reader = SimpleITK.ImageSeriesReader()
    dicom_filenames = reader.GetGDCMSeriesFileNames(series_dir)
    # Read source Images
    series_dir = pathlib.Path(series_dir)
    image_files = series_dir.glob(file_ext)
    image_datasets = [dcmread(str(f), stop_before_pixels=True) for f in image_files]


    reader.SetFileNames(dicom_filenames)            
    image = reader.Execute()
    logger.info(f"Total Source Images: {len(image_datasets)}")
    
    if 0x0008103e in image_datasets[0].keys():
        image_series_desc = image_datasets[0][0x0008103e].value
    else:
        image_series_desc = ""
    pre_path = label.split('/predictions/')[0]
    file_name = label.split('/predictions/')[-1]
    #sam_label_np, _ = LoadImage(image_only=False)(pre_path+'/predictions/'+'sam_'+file_name)
    #nninter_label_np, _ = LoadImage(image_only=False)(pre_path+'/predictions/'+'nninter_'+file_name)
    sam_label_itk = SimpleITK.ReadImage(pre_path+'/predictions/'+'sam_'+image_series_desc+'_'+final_result_json["user_name"]+'.nii.gz')
    nninter_label_itk = SimpleITK.ReadImage(pre_path+'/predictions/'+'nninter_'+image_series_desc+'_'+final_result_json["user_name"]+'.nii.gz')
    
    sam_label_np = SimpleITK.GetArrayFromImage(sam_label_itk)
    nninter_label_np = SimpleITK.GetArrayFromImage(nninter_label_itk)

    nninter_label_np[nninter_label_np != 0] = 2
    nninter_unique_labels = np.unique(nninter_label_np.flatten()).astype(np.int_)
    nninter_unique_labels = nninter_unique_labels[nninter_unique_labels != 0]
    logger.info(f"nninter_unique_labels: {nninter_unique_labels}")
    sam_unique_labels = np.unique(sam_label_np.flatten()).astype(np.int_)
    sam_unique_labels = sam_unique_labels[sam_unique_labels != 0]
    logger.info(f"sam_unique_labels: {sam_unique_labels}")
    label_np = sam_label_np + nninter_label_np
    logger.info(f"sam_label_np.shape: {sam_label_np.shape}")
    logger.info(f"nninter_label_np.shape: {nninter_label_np.shape}")
    logger.info(f"label_np.shape: {label_np.shape}")
    #label_np, meta_dict = LoadImage(image_only=False)(label)
    label_itk = SimpleITK.GetImageFromArray(label_np)
    label_itk.CopyInformation(image)
    SimpleITK.WriteImage(label_itk, label)
    unique_labels = np.unique(label_np.flatten()).astype(np.int_)
    unique_labels = unique_labels[unique_labels != 0]
    logger.info(f"unique_labels: {unique_labels}")
    #info = label_info[0] if label_info and 0 < len(label_info) else {}
    info = {}
    #model_name = info.get("model_name", "Totalsegmentor")
    if "/predictions/" in label:
        label_names = ["sam_pred", "nninter_pred", "overlap"]
        image_series_desc = "Pred_"+ image_series_desc#"SAM2_"+ image_series_desc
    else:
        label_names = np.load('/code/labelname.npy').tolist()
        image_series_desc = "Total_"+ image_series_desc
    segment_attributes = []

    for i, idx in enumerate(unique_labels):
        #info = label_info[i] if label_info and i < len(label_info) else {}
        label_info = {}
        name = label_names[idx-1]
        description = label_info.get("description", json.dumps(final_result_json["prompt_info"]))
        rgb = list(np.random.random(size=3) * 256)
        rgb = [int(x) for x in rgb]

        logger.info(f"{i} => {idx} => {name}")

        if idx == 1:
            elapsed = final_result_json["sam_elapsed"]
        else:
            elapsed = final_result_json["nninter_elapsed"]
        logger.info(f"{idx}_{name}_elapsed: {elapsed}")
        segment_attribute = label_info.get(
            "segmentAttribute",
            {
                "labelID": int(idx),
                "SegmentLabel": name,
                "SegmentDescription": description,
                "SegmentAlgorithmType": "AUTOMATIC",
                "SegmentAlgorithmName": elapsed,
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
    #Resampling code below
    #reader = SimpleITK.ImageSeriesReader()
    #dicom_filenames = reader.GetGDCMSeriesFileNames(series_dir)
    #reader.SetFileNames(dicom_filenames)
    #dcm_img_sample = dcmread(dicom_filenames[0], stop_before_pixels=True)
#
    #source_image = reader.Execute()
#
    #segmentation = SimpleITK.ReadImage(label)
#
    #resampler = SimpleITK.ResampleImageFilter()
    #resampler.SetReferenceImage(source_image)
    #resampler.SetInterpolator(SimpleITK.sitkNearestNeighbor)  # Use nearest-neighbor for label images
    #resampler.SetOutputSpacing(source_image.GetSpacing())
    #resampler.SetOutputOrigin(source_image.GetOrigin())
    #resampler.SetOutputDirection(source_image.GetDirection())
    #resampled_segmentation = resampler.Execute(segmentation)
#
    #SimpleITK.WriteImage(resampled_segmentation, label)
#
    #seg_image = SimpleITK.ReadImage(label)
    #logger.info(f"Origin: {seg_image.GetOrigin()}")
    #logger.info(f"Spacing: {seg_image.GetSpacing()}")
    #logger.info(f"Direction: {seg_image.GetDirection()}")

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
