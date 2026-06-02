from __future__ import annotations

import json
import logging
import os
import subprocess
import tempfile
import threading
import uuid
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
    output_format: str = Field(default="Riff24Khz16BitMonoPcm", alias="WINDOWS_NATURAL_OUTPUT_FORMAT")
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
        self._daemons: list[subprocess.Popen[str] | None] = []
        self._daemon_locks: list[threading.Lock] = []
        self._daemon_pool_lock = threading.Lock()
        self._next_daemon_index = 0
        self._daemon_enabled = os.environ.get("WINDOWS_NATURAL_DISABLE_DAEMON", "").strip().lower() not in {"1", "true", "yes", "on"}
        self._daemon_pool_size = self._read_daemon_pool_size()

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

    def synthesize(self, text: str, voice_id: str, voice_root: str | None = None, output_format: str = "Riff24Khz16BitMonoPcm") -> bytes:
        if self._daemon_enabled and self._daemon_pool_size > 0:
            try:
                return self._synthesize_with_daemon(text, voice_id, voice_root, output_format)
            except Exception:
                logger.warning("Windows natural daemon synthesis failed; falling back to one-shot helper", exc_info=True)
                self._stop_daemon()

        return self._synthesize_oneshot(text, voice_id, voice_root, output_format)

    def _synthesize_oneshot(self, text: str, voice_id: str, voice_root: str | None = None, output_format: str = "Riff24Khz16BitMonoPcm") -> bytes:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as temp:
            temp_path = Path(temp.name)
        with tempfile.NamedTemporaryFile("w", suffix=".txt", encoding="utf-8", delete=False) as text_temp:
            text_temp.write(text)
            text_path = Path(text_temp.name)
        try:
            cmd = self._base_cmd() + ["synthesize", "--voice-id", voice_id, "--text-file", str(text_path), "--out", str(temp_path)]
            cmd.extend(["--output-format", output_format])
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

    def _synthesize_with_daemon(self, text: str, voice_id: str, voice_root: str | None = None, output_format: str = "Riff24Khz16BitMonoPcm") -> bytes:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as temp:
            temp_path = Path(temp.name)
        with tempfile.NamedTemporaryFile("w", suffix=".txt", encoding="utf-8", delete=False) as text_temp:
            text_temp.write(text)
            text_path = Path(text_temp.name)
        try:
            request_id = uuid.uuid4().hex
            request = {
                "id": request_id,
                "command": "synthesize",
                "voice_id": voice_id,
                "voice_root": voice_root or "",
                "output_format": output_format,
                "text_file": str(text_path),
                "out_path": str(temp_path),
            }
            daemon_index = self._next_daemon_slot()
            with self._daemon_locks[daemon_index]:
                daemon = self._ensure_daemon(daemon_index)
                assert daemon.stdin is not None
                assert daemon.stdout is not None
                daemon.stdin.write(json.dumps(request) + "\n")
                daemon.stdin.flush()
                raw = daemon.stdout.readline()
            if not raw:
                raise RuntimeError("daemon exited without a response")
            response = json.loads(raw)
            if response.get("id") != request_id:
                raise RuntimeError("daemon response id mismatch")
            if response.get("ok") is not True:
                raise RuntimeError(str(response.get("error") or "daemon synthesis failed"))
            return temp_path.read_bytes()
        except RuntimeError as error:
            raise HTTPException(
                status_code=400,
                detail={
                    "error": {
                        "message": str(error),
                        "type": "invalid_request_error",
                        "code": "windows_natural_helper_failed",
                    }
                },
            ) from error
        finally:
            temp_path.unlink(missing_ok=True)
            text_path.unlink(missing_ok=True)

    def _ensure_daemon(self, index: int) -> subprocess.Popen[str]:
        daemon = self._daemons[index]
        if daemon is not None and daemon.poll() is None:
            return daemon
        cmd = self._base_cmd() + ["serve-json"]
        for root in self._voice_roots():
            cmd.extend(["--voice-root", root])
        self._daemons[index] = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        return self._daemons[index]

    def _stop_daemon(self) -> None:
        for index, daemon in enumerate(self._daemons):
            self._daemons[index] = None
            if daemon is None or daemon.poll() is not None:
                continue
            daemon.terminate()
            try:
                daemon.wait(timeout=2)
            except subprocess.TimeoutExpired:
                daemon.kill()

    def _next_daemon_slot(self) -> int:
        with self._daemon_pool_lock:
            if not self._daemons:
                self._daemons = [None for _ in range(self._daemon_pool_size)]
                self._daemon_locks = [threading.Lock() for _ in range(self._daemon_pool_size)]
            index = self._next_daemon_index % self._daemon_pool_size
            self._next_daemon_index += 1
            return index

    @staticmethod
    def _read_daemon_pool_size() -> int:
        raw = os.environ.get("WINDOWS_NATURAL_DAEMON_POOL_SIZE", "3").strip()
        try:
            return max(0, int(raw))
        except ValueError:
            return 3


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
        return self.helper.synthesize(payload, selected_voice, str(voice_root) if voice_root else None, self.settings.output_format)

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
