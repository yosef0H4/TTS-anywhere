from __future__ import annotations

import asyncio
import base64
import json
import logging
import time
import uuid
from dataclasses import dataclass
from io import BytesIO
from typing import Any, Iterator

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from PIL import Image

try:
    import onnxruntime as ort
except Exception:  # noqa: BLE001
    ort = None

try:
    import torch
except Exception:  # noqa: BLE001
    torch = None

try:
    from rapidocr import EngineType, RapidOCR as ModernRapidOCR
except Exception:  # noqa: BLE001
    EngineType = None
    ModernRapidOCR = None

# Reuse uvicorn logger so app-level INFO logs appear in run_server console.
logger = logging.getLogger("uvicorn.error")


class DetectorSettings(BaseModel):
    include_polygons: bool = False


class DetectSettings(BaseModel):
    detector: DetectorSettings = Field(default_factory=DetectorSettings)


class RuntimeConfig(BaseModel):
    enable_detect: bool = False
    enable_openai_ocr: bool = False
    detect_execution_provider: str = "cpu"
    ocr_execution_provider: str = "cpu"


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
class ProviderResolution:
    requested: str
    resolved: str


def normalize_execution_provider(provider: str) -> str:
    value = provider.strip().lower()
    if value not in {"cpu", "cuda", "dml"}:
        raise ValueError(f"Unsupported execution provider: {provider}")
    return value


def _available_onnx_providers() -> set[str]:
    if ort is None:
        return set()
    try:
        return {name.lower() for name in ort.get_available_providers()}
    except Exception:  # noqa: BLE001
        return set()


def resolve_execution_provider(provider: str) -> ProviderResolution:
    requested = normalize_execution_provider(provider)
    available = _available_onnx_providers()

    if requested == "cpu":
        return ProviderResolution(requested="cpu", resolved="cpu")
    if requested == "cuda":
        if "cudaexecutionprovider" not in available:
            raise RuntimeError("CUDA execution provider requested but not available in this environment")
        return ProviderResolution(requested="cuda", resolved="cuda")
    if requested == "dml":
        if "dmlexecutionprovider" not in available:
            raise RuntimeError("DirectML execution provider requested but not available in this environment")
        return ProviderResolution(requested="dml", resolved="dml")
    raise RuntimeError(f"Unhandled execution provider: {requested}")


class RapidEngineFactory:
    def __init__(self, provider: ProviderResolution):
        self.provider = provider
        self._detect_engine: Any | None = None
        self._ocr_engine: Any | None = None

    def get_detect_engine(self) -> Any:
        if self._detect_engine is None:
            self._detect_engine = self._create_engine()
        return self._detect_engine

    def get_ocr_engine(self) -> Any:
        if self._ocr_engine is None:
            self._ocr_engine = self._create_engine()
        return self._ocr_engine

    def _create_engine(self) -> Any:
        resolved = self.provider.resolved
        if resolved == "cuda" and ort is not None and hasattr(ort, "preload_dlls"):
            # Let ORT discover CUDA/cuDNN/MSVC runtimes from torch or NVIDIA site packages before session creation.
            if torch is not None:
                _ = torch.cuda.is_available()
            ort.preload_dlls()
        if ModernRapidOCR is not None:
            params: dict[str, Any] = {}
            onnx_engine = EngineType.ONNXRUNTIME if EngineType is not None else None
            if resolved == "cpu":
                params.update(
                    {
                        "Det.engine_type": onnx_engine,
                        "Cls.engine_type": onnx_engine,
                        "Rec.engine_type": onnx_engine,
                    }
                )
            elif resolved == "cuda":
                params.update(
                    {
                        "Det.engine_type": onnx_engine,
                        "Cls.engine_type": onnx_engine,
                        "Rec.engine_type": onnx_engine,
                        "EngineConfig.onnxruntime.use_cuda": True,
                    }
                )
            elif resolved == "dml":
                params.update(
                    {
                        "Det.engine_type": onnx_engine,
                        "Cls.engine_type": onnx_engine,
                        "Rec.engine_type": onnx_engine,
                        "EngineConfig.onnxruntime.use_dml": True,
                    }
                )
            return ModernRapidOCR(params=params)

        raise RuntimeError("RapidOCR is not installed")


