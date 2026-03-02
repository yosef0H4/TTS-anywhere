from typing import Literal

from pydantic import BaseModel, Field, field_validator


class SpeechRequest(BaseModel):
    model: str
    input: str
    voice: str = "alloy"
    response_format: Literal["wav"] = "wav"
    speed: float = Field(default=1.0, ge=0.25, le=4.0)
    audio_prompt_path: str | None = None

    @field_validator("input")
    @classmethod
    def input_not_empty(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("input must not be empty")
        return cleaned


class OpenAIErrorBody(BaseModel):
    message: str
    type: str
    code: str | None = None


class OpenAIErrorEnvelope(BaseModel):
    error: OpenAIErrorBody


class ModelObject(BaseModel):
    id: str
    object: Literal["model"] = "model"
    owned_by: str = "local"


class ModelsResponse(BaseModel):
    object: Literal["list"] = "list"
    data: list[ModelObject]
