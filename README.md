# OHIF-AI

[![Docker](https://img.shields.io/badge/docker-required-blue.svg)](https://www.docker.com/)
[![CUDA](https://img.shields.io/badge/CUDA-12.6-green.svg)](https://developer.nvidia.com/cuda-toolkit)
[![YouTube](https://img.shields.io/badge/demo-video-red.svg)](https://youtu.be/z3aq3yd-KRA)

**Interactive AI segmentation and report generation for medical imaging, directly in your browser.**

OHIF-AI brings two main capabilities into the <a href="https://ohif.org/" target="_blank">OHIF Viewer</a>:

1. **Segmentation** — Interactive AI segmentation for medical imaging using **visual prompts** (points, scribbles, lassos, bounding boxes) with models such as **nnInteractive**, **SAM2**, **MedSAM2**, and **SAM3**, or using **text prompts** with **VoxTell**. Supports iterative refinement, live inference, and 3D propagation from minimal input.
2. **Report generation** — AI-assisted radiology-style reports from 3D CT/MRI. Choose **local MedGemma** (Hugging Face checkpoints) or **frontier / open-weight VLMs** via **provider APIs** (e.g. **Gemini**, **GPT**, **Claude**) or the **Hugging Face inference router** (**Kimi**, **Qwen**, **Gemma 4**), or a **self-hosted OpenAI-compatible server** such as **[vLLM](https://docs.vllm.ai/)** (e.g. **InternVL**, **Qwen**, **Kimi**, **Gemma 4**, depending on what you serve).

By combining these foundation models with the familiar OHIF interface, researchers and clinicians can perform prompt-based segmentation and generate reports without leaving the web environment.

---

## 📋 Table of Contents

- [Features](#-features)
- [Demo Video](#-demo-video)
- [Getting Started](#-getting-started)
- [Local MedGemma GPUs](#local-medgemma-gpus)
- [Environment variables and API keys](#environment-variables-and-api-keys)
- [Usage Guide](#-usage-guide)
  - [Segmentation](#segmentation)
    - [Visual prompts](#visual-prompts)
    - [Model selection & inference](#model-selection)
    - [Text-prompt segmentation](#text-prompt-segmentation)
  - [Report generation](#report-generation)
- [Keyboard Shortcuts](#%EF%B8%8F-keyboard-shortcuts)
- [FAQ](#-faq)
- [How to Cite](#-how-to-cite)
- [Contributing](#-contributing)
- [Acknowledgments](#-acknowledgments)

---

## ✨ Features

**Segmentation (medical imaging)**  
- 🖱️ **Visual prompts** — Real-time segmentation with points, scribbles, lassos, and bounding boxes  
- 📝 **Text prompts** — Free-form text to obtain segmentation (see [Text-prompt segmentation](#text-prompt-segmentation) for usage and important notices)  
- 🚀 **Live mode** — Automatic inference on every prompt  
- 📦 **3D propagation** — Single prompt segments the entire volume  
- 🤖 **Multiple models** — nnInteractive, SAM2, MedSAM2, SAM3, and VoxTell  

**Report generation**  
- 📄 **Flexible VLMs** — Local **MedGemma** (e.g. 1.5–4B and **27B IT** on GPU), or cloud / router models (**Gemini**, **GPT**, **Claude**, **Kimi**, **Qwen**, **Gemma 4**), or **vLLM** on your own machine for open-weight multimodal models such as **InternVL**  
- 🔑 **Your keys, your stack** — Provider credentials and Hugging Face token are configured in a **`.env`** file you maintain (see [below](#environment-variables-and-api-keys))  

**General**  
- 🌐 **Browser-based** — No local installation; runs in the web browser

---

## 🎥 Demo Video

<a href="https://youtu.be/z3aq3yd-KRA" target="_blank">
  <img src="https://img.youtube.com/vi/z3aq3yd-KRA/maxresdefault.jpg" alt="Demo Video" width="700">
</a>

Click to watch the full demonstration of OHIF-AI in action.

---

## 🚀 Getting Started

### Prerequisites

- **Docker** (v27.3.1 or later)
- **Docker Compose** — if `docker compose` is not available, install the plugin:
  ```bash
  mkdir -p ~/.docker/cli-plugins
  curl -SL https://github.com/docker/compose/releases/download/v2.27.1/docker-compose-linux-x86_64 \
    -o ~/.docker/cli-plugins/docker-compose
  chmod +x ~/.docker/cli-plugins/docker-compose
  ```
- **NVIDIA Container Toolkit** (v1.16.2 or later)
- **CUDA** v12.6 or compatible version
- NVIDIA GPU with appropriate drivers

### Model Checkpoints

Model checkpoints are typically downloaded automatically during setup. However, if you encounter issues with automatic downloads, you can manually download them:

**Automatically Downloaded Models:**
- **nnInteractive**: [Hugging Face](https://huggingface.co/nnInteractive/nnInteractive)
- **SAM2** (sam2.1-hiera-tiny): [Hugging Face](https://huggingface.co/facebook/sam2.1-hiera-tiny)
- **MedSAM2** (MedSAM2_latest): [Hugging Face](https://huggingface.co/wanglab/MedSAM2)
- **VoxTell**: [Hugging Face](https://huggingface.co/mrokuss/VoxTell)
- **MedGemma** (local HF): [1.5–4B IT](https://huggingface.co/google/medgemma-1.5-4b-it), [27B IT](https://huggingface.co/google/medgemma-27b-it) — authenticated download via **`HF_TOKEN`** in your **`.env`** (recommended) or environment; see [Environment variables and API keys](#environment-variables-and-api-keys). Larger weights (especially **27B**) need plenty of VRAM.

### Local MedGemma GPUs

- **`docker-compose.yml`** → **`monai_server`** → **`CUDA_VISIBLE_DEVICES`**: which **host** GPUs the container sees (logical `cuda:0`, …; shared with segmentation).
- **`basic_infer.py`** → **`_medgemma_get_processor_and_model`** → **`gem_model_kwargs`**: default **`device_map="auto"`** + **`max_memory`** per logical GPU; adjust caps or use **`device_map={"": "cuda:0"}`** to pin one GPU.
- Rebuild / restart MONAI after editing **`basic_infer.py`**. Not configured via `.env`.

Default in the repo (logical GPUs **0** and **1**, **40GiB** cap each — tune to your cards):

```python
gem_model_kwargs = dict(
    dtype=torch.bfloat16,
    device_map="auto",
    max_memory={0: "40GiB", 1: "40GiB"},
    offload_buffers=True,
)
```

**Manual Download Required:**

**SAM3 Model:**
1. Request access to the SAM3 model on [Hugging Face](https://huggingface.co/facebook/sam3)
2. Once access is granted, download the model checkpoint
3. Place the downloaded file as `sam3.pt` in the `monai-label/checkpoints/` directory

⚠️ **Note:** If the SAM3 checkpoint is not found, you will see a warning message and SAM3 will not be available for use. The application will continue to work with other segmentation models (nnInteractive, SAM2, MedSAM2, VoxTell) and report generation backends you have configured.

![SAM3 Not Found Warning](docs/images/sam3_not_found.png)

### Quick Start

1. **Clone the repository**
   ```bash
   git clone https://github.com/CCI-Bonn/OHIF-AI.git
   cd OHIF-AI
   ```

2. **Start the application**
   ```bash
   bash start.sh
   ```

3. **Access the viewer**
   
   Open your browser and navigate to: http://localhost:1026

4. **Load sample data**
   
   Upload all DICOM files from the `sample-data` directory

### Environment variables and API keys

Report generation can call **Hugging Face** (Hub downloads and/or the **Kimi**, **Qwen**, and **Gemma 4** router), **Google Gemini**, **OpenAI**, **Anthropic (Claude)**, and optionally **vLLM** on your host. **You must supply your own secrets**; nothing in the repo should contain real keys.

1. **Copy the template** in the project root (same folder as `docker-compose.yml`):
   ```bash
   cp .env-sample .env
   ```
2. **Edit `.env`** and fill in only the providers you use. Docker Compose reads `.env` automatically and passes values into the `monai_server` container (see `docker-compose.yml` → `environment`). The MONAI infer task resolves keys from the **infer request** first, then from **these environment variables**:
   - **`HF_TOKEN`** — Hugging Face token ([create a token](https://huggingface.co/settings/tokens)): authenticated downloads (e.g. MedGemma) and **Hugging Face router** VLMs (Kimi / Qwen / Gemma 4).
   - **`GEMINI_API_KEY`** — [Google AI Studio](https://aistudio.google.com/apikey) for Gemini.
   - **`OPENAI_API_KEY`** — [OpenAI](https://platform.openai.com/api-keys) for GPT-class models.
   - **`ANTHROPIC_API_KEY`** — [Anthropic](https://console.anthropic.com/) for Claude.
   - **`VLLM_BASE_URL`** — Optional override for a **local OpenAI-compatible vLLM** server (default in Compose: `http://host.docker.internal:8000/v1` so the container can reach vLLM on the host).

3. **File permissions** — Treat `.env` as secret (e.g. `chmod 600 .env`). **Never commit `.env`**; it is gitignored.

For **self-hosted vLLM** (open-weight multimodal models such as InternVL, Qwen, Kimi, Gemma 4, etc.), see the **[`vllm/`](vllm/)** folder and **[vLLM Recipes](https://recipes.vllm.ai/)** for hardware-matched `vllm serve` examples.

---

## 📖 Usage Guide

### Segmentation

OHIF-AI supports interactive segmentation in two ways: **visual prompts** (points, scribbles, lassos, bounding boxes) and **text prompts**. Visual prompts are described below; text-prompt segmentation has its own subsection with usage and important notices.

#### Visual prompts

The tool provides four visual prompt types for segmentation (shown in red boxes from left to right):

<img src="docs/images/tools.png" alt="Segmentation Tools" width="700">

- **Point**: Click to indicate what you want to segment  
- **Scribble**: Paint over the structure to include  
- **Lasso**: Draw around and surround the structure inside the lasso  
- **Bounding Box**: Draw a rectangular box to surround the target structure  

<a href="docs/images/all_prompts.png" target="_blank">
  <img src="docs/images/all_prompts.png" alt="All Prompts Example" width="700">
</a>

#### Model selection

Choose which segmentation model to use:

- **nnInteractive**: Supports all prompt types (point, scribble, lasso, bounding box)  
- **SAM2/MedSAM2/SAM3**: Currently supports positive/negative points and positive bounding boxes only

💡 Based on preliminary internal testing, nnInteractive provides faster inference and generally feels more real-time and accurate in typical clinical image segmentation tasks.

#### Running inference

After providing prompts and choosing the model, you can run inference by clicking the inference button located next to the red box:

**Live Mode**: To avoid manually clicking the inference button each time, enable **Live Mode**. Once enabled, the model will automatically segment the target structure on every prompt you provide.

💡 For all models, a single prompt (for example, a point or scribble on one slice) automatically propagates the segmentation across the entire 3D image stack, enabling volumetric segmentation from minimal user input.

<a href="docs/images/output.png" target="_blank">
  <img src="docs/images/output.png" alt="Output" width="700">
</a>

#### Positive and negative prompts

You can exclude certain structures from your segmentation by toggling on the **neg.** (negative) button before providing prompts.

**Negative Scribble Example:**  
<a href="docs/images/scribble_pos_neg.png" target="_blank">
  <img src="docs/images/scribble_pos_neg.png" alt="Neg Scribble Example" width="700">
</a>

**Negative Point Example:**  
<a href="docs/images/point_pos_neg.png" target="_blank">
  <img src="docs/images/point_pos_neg.png" alt="Neg Point Example" width="700">
</a>

#### Refine vs. new segment

Use the **Refine/New** toggle to control segmentation behavior:

- **Refine**: Keep refining the current segment with additional prompts  
- **New**: Create a new, separate segment  

💡 You can revisit any existing segment at any time by selecting it from the segmentation list — once selected, new prompts will continue refining that specific segmentation interactively.

#### Text-prompt segmentation

**VoxTell** is part of the segmentation workflow: it produces segmentations from **free-form text** instead of visual prompts. Describe the structure or region you want to segment in natural language.

- **Replace current segment** – Use your text prompt to replace the currently selected segment.
- **Add segment label** – Create an additional segment with a new label from your text prompt.

**Notices:**

- ⚠️ **Cross-usage with nnInteractive** — Not supported yet (e.g., VoxTell → nnInteractive). Use VoxTell and nnInteractive in separate workflows.

<a href="docs/images/text_prompt.png" target="_blank">
  <img src="docs/images/text_prompt.png" alt="Text-Prompt Segmentation (VoxTell)" width="700">
</a>

**VoxTell demo:**

<a href="https://youtu.be/NOajvjTfGnU" target="_blank">
  <img src="https://img.youtube.com/vi/NOajvjTfGnU/maxresdefault.jpg" alt="VoxTell Demo" width="700">
</a>

### Report generation

Radiology-style reports from **3D CT/MRI** are separate from segmentation. In the OHIF toolbox you choose a **report backend** (local MedGemma, a cloud API, the Hugging Face router, or **vLLM**), then set **Instruction**, **Query**, and **slice range** as before.

| Path | Examples | How it runs |
|------|------------|-------------|
| **Local MedGemma (Hugging Face)** | MedGemma **1.5–4B IT**, **27B IT** | **`HF_TOKEN`** in `.env`; GPUs: [Local MedGemma GPUs](#local-medgemma-gpus). |
| **Provider APIs** | **Gemini**, **GPT**, **Claude** | Calls the vendor API; set **`GEMINI_API_KEY`**, **`OPENAI_API_KEY`**, or **`ANTHROPIC_API_KEY`** in `.env` (or pass keys per request where supported). |
| **Hugging Face inference router** | **Kimi**, **Qwen**, **Gemma 4** | OpenAI-compatible router; uses **`HF_TOKEN`**. |
| **Local vLLM** | **InternVL**, **Qwen**, **Kimi**, **Gemma 4**, … (whatever you serve) | Run **[vLLM](https://docs.vllm.ai/)** (or compatible server) on the host; MONAI defaults to **`VLLM_BASE_URL`** → `http://host.docker.internal:8000/v1`. Pick a model id and GPU layout using **[vLLM Recipes](https://recipes.vllm.ai/)** and the scripts in **[`vllm/`](vllm/README.md)**. |

**Panel fields (all backends):**

- **Instruction** — Broad role (e.g. “You are a radiology assistant”) and style.
- **Query** — What you want in the report (findings, impression, structured sections, etc.).
- **Slice range** — Which slices of the 3D stack to send (e.g. 10–50).

**Notices:**

- ⚠️ **Secrets** — Configure **your own** `.env` from **`.env-sample`**; never commit real API keys. See [Environment variables and API keys](#environment-variables-and-api-keys).
- ⚠️ **GPU / VRAM (local MedGemma)** — [Local MedGemma GPUs](#local-medgemma-gpus).
- ⚠️ **vLLM** — You are responsible for starting the server, model compatibility, and **`VLLM_BASE_URL`** if not on the default host port.

**MedGemma (local)** — model variant and **Thinking**:

<a href="docs/images/medgemma.png" target="_blank">
  <img src="docs/images/medgemma.png" alt="VLM Report Generation with MedGemma" width="700">
</a>

**OpenAI** — API **model id** and **Reasoning effort**:

<a href="docs/images/gpt.png" target="_blank">
  <img src="docs/images/gpt.png" alt="VLM Report Generation with OpenAI" width="700">
</a>

**VoxTell + MedGemma demo:**

<a href="https://youtu.be/Rl-LKu_wWMQ" target="_blank">
  <img src="https://img.youtube.com/vi/Rl-LKu_wWMQ/maxresdefault.jpg" alt="VoxTell + MedGemma Demo" width="700">
</a>

---

## ⌨️ Keyboard Shortcuts

For faster workflow, you can use the following keyboard shortcuts:

**Prompt Tools:**
- `p` - Point
- `s` - Scribble
- `l` - Lasso
- `b` - Bounding box

**Segment Management:**
- `m` - Add Segment
- `r` - Reset active Segment (clears prompts and mask)

**Mode Controls:**
- `q` - Toggle Live Mode
- `t` - Toggle Positive/Negative

<a href="docs/images/hotkeys.png" target="_blank">
  <img src="docs/images/hotkeys.png" alt="List of hotkeys" width="700">
</a>

You can view other keyboard shortcuts and customize them in the **Settings** menu (located in the top-right corner). Select **Preferences** to access the hotkey configuration panel.

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

**MedSAM2:**
```bibtex
@article{MedSAM2,
    title={MedSAM2: Segment Anything in 3D Medical Images and Videos},
    author={Ma, Jun and Yang, Zongxin and Kim, Sumin and Chen, Bihui and Baharoon, Mohammed and Fallahpour, Adibvafa and Asakereh, Reza and Lyu, Hongwei and Wang, Bo},
    journal={arXiv preprint arXiv:2504.03600},
    year={2025}
}
```

**SAM3:**
```bibtex
@misc{carion2025sam3segmentconcepts,
      title={SAM 3: Segment Anything with Concepts}, 
      author={Nicolas Carion and Laura Gustafson and Yuan-Ting Hu and Shoubhik Debnath and Ronghang Hu and Didac Suris and Chaitanya Ryali and Kalyan Vasudev Alwala and Haitham Khedr and Andrew Huang and Jie Lei and Tengyu Ma and Baishan Guo and Arpit Kalla and Markus Marks and Joseph Greer and Meng Wang and Peize Sun and Roman Rädle and Triantafyllos Afouras and Effrosyni Mavroudi and Katherine Xu and Tsung-Han Wu and Yu Zhou and Liliane Momeni and Rishi Hazra and Shuangrui Ding and Sagar Vaze and Francois Porcher and Feng Li and Siyuan Li and Aishwarya Kamath and Ho Kei Cheng and Piotr Dollár and Nikhila Ravi and Kate Saenko and Pengchuan Zhang and Christoph Feichtenhofer},
      year={2025},
      eprint={2511.16719},
      archivePrefix={arXiv},
      primaryClass={cs.CV},
      url={https://arxiv.org/abs/2511.16719}, 
}
```

**VoxTell:**
```bibtex
@misc{rokuss2025voxtell,
  title={VoxTell: Free-Text Promptable Universal 3D Medical Image Segmentation}, 
  author={Maximilian Rokuss and Moritz Langenberg and Yannick Kirchhoff and Fabian Isensee and Benjamin Hamm and Constantin Ulrich and Sebastian Regnery and Lukas Bauer and Efthimios Katsigiannopulos and Tobias Norajitra and Klaus Maier-Hein},
  year={2025},
  eprint={2511.11450},
  archivePrefix={arXiv},
  primaryClass={cs.CV},
  url={https://arxiv.org/abs/2511.11450}
}
```

**Papers:**
- [OHIF-SAM2 (IEEE ISBI 2025)](https://ieeexplore.ieee.org/document/10981119)
- [nnInteractive (arXiv)](https://arxiv.org/abs/2503.08373)
- [SAM2 (arXiv)](https://arxiv.org/abs/2408.00714)
- [MedSAM2 (arXiv)](https://arxiv.org/abs/2504.03600)
- [SAM3 (arXiv)](https://arxiv.org/abs/2511.16719)
- [VoxTell (arXiv)](https://arxiv.org/abs/2511.11450)

---

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request. For major changes, please open an issue first to discuss what you would like to change.

---

## 🙏 Acknowledgments

This project builds upon:
- [OHIF Viewer](https://ohif.org/) - Open Health Imaging Foundation Viewer
- [SAM2](https://github.com/facebookresearch/sam2) - Segment Anything Model 2 by Meta
- [nnInteractive](https://github.com/MIC-DKFZ/nnInteractive) - Interactive 3D Segmentation Framework
- [MedSAM2](https://github.com/bowang-lab/MedSAM2) - MedSAM2 by Bowang lab
- [SAM3](https://github.com/facebookresearch/sam3) - Segment Anything Model 3 by Meta
- [VoxTell](https://github.com/MIC-DKFZ/VoxTell) - Free-Text Promptable Universal 3D Medical Image Segmentation
- [MedGemma](https://github.com/Google-Health/medgemma) - Local report generation from 3D medical images ([Google Research Blog](https://research.google/blog/next-generation-medical-image-interpretation-with-medgemma-15-and-medical-speech-to-text-with-medasr/))
- [vLLM](https://github.com/vllm-project/vllm) - Optional self-hosted OpenAI-compatible serving for open-weight VLMs; see also [vLLM Recipes](https://recipes.vllm.ai/)



