from __future__ import annotations

import base64
import json
import logging
import os
import time
import uuid
from dataclasses import dataclass
from io import BytesIO
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Any, Iterator

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from PIL import Image
from pydantic import BaseModel, Field

SERVICE_ROOT = Path(__file__).resolve().parents[2]
os.environ.setdefault("PADDLE_PDX_CACHE_HOME", str(SERVICE_ROOT / ".paddlex-cache"))
os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
os.environ.setdefault("PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT", "False")

try:
    import paddle
except Exception:  # noqa: BLE001
    paddle = None

try:
    from paddleocr import PaddleOCR, TextDetection
except Exception:  # noqa: BLE001
    PaddleOCR = None
    TextDetection = None

logger = logging.getLogger("uvicorn.error")

DEFAULT_DETECT_MODEL_NAME = "PP-OCRv5_mobile_det"
DEFAULT_RECOGNITION_MODEL_NAME = "PP-OCRv5_mobile_rec"
DEFAULT_CPU_THREADS = 4


class DetectorSettings(BaseModel):
    include_polygons: bool = False


class DetectSettings(BaseModel):
    detector: DetectorSettings = Field(default_factory=DetectorSettings)


class RuntimeConfig(BaseModel):
    enable_detect: bool = False
    enable_openai_ocr: bool = False
    detect_device: str = "cpu"
    ocr_device: str = "cpu"
    detect_model_name: str = DEFAULT_DETECT_MODEL_NAME
    ocr_detection_model_name: str = DEFAULT_DETECT_MODEL_NAME
    ocr_recognition_model_name: str = DEFAULT_RECOGNITION_MODEL_NAME
    detect_model_dir: str | None = None
    ocr_detection_model_dir: str | None = None
    ocr_recognition_model_dir: str | None = None
    cpu_threads: int = DEFAULT_CPU_THREADS


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
class DeviceResolution:
    requested: str
    resolved: str


def normalize_device(device: str) -> str:
    value = device.strip().lower()
    if value not in {"cpu", "gpu"}:
        raise ValueError(f"Unsupported device: {device}")
    return value


def _cuda_available() -> bool:
    if paddle is None:
        return False
    try:
        if hasattr(paddle, "device") and hasattr(paddle.device, "is_compiled_with_cuda"):
            return bool(paddle.device.is_compiled_with_cuda()) and paddle.device.cuda.device_count() > 0
        if hasattr(paddle, "is_compiled_with_cuda"):
            return bool(paddle.is_compiled_with_cuda())
    except Exception:  # noqa: BLE001
        return False
    return False


def resolve_device(device: str) -> DeviceResolution:
    requested = normalize_device(device)
    if requested == "cpu":
        return DeviceResolution(requested="cpu", resolved="cpu")
    if requested == "gpu":
        if not _cuda_available():
            raise RuntimeError("GPU device requested but Paddle CUDA support is not available")
        return DeviceResolution(requested="gpu", resolved="gpu")
    raise RuntimeError(f"Unhandled device: {requested}")


def _package_version(name: str) -> str | None:
    try:
        return version(name)
    except PackageNotFoundError:
        return None


def _describe_runtime_device(resolution: DeviceResolution) -> str:
    if resolution.resolved != "gpu" or paddle is None:
        return resolution.resolved
    try:
        current = paddle.device.get_device()
    except Exception:  # noqa: BLE001
        current = "gpu"

    gpu_index: int | None = None
    if ":" in current:
        _, _, raw_index = current.partition(":")
        if raw_index.isdigit():
            gpu_index = int(raw_index)
    if gpu_index is None:
        gpu_index = 0

    device_name: str | None = None
    try:
        if hasattr(paddle.device.cuda, "get_device_name"):
            device_name = str(paddle.device.cuda.get_device_name(gpu_index))
    except Exception:  # noqa: BLE001
        device_name = None

    if device_name:
        return f"gpu:{gpu_index} ({device_name})"
    return f"gpu:{gpu_index}"


def _log_startup_runtime(label: str, enabled: bool, resolution: DeviceResolution) -> None:
    if not enabled:
        logger.info("Paddle %s startup disabled", label)
        return
    logger.info(
        "Paddle %s startup requested=%s resolved=%s runtime=%s",
        label,
        resolution.requested,
        resolution.resolved,
        _describe_runtime_device(resolution),
    )


class PaddleDetectFactory:
    def __init__(self, config: RuntimeConfig, resolution: DeviceResolution):
        self.config = config
        self.resolution = resolution
        self._detector: Any | None = None

    def get_engine(self) -> Any:
        if self._detector is None:
            if paddle is None:
                raise RuntimeError("Paddle runtime is not installed. Use the Windows host scripts to install the CPU or GPU runtime.")
            if TextDetection is None:
                raise RuntimeError("PaddleOCR TextDetection is not installed")

            logger.info(
                "Initializing Paddle detect engine requested=%s resolved=%s runtime=%s model=%s",
                self.resolution.requested,
                self.resolution.resolved,
                _describe_runtime_device(self.resolution),
                self.config.detect_model_name,
            )
            self._detector = TextDetection(
                model_name=self.config.detect_model_name,
                model_dir=self.config.detect_model_dir,
                device=self.resolution.resolved,
                enable_mkldnn=False,
                enable_cinn=False,
                cpu_threads=self.config.cpu_threads,
            )
        return self._detector


