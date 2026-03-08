from __future__ import annotations

import logging
import os
import time
import uuid
from dataclasses import dataclass
from io import BytesIO
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Any

import numpy as np
from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
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
    from paddleocr import TextDetection
except Exception:  # noqa: BLE001
    TextDetection = None

logger = logging.getLogger("uvicorn.error")

DEFAULT_MODEL_NAME = "PP-OCRv5_mobile_det"
DEFAULT_CPU_THREADS = 4


class DetectorSettings(BaseModel):
    include_polygons: bool = False


class DetectSettings(BaseModel):
    detector: DetectorSettings = Field(default_factory=DetectorSettings)


class RuntimeConfig(BaseModel):
    device: str = "auto"
    model_name: str = DEFAULT_MODEL_NAME
    det_model_dir: str | None = None
    cpu_threads: int = DEFAULT_CPU_THREADS


@dataclass(frozen=True)
class DeviceResolution:
    requested: str
    resolved: str


def normalize_device(device: str) -> str:
    value = device.strip().lower()
    if value not in {"auto", "cpu", "gpu"}:
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
    if requested == "auto":
        return DeviceResolution(requested="auto", resolved="gpu" if _cuda_available() else "cpu")
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


class PaddleDetectorFactory:
    def __init__(self, config: RuntimeConfig, resolution: DeviceResolution):
        self.config = config
        self.resolution = resolution
        self._detector: Any | None = None

    def get_detector(self) -> Any:
        if self._detector is None:
            if paddle is None:
                raise RuntimeError("Paddle runtime is not installed. Install paddlepaddle==3.2.0.")
            if TextDetection is None:
                raise RuntimeError("PaddleOCR TextDetection is not installed")

            self._detector = TextDetection(
                model_name=self.config.model_name,
                model_dir=self.config.det_model_dir,
                device=self.resolution.resolved,
                enable_mkldnn=False,
                enable_cinn=False,
                cpu_threads=self.config.cpu_threads,
            )
        return self._detector


def _load_rgb_image(payload: bytes) -> np.ndarray:
    return np.array(Image.open(BytesIO(payload)).convert("RGB"))


def _extract_dt_polys(result: Any) -> list[list[list[float]]]:
    polygons: list[list[list[float]]] = []
    if not isinstance(result, list):
        return polygons

    for item in result:
        dt_polys = getattr(item, "dt_polys", None)
        if dt_polys is None and isinstance(item, dict):
            dt_polys = item.get("dt_polys")
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


def create_app(
    config: RuntimeConfig | None = None,
    detector_factory: PaddleDetectorFactory | Any | None = None,
) -> FastAPI:
    runtime = config or RuntimeConfig()
    resolved_device = resolve_device(runtime.device)
    detectors = detector_factory or PaddleDetectorFactory(runtime, resolved_device)

    app = FastAPI(title="Paddle Text Processing", version="0.3.0")
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
            "detector": "paddleocr",
            "version": "0.3.0",
            "features": {
                "detect": True,
                "openai_ocr": False,
            },
            "execution_provider": {
                "detect": {
                    "requested": resolved_device.requested,
                    "resolved": resolved_device.resolved,
                }
            },
            "runtime": {
                "model_name": runtime.model_name,
                "cpu_threads": runtime.cpu_threads,
                "enable_mkldnn": False,
                "enable_cinn": False,
                "flags_enable_pir_api": os.environ.get("FLAGS_enable_pir_api"),
                "paddle_pdx_enable_mkldnn_bydefault": os.environ.get("PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT"),
                "paddle_pdx_disable_model_source_check": os.environ.get("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"),
                "packages": {
                    "paddleocr": _package_version("paddleocr"),
                    "paddlepaddle": _package_version("paddlepaddle"),
                    "paddlex": _package_version("paddlex"),
                },
            },
        }

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
            detector = detectors.get_detector()
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
            }
            if parsed_settings.detector.include_polygons:
                entry["polygon"] = poly
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

    return app
