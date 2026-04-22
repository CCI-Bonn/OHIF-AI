# Set the path to the specific snapshot folder
export MODEL_PATH="your_model_path"

export CUDA_LAUNCH_BLOCKING=1
export VLLM_LOGGING_LEVEL=DEBUG
# Avoid VLLM_ALLOW_LONG_MAX_MODEL_LEN=1: it can cause "index out of bounds: 0 <= tmp16 < 40960"
# in compiled kernels (vLLM issue #17924). If startup fails for max-model-len 131072, try --max-model-len 32768.
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

export CUDA_VISIBLE_DEVICES=0,2,3,4,5,6,7
# Launch vLLM with the local path
# Workaround for vLLM MM cache AssertionError ("Expected a cached item for mm_hash"):
# disable the multimodal preprocessor cache (avoids P0/engine cache desync with pipeline parallel).
python -m vllm.entrypoints.openai.api_server \
    --model $MODEL_PATH \
    --tensor-parallel-size 1 \
    --pipeline-parallel-size 7 \
    --limit-mm-per-prompt '{"image": 450}' \
    --trust-remote-code \
    --mm-processor-cache-gb 0 \
    --gpu-memory-utilization 0.95 \
    --enforce-eager