class PaddleOcrFactory:
    def __init__(self, config: RuntimeConfig, resolution: DeviceResolution):
        self.config = config
        self.resolution = resolution
        self._ocr: Any | None = None

    def get_engine(self) -> Any:
        if self._ocr is None:
            if paddle is None:
                raise RuntimeError("Paddle runtime is not installed. Use the Windows host scripts to install the CPU or GPU runtime.")
            if PaddleOCR is None:
                raise RuntimeError("PaddleOCR is not installed")

            logger.info(
                "Initializing Paddle OCR engine requested=%s resolved=%s runtime=%s det_model=%s rec_model=%s",
                self.resolution.requested,
                self.resolution.resolved,
                _describe_runtime_device(self.resolution),
                self.config.ocr_detection_model_name,
                self.config.ocr_recognition_model_name,
            )
            self._ocr = PaddleOCR(
                text_detection_model_name=self.config.ocr_detection_model_name,
                text_detection_model_dir=self.config.ocr_detection_model_dir,
                text_recognition_model_name=self.config.ocr_recognition_model_name,
                text_recognition_model_dir=self.config.ocr_recognition_model_dir,
                use_doc_orientation_classify=False,
                use_doc_unwarping=False,
                use_textline_orientation=False,
                device=self.resolution.resolved,
                enable_mkldnn=False,
                enable_cinn=False,
                cpu_threads=self.config.cpu_threads,
            )
        return self._ocr


def _load_rgb_image(payload: bytes) -> np.ndarray:
    return np.array(Image.open(BytesIO(payload)).convert("RGB"))


def _nested_payload(item: Any) -> Any:
    if hasattr(item, "res"):
        return getattr(item, "res")
    if isinstance(item, dict) and isinstance(item.get("res"), dict):
        return item["res"]
    return item


def _extract_dt_polys(result: Any) -> list[list[list[float]]]:
    polygons: list[list[list[float]]] = []
    if not isinstance(result, list):
        return polygons

    for item in result:
        payload = _nested_payload(item)
        dt_polys = getattr(payload, "dt_polys", None)
        if dt_polys is None and isinstance(payload, dict):
            dt_polys = payload.get("dt_polys")
        if dt_polys is None:
            continue

        array = np.asarray(dt_polys)
        if array.ndim != 3 or array.shape[1] < 4 or array.shape[2] < 2:
            continue

        for poly in array:
            coords = [[float(point[0]), float(point[1])] for point in poly]
            if len(coords) >= 4:
                polygons.append(coords)

    return polygons


def _extract_ocr_lines(result: Any) -> list[str]:
    lines: list[str] = []
    if not isinstance(result, list):
        return lines

    for item in result:
        payload = _nested_payload(item)
        texts = getattr(payload, "rec_texts", None)
        if texts is None and isinstance(payload, dict):
            texts = payload.get("rec_texts")
        if texts is None:
            continue
        for text in texts:
            normalized = str(text).strip()
            if normalized:
                lines.append(normalized)
    return lines


def _data_url_to_bytes(url: str) -> bytes:
    if not url.startswith("data:"):
        raise ValueError("Only data URL images are supported")
    header, _, payload = url.partition(",")
    if not payload:
        raise ValueError("Malformed data URL")
    if ";base64" not in header.lower():
        raise ValueError("Only base64 data URL images are supported")
    return base64.b64decode(payload)


def _extract_first_image_payload(messages: list[OpenAiMessage]) -> bytes:
    for message in messages:
        content = message.content
        if isinstance(content, str) or content is None:
            continue
        for part in content:
            if part.type == "image_url" and part.image_url is not None:
                return _data_url_to_bytes(part.image_url.url)
    raise ValueError("No image_url content found in messages")


def _build_openai_response(text: str, model: str | None) -> dict[str, Any]:
    created = int(time.time())
    completion_id = f"chatcmpl-{uuid.uuid4().hex}"
    return {
        "id": completion_id,
        "object": "chat.completion",
        "created": created,
        "model": model or "paddleocr",
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
    model_name = model or "paddleocr"

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
                "id": "paddle",
                "object": "model",
                "created": created,
                "owned_by": "paddle-text-processing",
            }
        ],
    }


