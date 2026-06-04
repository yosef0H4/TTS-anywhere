from __future__ import annotations

import logging

import pytest
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
        self.steps: list[int | None] = []

    def synth_to_wav(self, text: str, voice: str | None, speed: float | None, language: str | None = None, total_steps: int | None = None) -> bytes:
        assert text == "hello"
        assert voice == DEFAULT_VOICE_ID
        assert speed == 1.0
        self.languages.append(language)
        self.steps.append(total_steps)
        return b"RIFFfake"


def test_models_lists_supertonic() -> None:
    client = TestClient(create_app(settings=Settings(), runtime=FakeRuntime()))

    res = client.get("/v1/models")

    assert res.status_code == 200
    assert res.json()["data"][0]["id"] == SUPERTONIC_MODEL_ID


def test_default_steps_preserve_quality() -> None:
    assert Settings().total_steps == 6


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
    assert runtime.steps == [None]


def test_speech_accepts_language_hints() -> None:
    runtime = FakeRuntime()
    client = TestClient(create_app(settings=Settings(), runtime=runtime))

    res = client.post(
        "/v1/audio/speech",
        json={"model": SUPERTONIC_MODEL_ID, "input": "hello", "voice": DEFAULT_VOICE_ID, "speed": 1.0, "instructions": "Please read this in Arabic."},
    )

    assert res.status_code == 200
    assert runtime.languages == ["ar"]
    assert runtime.steps == [None]


def test_speech_accepts_short_language_hints() -> None:
    runtime = FakeRuntime()
    client = TestClient(create_app(settings=Settings(), runtime=runtime))

    res = client.post(
        "/v1/audio/speech",
        json={"model": SUPERTONIC_MODEL_ID, "input": "hello", "voice": DEFAULT_VOICE_ID, "speed": 1.0, "instructions": "random text ar please"},
    )

    assert res.status_code == 200
    assert runtime.languages == ["ar"]


@pytest.mark.parametrize(
    ("hint", "expected"),
    [
        ("eng", "en"),
        ("en", "en"),
        ("english", "en"),
        ("arabic", "ar"),
        ("arab", "ar"),
        ("ar", "ar"),
    ],
)
def test_speech_accepts_language_aliases(hint: str, expected: str) -> None:
    runtime = FakeRuntime()
    client = TestClient(create_app(settings=Settings(), runtime=runtime))

    res = client.post(
        "/v1/audio/speech",
        json={"model": SUPERTONIC_MODEL_ID, "input": "hello", "voice": DEFAULT_VOICE_ID, "speed": 1.0, "instructions": f"random text {hint} please"},
    )

    assert res.status_code == 200
    assert runtime.languages == [expected]


def test_speech_uses_first_language_hint() -> None:
    runtime = FakeRuntime()
    client = TestClient(create_app(settings=Settings(), runtime=runtime))

    res = client.post(
        "/v1/audio/speech",
        json={"model": SUPERTONIC_MODEL_ID, "input": "hello", "voice": DEFAULT_VOICE_ID, "speed": 1.0, "instructions": "anything en then later Arabic"},
    )

    assert res.status_code == 200
    assert runtime.languages == ["en"]


def test_speech_accepts_explicit_total_steps() -> None:
    runtime = FakeRuntime()
    client = TestClient(create_app(settings=Settings(), runtime=runtime))

    res = client.post(
        "/v1/audio/speech",
        json={"model": SUPERTONIC_MODEL_ID, "input": "hello", "voice": DEFAULT_VOICE_ID, "speed": 1.0, "total_steps": 6},
    )

    assert res.status_code == 200
    assert runtime.steps == [6]


def test_speech_accepts_steps_hints() -> None:
    runtime = FakeRuntime()
    client = TestClient(create_app(settings=Settings(), runtime=runtime))

    res = client.post(
        "/v1/audio/speech",
        json={"model": SUPERTONIC_MODEL_ID, "input": "hello", "voice": DEFAULT_VOICE_ID, "speed": 1.0, "instructions": "Use Arabic and Supertonic steps 5."},
    )

    assert res.status_code == 200
    assert runtime.languages == ["ar"]
    assert runtime.steps == [5]


def test_speech_accepts_compact_steps_hints() -> None:
    runtime = FakeRuntime()
    client = TestClient(create_app(settings=Settings(), runtime=runtime))

    res = client.post(
        "/v1/audio/speech",
        json={"model": SUPERTONIC_MODEL_ID, "input": "hello", "voice": DEFAULT_VOICE_ID, "speed": 1.0, "prompt": "12steps"},
    )

    assert res.status_code == 200
    assert runtime.steps == [12]


def test_speech_uses_first_steps_hint() -> None:
    runtime = FakeRuntime()
    client = TestClient(create_app(settings=Settings(), runtime=runtime))

    res = client.post(
        "/v1/audio/speech",
        json={"model": SUPERTONIC_MODEL_ID, "input": "hello", "voice": DEFAULT_VOICE_ID, "speed": 1.0, "prompt": "random text 4steps then 8 steps"},
    )

    assert res.status_code == 200
    assert runtime.steps == [4]


def test_speech_logs_resolved_controls(caplog) -> None:
    runtime = FakeRuntime()
    client = TestClient(create_app(settings=Settings(), runtime=runtime))

    with caplog.at_level(logging.INFO, logger="tts_supertonic_adapter"):
        res = client.post(
            "/v1/audio/speech",
            json={"model": SUPERTONIC_MODEL_ID, "input": "hello", "voice": DEFAULT_VOICE_ID, "speed": 1.0, "instructions": "ar 4steps"},
        )

    assert res.status_code == 200
    assert "voice='M1' language_hint=ar steps_hint=4" in caplog.text


def test_nvidia_runtime_receives_voice_language_and_steps() -> None:
    class FakeNvidiaRuntime(SupertonicRuntime):
        def __init__(self) -> None:
            super().__init__(Settings(SUPERTONIC_RUNTIME="nvidia"))
            self.calls: list[tuple[str, str, str | None, int]] = []

        def load(self) -> None:
            self._tts = object()

        def _sanitize_text(self, text: str, language: str | None = None) -> str:
            return text

        def _synth_to_wav_pytorch_cuda(self, text: str, voice: str, speed: float | None, language: str | None, total_steps: int) -> bytes:
            self.calls.append((text, voice, language, total_steps))
            return b"RIFFnvidia"

    runtime = FakeNvidiaRuntime()

    wav = runtime.synth_to_wav("hello", voice=DEFAULT_VOICE_ID, speed=1.0, language="ar", total_steps=4)

    assert wav == b"RIFFnvidia"
    assert runtime.calls == [("hello", DEFAULT_VOICE_ID, "ar", 4)]


def test_rejects_invalid_step_hints() -> None:
    runtime = FakeRuntime()
    client = TestClient(create_app(settings=Settings(), runtime=runtime))

    res = client.post(
        "/v1/audio/speech",
        json={"model": SUPERTONIC_MODEL_ID, "input": "hello", "voice": DEFAULT_VOICE_ID, "speed": 1.0, "instructions": "Use steps 99."},
    )

    assert res.status_code == 400
    assert runtime.steps == []


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
