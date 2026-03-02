import pytest
from fastapi import HTTPException

from tts_adapter.security import enforce_bearer


def test_no_auth_when_api_key_missing() -> None:
    enforce_bearer(api_key=None, authorization=None)


def test_auth_fails_with_missing_header() -> None:
    with pytest.raises(HTTPException):
        enforce_bearer(api_key="secret", authorization=None)


def test_auth_fails_with_bad_token() -> None:
    with pytest.raises(HTTPException):
        enforce_bearer(api_key="secret", authorization="Bearer nope")


def test_auth_accepts_valid_token() -> None:
    enforce_bearer(api_key="secret", authorization="Bearer secret")
