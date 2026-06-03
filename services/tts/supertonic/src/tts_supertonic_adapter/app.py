from __future__ import annotations

import logging
import re
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

logger = logging.getLogger("tts_supertonic_adapter")

SUPERTONIC_MODEL_ID = "Supertone/supertonic-3"
SUPERTONIC_SDK_MODEL = "supertonic-3"
DEFAULT_VOICE_ID = "M1"
DEFAULT_LANGUAGE = "na"
LANGUAGE_ALIASES = {
    "arab": "ar",
    "arabic": "ar",
    "عرب": "ar",
    "english": "en",
    "eng": "en",
}


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    api_key: str | None = Field(default=None, alias="API_KEY")
    runtime: str = Field(default="cpu", alias="SUPERTONIC_RUNTIME")
    default_voice: str = Field(default=DEFAULT_VOICE_ID, alias="SUPERTONIC_DEFAULT_VOICE")
    default_language: str = Field(default=DEFAULT_LANGUAGE, alias="SUPERTONIC_DEFAULT_LANGUAGE")
    model_dir: str | None = Field(default=None, alias="SUPERTONIC_MODEL_DIR")
    total_steps: int = Field(default=8, alias="SUPERTONIC_TOTAL_STEPS")
    speed: float = Field(default=1.05, alias="SUPERTONIC_SPEED")
    max_chunk_length: int | None = Field(default=None, alias="SUPERTONIC_MAX_CHUNK_LENGTH")
    silence_duration: float = Field(default=0.3, alias="SUPERTONIC_SILENCE_DURATION")
    intra_op_threads: int | None = Field(default=None, alias="SUPERTONIC_INTRA_OP_THREADS")
    inter_op_threads: int | None = Field(default=None, alias="SUPERTONIC_INTER_OP_THREADS")
    port: int = Field(default=8017, alias="SUPERTONIC_PORT")


class SpeechRequest(BaseModel):
    model: str | None = None
    input: str
    voice: str | None = None
    response_format: str = "wav"
    speed: float | None = None
    language: str | None = None
    lang: str | None = None
    instructions: str | None = None
    prompt: str | None = None


class SupertonicRuntime:
    def __init__(self, settings: Settings):
        self.settings = settings
        self._lock = threading.Lock()
        self._synth_lock = threading.Lock()
        self._tts: Any | None = None
        self._providers: list[str] = []

    def _configure_providers(self) -> None:
        import onnxruntime as ort
        import supertonic.config as supertonic_config
        import supertonic.loader as supertonic_loader

        runtime = self.settings.runtime.strip().lower()
        available = ort.get_available_providers()
        if runtime == "gpu":
            if "DmlExecutionProvider" in available:
                providers = ["DmlExecutionProvider"]
            else:
                preload = getattr(ort, "preload_dlls", None)
                if callable(preload):
                    preload(directory="")
                providers = ["CUDAExecutionProvider"]
            if providers[0] not in available:
                raise RuntimeError(
                    f"Supertonic GPU runtime requires ONNX Runtime {providers[0]}. "
                    f"Available providers: {available}"
                )
        elif runtime == "cpu":
            providers = ["CPUExecutionProvider"]
        else:
            raise RuntimeError(f"Unsupported Supertonic runtime: {self.settings.runtime}")

        supertonic_config.DEFAULT_ONNX_PROVIDERS = providers
        supertonic_loader.DEFAULT_ONNX_PROVIDERS = providers
        self._providers = providers

    def load(self) -> None:
        with self._lock:
            if self._tts is not None:
                return
            started = time.perf_counter()
            self._configure_providers()
            from supertonic import TTS

            logger.info("Loading Supertonic model runtime=%s providers=%s", self.settings.runtime, self._providers)
            self._tts = TTS(
                model=SUPERTONIC_SDK_MODEL,
                model_dir=self.settings.model_dir,
                auto_download=True,
                intra_op_num_threads=self.settings.intra_op_threads,
                inter_op_num_threads=self.settings.inter_op_threads,
            )
            self._verify_loaded_providers()
            logger.info("Supertonic loaded in %.2fs", time.perf_counter() - started)

    def _verify_loaded_providers(self) -> None:
        if self._tts is None:
            return
        session_names = ["dp_ort", "text_enc_ort", "vector_est_ort", "vocoder_ort"]
        loaded: dict[str, list[str]] = {}
        for name in session_names:
            session = getattr(self._tts.model, name, None)
            if hasattr(session, "get_providers"):
                loaded[name] = list(session.get_providers())
        if loaded:
            self._providers = sorted({provider for providers in loaded.values() for provider in providers})
        if self.settings.runtime.strip().lower() == "gpu":
            required_provider = "DmlExecutionProvider" if "DmlExecutionProvider" in self._providers else "CUDAExecutionProvider"
            missing = [name for name, providers in loaded.items() if required_provider not in providers]
            if missing:
                raise RuntimeError(
                    f"Supertonic GPU runtime could not create {required_provider}-backed ONNX sessions. "
                    f"Session providers: {loaded}."
                )
            for name in loaded:
                session = getattr(self._tts.model, name, None)
                disable_fallback = getattr(session, "disable_fallback", None)
                if callable(disable_fallback):
                    disable_fallback()

    def warmup(self) -> None:
        self.load()

    def loaded(self) -> bool:
        return self._tts is not None

    def get_available_voices(self) -> list[str]:
        self.load()
        assert self._tts is not None
        names = list(getattr(self._tts, "voice_style_names", []) or [])
        return names if names else [self.settings.default_voice]

    def synth_to_wav(self, text: str, voice: str | None, speed: float | None, language: str | None = None) -> bytes:
        if not text.strip():
            raise HTTPException(status_code=400, detail={"error": {"message": "Input text is required", "type": "invalid_request_error", "code": "empty_input"}})
        self.load()
        assert self._tts is not None

        selected_voice = (voice or self.settings.default_voice).strip()
        selected_language = _normalize_language(language) or _normalize_language(self.settings.default_language)
        started = time.perf_counter()
        synthesis_text = self._sanitize_text(text.strip())
        logger.info("Supertonic synth request runtime=%s voice='%s' lang=%s chars=%d", self.settings.runtime, selected_voice, selected_language, len(synthesis_text))
        with self._synth_lock:
            style = self._tts.get_voice_style(voice_name=selected_voice)
            wav, _duration = self._tts.synthesize(
                synthesis_text,
                voice_style=style,
                total_steps=self.settings.total_steps,
                speed=speed or self.settings.speed,
                max_chunk_length=self.settings.max_chunk_length,
                silence_duration=self.settings.silence_duration,
                lang=selected_language,
            )
        sample_rate = int(getattr(self._tts, "sample_rate", 24000))
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as temp_wav:
            temp_path = Path(temp_wav.name)
        try:
            self._tts.save_audio(wav, str(temp_path))
            wav_bytes = temp_path.read_bytes()
        finally:
            try:
                temp_path.unlink(missing_ok=True)
            except OSError:
                logger.debug("Could not remove temporary Supertonic wav %s", temp_path, exc_info=True)
        logger.info("Supertonic synth complete runtime=%s chars=%d sample_rate=%d elapsed=%.2fs", self.settings.runtime, len(synthesis_text), sample_rate, time.perf_counter() - started)
        return wav_bytes

    def _sanitize_text(self, text: str) -> str:
        assert self._tts is not None
        processor = self._tts.model.text_processor
        normalized = re.sub(r"\s+", " ", text).strip()
        is_valid, unsupported = processor.validate_text(normalized)
        if is_valid:
            return normalized

        unsupported_set = set(unsupported)
        sanitized = "".join(" " if char in unsupported_set else char for char in normalized)
        sanitized = re.sub(r"\s+", " ", sanitized).strip()
        if not sanitized:
            raise HTTPException(
                status_code=400,
                detail={"error": {"message": "Input text contains no supported Supertonic characters", "type": "invalid_request_error", "code": "unsupported_input"}},
            )
        logger.warning("Removed unsupported Supertonic character(s): %s", unsupported)
        return sanitized


