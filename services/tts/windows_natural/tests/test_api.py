from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from tts_windows_natural_adapter.app import HelperClient, Settings, WindowsNaturalRuntime, create_app


class FakeHelper:
    def __init__(self) -> None:
        self.synth_calls: list[tuple[str, str, str | None, str]] = []
        self.list_voice_calls = 0

    def list_voices(self) -> dict[str, object]:
        self.list_voice_calls += 1
        return {
            "helper_version": "0.1.0",
            "voices": [
                {
                    "id": "windows-natural:en-GB:SoniaNeural",
                    "name": "Microsoft Sonia (Natural) - English (United Kingdom)",
                    "language": "en-GB",
                    "gender": "Female",
                    "source": "narrator_local",
                    "path": "C:\\voices\\sonia",
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
                    "path": "C:\\voices\\sonia-installed",
                    "backend": "installed-appx-current",
                    "compatibilityMode": "installed_voice_requires_current_narrator_license",
                    "compatible": False,
                    "error": "Invalid embedded speech synthesis model license.",
                },
            ],
        }

    def synthesize(self, text: str, voice_id: str, voice_root: str | None = None, output_format: str = "Riff24Khz16BitMonoPcm") -> bytes:
        self.synth_calls.append((text, voice_id, voice_root, output_format))
        return b"RIFFtestWAVEfmt "


def _client(helper: FakeHelper | None = None) -> TestClient:
    runtime = WindowsNaturalRuntime(Settings(), helper=helper or FakeHelper())  # type: ignore[arg-type]
    return TestClient(create_app(settings=Settings(), runtime=runtime))


def _client_with_settings(settings: Settings, helper: FakeHelper | None = None) -> TestClient:
    runtime = WindowsNaturalRuntime(settings, helper=helper or FakeHelper())  # type: ignore[arg-type]
    return TestClient(create_app(settings=settings, runtime=runtime))


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
    assert helper.synth_calls == [("hello", "windows-natural:en-GB:SoniaNeural", "C:\\voices\\sonia", "Riff24Khz16BitMonoPcm")]


def test_speech_reuses_cached_voice_probe() -> None:
    helper = FakeHelper()
    client = _client(helper)

    for text in ("hello", "hello again"):
        response = client.post("/v1/audio/speech", json={"input": text, "voice": "windows-natural:en-GB:SoniaNeural", "response_format": "wav"})
        assert response.status_code == 200

    assert helper.list_voice_calls == 1
    assert helper.synth_calls == [
        ("hello", "windows-natural:en-GB:SoniaNeural", "C:\\voices\\sonia", "Riff24Khz16BitMonoPcm"),
        ("hello again", "windows-natural:en-GB:SoniaNeural", "C:\\voices\\sonia", "Riff24Khz16BitMonoPcm"),
    ]


def test_speech_uses_configured_output_format() -> None:
    helper = FakeHelper()
    settings = Settings(WINDOWS_NATURAL_OUTPUT_FORMAT="Riff16Khz16BitMonoPcm")
    client = _client_with_settings(settings, helper)

    response = client.post("/v1/audio/speech", json={"input": "hello", "voice": "windows-natural:en-GB:SoniaNeural"})

    assert response.status_code == 200
    assert helper.synth_calls == [("hello", "windows-natural:en-GB:SoniaNeural", "C:\\voices\\sonia", "Riff16Khz16BitMonoPcm")]


def test_daemon_pool_size_env_defaults_to_three(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("WINDOWS_NATURAL_DAEMON_POOL_SIZE", raising=False)

    assert HelperClient._read_daemon_pool_size() == 3


def test_daemon_pool_size_env_allows_disable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WINDOWS_NATURAL_DAEMON_POOL_SIZE", "0")

    assert HelperClient._read_daemon_pool_size() == 0


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
