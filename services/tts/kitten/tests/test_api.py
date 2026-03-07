from __future__ import annotations

from typing import Any

import numpy as np
from fastapi.testclient import TestClient

from tts_kitten_adapter.app import KITTEN_MODELS, KittenRuntime, Settings, create_app


class FakeInnerModel:
    def __init__(self) -> None:
        self.session = object()


class FakeKittenModel:
    def __init__(self, model_id: str, voices: list[str]) -> None:
        self.model_id = model_id
        self.available_voices = voices
        self.model = FakeInnerModel()
        self.generate_calls: list[dict[str, Any]] = []
        self.fail_predicate: Any = None

    def generate(self, text: str, voice: str, speed: float) -> np.ndarray:
        if self.fail_predicate is not None and self.fail_predicate(text):
            raise RuntimeError(f"rejected:{text}")
        self.generate_calls.append({"text": text, "voice": voice, "speed": speed})
        return np.array([0.0, 0.1, -0.1, 0.0], dtype=np.float32)


class FakeKittenFactory:
    def __init__(self) -> None:
        self.created: list[str] = []
        self.instances: dict[str, FakeKittenModel] = {}

    def __call__(self, model_id: str, cache_dir: str | None) -> FakeKittenModel:
        assert cache_dir is None
        self.created.append(model_id)
        voices = ["Bella", "Jasper"] if model_id != KITTEN_MODELS[1] else ["Bella"]
        model = FakeKittenModel(model_id=model_id, voices=voices)
        self.instances[model_id] = model
        return model


def _make_runtime(factory: FakeKittenFactory | None = None) -> KittenRuntime:
    return KittenRuntime(Settings(default_model=KITTEN_MODELS[0], default_voice="Bella"), model_factory=factory or FakeKittenFactory())


def _make_client(runtime: KittenRuntime | None = None, api_key: str | None = None) -> TestClient:
    settings = Settings(default_model=KITTEN_MODELS[0], default_voice="Bella", api_key=api_key)
    return TestClient(create_app(settings=settings, runtime=runtime or _make_runtime()))


def test_models_endpoint_lists_all_kitten_models() -> None:
    client = _make_client()

    res = client.get("/v1/models")

    assert res.status_code == 200
    assert [item["id"] for item in res.json()["data"]] == list(KITTEN_MODELS)


def test_voices_endpoint_is_model_aware() -> None:
    factory = FakeKittenFactory()
    client = _make_client(runtime=_make_runtime(factory))

    res = client.get("/v1/voices", params={"model": KITTEN_MODELS[1]})

    assert res.status_code == 200
    assert res.json()["voices"] == [{"id": "Bella", "name": "Bella"}]
    assert factory.created == [KITTEN_MODELS[1]]


def test_speech_reuses_loaded_model_until_switch() -> None:
    factory = FakeKittenFactory()
    runtime = _make_runtime(factory)
    client = _make_client(runtime=runtime)

    first = client.post("/v1/audio/speech", json={"model": KITTEN_MODELS[0], "voice": "Bella", "input": "hello"})
    second = client.post("/v1/audio/speech", json={"model": KITTEN_MODELS[0], "voice": "Bella", "input": "again"})

    assert first.status_code == 200
    assert second.status_code == 200
    assert factory.created == [KITTEN_MODELS[0]]
    assert runtime.active_model_id == KITTEN_MODELS[0]


def test_switching_models_unloads_previous_before_loading_new_one() -> None:
    factory = FakeKittenFactory()
    runtime = _make_runtime(factory)

    runtime.get_available_voices(KITTEN_MODELS[0])
    previous = factory.instances[KITTEN_MODELS[0]]
    assert previous.model.session is not None

    runtime.get_available_voices(KITTEN_MODELS[1])

    assert factory.created == [KITTEN_MODELS[0], KITTEN_MODELS[1]]
    assert previous.model.session is None
    assert runtime.active_model_id == KITTEN_MODELS[1]


def test_retired_model_stays_alive_until_checked_out_request_finishes() -> None:
    factory = FakeKittenFactory()
    runtime = _make_runtime(factory)

    with runtime.checkout_model(KITTEN_MODELS[0]) as (_, checked_out_model):
        runtime.get_available_voices(KITTEN_MODELS[1])
        assert checked_out_model.model.session is not None

    assert checked_out_model.model.session is None
    assert runtime.active_model_id == KITTEN_MODELS[1]


def test_speech_rejects_unknown_voice_for_selected_model() -> None:
    client = _make_client(runtime=_make_runtime(FakeKittenFactory()))

    res = client.post("/v1/audio/speech", json={"model": KITTEN_MODELS[1], "voice": "Jasper", "input": "hello"})

    assert res.status_code == 400
    assert res.json()["detail"]["error"]["code"] == "voice_not_found"


def test_speech_rejects_unknown_model() -> None:
    client = _make_client()

    res = client.post("/v1/audio/speech", json={"model": "bad-model", "voice": "Bella", "input": "hello"})

    assert res.status_code == 400
    assert res.json()["detail"]["error"]["code"] == "model_not_found"


def test_health_reports_loaded_model() -> None:
    runtime = _make_runtime(FakeKittenFactory())
    runtime.get_available_voices(KITTEN_MODELS[2])
    client = _make_client(runtime=runtime)

    res = client.get("/healthz")

    assert res.status_code == 200
    assert res.json()["loaded_model"] == KITTEN_MODELS[2]


def test_auth_is_enforced_when_api_key_is_configured() -> None:
    client = _make_client(api_key="secret")

    res = client.get("/v1/models")

    assert res.status_code == 401


def test_speech_sanitizes_citations_before_retrying() -> None:
    factory = FakeKittenFactory()
    runtime = _make_runtime(factory)
    runtime.ensure_model_loaded(KITTEN_MODELS[0])
    factory.instances[KITTEN_MODELS[0]].fail_predicate = lambda text: "[" in text or "]" in text
    client = _make_client(runtime=runtime)

    res = client.post(
        "/v1/audio/speech",
        json={"model": KITTEN_MODELS[0], "voice": "Bella", "input": "Sherlock Holmes [1][2] is famous."},
    )

    assert res.status_code == 200
    calls = factory.instances[KITTEN_MODELS[0]].generate_calls
    assert any(call["text"] == "Sherlock Holmes is famous" for call in calls)


def test_speech_falls_back_to_fragment_generation() -> None:
    factory = FakeKittenFactory()
    runtime = _make_runtime(factory)
    runtime.ensure_model_loaded(KITTEN_MODELS[0])
    factory.instances[KITTEN_MODELS[0]].fail_predicate = lambda text: len(text) > 30
    client = _make_client(runtime=runtime)

    res = client.post(
        "/v1/audio/speech",
        json={"model": KITTEN_MODELS[0], "voice": "Bella", "input": "First sentence is long enough to fail. Second sentence also fails whole-text mode."},
    )

    assert res.status_code == 200
    calls = factory.instances[KITTEN_MODELS[0]].generate_calls
    assert len(calls) >= 2
