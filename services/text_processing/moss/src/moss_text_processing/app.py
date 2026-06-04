from __future__ import annotations

import base64
import json
import logging
import os
import tempfile
import threading
import time
import uuid
from importlib.metadata import PackageNotFoundError, version
from io import BytesIO
from pathlib import Path
from typing import Any, Iterator

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from PIL import Image
from pydantic import BaseModel

logger = logging.getLogger("uvicorn.error")

DEFAULT_MODEL_ID = "PatSnap/Hiro-MOSS-OCR-0.3B"
DEFAULT_LOCAL_MODEL_PATH = Path(__file__).resolve().parents[2] / ".hf-cache" / "models--PatSnap--Hiro-MOSS-OCR-0.3B"
DEFAULT_PROMPT = "Extract all text from this image. Return only the extracted text."
SERVICE_VERSION = "0.1.0"


class RuntimeConfig(BaseModel):
    model_id: str = DEFAULT_MODEL_ID
    model_path: str = str(DEFAULT_LOCAL_MODEL_PATH)
    default_prompt: str = DEFAULT_PROMPT
    max_new_tokens: int = 1024


class OpenAiImageUrl(BaseModel):
    url: str


class OpenAiMessagePart(BaseModel):
    type: str
    text: str | None = None
    image_url: OpenAiImageUrl | None = None


class OpenAiMessage(BaseModel):
    role: str
    content: str | list[OpenAiMessagePart] | None = None


class OpenAiChatRequest(BaseModel):
    model: str | None = None
    messages: list[OpenAiMessage]
    stream: bool = False
    max_tokens: int | None = None


def _package_version(name: str) -> str | None:
    try:
        return version(name)
    except PackageNotFoundError:
        return None


def _require_gpu() -> tuple[Any, str]:
    import torch

    if not torch.cuda.is_available():
        raise RuntimeError("Hiro-MOSS-OCR requires a CUDA GPU and will not run on CPU.")
    return torch, torch.cuda.get_device_name(0)


def _extract_image_payload(messages: list[OpenAiMessage]) -> bytes:
    for message in messages:
        content = message.content
        if isinstance(content, list):
            for part in content:
                if part.type != "image_url" or part.image_url is None:
                    continue
                url = part.image_url.url.strip()
                if not url.startswith("data:") or "," not in url:
                    raise ValueError("Only data URL images are supported")
                return base64.b64decode(url.split(",", 1)[1])
    raise ValueError("No image_url found in messages")


def _extract_prompt(messages: list[OpenAiMessage], fallback_prompt: str) -> str:
    texts: list[str] = []
    for message in messages:
        content = message.content
        if isinstance(content, str) and content.strip():
            texts.append(content.strip())
        elif isinstance(content, list):
            texts.extend(part.text.strip() for part in content if part.type == "text" and part.text and part.text.strip())
    return "\n".join(texts).strip() or fallback_prompt


def _build_openai_response(text: str, model: str) -> dict[str, Any]:
    return {
        "id": f"chatcmpl-{uuid.uuid4().hex}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [
            {
                "index": 0,
                "finish_reason": "stop",
                "message": {"role": "assistant", "content": text},
            }
        ],
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
    }


def _stream_chunk(completion_id: str, created: int, model: str, delta: dict[str, Any], finish_reason: str | None) -> str:
    payload = {
        "id": completion_id,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model,
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
    }
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


