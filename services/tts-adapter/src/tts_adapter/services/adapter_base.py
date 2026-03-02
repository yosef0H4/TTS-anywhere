from typing import Protocol


class TtsAdapter(Protocol):
    model_id: str

    def load(self) -> None: ...

    def synthesize(
        self,
        text: str,
        *,
        speed: float,
        voice: str | None,
        audio_prompt_path: str | None,
    ) -> bytes: ...
