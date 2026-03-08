from __future__ import annotations

import base64
import importlib
import json
import logging
import os
import queue
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass
from importlib.metadata import PackageNotFoundError, version
from io import BytesIO
from pathlib import Path
from typing import Any, Iterator

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from PIL import Image
from pydantic import BaseModel

from .torchvision_patch import apply_torchvision_patch

apply_torchvision_patch()

logger = logging.getLogger("uvicorn.error")

DEFAULT_MODEL_ID = "h2oai/h2ovl-mississippi-800m"
DEFAULT_PROMPT = "Extract all text from this image. Return only the extracted text, no additional commentary."
SERVICE_VERSION = "0.1.0"
SERVICE_ROOT = Path(__file__).resolve().parents[2]


class RuntimeConfig(BaseModel):
    model_id: str = DEFAULT_MODEL_ID
    hf_cache_dir: str | None = None
    default_prompt: str = DEFAULT_PROMPT
    max_new_tokens: int = 2048


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
        raise RuntimeError("H2OVL requires a CUDA GPU and will not run on CPU.")
    device_name = torch.cuda.get_device_name(0)
    return torch, device_name


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
                _, _, encoded = url.partition(",")
                return base64.b64decode(encoded)
    raise ValueError("No image_url found in messages")


def _extract_prompt(messages: list[OpenAiMessage], fallback_prompt: str) -> str:
    texts: list[str] = []
    for message in messages:
        content = message.content
        if isinstance(content, str):
            if content.strip():
                texts.append(content.strip())
        elif isinstance(content, list):
            for part in content:
                if part.type == "text" and part.text and part.text.strip():
                    texts.append(part.text.strip())
    return "\n".join(texts).strip() or fallback_prompt


def _build_openai_response(text: str, model: str | None) -> dict[str, Any]:
    created = int(time.time())
    completion_id = f"chatcmpl-{uuid.uuid4().hex}"
    return {
        "id": completion_id,
        "object": "chat.completion",
        "created": created,
        "model": model or DEFAULT_MODEL_ID,
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
        "choices": [
            {
                "index": 0,
                "delta": delta,
                "finish_reason": finish_reason,
            }
        ],
    }
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


@dataclass
class PreparedRequest:
    pixel_values: Any
    input_ids: Any
    attention_mask: Any
    template_sep: str


