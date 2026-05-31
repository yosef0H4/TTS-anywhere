from __future__ import annotations

from pathlib import Path

import pytest

import launcher


def test_parse_args() -> None:
    args = launcher.parse_args(["--host", "127.0.0.1", "--port", "8016"])
    assert args.host == "127.0.0.1"
    assert args.port == 8016


def test_ensure_env_runs_uv_sync(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[list[str]] = []
    monkeypatch.setattr(launcher, "run", lambda cmd, env: calls.append(cmd))
    monkeypatch.setattr(launcher, "venv_python", lambda env_dir: Path("/tmp/python"))
    env_python = launcher.ensure_env()
    assert env_python == Path("/tmp/python")
    assert calls == [["uv", "sync", "--group", "dev", "--inexact"]]


def test_main_rejects_non_windows(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(launcher.os, "name", "posix")
    with pytest.raises(SystemExit, match="only supported on Windows"):
        launcher.main([])
