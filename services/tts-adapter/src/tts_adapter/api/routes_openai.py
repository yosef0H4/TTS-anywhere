from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse, Response

from tts_adapter.api.schemas import ModelObject, ModelsResponse, OpenAIErrorEnvelope, SpeechRequest
from tts_adapter.security import auth_dependency_factory
from tts_adapter.services.adapter_registry import AdapterRegistry, UnknownModelError


def build_router(registry: AdapterRegistry, api_key: str | None) -> APIRouter:
    router = APIRouter()
    auth_dep = auth_dependency_factory(api_key)

    @router.get("/models", response_model=ModelsResponse)
    def list_models(_: None = Depends(auth_dep)) -> ModelsResponse:
        models = [ModelObject(id=model_id) for model_id in registry.list_models()]
        return ModelsResponse(data=models)

    @router.post("/audio/speech")
    def speech(request: SpeechRequest, _: None = Depends(auth_dep)) -> Response:
        try:
            adapter = registry.get(request.model)
        except UnknownModelError as exc:
            envelope = OpenAIErrorEnvelope.model_validate(
                {
                    "error": {
                        "message": str(exc),
                        "type": "invalid_request_error",
                        "code": "model_not_found",
                    }
                }
            )
            return JSONResponse(status_code=400, content=envelope.model_dump())

        wav_bytes = adapter.synthesize(
            request.input,
            speed=request.speed,
            voice=request.voice,
            audio_prompt_path=request.audio_prompt_path,
        )

        return Response(content=wav_bytes, media_type="audio/wav")

    return router
