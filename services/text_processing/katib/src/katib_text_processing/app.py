from __future__ import annotations

import base64
import asyncio
import json
import logging
import os
import queue
import threading
import time
import uuid
from dataclasses import dataclass
from importlib.metadata import PackageNotFoundError, version
from io import BytesIO
from typing import Any, Iterator

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from PIL import Image
from pydantic import BaseModel

logger = logging.getLogger("uvicorn.error")

DEFAULT_MODEL_ID = "oddadmix/Katib-Qwen3.5-0.8B-0.1"
DEFAULT_PROMPT = "Free OCR"
SERVICE_VERSION = "0.1.0"

os.environ.setdefault("HF_HUB_DISABLE_XET", "1")


class RuntimeConfig(BaseModel):
    model_id: str = DEFAULT_MODEL_ID
    hf_cache_dir: str | None = None
    default_prompt: str = DEFAULT_PROMPT
    max_new_tokens: int = 512
    max_image_long_edge: int = 1280


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


@dataclass
class PreparedRequest:
    inputs: Any
    prompt_length: int


def _package_version(name: str) -> str | None:
    try:
        return version(name)
    except PackageNotFoundError:
        return None


def _require_gpu() -> tuple[Any, str]:
    import torch

    if not torch.cuda.is_available():
        raise RuntimeError("Katib OCR requires a CUDA GPU and will not run on CPU.")
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


def _resize_for_ocr(image: Image.Image, max_long_edge: int) -> Image.Image:
    width, height = image.size
    longest = max(width, height)
    if max_long_edge <= 0 or longest <= max_long_edge:
        return image
    scale = max_long_edge / longest
    resized = image.resize((max(1, round(width * scale)), max(1, round(height * scale))), Image.Resampling.LANCZOS)
    logger.info("Resized Katib OCR image from %sx%s to %sx%s", width, height, resized.width, resized.height)
    return resized


def _build_openai_response(text: str, model: str | None) -> dict[str, Any]:
    created = int(time.time())
    return {
        "id": f"chatcmpl-{uuid.uuid4().hex}",
        "object": "chat.completion",
        "created": created,
        "model": model or DEFAULT_MODEL_ID,
        "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": text}}],
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


