from __future__ import annotations

from fastapi.testclient import TestClient

from katib_text_processing.app import DEFAULT_MODEL_ID, RuntimeConfig, create_app


class FakeRuntime:
    def warmup(self) -> None:
        return None

    def health_payload(self) -> dict:
        return {
            "ok": True,
            "detector": "katib",
            "features": {"detect": False, "openai_ocr": True},
            "execution_provider": {"openai_ocr": {"requested": "gpu", "resolved": "gpu"}},
            "runtime": {"model_id": DEFAULT_MODEL_ID, "device": "cuda:0", "gpu_name": "Fake GPU"},
        }

    def complete(self, image_payload: bytes, prompt: str, max_new_tokens: int, cancel_event: object | None = None) -> str:
        assert image_payload == b"image"
        assert prompt == "Free OCR"
        assert max_new_tokens == 32
        assert cancel_event is not None
        assert getattr(cancel_event, "is_set")() is False
        return "مرحبا"


def test_models_lists_katib() -> None:
    client = TestClient(create_app(config=RuntimeConfig(), runtime=FakeRuntime()))

    res = client.get("/v1/models")

    assert res.status_code == 200
    assert res.json()["data"][0]["id"] == DEFAULT_MODEL_ID


def test_chat_completion_returns_ocr_text() -> None:
    client = TestClient(create_app(config=RuntimeConfig(max_new_tokens=32), runtime=FakeRuntime()))

    res = client.post(
        "/v1/chat/completions",
        json={
            "model": DEFAULT_MODEL_ID,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "Free OCR"},
                        {"type": "image_url", "image_url": {"url": "data:image/png;base64,aW1hZ2U="}},
                    ],
                }
            ],
        },
    )

    assert res.status_code == 200
    assert res.json()["choices"][0]["message"]["content"] == "مرحبا"
