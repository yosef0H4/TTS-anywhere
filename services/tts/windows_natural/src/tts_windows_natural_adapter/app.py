from __future__ import annotations

import json
import logging
import subprocess
import tempfile
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from . import helper_manager


logger = logging.getLogger("tts_windows_natural_adapter")
MODEL_ID = "windows-natural"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    api_key: str | None = Field(default=None, alias="API_KEY")
    default_voice: str = Field(default="windows-natural:en-GB:SoniaNeural", alias="WINDOWS_NATURAL_DEFAULT_VOICE")
    cors_allow_origin_regex: str = Field(
        default=r"^https?://(127\.0\.0\.1|localhost)(:\d+)?$",
        alias="WINDOWS_NATURAL_CORS_ALLOW_ORIGIN_REGEX",
    )


class SpeechRequest(BaseModel):
    model: str | None = None
    input: str
    voice: str | None = None
    response_format: str = "wav"
    speed: float = 1.0


class HelperClient:
    def __init__(self) -> None:
        self._helper_exe = helper_manager.ensure_helper()
        self._voice_roots_cache = helper_manager.all_voice_roots()

    def _base_cmd(self) -> list[str]:
        return [str(self._helper_exe)]

    def _voice_roots(self) -> list[str]:
        return list(self._voice_roots_cache)

    def list_voices(self) -> dict[str, object]:
        cmd = self._base_cmd() + ["list-voices", "--probe-synthesis"]
        for root in self._voice_roots():
            cmd.extend(["--voice-root", root])
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        return json.loads(result.stdout)

    def synthesize(self, text: str, voice_id: str, voice_root: str | None = None) -> bytes:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as temp:
            temp_path = Path(temp.name)
        with tempfile.NamedTemporaryFile("w", suffix=".txt", encoding="utf-8", delete=False) as text_temp:
            text_temp.write(text)
            text_path = Path(text_temp.name)
        try:
            cmd = self._base_cmd() + ["synthesize", "--voice-id", voice_id, "--text-file", str(text_path), "--out", str(temp_path)]
            voice_roots = [voice_root] if voice_root else self._voice_roots()
            for root in voice_roots:
                cmd.extend(["--voice-root", root])
            subprocess.run(cmd, capture_output=True, text=True, check=True)
            return temp_path.read_bytes()
        except subprocess.CalledProcessError as error:
            message = error.stderr.strip() or error.stdout.strip() or "helper failed"
            raise HTTPException(
                status_code=400,
                detail={
                    "error": {
                        "message": message,
                        "type": "invalid_request_error",
                        "code": "windows_natural_helper_failed",
                    }
                },
            ) from error
        finally:
            temp_path.unlink(missing_ok=True)
            text_path.unlink(missing_ok=True)