class H2OVLRuntime:
    def __init__(self, config: RuntimeConfig):
        self.config = config
        self._lock = threading.Lock()
        self._ready = False
        self._torch: Any | None = None
        self._device_name: str | None = None
        self._model: Any | None = None
        self._tokenizer: Any | None = None
        self._model_module: Any | None = None

    def ensure_ready(self) -> None:
        if self._ready:
            return
        with self._lock:
            if self._ready:
                return
            torch, device_name = _require_gpu()
            from transformers import AutoConfig, AutoModel, AutoTokenizer

            use_flash_attention = False
            try:
                import flash_attn  # noqa: F401
                use_flash_attention = True
            except Exception:  # noqa: BLE001
                use_flash_attention = False

            logger.info("Initializing H2OVL model=%s gpu=%s flash_attention=%s", self.config.model_id, device_name, use_flash_attention)
            model_config = AutoConfig.from_pretrained(self.config.model_id, trust_remote_code=True)
            model_config.llm_config._attn_implementation = "flash_attention_2" if use_flash_attention else "sdpa"
            self._model = AutoModel.from_pretrained(
                self.config.model_id,
                dtype=torch.bfloat16,
                config=model_config,
                trust_remote_code=True,
                cache_dir=self.config.hf_cache_dir,
            ).eval().cuda()
            self._tokenizer = AutoTokenizer.from_pretrained(
                self.config.model_id,
                trust_remote_code=True,
                use_fast=False,
                cache_dir=self.config.hf_cache_dir,
            )
            self._model_module = importlib.import_module(self._model.__class__.__module__)
            self._torch = torch
            self._device_name = device_name
            self._ready = True

    @property
    def device_name(self) -> str:
        self.ensure_ready()
        return self._device_name or "unknown"

    def _image_to_temp_path(self, image_payload: bytes) -> str:
        image = Image.open(BytesIO(image_payload)).convert("RGB")
        fd, temp_path = tempfile.mkstemp(suffix=".png")
        os.close(fd)
        image.save(temp_path, format="PNG")
        return temp_path

    def _prepare_request(self, image_payload: bytes, prompt: str, max_new_tokens: int) -> tuple[PreparedRequest, dict[str, Any]]:
        self.ensure_ready()
        assert self._model is not None
        assert self._tokenizer is not None
        assert self._model_module is not None
        assert self._torch is not None

        image_path = self._image_to_temp_path(image_payload)
        try:
            pixel_values, num_patches_list = self._model_module.load_single_image(
                image_path,
                max_num=6,
                msac=getattr(self._model, "use_msac", False),
            )
        finally:
            try:
                os.remove(image_path)
            except OSError:
                pass

        question = prompt
        if pixel_values is not None and "<image>" not in question:
            question = "<image>\n" + question
        img_context_token = "<IMG_CONTEXT>"
        img_start_token = "<img>"
        img_end_token = "</img>"
        img_context_token_id = self._tokenizer.convert_tokens_to_ids(img_context_token)
        self._model.img_context_token_id = img_context_token_id

        template = self._model_module.get_conv_template(self._model.template)
        template.system_message = getattr(self._model, "system_message", template.system_message)
        template.append_message(template.roles[0], question)
        template.append_message(template.roles[1], None)
        query = template.get_prompt()
        for num_patches in num_patches_list:
            image_tokens = img_start_token + img_context_token * self._model.num_image_token * num_patches + img_end_token
            query = query.replace("<image>", image_tokens, 1)

        model_inputs = self._tokenizer(query, return_tensors="pt")
        input_ids = model_inputs["input_ids"].cuda()
        attention_mask = model_inputs["attention_mask"].cuda()
        generation_config = {
            "max_new_tokens": max_new_tokens,
            "do_sample": False,
            "eos_token_id": self._tokenizer.convert_tokens_to_ids(template.sep),
        }
        return PreparedRequest(
            pixel_values=pixel_values,
            input_ids=input_ids,
            attention_mask=attention_mask,
            template_sep=template.sep,
        ), generation_config

    def complete(self, image_payload: bytes, prompt: str, max_new_tokens: int) -> str:
        prepared, generation_config = self._prepare_request(image_payload, prompt, max_new_tokens)
        assert self._model is not None
        assert self._tokenizer is not None
        generation_output = self._model.generate(
            pixel_values=prepared.pixel_values,
            input_ids=prepared.input_ids,
            attention_mask=prepared.attention_mask,
            **generation_config,
        )
        text = self._tokenizer.batch_decode(generation_output, skip_special_tokens=True)[0]
        return text.split(prepared.template_sep)[0].strip()

    def stream(self, image_payload: bytes, prompt: str, max_new_tokens: int) -> Iterator[str]:
        prepared, generation_config = self._prepare_request(image_payload, prompt, max_new_tokens)
        assert self._model is not None
        assert self._tokenizer is not None
        assert self._torch is not None

        from transformers import TextIteratorStreamer

        streamer = TextIteratorStreamer(self._tokenizer, skip_prompt=True, skip_special_tokens=True, timeout=30.0)
        error_holder: dict[str, Exception] = {}

        def worker() -> None:
            try:
                self._model.generate(
                    pixel_values=prepared.pixel_values,
                    input_ids=prepared.input_ids,
                    attention_mask=prepared.attention_mask,
                    streamer=streamer,
                    **generation_config,
                )
            except Exception as error:  # noqa: BLE001
                error_holder["error"] = error

        thread = threading.Thread(target=worker, daemon=True)
        thread.start()

        created = int(time.time())
        completion_id = f"chatcmpl-{uuid.uuid4().hex}"
        model_name = self.config.model_id
        yield _stream_chunk(completion_id, created, model_name, {"role": "assistant"}, None)

        text_so_far = ""
        streamer_iter = iter(streamer)
        stream_timed_out = False
        while True:
            try:
                token = next(streamer_iter)
            except StopIteration:
                break
            except queue.Empty:
                stream_timed_out = True
                logger.warning("H2OVL stream timed out waiting for next token")
                break
            if not token:
                continue
            if prepared.template_sep and prepared.template_sep in token:
                token = token.split(prepared.template_sep, 1)[0]
            if token:
                text_so_far += token
                yield _stream_chunk(completion_id, created, model_name, {"content": token}, None)

        thread.join(timeout=1.0)
        if "error" in error_holder:
            raise error_holder["error"]
        if stream_timed_out and not text_so_far:
            raise RuntimeError("H2OVL stream timed out before producing any text")
        yield _stream_chunk(completion_id, created, model_name, {}, "stop")
        yield "data: [DONE]\n\n"

    def warmup(self) -> None:
        self.ensure_ready()
        assert self._model is not None
        assert self._tokenizer is not None
        assert self._torch is not None
        logger.info("Running H2OVL startup warmup")
        generation_config = {"max_new_tokens": 16, "do_sample": False}
        with self._torch.autocast(device_type="cuda", dtype=self._torch.bfloat16):
            self._model.chat(
                self._tokenizer,
                None,
                "Hello",
                generation_config,
                history=None,
                return_history=True,
            )

    def health_payload(self) -> dict[str, Any]:
        self.ensure_ready()
        return {
            "ok": True,
            "detector": "h2ovl",
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
                    "torchvision": _package_version("torchvision"),
                    "peft": _package_version("peft"),
                    "timm": _package_version("timm"),
                },
            },
        }


def create_app(config: RuntimeConfig | None = None, runtime: Any | None = None) -> FastAPI:
    resolved_config = config or RuntimeConfig()
    service_runtime = runtime or H2OVLRuntime(resolved_config)

    app = FastAPI(title="H2OVL Text Processing", version=SERVICE_VERSION)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.on_event("startup")
    async def startup_load() -> None:
        service_runtime.warmup()

    @app.get("/healthz")
    def healthz() -> dict[str, Any]:
        return service_runtime.health_payload()

    @app.get("/v1/models")
    async def models() -> dict[str, Any]:
        created = int(time.time())
        return {
            "object": "list",
            "data": [
                {
                    "id": resolved_config.model_id,
                    "object": "model",
                    "created": created,
                    "owned_by": "h2ovl-text-processing",
                }
            ],
        }

    @app.post("/v1/chat/completions", response_model=None)
    async def chat_completions(body: OpenAiChatRequest) -> dict[str, Any] | StreamingResponse:
        try:
            image_payload = _extract_image_payload(body.messages)
            prompt = _extract_prompt(body.messages, resolved_config.default_prompt)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error

        max_new_tokens = body.max_tokens or resolved_config.max_new_tokens
        try:
            if body.stream:
                return StreamingResponse(
                    service_runtime.stream(image_payload, prompt, max_new_tokens),
                    media_type="text/event-stream",
                )
            text = service_runtime.complete(image_payload, prompt, max_new_tokens)
        except Exception as error:  # noqa: BLE001
            logger.exception("H2OVL OCR request failed")
            raise HTTPException(status_code=500, detail=f"H2OVL OCR failed: {error}") from error

        return _build_openai_response(text, body.model or resolved_config.model_id)

    return app
