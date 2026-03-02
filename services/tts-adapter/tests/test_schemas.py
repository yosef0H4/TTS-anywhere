import pytest
from pydantic import ValidationError

from tts_adapter.api.schemas import SpeechRequest


def test_speech_request_defaults() -> None:
    req = SpeechRequest(model="namaa-saudi-tts", input="  hello ")
    assert req.input == "hello"
    assert req.response_format == "wav"
    assert req.speed == 1.0


def test_speech_request_rejects_empty_input() -> None:
    with pytest.raises(ValidationError):
        SpeechRequest(model="namaa-saudi-tts", input="   ")
