# vLLM launch examples

This folder holds **example shell commands** for starting an [OpenAI-compatible](https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html) vLLM server on port **8000**. The MONAI Label infer path (`nnInter: "vllm"` in `basic_infer.py`) talks to that API; Docker Compose defaults to **`http://host.docker.internal:8000/v1`** via `VLLM_BASE_URL` (see repo `docker-compose.yml`).

## Start here: pick a recipe for your hardware

**For running your own local vision–language model (VLM) or any supported model, prefer the official community recipes:** **[https://recipes.vllm.ai/](https://recipes.vllm.ai/)**

There you can filter by provider, model size, precision, and GPU class, then copy a tuned `vllm serve` (or equivalent) line for your setup. The scripts below are **project-specific snapshots** and may assume many GPUs, long context, or local paths—treat them as references, not universal defaults.

## Scripts in this folder

| Script | Role |
|--------|------|
| **`qwen_vllm.sh`** | Large **Qwen3.5 MoE** (`Qwen/Qwen3.5-397B-A17B`) with tensor parallel 8, long `max-model-len`, and `reasoning-parser qwen3`. Sets conda `CUDA_HOME` / nvcc for FlashInfer JIT. |
| **`internVL_vllm.sh`** | **InternVL** from a **local** snapshot: set `MODEL_PATH`, pipeline/tensor parallel split, multimodal limits (`--limit-mm-per-prompt`), `--mm-processor-cache-gb 0` workaround for MM cache issues, `--trust-remote-code`. |
| **`kimi_vllm.sh`** | **Kimi-K2.5** via **`vllm/vllm-openai`** Docker image, HF cache volume, Kimi reasoning/tool parsers. Adjust `CUDA_VISIBLE_DEVICES` and image tag to match your environment. |
| **`gemma4_vllm.sh`** | **Gemma 4** (`google/gemma-4-31B-it`) in Docker with Gemma4 tool/reasoning parsers and chat template. |

## Before you run

1. **Install vLLM** (or use the Docker images as in `kimi_vllm.sh` / `gemma4_vllm.sh`) per [vLLM installation](https://docs.vllm.ai/en/latest/getting_started/installation.html).
2. **HF access**: models may require `huggingface-cli login` or `HF_TOKEN`; Docker examples often mount `~/.cache/huggingface`.
3. **Edit scripts**: replace `your_conda_env_path` / `your_model_path`, `CUDA_VISIBLE_DEVICES`, tensor/pipeline parallel sizes, and ports if 8000 is taken.
4. **MONAI / OHIF**: point the stack at your server with `VLLM_BASE_URL` (must include the `/v1` suffix for the OpenAI client).

## Further reading

- [vLLM Recipes](https://recipes.vllm.ai/) — curated `vllm serve` lines and hardware notes  
- [vLLM documentation](https://docs.vllm.ai/) — full CLI and serving options  
