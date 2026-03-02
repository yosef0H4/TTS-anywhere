from collections.abc import Callable

from fastapi import Header, HTTPException, status


def enforce_bearer(api_key: str | None, authorization: str | None) -> None:
    if api_key is None:
        return

    if authorization is None or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "error": {
                    "message": "Missing Bearer token",
                    "type": "authentication_error",
                    "code": "missing_api_key",
                }
            },
        )

    token = authorization[len("Bearer ") :]
    if token != api_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "error": {
                    "message": "Invalid API key",
                    "type": "authentication_error",
                    "code": "invalid_api_key",
                }
            },
        )


def auth_dependency_factory(api_key: str | None) -> Callable[[str | None], None]:
    def _auth(authorization: str | None = Header(default=None)) -> None:
        enforce_bearer(api_key=api_key, authorization=authorization)

    return _auth
