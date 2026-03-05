from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient

from rapid_text_processing.app import create_app


def _image_bytes() -> bytes:
    image_path = Path(__file__).resolve().parents[1] / "sgdsfg.webp"
    return image_path.read_bytes()


def test_detect_accepts_missing_request_id() -> None:
    client = TestClient(create_app())
    files = {
        "image": ("sample.webp", _image_bytes(), "image/webp"),
        "settings": (None, json.dumps({"detector": {"include_polygons": False}})),
    }

    res = client.post("/v1/detect", files=files)
    data = res.json()

    assert data["status"] == "success"
    assert isinstance(data.get("request_id"), str)


def test_detect_invalid_image() -> None:
    client = TestClient(create_app())
    files = {
        "image": ("bad.bin", b"not-an-image", "application/octet-stream"),
        "settings": (None, json.dumps({"detector": {"include_polygons": False}})),
    }

    res = client.post("/v1/detect", files=files)
    data = res.json()

    assert data["status"] == "error"
    assert data["error"]["code"] == "invalid_image"


def test_detect_invalid_settings_falls_back_defaults() -> None:
    client = TestClient(create_app())
    files = {
        "image": ("sample.webp", _image_bytes(), "image/webp"),
        "settings": (None, "{bad-json"),
    }

    res = client.post("/v1/detect", files=files)
    data = res.json()

    # malformed settings should not crash detect; service falls back to defaults
    assert data["status"] == "success"
    assert "request_id" in data


def test_real_image_detect_success() -> None:
    client = TestClient(create_app())
    files = {
        "image": ("sgdsfg.webp", _image_bytes(), "image/webp"),
        "settings": (None, json.dumps({"detector": {"include_polygons": False}})),
    }
    res = client.post("/v1/detect", files=files)
    data = res.json()

    assert data["status"] == "success"
    assert isinstance(data.get("raw_boxes"), list)
    assert data["metrics"]["raw_count"] >= 0
