from __future__ import annotations

import time
import uuid
from dataclasses import dataclass
from io import BytesIO

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from PIL import Image
from rapidocr_onnxruntime import RapidOCR


class PreprocessingSettings(BaseModel):
    binary_threshold: int = Field(default=0, ge=0, le=255)
    invert: bool = False
    dilation: int = Field(default=0, ge=-10, le=10)
    contrast: float = Field(default=1.0, ge=0.1, le=5)
    brightness: int = Field(default=0, ge=-255, le=255)


class DetectionSettings(BaseModel):
    min_width_ratio: float = Field(default=0.0, ge=0, le=1)
    min_height_ratio: float = Field(default=0.0, ge=0, le=1)
    median_height_fraction: float = Field(default=0.45, ge=0.0, le=2.0)


class DetectSettings(BaseModel):
    preprocessing: PreprocessingSettings = Field(default_factory=PreprocessingSettings)
    detection: DetectionSettings = Field(default_factory=DetectionSettings)


@dataclass
class BoxPx:
    x1: int
    y1: int
    x2: int
    y2: int


def create_app() -> FastAPI:
    app = FastAPI(title="Preprocessing RapidOCR Server", version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    ocr = RapidOCR()

    @app.get("/healthz")
    def healthz() -> dict[str, object]:
        return {"ok": True, "detector": "rapidocr", "version": "0.1.0"}

    @app.post("/v1/detect")
    async def detect(image: UploadFile = File(...), settings: str = Form(...)) -> dict[str, object]:
        started = time.perf_counter()
        request_id = str(uuid.uuid4())

        try:
            parsed = DetectSettings.model_validate_json(settings)
        except Exception as error:
            return {
                "status": "error",
                "request_id": request_id,
                "error": {"code": "invalid_settings", "message": f"Settings JSON is invalid: {error}"},
            }

        try:
            payload = await image.read()
            pil_image = Image.open(BytesIO(payload)).convert("RGB")
        except Exception as error:
            return {
                "status": "error",
                "request_id": request_id,
                "error": {"code": "invalid_image", "message": f"Image parsing failed: {error}"},
            }

        pre_start = time.perf_counter()
        processed = process_image(pil_image, parsed.preprocessing)
        preprocess_ms = (time.perf_counter() - pre_start) * 1000

        det_start = time.perf_counter()
        raw_boxes = detect_regions(processed, ocr)
        detect_ms = (time.perf_counter() - det_start) * 1000

        filter_start = time.perf_counter()
        filtered_boxes = filter_text_regions(raw_boxes, processed.shape[:2], parsed.detection)
        filter_ms = (time.perf_counter() - filter_start) * 1000

        img_h, img_w = processed.shape[:2]
        boxes = []
        for box in filtered_boxes:
            w = max(0, box.x2 - box.x1)
            h = max(0, box.y2 - box.y1)
            boxes.append(
                {
                    "id": str(uuid.uuid4()),
                    "norm": {
                        "x": box.x1 / img_w,
                        "y": box.y1 / img_h,
                        "w": w / img_w,
                        "h": h / img_h,
                    },
                    "px": {
                        "x1": box.x1,
                        "y1": box.y1,
                        "x2": box.x2,
                        "y2": box.y2,
                    },
                }
            )

        return {
            "status": "success",
            "request_id": request_id,
            "image": {"width": img_w, "height": img_h},
            "settings": parsed.model_dump(mode="json"),
            "boxes": boxes,
            "metrics": {
                "preprocess_ms": round(preprocess_ms, 2),
                "detect_ms": round(detect_ms, 2),
                "filter_ms": round(filter_ms, 2),
                "total_ms": round((time.perf_counter() - started) * 1000, 2),
                "raw_count": len(raw_boxes),
                "filtered_count": len(filtered_boxes),
            },
        }

    return app


def process_image(pil_image: Image.Image, settings: PreprocessingSettings) -> np.ndarray:
    img = np.array(pil_image)
    img = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)

    if settings.contrast != 1.0 or settings.brightness != 0:
        img = cv2.convertScaleAbs(img, alpha=settings.contrast, beta=settings.brightness)

    if settings.binary_threshold > 0:
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        _, gray = cv2.threshold(gray, settings.binary_threshold, 255, cv2.THRESH_BINARY)
        img = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)

    if settings.invert:
        img = cv2.bitwise_not(img)

    if settings.dilation != 0:
        kernel = np.ones((2, 2), np.uint8)
        if settings.dilation > 0:
            img = cv2.dilate(img, kernel, iterations=settings.dilation)
        else:
            img = cv2.erode(img, kernel, iterations=abs(settings.dilation))

    return img


def detect_regions(image_bgr: np.ndarray, ocr: RapidOCR) -> list[BoxPx]:
    result, _ = ocr(image_bgr, use_det=True, use_rec=False)
    boxes: list[BoxPx] = []

    if not result:
        return boxes

    for poly in result:
        if not isinstance(poly, list) or len(poly) < 4:
            continue
        x_coords = [int(float(point[0])) for point in poly]
        y_coords = [int(float(point[1])) for point in poly]
        x1, x2 = min(x_coords), max(x_coords)
        y1, y2 = min(y_coords), max(y_coords)
        if x2 > x1 and y2 > y1:
            boxes.append(BoxPx(x1=x1, y1=y1, x2=x2, y2=y2))

    return boxes


def filter_text_regions(text_regions: list[BoxPx], image_shape: tuple[int, int], settings: DetectionSettings) -> list[BoxPx]:
    if not text_regions:
        return []

    img_h, img_w = image_shape
    valid: list[BoxPx] = []
    heights: list[int] = []

    for box in text_regions:
        x1 = max(0, min(box.x1, img_w))
        x2 = max(0, min(box.x2, img_w))
        y1 = max(0, min(box.y1, img_h))
        y2 = max(0, min(box.y2, img_h))
        if x2 <= x1 or y2 <= y1:
            continue
        clamped = BoxPx(x1=x1, y1=y1, x2=x2, y2=y2)
        valid.append(clamped)
        heights.append(y2 - y1)

    if not valid:
        return []

    median_h = float(np.median(np.array(heights))) if heights else 0.0
    filtered: list[BoxPx] = []

    for box in valid:
        width = box.x2 - box.x1
        height = box.y2 - box.y1

        if settings.min_height_ratio > 0 and height < (img_h * settings.min_height_ratio):
            continue
        if settings.min_width_ratio > 0 and width < (img_w * settings.min_width_ratio):
            continue

        if median_h > 0 and height < (median_h * settings.median_height_fraction) and width < (median_h * 2):
            continue

        filtered.append(box)

    return filtered