class MossRuntime:
    def __init__(self, config: RuntimeConfig):
        self.config = config
        self._lock = threading.Lock()
        self._ready = False
        self._torch: Any | None = None
        self._model: Any | None = None
        self._device_name: str | None = None

    def ensure_ready(self) -> None:
        if self._ready:
            return
        with self._lock:
            if self._ready:
                return
            torch, device_name = _require_gpu()
            from transformers import AutoModelForCausalLM

            model_source = self.config.model_path if Path(self.config.model_path).exists() else self.config.model_id
            logger.info("Initializing Hiro-MOSS-OCR model=%s gpu=%s", model_source, device_name)
            self._model = AutoModelForCausalLM.from_pretrained(
                model_source,
                trust_remote_code=True,
                dtype=torch.bfloat16,
                device_map={"": 0},
            ).eval()
            self._torch = torch
            self._device_name = device_name
            self._ready = True

    @property
    def device_name(self) -> str | None:
        return self._device_name

    def complete(self, image_payload: bytes, _prompt: str, max_new_tokens: int) -> str:
        self.ensure_ready()
        assert self._model is not None
        assert self._torch is not None
        fd, temp_path = tempfile.mkstemp(suffix=".png")
        os.close(fd)
        try:
            Image.open(BytesIO(image_payload)).convert("RGB").save(temp_path, format="PNG")
            with self._torch.inference_mode():
                texts = self._model.generate(temp_path, task="text", max_new_tokens=max_new_tokens)
            return (texts[0] if texts else "").strip()
        finally:
            try:
                os.remove(temp_path)
            except OSError:
                pass

    def stream(self, image_payload: bytes, prompt: str, max_new_tokens: int) -> Iterator[str]:
        created = int(time.time())
        completion_id = f"chatcmpl-{uuid.uuid4().hex}"
        model_name = self.config.model_id
        yield _stream_chunk(completion_id, created, model_name, {"role": "assistant"}, None)
        text = self.complete(image_payload, prompt, max_new_tokens)
        if text:
            yield _stream_chunk(completion_id, created, model_name, {"content": text}, None)
        yield _stream_chunk(completion_id, created, model_name, {}, "stop")
        yield "data: [DONE]\n\n"

    def health_payload(self) -> dict[str, Any]:
        gpu_name = self._device_name
        if gpu_name is None:
            try:
                _torch, gpu_name = _require_gpu()
            except Exception:  # noqa: BLE001
                gpu_name = None
        return {
            "ok": True,
            "detector": "moss",
            "version": SERVICE_VERSION,
            "features": {"detect": False, "openai_ocr": True},
            "execution_provider": {"openai_ocr": {"requested": "gpu", "resolved": "gpu" if gpu_name else "unavailable"}},
            "runtime": {
                "model_id": self.config.model_id,
                "model_path": self.config.model_path,
                "device": "cuda:0" if gpu_name else None,
                "gpu_name": gpu_name,
                "languages": ["en", "ja", "zh"],
                "packages": {
                    "transformers": _package_version("transformers"),
                    "torch": _package_version("torch"),
                    "opencv-python-headless": _package_version("opencv-python-headless"),
                },
            },
        }


def create_app(config: RuntimeConfig | None = None, runtime: Any | None = None) -> FastAPI:
    resolved_config = config or RuntimeConfig()
    service_runtime = runtime or MossRuntime(resolved_config)

    app = FastAPI(title="Hiro-MOSS-OCR Text Processing", version=SERVICE_VERSION)
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

    @app.get("/healthz")
    def healthz() -> dict[str, Any]:
        return service_runtime.health_payload()

    @app.get("/v1/models")
    async def models() -> dict[str, Any]:
        return {
            "object": "list",
            "data": [
                {
                    "id": resolved_config.model_id,
                    "object": "model",
                    "created": int(time.time()),
                    "owned_by": "moss-text-processing",
                }
            ],
        }

    @app.post("/v1/chat/completions", response_model=None)
    async def chat_completions(body: OpenAiChatRequest) -> dict[str, Any] | StreamingResponse:
        if body.model and body.model != resolved_config.model_id:
            raise HTTPException(status_code=400, detail=f"Unknown model: {body.model}")
        try:
            image_payload = _extract_image_payload(body.messages)
            prompt = _extract_prompt(body.messages, resolved_config.default_prompt)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error

        max_new_tokens = body.max_tokens or resolved_config.max_new_tokens
        try:
            if body.stream:
                return StreamingResponse(service_runtime.stream(image_payload, prompt, max_new_tokens), media_type="text/event-stream")
            text = service_runtime.complete(image_payload, prompt, max_new_tokens)
        except Exception as error:  # noqa: BLE001
            logger.exception("Hiro-MOSS-OCR request failed")
            raise HTTPException(status_code=500, detail=f"Hiro-MOSS-OCR failed: {error}") from error
        return _build_openai_response(text, resolved_config.model_id)

    return app
