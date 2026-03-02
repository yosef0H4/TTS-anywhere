from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol, cast

import numpy as np

from tts_adapter.services.audio_postprocess import float_wave_to_wav_bytes


class _GeneratedModel(Protocol):
    class _T3(Protocol):
        def load_state_dict(self, state_dict: object) -> None: ...

        def to(self, device: str) -> _GeneratedModel._T3: ...

        def eval(self) -> _GeneratedModel._T3: ...

    sr: int
    t3: _T3

    def generate(self, text: str, **kwargs: str) -> object: ...


@dataclass(slots=True)
class NamaaChatterboxAdapter:
    model_id: str
    hf_repo_id: str
    hf_revision: str
    device: str

    _loaded: bool = False
    _model: _GeneratedModel | None = None

    def load(self) -> None:
        if self._loaded:
            return

        from chatterbox import mtl_tts
        from huggingface_hub import snapshot_download
        from safetensors.torch import load_file as load_safetensors

        ckpt_dir = snapshot_download(
            repo_id=self.hf_repo_id,
            repo_type="model",
            revision=self.hf_revision,
        )

        model = cast(
            _GeneratedModel,
            mtl_tts.ChatterboxMultilingualTTS.from_pretrained(device=self.device),
        )
        t3_state = load_safetensors(f"{ckpt_dir}/t3_mtl23ls_v2.safetensors", device=self.device)
        model.t3.load_state_dict(t3_state)
        model.t3.to(self.device).eval()

        self._model = model
        self._loaded = True

    def synthesize(
        self,
        text: str,
        *,
        speed: float,
        voice: str | None,
        audio_prompt_path: str | None,
    ) -> bytes:
        del speed, voice

        if not self._loaded or self._model is None:
            self.load()

        model = self._model
        assert model is not None

        kwargs: dict[str, str] = {"language_id": "ar"}
        if audio_prompt_path:
            kwargs["audio_prompt_path"] = audio_prompt_path

        wav_tensor = cast(Any, model.generate(text, **kwargs))

        # Chatterbox returns a tensor-like array. Convert safely to numpy mono.
        wav_np = cast(np.ndarray, wav_tensor.detach().cpu().numpy())
        if wav_np.ndim > 1:
            wav_np = np.squeeze(wav_np)
        wav_np = np.asarray(wav_np, dtype=np.float32)

        sample_rate = int(model.sr)
        return float_wave_to_wav_bytes(wav_np, sample_rate)
