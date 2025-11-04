# OHIF-AI

[![Docker](https://img.shields.io/badge/docker-required-blue.svg)](https://www.docker.com/)
[![CUDA](https://img.shields.io/badge/CUDA-12.6-green.svg)](https://developer.nvidia.com/cuda-toolkit)
[![YouTube](https://img.shields.io/badge/demo-video-red.svg)](https://youtu.be/z3aq3yd-KRA)

**Interactive AI segmentation for medical imaging, directly in your browser.**

OHIF-AI integrates state-of-the-art interactive segmentation models such as **nnInteractive** and **SAM2** into the **OHIF Viewer**, enabling convenient and accurate real-time, prompt-based segmentation of medical images directly in the browser.

By combining the capabilities of large foundation models with the familiar <a href="https://ohif.org/" target="_blank">OHIF</a> interface, users can guide AI segmentation using simple visual prompts — such as **points**, **scribbles**, **lassos**, or **bounding boxes** — to delineate anatomical structures or regions of interest within 2D or 3D DICOM images. The integration supports iterative refinement, live inference, and model selection, offering a flexible framework for researchers and clinicians to explore next-generation segmentation workflows without leaving the web environment.

---

## 📋 Table of Contents

- [Features](#-features)
- [Demo Video](#-demo-video)
- [Getting Started](#-getting-started)
- [Usage Guide](#-usage-guide)
  - [Segmentation Prompts](#segmentation-prompts)
  - [Running Inference](#running-inference)
  - [Positive and Negative Prompts](#positive-and-negative-prompts)
  - [Refine vs. New Segment](#refine-vs-new-segment)
  - [Model Selection](#model-selection)
- [Keyboard Shortcuts](#-keyboard-shortcuts)
- [FAQ](#-faq)
- [How to Cite](#-how-to-cite)
- [Contributing](#-contributing)
- [Acknowledgments](#-acknowledgments)

---

## ✨ Features

- 🖱️ **Interactive Segmentation** - Real-time AI segmentation with visual prompts
- 🚀 **Live Mode** - Automatic inference on every prompt
- 📦 **3D Propagation** - Single prompt automatically segments entire volume
- 🎯 **Multiple Prompt Types** - Points, scribbles, lassos, and bounding boxes
- 🤖 **Dual AI Models** - Choose between nnInteractive and SAM2
- 🌐 **Browser-Based** - No installation required, works directly in your web browser

---

## 🎥 Demo Video

<a href="https://youtu.be/z3aq3yd-KRA" target="_blank">
  <img src="https://img.youtube.com/vi/z3aq3yd-KRA/0.jpg" alt="Demo Video" width="700">
</a>

Click to watch the full demonstration of OHIF-AI in action.

---

## 🚀 Getting Started

### Prerequisites

- **Docker** (v27.3.1 or later)
- **NVIDIA Container Toolkit** (v1.16.2 or later)
- **CUDA** v12.6 or compatible version
- NVIDIA GPU with appropriate drivers

### Quick Start

1. **Clone the repository**
   ```bash
   git clone https://github.com/yourusername/ohif-ai.git
   cd ohif-ai
   ```

2. **Start the application**
   ```bash
   bash start.sh
   ```

3. **Access the viewer**
   
   Open your browser and navigate to: http://localhost:1026

4. **Load sample data**
   
   Upload all DICOM files from the `sample-data` directory

---

## 📖 Usage Guide

### Segmentation Prompts

The tool provides four different prompt types for segmentation (shown in red boxes from left to right):

<img src="docs/images/tools.png" alt="Segmentation Tools" width="700">

- **Point**: Click to indicate what you want to segment  
- **Scribble**: Paint over the structure to include  
- **Lasso**: Draw around and surround the structure inside the lasso  
- **Bounding Box**: Draw a rectangular box to surround the target structure  

<a href="docs/images/all_prompts.png" target="_blank">
  <img src="docs/images/all_prompts.png" alt="All Prompts Example" width="700">
</a>

### Running Inference

After providing prompts, you can run inference by clicking one of the manual inference buttons located next to the red box:

- **SAM2 inference**: Run segmentation using **SAM2**  
- **nnInteractive inference**: Run segmentation using **nnInteractive**  

**Live Mode**: To avoid manually clicking the inference button each time, enable **Live Mode**. Once enabled, the model will automatically segment the target structure on every prompt you provide.

💡 For both models, a single prompt (for example, a point or scribble on one slice) automatically propagates the segmentation across the entire 3D image stack, enabling volumetric segmentation from minimal user input.

<a href="docs/images/output.png" target="_blank">
  <img src="docs/images/output.png" alt="Output" width="700">
</a>
### Positive and Negative Prompts

You can exclude certain structures from your segmentation by toggling on the **neg.** (negative) button before providing prompts.

**Negative Scribble Example:**  
<a href="docs/images/scribble_pos_neg.png" target="_blank">
  <img src="docs/images/scribble_pos_neg.png" alt="Neg Scribble Example" width="700">
</a>

**Negative Point Example:**  
<a href="docs/images/point_pos_neg.png" target="_blank">
  <img src="docs/images/point_pos_neg.png" alt="Neg Point Example" width="700">
</a>

### Refine vs. New Segment

Use the **Refine/New** toggle to control segmentation behavior:

- **Refine**: Keep refining the current segment with additional prompts  
- **New**: Create a new, separate segment  

💡 You can revisit any existing segment at any time by selecting it from the segmentation list — once selected, new prompts will continue refining that specific segmentation interactively.

### Model Selection

Choose which segmentation model to use:

- **nnInteractive**: Supports all prompt types (point, scribble, lasso, bounding box)  
- **SAM2**: Currently supports positive/negative points and positive bounding boxes only

💡 Based on preliminary internal testing, nnInteractive provides faster inference and generally feels more real-time and accurate in typical clinical image segmentation tasks.

---

## ⌨️ Keyboard Shortcuts

For faster workflow, you can use the following keyboard shortcuts:

**Prompt Types:**
- `a` - Point
- `s` - Scribble
- `d` - Lasso
- `f` - Bounding box

**Mode Controls:**
- `q` - Toggle Live Mode
- `w` - Toggle Positive/Negative
- `e` - Toggle Refine/New
- `t` - Toggle nnInteractive/SAM2

---

## ❓ FAQ

<details>
<summary><b>Load library (libnvidia-ml.so) failed from NVIDIA Container Toolkit</b></summary>

**Solution:** Reinstall Docker CE
```bash
sudo apt-get install --reinstall docker-ce
```
[Reference](https://github.com/NVIDIA/nvidia-container-toolkit/issues/305)
</details>

<details>
<summary><b>Failed to initialize NVML: Unknown Error or "No CUDA available"</b></summary>

**Solution:** Edit `/etc/nvidia-container-runtime/config.toml` and set:
```toml
no-cgroups = false
```
[Reference](https://forums.developer.nvidia.com/t/nvida-container-toolkit-failed-to-initialize-nvml-unknown-error/286219/2)
</details>

---

## 📚 How to Cite

If you use OHIF-AI in your research, please cite:

**OHIF-SAM2:**
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
  doi={10.1109/ISBI60581.2025.10981119}
}
```

**nnInteractive:**
```bibtex
@misc{isensee2025nninteractiveredefining3dpromptable,
  title={nnInteractive: Redefining 3D Promptable Segmentation}, 
  author={Fabian Isensee and Maximilian Rokuss and Lars Krämer and Stefan Dinkelacker and Ashis Ravindran and Florian Stritzke and Benjamin Hamm and Tassilo Wald and Moritz Langenberg and Constantin Ulrich and Jonathan Deissler and Ralf Floca and Klaus Maier-Hein},
  year={2025},
  eprint={2503.08373},
  archivePrefix={arXiv},
  primaryClass={cs.CV},
  url={https://arxiv.org/abs/2503.08373}
}
```

**SAM2:**
```bibtex
@misc{ravi2024sam2segmentimages,
  title={SAM 2: Segment Anything in Images and Videos}, 
  author={Nikhila Ravi and Valentin Gabeur and Yuan-Ting Hu and Ronghang Hu and Chaitanya Ryali and Tengyu Ma and Haitham Khedr and Roman Rädle and Chloe Rolland and Laura Gustafson and Eric Mintun and Junting Pan and Kalyan Vasudev Alwala and Nicolas Carion and Chao-Yuan Wu and Ross Girshick and Piotr Dollár and Christoph Feichtenhofer},
  year={2024},
  eprint={2408.00714},
  archivePrefix={arXiv},
  primaryClass={cs.CV},
  url={https://arxiv.org/abs/2408.00714}
}
```

**Papers:**
- [OHIF-SAM2 (IEEE ISBI 2025)](https://ieeexplore.ieee.org/document/10981119)
- [nnInteractive (arXiv)](https://arxiv.org/abs/2503.08373)
- [SAM2 (arXiv)](https://arxiv.org/abs/2408.00714)

---

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request. For major changes, please open an issue first to discuss what you would like to change.

---

## 🙏 Acknowledgments

This project builds upon:
- [OHIF Viewer](https://ohif.org/) - Open Health Imaging Foundation Viewer
- [SAM2](https://arxiv.org/abs/2408.00714) - Segment Anything Model 2 by Meta
- [nnInteractive](https://arxiv.org/abs/2503.08373) - Interactive 3D Segmentation Framework



