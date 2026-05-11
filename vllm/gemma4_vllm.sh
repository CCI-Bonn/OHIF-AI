export CUDA_LAUNCH_BLOCKING=1
export VLLM_LOGGING_LEVEL=DEBUG

docker run --gpus all \
  --ipc=host -p 8000:8000 \
  -v ~/.cache/huggingface:/root/.cache/huggingface \
  vllm/vllm-openai:gemma4 google/gemma-4-31B-it \
  --tensor-parallel-size 1 \
  --enable-auto-tool-choice \
  --tool-call-parser gemma4 \
  --chat-template examples/tool_chat_template_gemma4.jinja \
  --reasoning-parser gemma4
