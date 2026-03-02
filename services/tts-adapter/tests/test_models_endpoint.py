from fastapi.testclient import TestClient

from tts_adapter.config import AppSettings
from tts_adapter.main import create_app
from tts_adapter.services.adapter_registry import AdapterRegistry


class FakeAdapter:
    model_id = "namaa-saudi-tts"

    def load(self) -> None:
        return None

    def synthesize(
        self,
        text: str,
        *,
        speed: float,
        voice: str | None,
        audio_prompt_path: str | None,
    ) -> bytes:
        del text, speed, voice, audio_prompt_path
        return b"RIFF"


class FakeRegistry(AdapterRegistry):
    def _resolve_device(self) -> str:
        return "cpu"

    def get(self, model_id: str) -> FakeAdapter:
        if model_id != self.settings.model_id:
            raise RuntimeError("Unknown model")
        return FakeAdapter()


def test_models_endpoint_lists_model() -> None:
    settings = AppSettings(TTS_MODEL_ID="namaa-saudi-tts")
    fake_registry = FakeRegistry(settings=settings, allow_cpu=True)
    app = create_app(settings=settings, allow_cpu=True, registry=fake_registry)
    client = TestClient(app)

    res = client.get("/v1/models")
    assert res.status_code == 200
    payload = res.json()
    assert payload["object"] == "list"
    assert payload["data"][0]["id"] == "namaa-saudi-tts"
