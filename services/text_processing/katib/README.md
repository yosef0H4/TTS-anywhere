# Katib OCR Service

OpenAI-compatible OCR service for `oddadmix/Katib-Qwen3.5-0.8B-0.1`.

```powershell
uv run python launcher.py --host 127.0.0.1 --port 8096
```

The launcher creates a managed `.venv-gpu`, installs CUDA Torch, and starts `/v1/chat/completions` and `/v1/models`.

Run the model directly before API/UI tests:

```powershell
uv run python basic_usage_test.py --image ..\..\..\test-fixtures\ocr\arabic-basic.png
```
