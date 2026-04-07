from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import platform
import time
import uuid
from dataclasses import dataclass
from importlib.metadata import PackageNotFoundError, version
from io import BytesIO
from typing import Any, Iterator

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from PIL import Image
from pydantic import BaseModel


logger = logging.getLogger("uvicorn.error")

SERVICE_VERSION = "0.1.0"
DEFAULT_MODEL_ID = "windows-media-ocr"
DEFAULT_PROMPT = "Extract all text from this image. Return only the extracted text, no additional commentary."
MIN_IMAGE_DIMENSION = 40


class RuntimeConfig(BaseModel):
    language_tag: str | None = None
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


@dataclass(frozen=True)
class OcrWordResult:
    text: str
    x: int
    y: int
    w: int
    h: int


@dataclass(frozen=True)
class OcrLineResult:
    text: str
    words: list[OcrWordResult]


@dataclass(frozen=True)
class OcrResult:
    text: str
    lines: list[OcrLineResult]
    language_tag: str
    max_image_dimension: int


def _package_version(name: str) -> str | None:
    try:
        return version(name)
    except PackageNotFoundError:
        return None


def _data_url_to_bytes(url: str) -> bytes:
    if not url.startswith("data:"):
        raise ValueError("Only data URL images are supported")
    header, _, payload = url.partition(",")
    if not payload:
        raise ValueError("Malformed data URL")
    if ";base64" not in header.lower():
        raise ValueError("Only base64 data URL images are supported")
    return base64.b64decode(payload)


def _extract_image_payload(messages: list[OpenAiMessage]) -> bytes:
    for message in messages:
        content = message.content
        if isinstance(content, str) or content is None:
            continue
        for part in content:
            if part.type == "image_url" and part.image_url is not None:
                return _data_url_to_bytes(part.image_url.url)
    raise ValueError("No image_url content found in messages")


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


def _build_stream_events(text: str, model: str | None) -> Iterator[str]:
    created = int(time.time())
    completion_id = f"chatcmpl-{uuid.uuid4().hex}"
    model_name = model or DEFAULT_MODEL_ID

    first_chunk = {
        "id": completion_id,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model_name,
        "choices": [
            {
                "index": 0,
                "delta": {"role": "assistant", "content": text},
                "finish_reason": None,
            }
        ],
    }
    yield f"data: {json.dumps(first_chunk, ensure_ascii=False)}\n\n"

    final_chunk = {
        "id": completion_id,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model_name,
        "choices": [
            {
                "index": 0,
                "delta": {},
                "finish_reason": "stop",
            }
        ],
    }
    yield f"data: {json.dumps(final_chunk, ensure_ascii=False)}\n\n"
    yield "data: [DONE]\n\n"


