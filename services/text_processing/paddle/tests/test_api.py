from __future__ import annotations

import io
import json

import numpy as np
from fastapi.testclient import TestClient
from PIL import Image

from paddle_text_processing.app import RuntimeConfig, create_app


def _image_bytes() -> bytes:
    image = Image.new("RGB", (200, 120), color="white")
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return buf.getvalue()


class FakeResult:
    def __init__(self, polys: list[list[list[float]]]):
        self.polys = polys


class FakeDetector:
    def ocr(self, image_bgr: np.ndarray, cls: bool = False, rec: bool = False, det: bool = True) -> list[list[list[list[float]]]]:
        assert image_bgr.ndim == 3
        assert cls is False
        assert rec is False
        assert det is True
        return [
            [
                [[10.0, 12.0], [110.0, 10.0], [111.0, 42.0], [9.0, 44.0]],
                [[20.0, 60.0], [140.0, 60.0], [140.0, 95.0], [20.0, 95.0]],
            ]
        ]


class FakeFactory:
    def __init__(self) -> None:
        self.calls = 0

    def get_detector(self) -> FakeDetector:
        self.calls += 1
        return FakeDetector()


def _client(factory: FakeFactory | None = None) -> TestClient:
    return TestClient(create_app(config=RuntimeConfig(device="cpu"), detector_factory=factory or FakeFactory()))


def test_health_reports_detector_and_device() -> None:
    client = _client()
    res = client.get("/healthz")
    data = res.json()

    assert res.status_code == 200
    assert data["ok"] is True
    assert data["detector"] == "paddleocr"
    assert data["execution_provider"]["detect"]["resolved"] == "cpu"


def test_detect_returns_axis_aligned_boxes() -> None:
    factory = FakeFactory()
    client = _client(factory)
    files = {
        "image": ("sample.png", _image_bytes(), "image/png"),
        "settings": (None, json.dumps({"detector": {"include_polygons": False}})),
    }

    res = client.post("/v1/detect", files=files)
    data = res.json()

    assert res.status_code == 200
    assert data["status"] == "success"
    assert data["metrics"]["raw_count"] == 2
    assert data["raw_boxes"][0]["px"] == {"x1": 9, "y1": 10, "x2": 111, "y2": 44}
    assert data["raw_boxes"][0]["polygon"] is None
    assert factory.calls == 1


def test_detect_can_include_polygons() -> None:
    client = _client()
    files = {
        "image": ("sample.png", _image_bytes(), "image/png"),
        "settings": (None, json.dumps({"detector": {"include_polygons": True}})),
    }

    res = client.post("/v1/detect", files=files)
    data = res.json()

    assert res.status_code == 200
    assert len(data["raw_boxes"][0]["polygon"]) == 4


def test_detect_invalid_image() -> None:
    client = _client()
    files = {
        "image": ("bad.bin", b"not-an-image", "application/octet-stream"),
        "settings": (None, json.dumps({"detector": {"include_polygons": False}})),
    }

    res = client.post("/v1/detect", files=files)
    data = res.json()

    assert data["status"] == "error"
    assert data["error"]["code"] == "invalid_image"


class BrokenFactory:
    def get_detector(self) -> FakeDetector:
        raise RuntimeError("missing paddle")


def test_detect_surfaces_detector_init_error() -> None:
    client = TestClient(create_app(config=RuntimeConfig(device="cpu"), detector_factory=BrokenFactory()))
    files = {
        "image": ("sample.png", _image_bytes(), "image/png"),
        "settings": (None, json.dumps({"detector": {"include_polygons": False}})),
    }

    res = client.post("/v1/detect", files=files)
    data = res.json()

    assert res.status_code == 200
    assert data["status"] == "error"
    assert data["error"]["code"] == "detector_init_failed"
