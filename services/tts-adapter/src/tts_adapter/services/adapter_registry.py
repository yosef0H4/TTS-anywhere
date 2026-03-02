from dataclasses import dataclass

from tts_adapter.config import AppSettings
from tts_adapter.services.adapter_base import TtsAdapter
from tts_adapter.services.namaa_chatterbox_adapter import NamaaChatterboxAdapter


class UnknownModelError(Exception):
    pass


@dataclass(slots=True)
class AdapterRegistry:
    settings: AppSettings
    allow_cpu: bool

    _adapter: TtsAdapter | None = None

    def _resolve_device(self) -> str:
        import torch

        if torch.cuda.is_available():
            return "cuda"

        if self.allow_cpu:
            return "cpu"

        raise RuntimeError(
            "CUDA is not available. Relaunch with '--allow-cpu' to force CPU mode."
        )

    def validate_runtime(self) -> None:
        self._resolve_device()

    def get(self, model_id: str) -> TtsAdapter:
        if model_id != self.settings.model_id:
            raise UnknownModelError(f"Unknown model: {model_id}")

        if self._adapter is None:
            self._adapter = NamaaChatterboxAdapter(
                model_id=self.settings.model_id,
                hf_repo_id=self.settings.hf_repo_id,
                hf_revision=self.settings.hf_revision,
                device=self._resolve_device(),
            )

        return self._adapter

    def list_models(self) -> list[str]:
        return [self.settings.model_id]
