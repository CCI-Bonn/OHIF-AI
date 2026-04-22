# Kimi-K2.5 via vLLM OpenAI-compatible server.
# Optional: set MODEL_PATH to a local snapshot (e.g. from HF cache) instead of hub id.
# export MODEL_PATH="/path/to/moonshotai-Kimi-K2.5/snapshots/..."

export CUDA_LAUNCH_BLOCKING=1
export VLLM_LOGGING_LEVEL=DEBUG
# Avoid VLLM_ALLOW_LONG_MAX_MODEL_LEN=1: it can cause "index out of bounds" in compiled kernels.
# export VLLM_ALLOW_LONG_MAX_MODEL_LEN=1

# Force CUDA/nvcc from conda env so FlashInfer JIT build does not use /usr/local/cuda-12.8 (no nvcc there)
CUDA_ENV="${CONDA_PREFIX:-your_conda_env_path}"
export CUDA_HOME="$CUDA_ENV"
export PATH="$CUDA_HOME/bin:$PATH"
export LD_LIBRARY_PATH="$CUDA_HOME/lib:$CUDA_HOME/lib64:/usr/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH:-}"
# Linker needs to find libcuda.so (driver lib) for FlashInfer JIT build
export LIBRARY_PATH="/usr/lib/x86_64-linux-gnu:$CUDA_HOME/lib64:${LIBRARY_PATH:-}"
export VLLM_NVCC_EXECUTABLE="$CUDA_HOME/bin/nvcc"
# FlashInfer / CMake respect CUDA_HOME and CMAKE_CUDA_COMPILER
export CMAKE_CUDA_COMPILER="$CUDA_HOME/bin/nvcc"

nvcc --version

export CUDA_VISIBLE_DEVICES=0,3,4,5

docker run --gpus all \
  -p 8000:8000 \
  -e VLLM_ENABLE_CUDA_COMPATIBILITY=1 \
  -e PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True \
  --ipc=host \
  -v /raid/Users/cho/.cache/huggingface:/root/.cache/huggingface \
  vllm/vllm-openai:v0.17.0-cu130 moonshotai/Kimi-K2.5 \
    --tensor-parallel-size 8 \
    --mm-encoder-tp-mode data \
    --gpu-memory-utilization 0.96 \
    --max-model-len auto \
    --compilation_config.pass_config.fuse_allreduce_rms true \
    --tool-call-parser kimi_k2 \
    --reasoning-parser kimi_k2 \
    --enable-auto-tool-choice \
    --trust-remote-code \
    --mm-processor-cache-gb 64 \
    --mm-processor-cache-type shm \
