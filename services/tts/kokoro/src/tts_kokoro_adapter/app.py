from __future__ import annotations

import io
import logging
import tempfile
import threading
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf
import torch
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

logger = logging.getLogger("tts_kokoro_adapter")

KOKORO_MODEL_ID = "kokoro"
SAMPLE_RATE = 24000

# Log GPU status at module load (informational only)
if torch.cuda.is_available():
    logger.info("GPU detected: %s", torch.cuda.get_device_name(0))
else:
    logger.warning("No GPU detected. Kokoro TTS adapter requires GPU for synthesis.")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    api_key: str | None = Field(default=None, alias="API_KEY")
    default_voice: str = Field(default="af_heart", alias="KOKORO_DEFAULT_VOICE")
    default_speed: float = Field(default=1.0, alias="KOKORO_DEFAULT_SPEED")
    port: int = Field(default=8013, alias="KOKORO_PORT")


class SpeechRequest(BaseModel):
    model: str | None = None
    input: str
    voice: str | None = None
    response_format: str = "wav"
    speed: float | None = None


# Voice definitions by language code
# American English (lang_code='a')
AMERICAN_VOICES = [
    "af_heart", "af_bella", "af_nicole", "af_sarah", "af_sky",
    "am_michael", "am_adam", "am_gurney"
]

# British English (lang_code='b')
BRITISH_VOICES = [
    "bf_emma", "bm_george", "bm_lewis"
]

ALL_VOICES = AMERICAN_VOICES + BRITISH_VOICES


class KokoroRuntime:
    def __init__(self, settings: Settings):
        self.settings = settings
        self._pipelines: dict[str, Any] = {}
        self._pipeline_lock = threading.Lock()
        self._voices_cache: list[str] | None = None

    def _check_gpu(self) -> None:
        """Validate CUDA availability."""
        if not torch.cuda.is_available():
            raise HTTPException(
                status_code=500,
                detail={
                    "error": {
                        "message": "CUDA/GPU is required for Kokoro TTS adapter. No GPU detected.",
                        "type": "server_error",
                        "code": "gpu_required",
                    }
                },
            )

    def _get_lang_code(self, voice: str) -> str:
        """Extract language code from voice name."""
        if voice.startswith("b"):
            return "b"  # British English
        return "a"  # American English (default)

    def get_pipeline(self, lang_code: str) -> Any:
        """Lazy load KPipeline for a language code."""
        with self._pipeline_lock:
            if lang_code not in self._pipelines:
                logger.info("Loading Kokoro pipeline for lang_code='%s'", lang_code)
                from kokoro import KPipeline
                self._pipelines[lang_code] = KPipeline(lang_code=lang_code)
            return self._pipelines[lang_code]

    def warmup(self) -> None:
        """Preload the default pipeline and run a tiny silent synth."""
        self._check_gpu()
        voice = self.settings.default_voice
        speed = self.settings.default_speed
        lang_code = self._get_lang_code(voice)
        pipeline = self.get_pipeline(lang_code)
        logger.info("Warming Kokoro pipeline voice='%s' lang_code='%s'", voice, lang_code)
        generator = pipeline("TTS ready", voice=voice, speed=speed)
        for _gs, _ps, audio in generator:
            if audio is not None:
                break

    def get_available_voices(self) -> list[str]:
        """Get list of available voices."""
        if self._voices_cache is not None:
            return self._voices_cache

        # Return our predefined voice list
        # In the future, this could fetch from HuggingFace
        self._voices_cache = ALL_VOICES
        return self._voices_cache

    def synth_to_wav(self, text: str, voice: str, speed: float) -> bytes:
        """Generate WAV audio from text."""
        self._check_gpu()

        effective_voice = voice or self.settings.default_voice
        effective_speed = speed if speed is not None else self.settings.default_speed
        lang_code = self._get_lang_code(effective_voice)

        logger.info(
            "Synth request voice='%s' lang_code='%s' speed=%.2f chars=%d",
            effective_voice,
            lang_code,
            effective_speed,
            len(text),
        )

        pipeline = self.get_pipeline(lang_code)
        generator = pipeline(text, voice=effective_voice, speed=effective_speed)

        # Collect all audio chunks
        full_audio: list[np.ndarray] = []
        for gs, ps, audio in generator:
            if audio is not None:
                full_audio.append(audio)

        if not full_audio:
            raise HTTPException(
                status_code=500,
                detail={
                    "error": {
                        "message": "No audio generated from text",
                        "type": "server_error",
                        "code": "no_audio_generated",
                    }
                },
            )

        # Concatenate all audio chunks
        combined = np.concatenate(full_audio)

        # Convert to WAV bytes
        buffer = io.BytesIO()
        sf.write(buffer, combined, SAMPLE_RATE, format="WAV")
        buffer.seek(0)
        return buffer.read()

    def synth_to_file(self, text: str, voice: str, speed: float) -> Path:
        """Generate WAV file from text and return path."""
        wav_bytes = self.synth_to_wav(text, voice, speed)

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


def create_app(settings: Settings | None = None) -> FastAPI:
    cfg = settings or Settings()
    runtime = KokoroRuntime(cfg)
    auth = _auth(cfg.api_key)

    app = FastAPI(title="TTS Kokoro Adapter", version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.on_event("startup")
    async def startup_warmup() -> None:
        runtime.warmup()

    @app.get("/v1/models")
    def models(_: None = Depends(auth)) -> dict:
        logger.info("Listing models")
        data = [{"id": KOKORO_MODEL_ID, "object": "model", "owned_by": "kokoro"}]
        return {"object": "list", "data": data}

    @app.get("/v1/voices")
    def voices(_: None = Depends(auth)) -> dict:
        logger.info("Listing voices")
        voice_ids = runtime.get_available_voices()
        return {"voices": [{"id": voice_id, "name": voice_id} for voice_id in voice_ids]}

    @app.get("/v1/audio/voices")
    def audio_voices(_: None = Depends(auth)) -> dict:
        voice_ids = runtime.get_available_voices()
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
        if request.model and request.model != KOKORO_MODEL_ID:
            logger.warning(
                "Received unknown model '%s'; expected '%s'. Continuing with Kokoro voice.",
                request.model,
                KOKORO_MODEL_ID,
            )

        selected_voice = (request.voice or "").strip() or cfg.default_voice
        effective_speed = request.speed if request.speed is not None else cfg.default_speed

        wav_bytes = runtime.synth_to_wav(
            text=request.input.strip(),
            voice=selected_voice,
            speed=effective_speed,
        )

        return Response(
            content=wav_bytes,
            media_type="audio/wav",
            headers={"Content-Disposition": 'attachment; filename="speech.wav"'},
        )

    @app.get("/healthz")
    def health() -> dict:
        gpu_available = torch.cuda.is_available()
        gpu_name = torch.cuda.get_device_name(0) if gpu_available else None
        return {
            "ok": gpu_available,
            "default_voice": cfg.default_voice,
            "default_speed": cfg.default_speed,
            "gpu": gpu_name,
        }

    return app
