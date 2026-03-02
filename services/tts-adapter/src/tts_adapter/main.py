from __future__ import annotations

import argparse

import uvicorn
from fastapi import FastAPI
from fastapi.responses import JSONResponse

from tts_adapter.api.routes_openai import build_router
from tts_adapter.config import AppSettings
from tts_adapter.services.adapter_registry import AdapterRegistry


def create_app(
    settings: AppSettings,
    *,
    allow_cpu: bool = False,
    registry: AdapterRegistry | None = None,
) -> FastAPI:
    resolved_registry = registry or AdapterRegistry(settings=settings, allow_cpu=allow_cpu)

    # Fail fast on device policy (GPU-only unless --allow-cpu), but defer model weight loading.
    resolved_registry.validate_runtime()

    app = FastAPI(title="TTS Adapter", version="0.1.0")
    app.include_router(
        build_router(registry=resolved_registry, api_key=settings.api_key),
        prefix="/v1",
    )

    @app.get("/healthz")
    def healthz() -> JSONResponse:
        return JSONResponse({"ok": True, "model": settings.model_id})

    return app


def run_server() -> None:
    parser = argparse.ArgumentParser(description="Run OpenAI-compatible local TTS adapter")
    parser.add_argument("--host", default=None)
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--allow-cpu", action="store_true")
    args = parser.parse_args()

    settings = AppSettings()
    host = args.host or settings.host
    port = args.port or settings.port
    app = create_app(settings=settings, allow_cpu=args.allow_cpu)
    uvicorn.run(app, host=host, port=port)


if __name__ == "__main__":
    run_server()