def create_app(
    config: RuntimeConfig | None = None,
    detect_factory: PaddleDetectFactory | Any | None = None,
    ocr_factory: PaddleOcrFactory | Any | None = None,
) -> FastAPI:
    runtime = config or RuntimeConfig(enable_detect=True, enable_openai_ocr=False)
    resolved_detect_device = resolve_device(runtime.detect_device)
    resolved_ocr_device = resolve_device(runtime.ocr_device)
    detect_engines = detect_factory or PaddleDetectFactory(runtime, resolved_detect_device)
    ocr_engines = ocr_factory or PaddleOcrFactory(runtime, resolved_ocr_device)

    app = FastAPI(title="Paddle Text Processing", version="0.4.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.on_event("startup")
    async def log_runtime_startup() -> None:
        _log_startup_runtime("detect", runtime.enable_detect, resolved_detect_device)
        _log_startup_runtime("ocr", runtime.enable_openai_ocr, resolved_ocr_device)

    @app.get("/healthz")
    def healthz() -> dict[str, object]:
        return {
            "ok": True,
            "detector": "paddleocr",
            "version": "0.4.0",
            "features": {
                "detect": runtime.enable_detect,
                "openai_ocr": runtime.enable_openai_ocr,
            },
            "execution_provider": {
                "detect": {
                    "requested": resolved_detect_device.requested,
                    "resolved": resolved_detect_device.resolved,
                },
                "openai_ocr": {
                    "requested": resolved_ocr_device.requested,
                    "resolved": resolved_ocr_device.resolved,
                },
            },
            "runtime": {
                "cpu_threads": runtime.cpu_threads,
                "detect_model_name": runtime.detect_model_name,
                "ocr_detection_model_name": runtime.ocr_detection_model_name,
                "ocr_recognition_model_name": runtime.ocr_recognition_model_name,
                "enable_mkldnn": False,
                "enable_cinn": False,
                "flags_enable_pir_api": os.environ.get("FLAGS_enable_pir_api"),
                "paddle_pdx_enable_mkldnn_bydefault": os.environ.get("PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT"),
                "paddle_pdx_disable_model_source_check": os.environ.get("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"),
                "packages": {
                    "paddleocr": _package_version("paddleocr"),
                    "paddlepaddle": _package_version("paddlepaddle"),
                    "paddlepaddle-gpu": _package_version("paddlepaddle-gpu"),
                    "paddlex": _package_version("paddlex"),
                },
            },
        }

    if runtime.enable_detect:

        @app.post("/v1/detect")
        async def detect(
            request: Request,
            image: UploadFile = File(...),
            settings: str | None = Form(default=None),
        ) -> dict[str, object]:
            started = time.perf_counter()
            request_id = str(uuid.uuid4())
            logger.info("Paddle detect started request_id=%s", request_id)

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
            try:
                detector = detect_engines.get_engine()
            except Exception as error:
                logger.exception("Paddle detector initialization failed request_id=%s", request_id)
                return {
                    "status": "error",
                    "request_id": request_id,
                    "error": {"code": "detector_init_failed", "message": f"Paddle detector init failed: {error}"},
                }

            detect_start = time.perf_counter()
            try:
                result = detector.predict(image_rgb, batch_size=1)
            except Exception as error:
                logger.exception("Paddle detect failed request_id=%s", request_id)
                return {
                    "status": "error",
                    "request_id": request_id,
                    "error": {"code": "detect_failed", "message": f"Paddle detect failed: {error}"},
                }
            detect_ms = (time.perf_counter() - detect_start) * 1000

            if await request.is_disconnected():
                logger.info("Client disconnected during paddle detect request_id=%s", request_id)

            polygons = _extract_dt_polys(result)
            raw_boxes: list[dict[str, Any]] = []
            for poly in polygons:
                x_coords = [point[0] for point in poly]
                y_coords = [point[1] for point in poly]
                x1, x2 = max(0.0, min(x_coords)), min(float(img_w), max(x_coords))
                y1, y2 = max(0.0, min(y_coords)), min(float(img_h), max(y_coords))
                if x2 <= x1 or y2 <= y1:
                    continue
                entry: dict[str, Any] = {
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
                    "polygon": poly if parsed_settings.detector.include_polygons else None,
                }
                raw_boxes.append(entry)

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
                "Paddle detect completed request_id=%s raw_count=%d detect_ms=%.2f total_ms=%.2f",
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

            try:
                ocr = ocr_engines.get_engine()
            except Exception as error:  # noqa: BLE001
                logger.exception("Paddle OCR initialization failed")
                raise HTTPException(status_code=500, detail=f"Paddle OCR init failed: {error}") from error

            try:
                result = ocr.predict(image_rgb)
            except Exception as error:  # noqa: BLE001
                logger.exception("Paddle OCR request failed")
                raise HTTPException(status_code=500, detail=f"Paddle OCR failed: {error}") from error

            text = "\n".join(_extract_ocr_lines(result)).strip()
            if body.stream:
                return StreamingResponse(_build_openai_stream_events(text, body.model), media_type="text/event-stream")
            return _build_openai_response(text, body.model)

    return app
