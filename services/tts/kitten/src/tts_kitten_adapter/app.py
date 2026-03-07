from __future__ import annotations

import gc
import io
import logging
import re
import tempfile
import threading
import unicodedata
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable

import numpy as np
import soundfile as sf
from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

logger = logging.getLogger("tts_kitten_adapter")
SAMPLE_RATE = 24000

KITTEN_MODELS: tuple[str, ...] = (
    "KittenML/kitten-tts-mini-0.8",
    "KittenML/kitten-tts-micro-0.8",
    "KittenML/kitten-tts-nano-0.8-fp32",
    "KittenML/kitten-tts-nano-0.8-int8",
)

_CITATION_RE = re.compile(r"\[(\d+)\](?:\[(\d+)\])*")
_MULTISPACE_RE = re.compile(r"\s+")
_REPEATED_PUNCT_RE = re.compile(r"([,;:.!?]){2,}")
_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?;:])\s+")
_UNSAFE_SYMBOL_RE = re.compile(r"[^A-Za-z0-9\s,.;:!?'\-()]")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    api_key: str | None = Field(default=None, alias="API_KEY")
    default_model: str = Field(default=KITTEN_MODELS[2], alias="KITTEN_DEFAULT_MODEL")
    default_voice: str = Field(default="Bella", alias="KITTEN_DEFAULT_VOICE")
    default_speed: float = Field(default=1.0, alias="KITTEN_DEFAULT_SPEED")
    cache_dir: str | None = Field(default=None, alias="KITTEN_CACHE_DIR")
    port: int = Field(default=8014, alias="KITTEN_PORT")


class SpeechRequest(BaseModel):
    model: str | None = None
    input: str
    voice: str | None = None
    response_format: str = "wav"
    speed: float | None = None


def _load_kitten_model(model_id: str, cache_dir: str | None) -> Any:
    from kittentts import KittenTTS

    return KittenTTS(model_id, cache_dir=cache_dir)


