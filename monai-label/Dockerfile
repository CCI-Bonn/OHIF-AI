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

FROM nvidia/cuda:12.1.1-devel-ubuntu22.04
#FROM python:3.10-slim

RUN apt update -y && apt install -y openslide-tools build-essential python3-pip python3-dev python-is-python3 ffmpeg libsm6 libxext6 libxcb-xinerama0 libxcb1 wget git

WORKDIR /code
RUN mkdir -p /install
COPY ./monai-label/requirements.txt ./
COPY ./sam2/. /install/
#ENV LD_LIBRARY_PATH=$LD_LIBRARY_PATH":/usr/lib/x86_64-linux-gnu:"
ENV LD_LIBRARY_PATH=$LD_LIBRARY_PATH:"/usr/local/nvidia/lib64"

RUN pip install --upgrade pip setuptools wheel
RUN pip install -e /install/.
RUN pip install --no-cache-dir -r requirements.txt
#RUN pip install emoji ddd-dataset
#RUN pip install "git+https://github.com/lvis-dataset/lvis-api.git"

#RUN mim install mmengine
#RUN mim install "mmcv>=2.0.0rc4,<2.2.0"
#RUN mim install mmdet

COPY ./monai-label/. ./

ENV WEIGHTS_DIR="/code/checkpoints/"
# SAM2 weights
#ENV WEIGHTS_URL="https://dl.fbaipublicfiles.com/segment_anything_2/072824/sam2_hiera_large.pt"
# SAM2.1 weights
ENV WEIGHTS_URL="https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_tiny.pt"
RUN wget --directory-prefix ${WEIGHTS_DIR} ${WEIGHTS_URL}

# MEDSAM2 (Jun Ma) weights
ENV MEDSAM2_WEIGHTS_URL="https://huggingface.co/wanglab/MedSAM2/resolve/main/MedSAM2_latest.pt"
RUN wget --directory-prefix ${WEIGHTS_DIR} ${MEDSAM2_WEIGHTS_URL}

#ENV GD_URL="https://download.openmmlab.com/mmdetection/v3.0/mm_grounding_dino/grounding_dino_swin-t_pretrain_obj365_goldg_grit9m_v3det/grounding_dino_swin-t_pretrain_obj365_goldg_grit9m_v3det_20231204_095047-b448804b.pth"

#RUN wget --directory-prefix ${WEIGHTS_DIR} ${GD_URL}

RUN rm -rf /usr/local/lib/python3.10/dist-packages/dicomweb_client/web.py

COPY ./monai-label/backup/web.py /usr/local/lib/python3.10/dist-packages/dicomweb_client/

ENV CUDA_VISIBLE_DEVICES=1
ENV PATH=$PATH":/code/monailabel/scripts"

RUN monailabel apps --download --name radiology --output /code/apps
EXPOSE 8002
CMD ["monailabel", "start_server", "--app", "/code/apps/radiology", "--studies", "http://ohif_orthanc:1026/pacs/dicom-web", "--conf", "models", "segmentation", "--conf", "use_pretrained_model", "false", "-p", "8002"]