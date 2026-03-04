from __future__ import annotations

import time
import uuid
from io import BytesIO
from typing import Any

import numpy as np
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from PIL import Image
from rapidocr_onnxruntime import RapidOCR


class DetectorSettings(BaseModel):
    include_polygons: bool = False


class DetectSettings(BaseModel):
    detector: DetectorSettings = Field(default_factory=DetectorSettings)


def create_app() -> FastAPI:
    app = FastAPI(title="Rapid Text Processing", version="0.1.0")
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
    async def detect(image: UploadFile = File(...), settings: str | None = Form(default=None)) -> dict[str, object]:
        started = time.perf_counter()
        request_id = str(uuid.uuid4())

        parsed_settings = DetectSettings()
        if settings:
            try:
                parsed_settings = DetectSettings.model_validate_json(settings)
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

        image_rgb = np.array(pil_image)
        img_h, img_w = image_rgb.shape[:2]

        detect_start = time.perf_counter()
        result, _ = ocr(image_rgb, use_det=True, use_rec=False)
        detect_ms = (time.perf_counter() - detect_start) * 1000

        raw_boxes: list[dict[str, Any]] = []
        if result:
            for poly in result:
                if not isinstance(poly, list) or len(poly) < 4:
                    continue
                points = []
                for point in poly:
                    try:
                        points.append([float(point[0]), float(point[1])])
                    except Exception:
                        points = []
                        break
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

        return {
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

    return app
