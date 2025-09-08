# OHIF-AI

[Paper, ISBI 2025](https://ieeexplore.ieee.org/document/10981119)

## Prerequisite

- Install Docker, NVIDIA Container Toolkit

- tested version: Docker: 27.3.1, NVIDIA Container Toolkit: 1.16.2, CUDA Version: 12.6

## Getting Started

- Run `bash start.sh`
- Go to http://localhost:1026
- Upload all DICOM files in sample-data

## Demo Video

[![OHIF-SAM2 Demo](https://img.youtube.com/vi/oNDI-WBMWC0/0.jpg)](https://youtu.be/oNDI-WBMWC0)

[![Text prompt Demo](https://img.youtube.com/vi/lCZE3y52nec/0.jpg)](https://youtu.be/lCZE3y52nec)

## Highlights

- All prompts (Positive, Negative Points and Bounding Boxes) from SAM2 are supported. 

- Text prompt is additionally supported thanks to [GroundingDino](https://github.com/IDEA-Research/GroundingDINO) and [mmDetection](https://github.com/open-mmlab/mmdetection) Team.

- Two SAM2 buttons are available: SAM2_one (faster) for the slices where prompts are given, SAM2 for all slices via propagation.

- Multiple labels are supported - click nextObj button once it is done with the current label

## Updates

- Integrated Text prompt

- OHIF upgrade: 3.10-beta.48, cornerstone 2.0 -> Support partially 3D segmentation rendering

- Fixed flipping segmentation issue


## Next steps

- Support SAM2 for any label anytime: Currently, if a user pass to the next Obj, the user cannot reuse SAM2 for the old label, only manually edit

## (potential) FAQ

- Q: Load library (libnvidia-ml.so) failed from NVIDIA Container Toolkit
- A: Run `sudo apt-get install --reinstall docker-ce ` [Reference](https://github.com/NVIDIA/nvidia-container-toolkit/issues/305)

- Q: `Failed to initialize NVML: Unknown Error` Or `No CUDA available``
- A: Edit `no-cgroups = false`in `/etc/nvidia-container-runtime/config.toml` [Reference](https://forums.developer.nvidia.com/t/nvida-container-toolkit-failed-to-initialize-nvml-unknown-error/286219/2)

## How to Cite

```bibtex
@INPROCEEDINGS{10981119,
  author={Cho, Jaeyoung and Rastogi, Aditya and Liu, Jingyu and Schlamp, Kai and Vollmuth, Philipp},
  booktitle={2025 IEEE 22nd International Symposium on Biomedical Imaging (ISBI)}, 
  title={OHIF -SAM2: Accelerating Radiology Workflows with Meta Segment Anything Model 2}, 
  year={2025},
  volume={},
  number={},
  pages={1-5},
  keywords={Image segmentation;Limiting;Grounding;Foundation models;Biological system modeling;Radiology;Biomedical imaging;Web-Based Medical Imaging;Foundation Model;Segmentation;Artificial Intelligence},
  doi={10.1109/ISBI60581.2025.10981119}}
```