class KittenRuntime:
    def __init__(
        self,
        settings: Settings,
        model_factory: Callable[[str, str | None], Any] = _load_kitten_model,
    ):
        self.settings = settings
        self._model_factory = model_factory
        self._active_model_id: str | None = None
        self._active_model: Any | None = None
        self._voice_cache: dict[str, list[str]] = {}
        self._model_lock = threading.Lock()
        self._model_ref_counts: dict[str, int] = {}
        self._retired_models: dict[str, Any] = {}

    @property
    def active_model_id(self) -> str | None:
        return self._active_model_id

    def known_models(self) -> list[str]:
        return list(KITTEN_MODELS)

    def _resolve_model_id(self, model_id: str | None) -> str:
        selected = (model_id or self.settings.default_model).strip()
        if selected not in KITTEN_MODELS:
            raise HTTPException(
                status_code=400,
                detail={
                    "error": {
                        "message": f"Unknown Kitten model: {selected}",
                        "type": "invalid_request_error",
                        "code": "model_not_found",
                    }
                },
            )
        return selected

    def _extract_voices(self, model: Any) -> list[str]:
        voices = getattr(model, "available_voices", None)
        if not isinstance(voices, list):
            raise HTTPException(
                status_code=500,
                detail={
                    "error": {
                        "message": "Kitten model did not expose a valid voice list",
                        "type": "server_error",
                        "code": "invalid_voice_catalog",
                    }
                },
            )
        return [str(voice) for voice in voices]

    def _dispose_model(self, model_id: str | None, model: Any | None) -> None:
        if model is None:
            return

        logger.info("Disposing Kitten model '%s'", model_id)
        inner_model = getattr(model, "model", None)
        if inner_model is not None and hasattr(inner_model, "session"):
            try:
                setattr(inner_model, "session", None)
            except Exception:
                logger.debug("Could not clear Kitten ONNX session for '%s'", model_id, exc_info=True)
        gc.collect()

    def _collect_retired_models_locked(self) -> None:
        releasable = [
            model_id for model_id in self._retired_models
            if self._model_ref_counts.get(model_id, 0) <= 0
        ]
        for model_id in releasable:
            model = self._retired_models.pop(model_id, None)
            self._dispose_model(model_id, model)

    def _unload_model_locked(self) -> None:
        if self._active_model is None:
            self._active_model_id = None
            self._collect_retired_models_locked()
            return

        retiring_id = self._active_model_id
        retiring_model = self._active_model
        self._active_model = None
        self._active_model_id = None

        if retiring_id is not None and self._model_ref_counts.get(retiring_id, 0) > 0:
            self._retired_models[retiring_id] = retiring_model
        else:
            self._dispose_model(retiring_id, retiring_model)
        self._collect_retired_models_locked()

    def unload_model(self) -> None:
        with self._model_lock:
            self._unload_model_locked()

    def ensure_model_loaded(self, model_id: str | None) -> tuple[str, Any]:
        selected = self._resolve_model_id(model_id)
        with self._model_lock:
            if self._active_model_id == selected and self._active_model is not None:
                return selected, self._active_model

            if self._active_model is not None:
                self._unload_model_locked()

            logger.info("Loading Kitten model '%s'", selected)
            self._active_model = self._model_factory(selected, self.settings.cache_dir)
            self._active_model_id = selected
            self._voice_cache[selected] = self._extract_voices(self._active_model)
            return selected, self._active_model

    @contextmanager
    def checkout_model(self, model_id: str | None) -> Any:
        selected, model = self.ensure_model_loaded(model_id)
        with self._model_lock:
            self._model_ref_counts[selected] = self._model_ref_counts.get(selected, 0) + 1
        try:
            yield selected, model
        finally:
            with self._model_lock:
                current = self._model_ref_counts.get(selected, 0)
                if current <= 1:
                    self._model_ref_counts.pop(selected, None)
                else:
                    self._model_ref_counts[selected] = current - 1
                self._collect_retired_models_locked()

    def get_available_voices(self, model_id: str | None = None) -> list[str]:
        selected, model = self.ensure_model_loaded(model_id)
        cached = self._voice_cache.get(selected)
        if cached is not None:
            return cached
        voices = self._extract_voices(model)
        self._voice_cache[selected] = voices
        return voices

    def _normalize_text(self, text: str) -> str:
        normalized = unicodedata.normalize("NFKC", text)
        normalized = normalized.replace("\r", " ").replace("\n", " ").replace("\t", " ")
        normalized = normalized.replace("—", "-").replace("–", "-").replace("…", ".")
        normalized = normalized.replace("“", '"').replace("”", '"').replace("’", "'").replace("‘", "'")
        normalized = _MULTISPACE_RE.sub(" ", normalized)
        return normalized.strip()

    def _sanitize_for_kitten(self, text: str) -> str:
        cleaned = self._normalize_text(text)
        cleaned = _CITATION_RE.sub("", cleaned)
        cleaned = _UNSAFE_SYMBOL_RE.sub(" ", cleaned)
        cleaned = _REPEATED_PUNCT_RE.sub(r"\1", cleaned)
        cleaned = _MULTISPACE_RE.sub(" ", cleaned)
        return cleaned.strip(" ,;:.!?-")

    def _split_for_kitten_retry(self, text: str) -> list[str]:
        sentences = [part.strip() for part in _SENTENCE_SPLIT_RE.split(text) if part.strip()]
        if len(sentences) <= 1:
            words = text.split()
            if len(words) <= 12:
                return [text]
            midpoint = max(1, len(words) // 2)
            return [" ".join(words[:midpoint]).strip(), " ".join(words[midpoint:]).strip()]
        return sentences

    def _try_generate_audio(self, model: Any, text: str, voice: str, speed: float) -> np.ndarray:
        return model.generate(text, voice=voice, speed=speed)

    def _generate_with_fallback(self, model: Any, text: str, voice: str, speed: float, selected_model: str) -> np.ndarray:
        attempts: list[tuple[str, str]] = []
        normalized = self._normalize_text(text)
        sanitized = self._sanitize_for_kitten(normalized)

        if normalized:
            attempts.append(("normalized", normalized))
        if sanitized and sanitized != normalized:
            attempts.append(("sanitized", sanitized))

        fragment_source = sanitized or normalized
        for index, fragment in enumerate(self._split_for_kitten_retry(fragment_source), start=1):
            if fragment and fragment not in {payload for _, payload in attempts}:
                attempts.append((f"fragment_{index}", fragment))

        last_error: RuntimeError | None = None
        for stage, candidate in attempts:
            try:
                logger.info(
                    "Kitten synthesis attempt model='%s' stage='%s' chars=%d",
                    selected_model,
                    stage,
                    len(candidate),
                )
                return self._try_generate_audio(model, candidate, voice, speed)
            except RuntimeError as error:
                last_error = error
                logger.warning(
                    "Kitten synthesis retry model='%s' stage='%s' failed: %s",
                    selected_model,
                    stage,
                    error,
                )

        fragment_outputs: list[np.ndarray] = []
        for index, fragment in enumerate(self._split_for_kitten_retry(fragment_source), start=1):
            try:
                logger.info(
                    "Kitten synthesis fragment model='%s' stage='fragment_concat_%d' chars=%d",
                    selected_model,
                    index,
                    len(fragment),
                )
                fragment_outputs.append(self._try_generate_audio(model, fragment, voice, speed))
            except RuntimeError as error:
                last_error = error
                logger.warning(
                    "Kitten synthesis fragment model='%s' stage='fragment_concat_%d' failed: %s",
                    selected_model,
                    index,
                    error,
                )
                fragment_outputs = []
                break

        if fragment_outputs:
            return np.concatenate(fragment_outputs)

        raise HTTPException(
            status_code=400,
            detail={
                "error": {
                    "message": f"Kitten synthesis failed after fallback: {last_error}",
                    "type": "invalid_request_error",
                    "code": "kitten_synthesis_failed",
                }
            },
        ) from last_error

    def synth_to_wav(self, text: str, model_id: str | None, voice: str | None, speed: float | None) -> bytes:
        payload = self._normalize_text(text)
        if not payload:
            raise HTTPException(
                status_code=400,
                detail={
                    "error": {
                        "message": "Input text is empty",
                        "type": "invalid_request_error",
                        "code": "empty_input",
                    }
                },
            )

        with self.checkout_model(model_id) as (selected_model, model):
            effective_voice = (voice or self.settings.default_voice).strip()
            effective_speed = speed if speed is not None else self.settings.default_speed
            available_voices = self._voice_cache.get(selected_model) or self._extract_voices(model)
            if effective_voice not in available_voices:
                raise HTTPException(
                    status_code=400,
                    detail={
                        "error": {
                            "message": f"Unknown Kitten voice '{effective_voice}' for model '{selected_model}'",
                            "type": "invalid_request_error",
                            "code": "voice_not_found",
                        }
                    },
                )

            logger.info(
                "Synth request model='%s' voice='%s' speed=%.2f chars=%d",
                selected_model,
                effective_voice,
                effective_speed,
                len(payload),
            )
            audio = self._generate_with_fallback(model, payload, effective_voice, effective_speed, selected_model)

        buffer = io.BytesIO()
        sf.write(buffer, audio, SAMPLE_RATE, format="WAV")
        buffer.seek(0)
        return buffer.read()

    def synth_to_file(self, text: str, model_id: str | None, voice: str | None, speed: float | None) -> Path:
        wav_bytes = self.synth_to_wav(text, model_id=model_id, voice=voice, speed=speed)
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as temp_wav:
            temp_wav.write(wav_bytes)
            return Path(temp_wav.name)


def _auth(api_key: str | None):
    def checker(authorization: str | None = Header(default=None)) -> None:
        if api_key is None:
            return
        if authorization != f"Bearer {api_key}":
            raise HTTPException(
                status_code=401,
                detail={
                    "error": {
                        "message": "Invalid API key",
                        "type": "authentication_error",
                        "code": "invalid_api_key",
                    }
                },
            )

    return checker


def create_app(
    settings: Settings | None = None,
    runtime: KittenRuntime | None = None,
) -> FastAPI:
    cfg = settings or Settings()
    runtime_instance = runtime or KittenRuntime(cfg)
    auth = _auth(cfg.api_key)

    app = FastAPI(title="TTS Kitten Adapter", version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/v1/models")
    def models(_: None = Depends(auth)) -> dict:
        logger.info("Listing Kitten models")
        data = [{"id": model_id, "object": "model", "owned_by": "kitten"} for model_id in runtime_instance.known_models()]
        return {"object": "list", "data": data}

    @app.get("/v1/voices")
    def voices(model: str | None = Query(default=None), _: None = Depends(auth)) -> dict:
        voice_ids = runtime_instance.get_available_voices(model)
        return {"voices": [{"id": voice_id, "name": voice_id} for voice_id in voice_ids]}

    @app.get("/v1/audio/voices")
    def audio_voices(model: str | None = Query(default=None), _: None = Depends(auth)) -> dict:
        voice_ids = runtime_instance.get_available_voices(model)
        return {"voices": [{"id": voice_id, "name": voice_id} for voice_id in voice_ids]}

    @app.post("/v1/audio/speech")
    def speech(request: SpeechRequest, _: None = Depends(auth)):
        logger.info(
            "POST /v1/audio/speech model=%s voice=%s format=%s speed=%s",
            request.model,
            request.voice,
            request.response_format,
            request.speed,
        )
        wav_bytes = runtime_instance.synth_to_wav(
            text=request.input,
            model_id=request.model,
            voice=request.voice,
            speed=request.speed,
        )
        return Response(
            content=wav_bytes,
            media_type="audio/wav",
            headers={"Content-Disposition": 'attachment; filename="speech.wav"'},
        )

    @app.get("/healthz")
    def health() -> dict:
        return {
            "ok": True,
            "default_model": cfg.default_model,
            "default_voice": cfg.default_voice,
            "default_speed": cfg.default_speed,
            "loaded_model": runtime_instance.active_model_id,
        }

    return app
