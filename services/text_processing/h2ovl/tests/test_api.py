from __future__ import annotations

import base64
import io

from fastapi.testclient import TestClient
from PIL import Image

from h2ovl_text_processing.app import RuntimeConfig, create_app


def _image_bytes() -> bytes:
    image = Image.new("RGB", (128, 64), color="white")
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return buf.getvalue()


def _body(*, stream: bool = False) -> dict[str, object]:
    payload = base64.b64encode(_image_bytes()).decode("ascii")
    return {
        "model": "h2oai/h2ovl-mississippi-800m",
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
    def ensure_ready(self) -> None:
        return None

    def health_payload(self) -> dict[str, object]:
        return {
            "ok": True,
            "detector": "h2ovl",
            "version": "0.1.0",
            "features": {"detect": False, "openai_ocr": True},
            "execution_provider": {"openai_ocr": {"requested": "gpu", "resolved": "gpu"}},
            "runtime": {"model_id": "h2oai/h2ovl-mississippi-800m", "device": "cuda:0", "gpu_name": "Fake GPU"},
        }

    def complete(self, image_payload: bytes, prompt: str, max_new_tokens: int) -> str:
        assert image_payload
        assert "Extract" in prompt
        assert max_new_tokens > 0
        return "hello\nworld"

    def stream(self, image_payload: bytes, prompt: str, max_new_tokens: int):
        assert image_payload
        yield 'data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n'
        yield 'data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\n\n'
        yield 'data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'
        yield "data: [DONE]\n\n"


def _client() -> TestClient:
    return TestClient(create_app(config=RuntimeConfig(), runtime=FakeRuntime()))


def test_health_reports_gpu_only_ocr() -> None:
    client = _client()
    res = client.get("/healthz")
    data = res.json()

    assert res.status_code == 200
    assert data["features"] == {"detect": False, "openai_ocr": True}
    assert data["execution_provider"]["openai_ocr"]["resolved"] == "gpu"


def test_models_lists_mississippi() -> None:
    client = _client()
    res = client.get("/v1/models")
    data = res.json()

    assert res.status_code == 200
    assert data["data"][0]["id"] == "h2oai/h2ovl-mississippi-800m"


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
