from __future__ import annotations

import base64
import json
from pathlib import Path
from typing import Any

import numpy as np
from fastapi.testclient import TestClient

from rapid_text_processing.app import RuntimeConfig, create_app


def _image_bytes() -> bytes:
    image_path = Path(__file__).resolve().parents[1] / "sgdsfg.webp"
    return image_path.read_bytes()


def _image_data_url() -> str:
    encoded = base64.b64encode(_image_bytes()).decode("ascii")
    return f"data:image/webp;base64,{encoded}"


class FakeDetectEngine:
    def __call__(self, image_rgb: np.ndarray, use_det: bool = True, use_rec: bool = False) -> tuple[list[list[list[float]]], None]:
        assert image_rgb.ndim == 3
        assert use_det is True
        assert use_rec is False
        return (
            [
                [[10.0, 10.0], [110.0, 10.0], [110.0, 45.0], [10.0, 45.0]],
                [[20.0, 60.0], [140.0, 60.0], [140.0, 95.0], [20.0, 95.0]],
            ],
            None,
        )


class FakeOcrResult:
    def __init__(self, txts: list[str]):
        self.txts = txts


class FakeOcrEngine:
    def __call__(self, image_rgb: np.ndarray, use_det: bool = True, use_cls: bool = True, use_rec: bool = True) -> FakeOcrResult:
        assert image_rgb.ndim == 3
        assert use_det is True
        assert use_cls is True
        assert use_rec is True
        return FakeOcrResult(["hello", "world"])


class FakeEngineFactory:
    def __init__(self) -> None:
        self.detect_calls = 0
        self.ocr_calls = 0

    def get_detect_engine(self) -> Any:
        self.detect_calls += 1
        return FakeDetectEngine()

    def get_ocr_engine(self) -> Any:
        self.ocr_calls += 1
        return FakeOcrEngine()


def _detect_client(factory: FakeEngineFactory | None = None) -> TestClient:
    return TestClient(
        create_app(
            config=RuntimeConfig(enable_detect=True, enable_openai_ocr=False, execution_provider="cpu"),
            engine_factory=factory or FakeEngineFactory(),
        )
    )


def _ocr_client(factory: FakeEngineFactory | None = None) -> TestClient:
    return TestClient(
        create_app(
            config=RuntimeConfig(enable_detect=False, enable_openai_ocr=True, execution_provider="cpu"),
            engine_factory=factory or FakeEngineFactory(),
        )
    )


def test_detect_accepts_missing_request_id() -> None:
    client = _detect_client()
    files = {
        "image": ("sample.webp", _image_bytes(), "image/webp"),
        "settings": (None, json.dumps({"detector": {"include_polygons": False}})),
    }

    res = client.post("/v1/detect", files=files)
    data = res.json()

    assert data["status"] == "success"
    assert isinstance(data.get("request_id"), str)


def test_detect_invalid_image() -> None:
    client = _detect_client()
    files = {
        "image": ("bad.bin", b"not-an-image", "application/octet-stream"),
        "settings": (None, json.dumps({"detector": {"include_polygons": False}})),
    }

    res = client.post("/v1/detect", files=files)
    data = res.json()

    assert data["status"] == "error"
    assert data["error"]["code"] == "invalid_image"


def test_detect_invalid_settings_falls_back_defaults() -> None:
    client = _detect_client()
    files = {
        "image": ("sample.webp", _image_bytes(), "image/webp"),
        "settings": (None, "{bad-json"),
    }

    res = client.post("/v1/detect", files=files)
    data = res.json()

    assert data["status"] == "success"
    assert "request_id" in data


def test_real_image_detect_success() -> None:
    client = _detect_client()
    files = {
        "image": ("sgdsfg.webp", _image_bytes(), "image/webp"),
        "settings": (None, json.dumps({"detector": {"include_polygons": False}})),
    }
    res = client.post("/v1/detect", files=files)
    data = res.json()

    assert data["status"] == "success"
    assert isinstance(data.get("raw_boxes"), list)
    assert data["metrics"]["raw_count"] == 2


def test_health_reports_enabled_features_and_provider() -> None:
    client = _ocr_client()
    res = client.get("/healthz")
    data = res.json()

    assert data["ok"] is True
    assert data["features"] == {"detect": False, "openai_ocr": True}
    assert data["execution_provider"]["requested"] == "cpu"
    assert data["execution_provider"]["resolved"] == "cpu"


def test_openai_models_lists_rapid_model() -> None:
    client = _ocr_client()
    res = client.get("/v1/models")
    data = res.json()

    assert res.status_code == 200
    assert data["object"] == "list"
    assert data["data"][0]["id"] == "rapid"


def test_detect_endpoint_absent_when_feature_disabled() -> None:
    client = _ocr_client()
    res = client.post("/v1/detect")
    assert res.status_code == 404


def test_openai_ocr_returns_chat_completion_shape() -> None:
    factory = FakeEngineFactory()
    client = _ocr_client(factory)
    res = client.post(
        "/v1/chat/completions",
        json={
            "model": "rapid-test",
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "read this"},
                        {"type": "image_url", "image_url": {"url": _image_data_url()}},
                    ],
                }
            ],
        },
    )
    data = res.json()

    assert res.status_code == 200
    assert data["object"] == "chat.completion"
    assert data["model"] == "rapid-test"
    assert data["choices"][0]["message"]["content"] == "hello\nworld"
    assert factory.ocr_calls == 1


def test_openai_ocr_requires_image() -> None:
    client = _ocr_client()
    res = client.post(
        "/v1/chat/completions",
        json={
            "messages": [{"role": "user", "content": [{"type": "text", "text": "no image"}]}],
        },
    )

    assert res.status_code == 400
    assert "No image_url" in res.json()["detail"]


def test_openai_ocr_fake_streaming_returns_sse_chunks() -> None:
    client = _ocr_client()
    with client.stream(
        "POST",
        "/v1/chat/completions",
        json={
            "stream": True,
            "messages": [{"role": "user", "content": [{"type": "image_url", "image_url": {"url": _image_data_url()}}]}],
        },
    ) as res:
        body = res.read().decode("utf-8")

    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/event-stream")
    assert '"object": "chat.completion.chunk"' in body
    assert '"content": "hello\\nworld"' in body
    assert "data: [DONE]" in body


def test_openai_ocr_endpoint_absent_when_feature_disabled() -> None:
    client = _detect_client()
    res = client.post("/v1/chat/completions")
    assert res.status_code == 404
