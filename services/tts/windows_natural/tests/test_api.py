from __future__ import annotations

from fastapi.testclient import TestClient

from tts_windows_natural_adapter.app import Settings, WindowsNaturalRuntime, create_app


class FakeHelper:
    def __init__(self) -> None:
        self.synth_calls: list[tuple[str, str]] = []

    def list_voices(self) -> dict[str, object]:
        return {
            "helper_version": "0.1.0",
            "voices": [
                {
                    "id": "windows-natural:en-GB:SoniaNeural",
                    "name": "Microsoft Sonia (Natural) - English (United Kingdom)",
                    "language": "en-GB",
                    "gender": "Female",
                    "source": "narrator_local",
                    "backend": "embedded-legacy-key",
                    "compatibilityMode": "embedded_legacy_key",
                    "compatible": True,
                },
                {
                    "id": "windows-natural:en-GB:SoniaNeural-installed",
                    "name": "Microsoft Sonia (Natural) - English (United Kingdom)",
                    "language": "en-GB",
                    "gender": "Female",
                    "source": "narrator_local",
                    "backend": "installed-appx-current",
                    "compatibilityMode": "installed_voice_requires_current_narrator_license",
                    "compatible": False,
                    "error": "Invalid embedded speech synthesis model license.",
                },
            ],
        }

    def synthesize(self, text: str, voice_id: str) -> bytes:
        self.synth_calls.append((text, voice_id))
        return b"RIFFtestWAVEfmt "


def _client(helper: FakeHelper | None = None) -> TestClient:
    runtime = WindowsNaturalRuntime(Settings(), helper=helper or FakeHelper())  # type: ignore[arg-type]
    return TestClient(create_app(settings=Settings(), runtime=runtime))


def test_models_endpoint_lists_windows_natural() -> None:
    client = _client()
    response = client.get("/v1/models")
    assert response.status_code == 200
    assert response.json()["data"][0]["id"] == "windows-natural"


def test_voices_endpoint_filters_incompatible_entries() -> None:
    client = _client()
    response = client.get("/v1/voices")
    assert response.status_code == 200
    assert response.json()["voices"] == [
        {
            "id": "windows-natural:en-GB:SoniaNeural",
            "name": "Microsoft Sonia (Natural) - English (United Kingdom)",
            "language": "en-GB",
            "gender": "Female",
            "source": "narrator_local",
        }
    ]


def test_speech_accepts_mp3_request_and_returns_wav() -> None:
    client = _client()
    response = client.post("/v1/audio/speech", json={"input": "hello", "voice": "windows-natural:en-GB:SoniaNeural", "response_format": "mp3"})
    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/wav"


def test_speech_synthesizes_with_sonia() -> None:
    helper = FakeHelper()
    client = _client(helper)
    response = client.post("/v1/audio/speech", json={"input": "hello", "voice": "windows-natural:en-GB:SoniaNeural", "response_format": "wav"})
    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/wav"
    assert helper.synth_calls == [("hello", "windows-natural:en-GB:SoniaNeural")]


def test_health_reports_compatible_and_incompatible_voices() -> None:
    client = _client()
    response = client.get("/healthz")
    payload = response.json()
    assert response.status_code == 200
    assert payload["sonia_available"] is True
    assert len(payload["compatible_voices"]) == 1
    assert len(payload["incompatible_voices"]) == 1
    assert len(payload["discovered_voices"]) == 2
    assert payload["backend_status"]["download-cache"] == "not_supported_voice_packages_must_be_installed_by_the_user"