class WindowsOcrRuntime:
    def __init__(self, config: RuntimeConfig):
        self.config = config
        self._engine: Any | None = None
        self._language_tag: str | None = None
        self._available_languages: list[str] | None = None
        self._max_image_dimension: int | None = None

    def _import_winrt_modules(self) -> dict[str, Any]:
        if os.name != "nt":
            raise RuntimeError("Windows OCR runtime is only available on Windows")

        from winrt.windows.globalization import Language
        from winrt.windows.graphics.imaging import BitmapDecoder, BitmapPixelFormat, SoftwareBitmap
        from winrt.windows.media.ocr import OcrEngine
        from winrt.windows.storage.streams import DataWriter, InMemoryRandomAccessStream

        return {
            "Language": Language,
            "BitmapDecoder": BitmapDecoder,
            "BitmapPixelFormat": BitmapPixelFormat,
            "SoftwareBitmap": SoftwareBitmap,
            "OcrEngine": OcrEngine,
            "DataWriter": DataWriter,
            "InMemoryRandomAccessStream": InMemoryRandomAccessStream,
        }

    def _prepare_image_payload(self, image_payload: bytes) -> bytes:
        image = Image.open(BytesIO(image_payload)).convert("RGBA")
        width, height = image.size
        if width <= 0 or height <= 0:
            raise ValueError("Image has invalid dimensions")

        min_dimension = min(width, height)
        if min_dimension < MIN_IMAGE_DIMENSION:
            scale = MIN_IMAGE_DIMENSION / float(min_dimension)
            width = max(MIN_IMAGE_DIMENSION, int(round(width * scale)))
            height = max(MIN_IMAGE_DIMENSION, int(round(height * scale)))
            image = image.resize((width, height), Image.Resampling.LANCZOS)

        output = BytesIO()
        image.save(output, format="PNG")
        return output.getvalue()

    async def _decode_software_bitmap(self, image_payload: bytes) -> Any:
        modules = self._import_winrt_modules()
        stream = modules["InMemoryRandomAccessStream"]()
        writer = modules["DataWriter"](stream)
        writer.write_bytes(image_payload)
        await writer.store_async()
        try:
            await writer.flush_async()
        except Exception:  # noqa: BLE001
            pass
        writer.detach_stream()
        stream.seek(0)

        decoder = await modules["BitmapDecoder"].create_async(stream)
        software_bitmap = await decoder.get_software_bitmap_async()

        try:
            pixel_format = getattr(software_bitmap, "bitmap_pixel_format", None)
        except Exception:  # noqa: BLE001
            pixel_format = None

        bgra8 = getattr(modules["BitmapPixelFormat"], "BGRA8", None)
        if bgra8 is not None and pixel_format != bgra8:
            software_bitmap = modules["SoftwareBitmap"].convert(software_bitmap, bgra8)
        return software_bitmap

    def _language_candidates(self) -> tuple[Any, list[Any], int]:
        modules = self._import_winrt_modules()
        ocr_engine = modules["OcrEngine"]
        available_languages = list(ocr_engine.available_recognizer_languages)
        available_tags = [str(language.language_tag) for language in available_languages]
        self._available_languages = available_tags
        self._max_image_dimension = int(ocr_engine.max_image_dimension)

        if self.config.language_tag:
            requested = modules["Language"](self.config.language_tag)
            if not ocr_engine.is_language_supported(requested):
                raise RuntimeError(f"OCR language is not supported: {self.config.language_tag}")
            return requested, available_languages, self._max_image_dimension

        return None, available_languages, self._max_image_dimension

    def ensure_ready(self) -> None:
        if self._engine is not None:
            return

        modules = self._import_winrt_modules()
        requested_language, available_languages, _ = self._language_candidates()
        ocr_engine = modules["OcrEngine"]

        engine = None
        if requested_language is not None:
            engine = ocr_engine.try_create_from_language(requested_language)
            if engine is None:
                raise RuntimeError(f"Unable to initialize OCR engine for language: {self.config.language_tag}")
            self._language_tag = str(requested_language.language_tag)
        else:
            engine = ocr_engine.try_create_from_user_profile_languages()
            if engine is not None:
                try:
                    self._language_tag = str(engine.recognizer_language.language_tag)
                except Exception:  # noqa: BLE001
                    self._language_tag = None
            if engine is None and available_languages:
                first_language = available_languages[0]
                engine = ocr_engine.try_create_from_language(first_language)
                self._language_tag = str(first_language.language_tag)

        if engine is None:
            raise RuntimeError("No Windows OCR language pack is available. Install a supported OCR language pack and retry.")

        self._engine = engine

    @property
    def available_languages(self) -> list[str]:
        if self._available_languages is None:
            self.ensure_ready()
        return self._available_languages or []

    @property
    def max_image_dimension(self) -> int:
        if self._max_image_dimension is None:
            self.ensure_ready()
        return self._max_image_dimension or 0

    @property
    def language_tag(self) -> str:
        self.ensure_ready()
        return self._language_tag or "unknown"

    async def recognize(self, image_payload: bytes, prompt: str, max_new_tokens: int) -> OcrResult:
        del prompt, max_new_tokens
        self.ensure_ready()
        prepared_payload = self._prepare_image_payload(image_payload)
        image = Image.open(BytesIO(prepared_payload))
        if image.width > self.max_image_dimension or image.height > self.max_image_dimension:
            raise ValueError(
                f"Image is too big - {image.width}x{image.height}. Maximum dimension is {self.max_image_dimension} pixels."
            )

        software_bitmap = await self._decode_software_bitmap(prepared_payload)
        assert self._engine is not None
        result = await self._engine.recognize_async(software_bitmap)

        lines: list[OcrLineResult] = []
        for raw_line in getattr(result, "lines", []):
            words: list[OcrWordResult] = []
            for raw_word in getattr(raw_line, "words", []):
                rect = raw_word.bounding_rect
                words.append(
                    OcrWordResult(
                        text=str(raw_word.text).strip(),
                        x=int(round(float(rect.x))),
                        y=int(round(float(rect.y))),
                        w=int(round(float(rect.width))),
                        h=int(round(float(rect.height))),
                    )
                )
            lines.append(OcrLineResult(text=str(raw_line.text).strip(), words=words))

        text = "\n".join(line.text for line in lines if line.text.strip()).strip()
        return OcrResult(
            text=text,
            lines=lines,
            language_tag=self.language_tag,
            max_image_dimension=self.max_image_dimension,
        )

    def recognize_sync(self, image_payload: bytes, prompt: str, max_new_tokens: int) -> OcrResult:
        return asyncio.run(self.recognize(image_payload, prompt, max_new_tokens))

    def health_payload(self) -> dict[str, Any]:
        self.ensure_ready()
        return {
            "ok": True,
            "detector": "windows_ocr",
            "version": SERVICE_VERSION,
            "features": {"detect": False, "openai_ocr": True},
            "execution_provider": {"openai_ocr": {"requested": "native_windows", "resolved": "native_windows"}},
            "runtime": {
                "language_tag": self.language_tag,
                "available_languages": self.available_languages,
                "max_image_dimension": self.max_image_dimension,
                "platform": platform.platform(),
                "packages": {
                    "winrt-Windows.Media.Ocr": _package_version("winrt-Windows.Media.Ocr"),
                    "winrt-Windows.Graphics.Imaging": _package_version("winrt-Windows.Graphics.Imaging"),
                    "winrt-Windows.Globalization": _package_version("winrt-Windows.Globalization"),
                    "winrt-Windows.Storage.Streams": _package_version("winrt-Windows.Storage.Streams"),
                },
            },
        }


def create_app(config: RuntimeConfig | None = None, runtime: Any | None = None) -> FastAPI:
    resolved_config = config or RuntimeConfig()
    service_runtime = runtime or WindowsOcrRuntime(resolved_config)

    app = FastAPI(title="Windows OCR Text Processing", version=SERVICE_VERSION)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

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
                    "id": DEFAULT_MODEL_ID,
                    "object": "model",
                    "created": created,
                    "owned_by": "windows-ocr-text-processing",
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
            result = await service_runtime.recognize(image_payload, prompt, max_new_tokens)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        except Exception as error:  # noqa: BLE001
            logger.exception("Windows OCR request failed")
            raise HTTPException(status_code=500, detail=f"Windows OCR failed: {error}") from error

        if body.stream:
            return StreamingResponse(_build_stream_events(result.text, body.model), media_type="text/event-stream")
        return _build_openai_response(result.text, body.model or DEFAULT_MODEL_ID)

    return app