class KatibRuntime:
    def __init__(self, config: RuntimeConfig):
        self.config = config
        self._lock = threading.Lock()
        self._ready = False
        self._torch: Any | None = None
        self._device_name: str | None = None
        self._model: Any | None = None
        self._processor: Any | None = None
        self._generate_lock = threading.Lock()

    def ensure_ready(self) -> None:
        if self._ready:
            return
        with self._lock:
            if self._ready:
                return
            torch, device_name = _require_gpu()
            from transformers import AutoModelForImageTextToText, AutoProcessor

            logger.info("Initializing Katib model=%s gpu=%s", self.config.model_id, device_name)
            self._processor = AutoProcessor.from_pretrained(
                self.config.model_id,
                trust_remote_code=True,
                cache_dir=self.config.hf_cache_dir,
            )
            self._model = AutoModelForImageTextToText.from_pretrained(
                self.config.model_id,
                dtype=torch.float16,
                device_map="auto",
                trust_remote_code=True,
                cache_dir=self.config.hf_cache_dir,
            ).eval()
            self._torch = torch
            self._device_name = device_name
            self._ready = True

    @property
    def device_name(self) -> str:
        self.ensure_ready()
        return self._device_name or "unknown"

    def _prepare_request(self, image_payload: bytes, prompt: str) -> PreparedRequest:
        self.ensure_ready()
        assert self._model is not None
        assert self._processor is not None

        image = _resize_for_ocr(Image.open(BytesIO(image_payload)).convert("RGB"), self.config.max_image_long_edge)
        messages = [{"role": "user", "content": [{"type": "image", "image": image}, {"type": "text", "text": prompt}]}]
        inputs = self._processor.apply_chat_template(
            messages,
            tokenize=True,
            add_generation_prompt=True,
            return_dict=True,
            return_tensors="pt",
        ).to(self._model.device)
        prompt_length = int(inputs["input_ids"].shape[1])
        return PreparedRequest(inputs=inputs, prompt_length=prompt_length)

    def complete(self, image_payload: bytes, prompt: str, max_new_tokens: int, cancel_event: threading.Event | None = None) -> str:
        prepared = self._prepare_request(image_payload, prompt)
        assert self._model is not None
        assert self._processor is not None
        assert self._torch is not None

        from transformers import StoppingCriteria, StoppingCriteriaList

        class CancelStoppingCriteria(StoppingCriteria):
            def __call__(self, input_ids: Any, scores: Any, **kwargs: Any) -> bool:
                return bool(cancel_event and cancel_event.is_set())

        max_tokens = max(1, min(max_new_tokens, self.config.max_new_tokens))
        pad_token_id = getattr(self._processor.tokenizer, "eos_token_id", None)
        with self._generate_lock:
            if cancel_event and cancel_event.is_set():
                raise RuntimeError("OCR request was cancelled before generation started.")
            with self._torch.inference_mode():
                output = self._model.generate(
                    **prepared.inputs,
                    max_new_tokens=max_tokens,
                    do_sample=False,
                    use_cache=True,
                    pad_token_id=pad_token_id,
                    stopping_criteria=StoppingCriteriaList([CancelStoppingCriteria()]),
                )
        if cancel_event and cancel_event.is_set():
            raise RuntimeError("OCR request was cancelled.")
        new_tokens = output[0][prepared.prompt_length:]
        return self._processor.batch_decode([new_tokens], skip_special_tokens=True, clean_up_tokenization_spaces=False)[0].strip()

    def stream(self, image_payload: bytes, prompt: str, max_new_tokens: int) -> Iterator[str]:
        prepared = self._prepare_request(image_payload, prompt)
        assert self._model is not None
        assert self._processor is not None

        from transformers import TextIteratorStreamer

        streamer = TextIteratorStreamer(self._processor, skip_prompt=True, skip_special_tokens=True, timeout=30.0)
        error_holder: dict[str, Exception] = {}

        def worker() -> None:
            try:
                pad_token_id = getattr(self._processor.tokenizer, "eos_token_id", None)
                with self._generate_lock:
                    self._model.generate(
                        **prepared.inputs,
                        max_new_tokens=max(1, min(max_new_tokens, self.config.max_new_tokens)),
                        do_sample=False,
                        streamer=streamer,
                        use_cache=True,
                        pad_token_id=pad_token_id,
                    )
            except Exception as error:  # noqa: BLE001
                error_holder["error"] = error

        thread = threading.Thread(target=worker, daemon=True)
        thread.start()

        created = int(time.time())
        completion_id = f"chatcmpl-{uuid.uuid4().hex}"
        yield _stream_chunk(completion_id, created, self.config.model_id, {"role": "assistant"}, None)
        produced = False
        for token in iter(streamer):
            if token:
                produced = True
                yield _stream_chunk(completion_id, created, self.config.model_id, {"content": token}, None)
        thread.join(timeout=1.0)
        if "error" in error_holder:
            raise error_holder["error"]
        if not produced:
            try:
                next(iter(streamer))
            except (StopIteration, queue.Empty):
                pass
        yield _stream_chunk(completion_id, created, self.config.model_id, {}, "stop")
        yield "data: [DONE]\n\n"

    def warmup(self) -> None:
        self.ensure_ready()

    def health_payload(self) -> dict[str, Any]:
        self.ensure_ready()
        return {
            "ok": True,
            "detector": "katib",
            "version": SERVICE_VERSION,
            "features": {"detect": False, "openai_ocr": True},
            "execution_provider": {"openai_ocr": {"requested": "gpu", "resolved": "gpu"}},
            "runtime": {
                "model_id": self.config.model_id,
                "device": "cuda:0",
                "gpu_name": self.device_name,
                "packages": {
                    "transformers": _package_version("transformers"),
                    "torch": _package_version("torch"),
                    "pillow": _package_version("pillow"),
                },
            },
        }


def create_app(config: RuntimeConfig | None = None, runtime: Any | None = None) -> FastAPI:
    resolved_config = config or RuntimeConfig()
    service_runtime = runtime or KatibRuntime(resolved_config)
    app = FastAPI(title="Katib Text Processing", version=SERVICE_VERSION)
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

    @app.on_event("startup")
    async def startup_load() -> None:
        service_runtime.warmup()

    @app.get("/healthz")
    def healthz() -> dict[str, Any]:
        return service_runtime.health_payload()

    @app.get("/v1/models")
    async def models() -> dict[str, Any]:
        return {
            "object": "list",
            "data": [{"id": resolved_config.model_id, "object": "model", "created": int(time.time()), "owned_by": "katib-text-processing"}],
        }

    @app.post("/v1/chat/completions", response_model=None)
    async def chat_completions(request: Request, body: OpenAiChatRequest) -> dict[str, Any] | StreamingResponse:
        try:
            image_payload = _extract_image_payload(body.messages)
            prompt = _extract_prompt(body.messages, resolved_config.default_prompt)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error

        max_new_tokens = min(body.max_tokens or resolved_config.max_new_tokens, resolved_config.max_new_tokens)
        cancel_event = threading.Event()

        async def watch_disconnect() -> None:
            while not cancel_event.is_set():
                if await request.is_disconnected():
                    cancel_event.set()
                    return
                await asyncio.sleep(0.1)

        disconnect_task = asyncio.create_task(watch_disconnect())
        try:
            if body.stream:
                return StreamingResponse(service_runtime.stream(image_payload, prompt, max_new_tokens), media_type="text/event-stream")
            text = await asyncio.to_thread(service_runtime.complete, image_payload, prompt, max_new_tokens, cancel_event)
        except Exception as error:  # noqa: BLE001
            logger.exception("Katib OCR request failed")
            raise HTTPException(status_code=500, detail=f"Katib OCR failed: {error}") from error
        finally:
            cancel_event.set()
            disconnect_task.cancel()
        return _build_openai_response(text, body.model or resolved_config.model_id)

    return app