def _data_url_to_bytes(url: str) -> bytes:
    if not url.startswith("data:"):
        raise ValueError("Only data URL images are supported")
    header, _, payload = url.partition(",")
    if not payload:
        raise ValueError("Malformed data URL")
    if ";base64" not in header.lower():
        raise ValueError("Only base64 data URL images are supported")
    return base64.b64decode(payload)


def _load_rgb_image(payload: bytes) -> np.ndarray:
    pil_image = Image.open(BytesIO(payload)).convert("RGB")
    return np.array(pil_image)


def _extract_first_image_payload(messages: list[OpenAiMessage]) -> bytes:
    for message in messages:
        content = message.content
        if isinstance(content, str) or content is None:
            continue
        for part in content:
            if part.type != "image_url" or part.image_url is None:
                continue
            return _data_url_to_bytes(part.image_url.url)
    raise ValueError("No image_url content found in messages")


def _coerce_detect_polygons(result: Any) -> list[list[list[float]]]:
    if hasattr(result, "boxes") and getattr(result, "boxes") is not None:
        boxes = getattr(result, "boxes")
        return [[list(map(float, point)) for point in box] for box in boxes]
    if isinstance(result, tuple) and result:
        boxes = result[0]
        if isinstance(boxes, list):
            return [[list(map(float, point)) for point in box] for box in boxes]
    if isinstance(result, list):
        return [[list(map(float, point)) for point in box] for box in result]
    return []


def _coerce_ocr_lines(result: Any) -> list[str]:
    if hasattr(result, "txts") and getattr(result, "txts") is not None:
        return [str(text).strip() for text in getattr(result, "txts") if str(text).strip()]
    if isinstance(result, tuple):
        for item in result:
            if isinstance(item, list):
                texts: list[str] = []
                for line in item:
                    if isinstance(line, (list, tuple)) and len(line) >= 2:
                        maybe_text = line[1]
                        if isinstance(maybe_text, (list, tuple)) and maybe_text:
                            text = str(maybe_text[0]).strip()
                            if text:
                                texts.append(text)
                    elif isinstance(line, str) and line.strip():
                        texts.append(line.strip())
                if texts:
                    return texts
    return []


def _build_openai_response(text: str, model: str | None) -> dict[str, Any]:
    created = int(time.time())
    completion_id = f"chatcmpl-{uuid.uuid4().hex}"
    return {
        "id": completion_id,
        "object": "chat.completion",
        "created": created,
        "model": model or "rapidocr",
        "choices": [
            {
                "index": 0,
                "finish_reason": "stop",
                "message": {"role": "assistant", "content": text},
            }
        ],
        "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
    }


def _build_openai_stream_events(text: str, model: str | None) -> Iterator[str]:
    created = int(time.time())
    completion_id = f"chatcmpl-{uuid.uuid4().hex}"
    model_name = model or "rapidocr"

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


def _build_openai_models_response() -> dict[str, Any]:
    created = int(time.time())
    return {
        "object": "list",
        "data": [
            {
                "id": "rapid",
                "object": "model",
                "created": created,
                "owned_by": "rapid-text-processing",
            }
        ],
    }