class WindowsNaturalRuntime:
    def __init__(self, settings: Settings, helper: HelperClient | None = None) -> None:
        self.settings = settings
        self.helper = helper or HelperClient()
        self._voices_payload_cache: dict[str, object] | None = None

    def _voices_payload(self) -> dict[str, object]:
        if self._voices_payload_cache is None:
            self._voices_payload_cache = self.helper.list_voices()
        return self._voices_payload_cache

    def list_voices(self) -> list[dict[str, object]]:
        payload = self._voices_payload()
        voices = payload.get("voices", [])
        if not isinstance(voices, list):
            return []
        return [voice for voice in voices if isinstance(voice, dict) and voice.get("compatible") is True]

    def discovered_voices(self) -> list[dict[str, object]]:
        payload = self._voices_payload()
        voices = payload.get("voices", [])
        if not isinstance(voices, list):
            return []
        return [voice for voice in voices if isinstance(voice, dict)]

    def incompatible_voices(self) -> list[dict[str, object]]:
        return [voice for voice in self.discovered_voices() if voice.get("compatible") is not True]

    def helper_version(self) -> str:
        payload = self._voices_payload()
        version = payload.get("helper_version", "")
        return str(version)

    def models_payload(self) -> dict[str, object]:
        return {"object": "list", "data": [{"id": MODEL_ID, "object": "model", "owned_by": "windows-natural"}]}

    def synth_to_wav_bytes(self, text: str, voice: str | None) -> bytes:
        payload = text.strip()
        if not payload:
            raise HTTPException(
                status_code=400,
                detail={"error": {"message": "Input text is empty", "type": "invalid_request_error", "code": "empty_input"}},
            )
        selected_voice = (voice or self.settings.default_voice).strip()
        selected_voice_record = next((item for item in self.list_voices() if str(item.get("id")) == selected_voice), None)
        if selected_voice_record is None:
            raise HTTPException(
                status_code=400,
                detail={
                    "error": {
                        "message": f"Unknown or incompatible Windows natural voice '{selected_voice}'",
                        "type": "invalid_request_error",
                        "code": "voice_not_found",
                    }
                },
            )
        voice_root = selected_voice_record.get("path")
        return self.helper.synthesize(payload, selected_voice, str(voice_root) if voice_root else None)

    def health_payload(self) -> dict[str, object]:
        discovered = self.discovered_voices()
        compatible = [voice for voice in discovered if voice.get("compatible") is True]
        incompatible = [voice for voice in discovered if voice.get("compatible") is not True]
        return {
            "ok": len(compatible) > 0,
            "model": MODEL_ID,
            "runtime": "windows_only",
            "helper_version": self.helper_version(),
            "voice_roots": self.helper._voice_roots() if isinstance(self.helper, HelperClient) else [],
            "backend_status": {
                "installed-appx-current": "probing_current_narrator_license_path",
                "embedded-legacy-key": "available_for_user_supplied_legacy_or_unpacked_compatible_voice_folders",
                "download-cache": "not_supported_voice_packages_must_be_installed_by_the_user",
            },
            "discovered_voices": discovered,
            "compatible_voices": compatible,
            "incompatible_voices": incompatible,
            "sonia_available": any(str(voice.get("id")) == "windows-natural:en-GB:SoniaNeural" for voice in compatible),
            "ryan_available": any(str(voice.get("id")) == "windows-natural:en-GB:RyanNeural" for voice in compatible),
            "compatibility_mode": "installed_appx_current_first",
        }


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


def create_app(settings: Settings | None = None, runtime: WindowsNaturalRuntime | None = None) -> FastAPI:
    cfg = settings or Settings()
    runtime_instance = runtime or WindowsNaturalRuntime(cfg)
    auth = _auth(cfg.api_key)
    app = FastAPI(title="TTS Windows Natural Adapter", version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=cfg.cors_allow_origin_regex,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
    )

    @app.get("/v1/models")
    def models(_: None = Depends(auth)) -> dict[str, object]:
        return runtime_instance.models_payload()

    @app.get("/v1/voices")
    def voices(_: None = Depends(auth)) -> dict[str, object]:
        voices_payload = runtime_instance.list_voices()
        return {"voices": [{"id": v["id"], "name": v["name"], "language": v["language"], "gender": v["gender"], "source": v["source"]} for v in voices_payload]}

    @app.get("/v1/audio/voices")
    def audio_voices(_: None = Depends(auth)) -> dict[str, object]:
        voices_payload = runtime_instance.list_voices()
        return {"voices": [{"id": v["id"], "name": v["name"], "language": v["language"], "gender": v["gender"], "source": v["source"]} for v in voices_payload]}

    @app.post("/v1/audio/speech")
    def speech(request: SpeechRequest, _: None = Depends(auth)) -> Response:
        wav = runtime_instance.synth_to_wav_bytes(request.input, request.voice)
        return Response(content=wav, media_type="audio/wav", headers={"Content-Disposition": 'attachment; filename="speech.wav"'})

    @app.get("/healthz")
    def health() -> dict[str, object]:
        return runtime_instance.health_payload()

    return app