def _normalize_language(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip().lower()
    if not normalized or normalized == "auto":
        return None
    return LANGUAGE_ALIASES.get(normalized, normalized)


def _language_from_prompt(prompt: str | None) -> str | None:
    if not prompt:
        return None
    normalized = prompt.lower()
    for token, language in LANGUAGE_ALIASES.items():
        if token in normalized:
            return language
    return None


def _resolve_request_language(request: SpeechRequest) -> str | None:
    return (
        _normalize_language(request.language)
        or _normalize_language(request.lang)
        or _language_from_prompt(request.instructions)
        or _language_from_prompt(request.prompt)
    )


def _auth(api_key: str | None):
    def checker(authorization: str | None = Header(default=None)) -> None:
        if api_key is None:
            return
        if authorization != f"Bearer {api_key}":
            raise HTTPException(
                status_code=401,
                detail={"error": {"message": "Invalid API key", "type": "authentication_error", "code": "invalid_api_key"}},
            )

    return checker


def create_app(settings: Settings | None = None, runtime: SupertonicRuntime | None = None) -> FastAPI:
    cfg = settings or Settings()
    runtime_instance = runtime or SupertonicRuntime(cfg)
    auth = _auth(cfg.api_key)

    app = FastAPI(title="TTS Supertonic Adapter", version="0.1.0")
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

    @app.on_event("startup")
    async def startup_warmup() -> None:
        runtime_instance.warmup()

    @app.get("/v1/models")
    def models(_: None = Depends(auth)) -> dict[str, Any]:
        return {"object": "list", "data": [{"id": SUPERTONIC_MODEL_ID, "object": "model", "owned_by": "Supertone"}]}

    @app.get("/v1/voices")
    def voices(_: None = Depends(auth)) -> dict[str, Any]:
        return {"voices": [{"id": voice_id, "name": voice_id} for voice_id in runtime_instance.get_available_voices()]}

    @app.get("/v1/audio/voices")
    def audio_voices(_: None = Depends(auth)) -> dict[str, Any]:
        return {"voices": [{"id": voice_id, "name": voice_id} for voice_id in runtime_instance.get_available_voices()]}

    @app.post("/v1/audio/speech")
    def speech(request: SpeechRequest, _: None = Depends(auth)) -> Response:
        if request.model and request.model != SUPERTONIC_MODEL_ID:
            logger.warning("Received unknown model '%s'; expected '%s'. Continuing with Supertonic.", request.model, SUPERTONIC_MODEL_ID)
        wav_bytes = runtime_instance.synth_to_wav(text=request.input, voice=request.voice, speed=request.speed, language=_resolve_request_language(request))
        return Response(
            content=wav_bytes,
            media_type="audio/wav",
            headers={"Content-Disposition": 'attachment; filename="speech.wav"'},
        )

    @app.get("/healthz")
    def health() -> dict[str, Any]:
        return {
            "ok": runtime_instance.loaded(),
            "model": SUPERTONIC_MODEL_ID,
            "default_voice": cfg.default_voice,
            "language": _normalize_language(cfg.default_language) or "na",
            "runtime": cfg.runtime,
            "providers": runtime_instance._providers,
            "loaded": runtime_instance.loaded(),
        }

    return app
