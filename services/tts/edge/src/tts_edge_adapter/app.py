from __future__ import annotations

import logging
import tempfile
from pathlib import Path

import edge_tts
from edge_tts.exceptions import NoAudioReceived
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

logger = logging.getLogger("tts_edge_adapter")
EDGE_MODEL_ID = "edge"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    api_key: str | None = Field(default=None, alias="API_KEY")
    edge_default_voice: str = Field(default="en-US-AriaNeural", alias="EDGE_DEFAULT_VOICE")


class SpeechRequest(BaseModel):
    model: str | None = None
    input: str
    voice: str | None = None
    response_format: str = "mp3"
    speed: float = 1.0


class EdgeRuntime:
    def __init__(self, settings: Settings):
        self.settings = settings

    async def list_voices(self) -> list[str]:
        voices = await edge_tts.list_voices()
        return [v["ShortName"] for v in voices if "ShortName" in v]

    async def synth_to_mp3(self, text: str, voice: str) -> Path:
        logger.info("Synth request voice='%s' chars=%d", voice, len(text))
        with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as temp_mp3:
            out_path = Path(temp_mp3.name)
        communicate = edge_tts.Communicate(text=text, voice=voice)
        await communicate.save(str(out_path))
        return out_path


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
    runtime = EdgeRuntime(cfg)
    auth = _auth(cfg.api_key)
    app = FastAPI(title="TTS Edge Adapter", version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/v1/models")
    async def models(_: None = Depends(auth)) -> dict:
        logger.info("Listing models")
        data = [{"id": EDGE_MODEL_ID, "object": "model", "owned_by": "edge"}]
        return {"object": "list", "data": data}

    @app.get("/v1/voices")
    async def voices(_: None = Depends(auth)) -> dict:
        logger.info("Listing voices")
        voice_ids = await runtime.list_voices()
        return {"voices": [{"id": voice_id, "name": voice_id} for voice_id in voice_ids]}

    @app.get("/v1/audio/voices")
    async def audio_voices(_: None = Depends(auth)) -> dict:
        voice_ids = await runtime.list_voices()
        return {"voices": [{"id": voice_id, "name": voice_id} for voice_id in voice_ids]}

    @app.post("/v1/audio/speech")
    async def speech(request: SpeechRequest, _: None = Depends(auth)):
        logger.info(
            "POST /v1/audio/speech model=%s voice=%s format=%s speed=%s",
            request.model,
            request.voice,
            request.response_format,
            request.speed,
        )
        if request.model and request.model != EDGE_MODEL_ID:
            logger.warning("Received unknown model '%s'; expected '%s'. Continuing with Edge TTS voice.", request.model, EDGE_MODEL_ID)
        text = request.input.strip()
        if not text:
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

        voice = (request.voice or cfg.edge_default_voice).strip()
        available_voices = await runtime.list_voices()
        if voice not in available_voices:
            fallback = cfg.edge_default_voice if cfg.edge_default_voice in available_voices else (available_voices[0] if available_voices else "")
            if not fallback:
                raise HTTPException(
                    status_code=500,
                    detail={
                        "error": {
                            "message": "No voices available from edge-tts",
                            "type": "server_error",
                            "code": "no_voices_available",
                        }
                    },
                )
            logger.warning("Requested voice '%s' is unavailable; falling back to '%s'", voice, fallback)
            voice = fallback

        try:
            out = await runtime.synth_to_mp3(text, voice)
        except NoAudioReceived as error:
            logger.error("edge-tts returned no audio for voice='%s': %s", voice, error)
            raise HTTPException(
                status_code=400,
                detail={
                    "error": {
                        "message": f"No audio received from edge-tts for voice '{voice}'",
                        "type": "invalid_request_error",
                        "code": "no_audio_received",
                    }
                },
            ) from error
        except Exception as error:
            logger.exception("edge-tts synthesis failed for voice='%s'", voice)
            raise HTTPException(
                status_code=500,
                detail={
                    "error": {
                        "message": f"edge-tts synthesis failed: {error}",
                        "type": "server_error",
                        "code": "edge_tts_failed",
                    }
                },
            ) from error

        return FileResponse(path=out, media_type="audio/mpeg", filename="speech.mp3")

    @app.get("/healthz")
    async def health() -> dict:
        return {"ok": True, "default_voice": cfg.edge_default_voice}

    return app
