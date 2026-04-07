from __future__ import annotations

import base64
import io

from fastapi.testclient import TestClient
from PIL import Image

from windows_ocr_text_processing.app import OcrResult, RuntimeConfig, create_app


def _image_bytes() -> bytes:
    image = Image.new("RGB", (128, 64), color="white")
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return buf.getvalue()


def _body(*, stream: bool = False) -> dict[str, object]:
    payload = base64.b64encode(_image_bytes()).decode("ascii")
    return {
        "model": "windows-media-ocr",
        "stream": stream,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "Extract all text"},
                    {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{payload}"}},
                ],
            }
        ],
    }


class FakeRuntime:
    def health_payload(self) -> dict[str, object]:
        return {
            "ok": True,
            "detector": "windows_ocr",
            "version": "0.1.0",
            "features": {"detect": False, "openai_ocr": True},
            "execution_provider": {"openai_ocr": {"requested": "native_windows", "resolved": "native_windows"}},
            "runtime": {"language_tag": "en-US", "available_languages": ["en-US"], "max_image_dimension": 4096},
        }

    async def recognize(self, image_payload: bytes, prompt: str, max_new_tokens: int) -> OcrResult:
        assert image_payload
        assert "Extract" in prompt
        assert max_new_tokens > 0
        return OcrResult(text="hello\nworld", lines=[], language_tag="en-US", max_image_dimension=4096)


class ValueErrorRuntime(FakeRuntime):
    async def recognize(self, image_payload: bytes, prompt: str, max_new_tokens: int) -> OcrResult:
        raise ValueError("Image is too big")


class BrokenRuntime(FakeRuntime):
    async def recognize(self, image_payload: bytes, prompt: str, max_new_tokens: int) -> OcrResult:
        raise RuntimeError("ocr unavailable")


def _client(runtime: object | None = None) -> TestClient:
    return TestClient(create_app(config=RuntimeConfig(), runtime=runtime or FakeRuntime()))


def test_health_reports_ocr_only() -> None:
    client = _client()
    res = client.get("/healthz")
    data = res.json()

    assert res.status_code == 200
    assert data["features"] == {"detect": False, "openai_ocr": True}
    assert data["execution_provider"]["openai_ocr"]["resolved"] == "native_windows"


def test_models_lists_windows_media_ocr() -> None:
    client = _client()
    res = client.get("/v1/models")
    data = res.json()

    assert res.status_code == 200
    assert data["data"][0]["id"] == "windows-media-ocr"


def test_chat_completion_returns_openai_shape() -> None:
    client = _client()
    res = client.post("/v1/chat/completions", json=_body())
    data = res.json()

    assert res.status_code == 200
    assert data["object"] == "chat.completion"
    assert data["choices"][0]["message"]["content"] == "hello\nworld"


def test_chat_completion_streams_sse() -> None:
    client = _client()
    res = client.post("/v1/chat/completions", json=_body(stream=True))

    assert res.status_code == 200
    assert "data: [DONE]" in res.text


def test_chat_completion_requires_image() -> None:
    client = _client()
    res = client.post("/v1/chat/completions", json={"messages": [{"role": "user", "content": "hi"}]})

    assert res.status_code == 400


def test_chat_completion_returns_bad_request_for_value_error() -> None:
    client = _client(ValueErrorRuntime())
    res = client.post("/v1/chat/completions", json=_body())

    assert res.status_code == 400
    assert "Image is too big" in res.json()["detail"]


def test_chat_completion_returns_server_error_for_runtime_failure() -> None:
    client = _client(BrokenRuntime())
    res = client.post("/v1/chat/completions", json=_body())

    assert res.status_code == 500
    assert "Windows OCR failed" in res.json()["detail"]
