from __future__ import annotations

import json
import logging
import os
import platform
import subprocess
import tempfile
import threading
import urllib.request
import zipfile
from pathlib import Path
from typing import Any
import shutil

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from huggingface_hub import hf_hub_download
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

logger = logging.getLogger("tts_piper_adapter")
PIPER_MODEL_ID = "piper"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    api_key: str | None = Field(default=None, alias="API_KEY")
    piper_bin: str = Field(default="piper", alias="PIPER_BIN")
    piper_model: str | None = Field(default=None, alias="PIPER_MODEL")
    piper_models: str | None = Field(default=None, alias="PIPER_MODELS")
    piper_speaker: int | None = Field(default=None, alias="PIPER_SPEAKER")
    piper_model_dir: str = Field(default="./models", alias="PIPER_MODEL_DIR")
    piper_bin_dir: str = Field(default="./bin", alias="PIPER_BIN_DIR")
    piper_voices_repo: str = Field(default="rhasspy/piper-voices", alias="PIPER_VOICES_REPO")
    piper_default_model: str = Field(default="en_US-lessac-medium", alias="PIPER_DEFAULT_MODEL")


class SpeechRequest(BaseModel):
    model: str | None = None
    input: str
    voice: str | None = None
    response_format: str = "wav"
    speed: float = 1.0


