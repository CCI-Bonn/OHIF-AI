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

# syntax=docker/dockerfile:1.7-labs

# ── Stage 1: deps ────────────────────────────────────────────────────────────
# Rebuilds only when requirements.txt, sam2/, or sam3/ change.
# Switch from cuda:devel (~6 GB) to cuda:runtime (~3 GB) — inference needs no compiler.
FROM nvidia/cuda:12.1.1-runtime-ubuntu22.04 AS deps

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    apt-get update -y && apt-get install -y --no-install-recommends \
    openslide-tools \
    build-essential \
    python3-pip \
    python3-dev \
    python-is-python3 \
    ffmpeg \
    libsm6 \
    libxext6 \
    libxcb-xinerama0 \
    libxcb1 \
    wget \
    git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /code
RUN mkdir -p /install /install-3

COPY ./sam2/. /install/
COPY ./sam3/. /install-3/
COPY ./monai-label/requirements.txt ./

RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --upgrade pip setuptools wheel && \
    pip install -e /install/. && \
    pip install -e /install-3/. && \
    pip install -r requirements.txt

# ── Stage 2: app ─────────────────────────────────────────────────────────────
# Rebuilds only when monai-label/* code changes.
FROM deps AS app

RUN mkdir -p /code/assets /code/checkpoints /code/apps
COPY ./sam3/assets/bpe_simple_vocab_16e6.txt.gz /code/assets/

ENV LD_LIBRARY_PATH="/usr/local/nvidia/lib64"
ENV PATH="$PATH:/code/monailabel/scripts"
ENV PYTHONPATH="/code"

RUN rm -rf /usr/local/lib/python3.10/dist-packages/dicomweb_client/web.py
COPY ./monai-label/backup/web.py /usr/local/lib/python3.10/dist-packages/dicomweb_client/

COPY ./monai-label/. ./

COPY ./monai-label/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8002
ENTRYPOINT ["/entrypoint.sh"]
CMD ["python", "-m", "monailabel.main", "start_server", "--app", "/code/apps/radiology", "--studies", "http://orthanc:8042/dicom-web", "--conf", "models", "segmentation", "--conf", "use_pretrained_model", "false", "-p", "8002"]
