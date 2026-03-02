from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class AppSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    api_key: str | None = Field(default=None, alias="API_KEY")
    model_id: str = Field(default="namaa-saudi-tts", alias="TTS_MODEL_ID")
    hf_repo_id: str = Field(default="NAMAA-Space/NAMAA-Saudi-TTS", alias="HF_REPO_ID")
    hf_revision: str = Field(default="main", alias="HF_REVISION")
    host: str = Field(default="127.0.0.1")
    port: int = Field(default=8000)
