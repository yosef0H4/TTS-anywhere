from __future__ import annotations

from fastapi.testclient import TestClient

from tts_supertonic_adapter.app import DEFAULT_VOICE_ID, SUPERTONIC_MODEL_ID, Settings, SupertonicRuntime, create_app


class FakeRuntime:
    _providers = ["CPUExecutionProvider"]

    def warmup(self) -> None:
        return None

    def loaded(self) -> bool:
        return True

    def get_available_voices(self) -> list[str]:
        return [DEFAULT_VOICE_ID]

    def __init__(self) -> None:
        self.languages: list[str | None] = []

    def synth_to_wav(self, text: str, voice: str | None, speed: float | None, language: str | None = None) -> bytes:
        assert text == "hello"
        assert voice == DEFAULT_VOICE_ID
        assert speed == 1.0
        self.languages.append(language)
        return b"RIFFfake"


def test_models_lists_supertonic() -> None:
    client = TestClient(create_app(settings=Settings(), runtime=FakeRuntime()))

    res = client.get("/v1/models")

    assert res.status_code == 200
    assert res.json()["data"][0]["id"] == SUPERTONIC_MODEL_ID


def test_speech_returns_wav() -> None:
    runtime = FakeRuntime()
    client = TestClient(create_app(settings=Settings(), runtime=runtime))

    res = client.post(
        "/v1/audio/speech",
        json={"model": SUPERTONIC_MODEL_ID, "input": "hello", "voice": DEFAULT_VOICE_ID, "speed": 1.0},
    )

    assert res.status_code == 200
    assert res.headers["content-type"] == "audio/wav"
    assert res.content == b"RIFFfake"
    assert runtime.languages == [None]


def test_speech_accepts_language_hints() -> None:
    runtime = FakeRuntime()
    client = TestClient(create_app(settings=Settings(), runtime=runtime))

    res = client.post(
        "/v1/audio/speech",
        json={"model": SUPERTONIC_MODEL_ID, "input": "hello", "voice": DEFAULT_VOICE_ID, "speed": 1.0, "instructions": "Please read this in Arabic."},
    )

    assert res.status_code == 200
    assert runtime.languages == ["ar"]


def test_sanitizes_unsupported_ipa_characters() -> None:
    class FakeTextProcessor:
        def validate_text(self, text: str) -> tuple[bool, list[str]]:
            unsupported = [char for char in text if char in {"ɒ", "ɜ", "ˈ", "ː"}]
            return not unsupported, unsupported

    class FakeTts:
        model = type("FakeModel", (), {"text_processor": FakeTextProcessor()})()

    runtime = SupertonicRuntime(Settings())
    runtime._tts = FakeTts()

    assert runtime._sanitize_text("word /ˈwɜːd/ and /ɒ/") == "word / w d/ and / /"
