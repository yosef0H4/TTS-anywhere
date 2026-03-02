from __future__ import annotations

import logging
import tempfile
from pathlib import Path

import edge_tts
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

logger = logging.getLogger("tts_edge_adapter")


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
        voices = await runtime.list_voices()
        data = [{"id": name, "object": "model", "owned_by": "edge-tts"} for name in voices]
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
        voice = request.voice or request.model or cfg.edge_default_voice
        out = await runtime.synth_to_mp3(request.input.strip(), voice)
        return FileResponse(path=out, media_type="audio/mpeg", filename="speech.mp3")

    @app.get("/healthz")
    async def health() -> dict:
        return {"ok": True, "default_voice": cfg.edge_default_voice}

    return app
