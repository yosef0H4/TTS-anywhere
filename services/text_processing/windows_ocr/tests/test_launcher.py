from __future__ import annotations

from pathlib import Path

import pytest

import launcher


def test_parse_args_includes_language() -> None:
    args = launcher.parse_args(["--host", "127.0.0.1", "--port", "8097", "--language", "en-US"])

    assert args.host == "127.0.0.1"
    assert args.port == 8097
    assert args.language == "en-US"


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


def test_main_builds_expected_command(monkeypatch: pytest.MonkeyPatch) -> None:
    args = launcher.parse_args(["--host", "127.0.0.1", "--port", "8097", "--language", "en-US"])
    captured: dict[str, object] = {}

    monkeypatch.setattr(launcher.os, "name", "nt")
    monkeypatch.setattr(launcher, "parse_args", lambda argv=None: args)
    monkeypatch.setattr(launcher, "ensure_env", lambda: Path(r"C:\service\.venv\Scripts\python.exe"))
    monkeypatch.setattr(
        launcher.subprocess,
        "run",
        lambda cmd, cwd, env, check: captured.update({"cmd": cmd, "cwd": cwd, "env": env, "check": check}),
    )

    launcher.main([])

    assert captured["cmd"] == [
        r"C:\service\.venv\Scripts\python.exe",
        "-m",
        "windows_ocr_text_processing.cli",
        "serve",
        "--host",
        "127.0.0.1",
        "--port",
        "8097",
        "--language",
        "en-US",
    ]
