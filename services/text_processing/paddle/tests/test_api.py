from __future__ import annotations

import base64
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


def _openai_body() -> dict[str, object]:
    payload = base64.b64encode(_image_bytes()).decode("ascii")
    return {
        "model": "paddle-test",
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:image/png;base64,{payload}"},
                    }
                ],
            }
        ],
    }


class FakeDetectionResult:
    def __init__(self, polys: list[list[list[float]]]):
        self.res = {"dt_polys": np.asarray(polys, dtype=np.float32)}


class FakeDetectEngine:
    def predict(self, image_rgb: np.ndarray, batch_size: int = 1) -> list[FakeDetectionResult]:
        assert image_rgb.ndim == 3
        assert batch_size == 1
        return [
            FakeDetectionResult(
                [
                    [[10.0, 12.0], [110.0, 10.0], [111.0, 42.0], [9.0, 44.0]],
                    [[20.0, 60.0], [140.0, 60.0], [140.0, 95.0], [20.0, 95.0]],
                ]
            )
        ]


class FakeOcrResult:
    def __init__(self, texts: list[str]):
        self.res = {"rec_texts": texts}


class FakeOcrEngine:
    def predict(self, image_rgb: np.ndarray) -> list[FakeOcrResult]:
        assert image_rgb.ndim == 3
        return [FakeOcrResult(["hello", "world"])]


class FakeDetectFactory:
    def __init__(self) -> None:
        self.calls = 0

    def get_engine(self) -> FakeDetectEngine:
        self.calls += 1
        return FakeDetectEngine()


class FakeOcrFactory:
    def __init__(self) -> None:
        self.calls = 0

    def get_engine(self) -> FakeOcrEngine:
        self.calls += 1
        return FakeOcrEngine()


class BrokenFactory:
    def get_engine(self):
        raise RuntimeError("missing paddle")


def _client(
    *,
    enable_detect: bool = True,
    enable_openai_ocr: bool = False,
    detect_factory=None,
    ocr_factory=None,
) -> TestClient:
    return TestClient(
        create_app(
            config=RuntimeConfig(
                enable_detect=enable_detect,
                enable_openai_ocr=enable_openai_ocr,
                detect_device="cpu",
                ocr_device="cpu",
            ),
            detect_factory=detect_factory,
            ocr_factory=ocr_factory,
        )
    )


def test_health_reports_features_and_devices() -> None:
    client = _client(enable_detect=True, enable_openai_ocr=True)
    res = client.get("/healthz")
    data = res.json()

    assert res.status_code == 200
    assert data["ok"] is True
    assert data["features"] == {"detect": True, "openai_ocr": True}
    assert data["execution_provider"]["detect"]["resolved"] == "cpu"
    assert data["execution_provider"]["openai_ocr"]["resolved"] == "cpu"


def test_detect_returns_axis_aligned_boxes() -> None:
    factory = FakeDetectFactory()
    client = _client(detect_factory=factory)
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
    client = _client(detect_factory=FakeDetectFactory())
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


def test_detect_surfaces_detector_init_error() -> None:
    client = _client(detect_factory=BrokenFactory())
    files = {
        "image": ("sample.png", _image_bytes(), "image/png"),
        "settings": (None, json.dumps({"detector": {"include_polygons": False}})),
    }

    res = client.post("/v1/detect", files=files)
    data = res.json()

    assert res.status_code == 200
    assert data["status"] == "error"
    assert data["error"]["code"] == "detector_init_failed"


def test_openai_models_lists_paddle_model() -> None:
    client = _client(enable_detect=False, enable_openai_ocr=True, ocr_factory=FakeOcrFactory())
    res = client.get("/v1/models")
    data = res.json()

    assert res.status_code == 200
    assert data["data"][0]["id"] == "paddle"


def test_openai_ocr_returns_chat_completion_shape() -> None:
    factory = FakeOcrFactory()
    client = _client(enable_detect=False, enable_openai_ocr=True, ocr_factory=factory)
    res = client.post("/v1/chat/completions", json=_openai_body())
    data = res.json()

    assert res.status_code == 200
    assert data["model"] == "paddle-test"
    assert data["choices"][0]["message"]["content"] == "hello\nworld"
    assert factory.calls == 1


def test_openai_ocr_fake_streaming_returns_sse_chunks() -> None:
    client = _client(enable_detect=False, enable_openai_ocr=True, ocr_factory=FakeOcrFactory())
    body = _openai_body()
    body["stream"] = True
    res = client.post("/v1/chat/completions", json=body)

    assert res.status_code == 200
    assert "data: [DONE]" in res.text


def test_openai_ocr_requires_image() -> None:
    client = _client(enable_detect=False, enable_openai_ocr=True, ocr_factory=FakeOcrFactory())
    res = client.post("/v1/chat/completions", json={"messages": [{"role": "user", "content": "hi"}]})

    assert res.status_code == 400


def test_openai_ocr_endpoint_absent_when_feature_disabled() -> None:
    client = _client(enable_detect=True, enable_openai_ocr=False)
    res = client.get("/v1/models")

    assert res.status_code == 404