class PiperRuntime:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.model_dir = Path(self.settings.piper_model_dir)
        self.model_dir.mkdir(parents=True, exist_ok=True)
        self.bin_dir = Path(self.settings.piper_bin_dir)
        self.bin_dir.mkdir(parents=True, exist_ok=True)
        self._voices_cache: dict[str, Any] | None = None
        self._model_download_lock = threading.Lock()
        self._binary_download_lock = threading.Lock()

    def _resolve_piper_binary(self) -> str:
        configured = self.settings.piper_bin
        if Path(configured).exists():
            return str(Path(configured))

        existing = shutil.which(configured)
        if existing:
            return existing

        return self._download_piper_binary()

    def _download_piper_binary(self) -> str:
        sys_name = platform.system().lower()
        machine = platform.machine().lower()

        if sys_name == "windows":
            asset_name = "piper_windows_amd64.zip"
            binary_name = "piper.exe"
        elif sys_name == "linux" and machine in {"x86_64", "amd64"}:
            asset_name = "piper_linux_x86_64.tar.gz"
            binary_name = "piper"
        elif sys_name == "darwin" and machine in {"arm64", "aarch64"}:
            asset_name = "piper_macos_aarch64.tar.gz"
            binary_name = "piper"
        elif sys_name == "darwin":
            asset_name = "piper_macos_x64.tar.gz"
            binary_name = "piper"
        else:
            raise HTTPException(
                status_code=500,
                detail={
                    "error": {
                        "message": f"Unsupported platform for auto Piper download: {sys_name}/{machine}",
                        "type": "server_error",
                        "code": "unsupported_platform",
                    }
                },
            )

        with self._binary_download_lock:
            existing_binary = list(self.bin_dir.rglob(binary_name))
            if existing_binary:
                binary = existing_binary[0]
                if sys_name != "windows":
                    binary.chmod(0o755)
                return str(binary)

            release_api = "https://api.github.com/repos/rhasspy/piper/releases/latest"
            with urllib.request.urlopen(release_api, timeout=30) as response:
                release = json.loads(response.read().decode("utf-8"))

            asset_url = None
            for asset in release.get("assets", []):
                if asset.get("name") == asset_name:
                    asset_url = asset.get("browser_download_url")
                    break

            if not asset_url:
                raise HTTPException(
                    status_code=500,
                    detail={
                        "error": {
                            "message": f"Could not find Piper asset {asset_name} in latest release",
                            "type": "server_error",
                            "code": "piper_asset_missing",
                        }
                    },
                )

            archive_path = self.bin_dir / asset_name
            urllib.request.urlretrieve(asset_url, archive_path)

            try:
                if asset_name.endswith(".zip"):
                    try:
                        with zipfile.ZipFile(archive_path, "r") as zip_handle:
                            zip_handle.extractall(self.bin_dir)
                    except zipfile.BadZipFile:
                        archive_path.unlink(missing_ok=True)
                        urllib.request.urlretrieve(asset_url, archive_path)
                        with zipfile.ZipFile(archive_path, "r") as zip_handle:
                            zip_handle.extractall(self.bin_dir)
                else:
                    import tarfile

                    with tarfile.open(archive_path, "r:gz") as tar_handle:
                        tar_handle.extractall(self.bin_dir)
            finally:
                archive_path.unlink(missing_ok=True)

            candidates = list(self.bin_dir.rglob(binary_name))
            if not candidates:
                raise HTTPException(
                    status_code=500,
                    detail={
                        "error": {
                            "message": "Piper binary extraction failed",
                            "type": "server_error",
                            "code": "piper_extract_failed",
                        }
                    },
                )

            binary = candidates[0]
            if sys_name != "windows":
                binary.chmod(0o755)
            return str(binary)

    def _copy_into_place(self, source_path: str | Path, target_path: Path) -> None:
        source = Path(source_path)
        target_path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=target_path.parent, delete=False) as tmp:
            tmp_path = Path(tmp.name)
        try:
            shutil.copy2(source, tmp_path)
            os.replace(tmp_path, target_path)
        finally:
            tmp_path.unlink(missing_ok=True)

    def _load_voices_catalog(self) -> dict[str, Any]:
        if self._voices_cache is not None:
            return self._voices_cache

        voices_path = hf_hub_download(
            repo_id=self.settings.piper_voices_repo,
            filename="voices.json",
            repo_type="model",
        )
        with open(voices_path, "r", encoding="utf-8") as handle:
            self._voices_cache = json.load(handle)
        return self._voices_cache

    def _find_model_key(self, requested: str) -> str:
        voices = self._load_voices_catalog()
        if requested in voices:
            return requested

        lowered = requested.lower()
        for key, value in voices.items():
            aliases = value.get("aliases", [])
            if any(str(alias).lower() == lowered for alias in aliases):
                return str(key)

        raise HTTPException(
            status_code=400,
            detail={
                "error": {
                    "message": f"Unknown model: {requested}",
                    "type": "invalid_request_error",
                    "code": "model_not_found",
                }
            },
        )

    def _download_model_if_missing(self, requested_model: str) -> str:
        model_key = self._find_model_key(requested_model)
        model_file = self.model_dir / f"{model_key}.onnx"
        config_file = self.model_dir / f"{model_key}.onnx.json"

        with self._model_download_lock:
            if model_file.exists() and config_file.exists():
                logger.info("Using cached Piper model '%s' at %s", model_key, model_file)
                return str(model_file)

            voices = self._load_voices_catalog()
            entry = voices[model_key]
            files = entry.get("files", {})

            onnx_remote = next((name for name in files if name.endswith(".onnx") and not name.endswith(".onnx.json")), None)
            json_remote = next((name for name in files if name.endswith(".onnx.json")), None)
            if not onnx_remote or not json_remote:
                raise HTTPException(
                    status_code=500,
                    detail={
                        "error": {
                            "message": f"Model files missing in catalog for {model_key}",
                            "type": "server_error",
                            "code": "model_files_missing",
                        }
                    },
                )

            downloaded_onnx = hf_hub_download(
                repo_id=self.settings.piper_voices_repo,
                filename=onnx_remote,
                repo_type="model",
                local_dir=self.model_dir,
            )
            downloaded_json = hf_hub_download(
                repo_id=self.settings.piper_voices_repo,
                filename=json_remote,
                repo_type="model",
                local_dir=self.model_dir,
            )

            self._copy_into_place(downloaded_onnx, model_file)
            self._copy_into_place(downloaded_json, config_file)
            logger.info("Downloaded Piper model '%s' to %s", model_key, model_file)
            return str(model_file)

    def local_models(self) -> dict[str, str]:
        if self.settings.piper_models:
            loaded = json.loads(self.settings.piper_models)
            return {str(k): str(v) for k, v in loaded.items()}

        models: dict[str, str] = {}
        for model_file in self.model_dir.glob("*.onnx"):
            cfg = model_file.with_suffix(".onnx.json")
            if cfg.exists():
                models[model_file.stem] = str(model_file)

        if self.settings.piper_model:
            model_name = Path(self.settings.piper_model).stem
            models[model_name] = self.settings.piper_model

        return models

    def known_models(self) -> list[str]:
        voices = self._load_voices_catalog()
        return sorted(str(key) for key in voices.keys())

    def resolve_model_path(self, requested_model: str) -> str:
        local = self.local_models()
        if requested_model in local:
            return local[requested_model]
        return self._download_model_if_missing(requested_model)

    def synth_to_wav(self, text: str, model_id: str) -> Path:
        effective_model = model_id or self.settings.piper_default_model
        model_path = self.resolve_model_path(effective_model)
        logger.info("Synth request model='%s' resolved_path='%s' chars=%d", effective_model, model_path, len(text))

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as temp_wav:
            out_path = Path(temp_wav.name)

        piper_bin = self._resolve_piper_binary()
        cmd = [piper_bin, "--model", model_path, "--output_file", str(out_path)]
        if self.settings.piper_speaker is not None:
            cmd.extend(["--speaker", str(self.settings.piper_speaker)])

        try:
            completed = subprocess.run(
                cmd,
                input=text.encode("utf-8"),
                text=False,
                capture_output=True,
                check=False,
            )
        except OSError as error:
            out_path.unlink(missing_ok=True)
            logger.error("Piper process launch failed: %s", error)
            raise HTTPException(
                status_code=500,
                detail={
                    "error": {
                        "message": f"Piper launch failed: {error}",
                        "type": "server_error",
                        "code": "piper_launch_failed",
                    }
                },
            ) from error

        stderr_text = completed.stderr.decode("utf-8", errors="replace").strip()
        stdout_text = completed.stdout.decode("utf-8", errors="replace").strip()
        if completed.returncode != 0:
            out_path.unlink(missing_ok=True)
            logger.error(
                "Piper synthesis failed model='%s' code=%d stderr=%s stdout=%s",
                effective_model,
                completed.returncode,
                stderr_text,
                stdout_text,
            )
            raise HTTPException(
                status_code=500,
                detail={
                    "error": {
                        "message": f"Piper failed: {stderr_text or stdout_text}",
                        "type": "server_error",
                        "code": "piper_failed",
                    }
                },
            )

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
    runtime = PiperRuntime(cfg)
    auth = _auth(cfg.api_key)

    app = FastAPI(title="TTS Piper Adapter", version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/v1/models")
    def models(_: None = Depends(auth)) -> dict:
        logger.info("Listing models")
        data = [{"id": PIPER_MODEL_ID, "object": "model", "owned_by": "piper"}]
        return {"object": "list", "data": data}

    @app.get("/v1/voices")
    def voices(_: None = Depends(auth)) -> dict:
        logger.info("Listing voices")
        voice_ids = runtime.known_models()
        return {"voices": [{"id": voice_id, "name": voice_id} for voice_id in voice_ids]}

    @app.get("/v1/audio/voices")
    def audio_voices(_: None = Depends(auth)) -> dict:
        voice_ids = runtime.known_models()
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
        if request.model and request.model != PIPER_MODEL_ID:
            logger.warning("Received unknown model '%s'; expected '%s'. Continuing with Piper voice.", request.model, PIPER_MODEL_ID)
        selected_voice = (request.voice or "").strip() or cfg.piper_default_model
        wav_path = runtime.synth_to_wav(request.input.strip(), selected_voice)
        return FileResponse(path=wav_path, media_type="audio/wav", filename="speech.wav")

    @app.get("/healthz")
    def health() -> dict:
        return {"ok": True, "default_model": cfg.piper_default_model}

    return app