def create_app(
    config: RuntimeConfig | None = None,
    detect_engine_factory: RapidEngineFactory | None = None,
    ocr_engine_factory: RapidEngineFactory | None = None,
) -> FastAPI:
    runtime = config or RuntimeConfig(enable_detect=True, enable_openai_ocr=False, detect_execution_provider="cpu", ocr_execution_provider="cpu")
    resolved_detect_provider = resolve_execution_provider(runtime.detect_execution_provider)
    resolved_ocr_provider = resolve_execution_provider(runtime.ocr_execution_provider)
    detect_engines = detect_engine_factory or RapidEngineFactory(resolved_detect_provider)
    ocr_engines = ocr_engine_factory or RapidEngineFactory(resolved_ocr_provider)

    app = FastAPI(title="Rapid Text Processing", version="0.2.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/healthz")
    def healthz() -> dict[str, object]:
        return {
            "ok": True,
            "detector": "rapidocr",
            "version": "0.2.0",
            "features": {
                "detect": runtime.enable_detect,
                "openai_ocr": runtime.enable_openai_ocr,
            },
            "execution_provider": {
                "detect": {
                    "requested": resolved_detect_provider.requested,
                    "resolved": resolved_detect_provider.resolved,
                },
                "openai_ocr": {
                    "requested": resolved_ocr_provider.requested,
                    "resolved": resolved_ocr_provider.resolved,
                },
            },
        }

    if runtime.enable_detect:

        @app.post("/v1/detect")
        async def detect(request: Request, image: UploadFile = File(...), settings: str | None = Form(default=None)) -> dict[str, object]:
            started = time.perf_counter()
            request_id = str(uuid.uuid4())
            logger.info("Detect started request_id=%s", request_id)

            parsed_settings = DetectSettings()
            try:
                if settings:
                    parsed_settings = DetectSettings.model_validate_json(settings)
            except Exception:
                parsed_settings = DetectSettings()

            try:
                payload = await image.read()
                image_rgb = _load_rgb_image(payload)
            except Exception as error:
                return {
                    "status": "error",
                    "request_id": request_id,
                    "error": {"code": "invalid_image", "message": f"Image parsing failed: {error}"},
                }

            img_h, img_w = image_rgb.shape[:2]

            detect_engine = detect_engines.get_detect_engine()
            detect_start = time.perf_counter()
            try:
                result = detect_engine(image_rgb, use_det=True, use_rec=False)
            except asyncio.CancelledError:
                logger.info("Detect cancelled by client request_id=%s", request_id)
                raise
            detect_ms = (time.perf_counter() - detect_start) * 1000

            if await request.is_disconnected():
                logger.info("Client disconnected during detect request_id=%s", request_id)

            polygons = _coerce_detect_polygons(result)
            raw_boxes: list[dict[str, Any]] = []
            for poly in polygons:
                if len(poly) < 4:
                    continue
                points: list[list[float]] = []
                for point in poly:
                    if len(point) < 2:
                        points = []
                        break
                    points.append([float(point[0]), float(point[1])])
                if len(points) < 4:
                    continue

                x_coords = [p[0] for p in points]
                y_coords = [p[1] for p in points]
                x1, x2 = max(0.0, min(x_coords)), min(float(img_w), max(x_coords))
                y1, y2 = max(0.0, min(y_coords)), min(float(img_h), max(y_coords))
                if x2 <= x1 or y2 <= y1:
                    continue

                raw_boxes.append(
                    {
                        "id": str(uuid.uuid4()),
                        "px": {
                            "x1": int(round(x1)),
                            "y1": int(round(y1)),
                            "x2": int(round(x2)),
                            "y2": int(round(y2)),
                        },
                        "norm": {
                            "x": x1 / img_w,
                            "y": y1 / img_h,
                            "w": (x2 - x1) / img_w,
                            "h": (y2 - y1) / img_h,
                        },
                        "polygon": points if parsed_settings.detector.include_polygons else None,
                    }
                )

            response = {
                "status": "success",
                "request_id": request_id,
                "image": {"width": img_w, "height": img_h},
                "raw_boxes": raw_boxes,
                "metrics": {
                    "detect_ms": round(detect_ms, 2),
                    "total_ms": round((time.perf_counter() - started) * 1000, 2),
                    "raw_count": len(raw_boxes),
                },
            }
            logger.info(
                "Detect completed request_id=%s raw_count=%d detect_ms=%.2f total_ms=%.2f",
                request_id,
                len(raw_boxes),
                response["metrics"]["detect_ms"],
                response["metrics"]["total_ms"],
            )
            return response

    if runtime.enable_openai_ocr:

        @app.get("/v1/models")
        async def openai_models() -> dict[str, Any]:
            return _build_openai_models_response()

        @app.post("/v1/chat/completions", response_model=None)
        async def openai_chat_completions(body: OpenAiChatRequest) -> dict[str, Any] | StreamingResponse:
            try:
                payload = _extract_first_image_payload(body.messages)
                image_rgb = _load_rgb_image(payload)
            except ValueError as error:
                raise HTTPException(status_code=400, detail=str(error)) from error
            except Exception as error:  # noqa: BLE001
                raise HTTPException(status_code=400, detail=f"Image parsing failed: {error}") from error

            ocr_engine = ocr_engines.get_ocr_engine()
            try:
                result = ocr_engine(image_rgb, use_det=True, use_cls=True, use_rec=True)
            except Exception as error:  # noqa: BLE001
                logger.exception("OpenAI OCR request failed")
                raise HTTPException(status_code=500, detail=f"RapidOCR failed: {error}") from error

            lines = _coerce_ocr_lines(result)
            text = "\n".join(lines).strip()
            if body.stream:
                return StreamingResponse(_build_openai_stream_events(text, body.model), media_type="text/event-stream")
            return _build_openai_response(text, body.model)

    return app
