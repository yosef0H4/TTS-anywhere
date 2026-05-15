from __future__ import annotations

import os
import time
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


def test_read_owner_watchdog_config_is_opt_in(tmp_path: Path) -> None:
    assert launcher.read_owner_watchdog_config({}) is None

    config = launcher.read_owner_watchdog_config({
        "TTS_ANYWHERE_OWNER_MODE": "heartbeat-file",
        "TTS_ANYWHERE_OWNER_HEARTBEAT_FILE": str(tmp_path / "heartbeat.json"),
        "TTS_ANYWHERE_OWNER_HEARTBEAT_INTERVAL_MS": "1500",
        "TTS_ANYWHERE_OWNER_GRACE_MS": "7000",
    })

    assert config == launcher.OwnerWatchdogConfig(
        heartbeat_file=tmp_path / "heartbeat.json",
        interval_ms=1500,
        grace_ms=7000,
    )


def test_heartbeat_is_stale_when_file_is_missing(tmp_path: Path) -> None:
    config = launcher.OwnerWatchdogConfig(tmp_path / "missing.json", interval_ms=1000, grace_ms=3000)

    assert launcher.heartbeat_is_stale(config) is True


def test_heartbeat_is_stale_after_interval_and_grace(tmp_path: Path) -> None:
    heartbeat = tmp_path / "heartbeat.json"
    heartbeat.write_text("{}", encoding="utf-8")
    now = time.time()
    os.utime(heartbeat, (now - 5, now - 5))

    config = launcher.OwnerWatchdogConfig(heartbeat, interval_ms=1000, grace_ms=3000)

    assert launcher.heartbeat_is_stale(config, now=now) is True


def test_main_builds_expected_command(monkeypatch: pytest.MonkeyPatch) -> None:
    args = launcher.parse_args(["--host", "127.0.0.1", "--port", "8097", "--language", "en-US"])
    captured: dict[str, object] = {}

    class FakeProcess:
        def __init__(self, cmd: list[str], cwd: Path, env: dict[str, str]) -> None:
            captured["cmd"] = cmd
            captured["cwd"] = cwd
            captured["env"] = env

        def wait(self, timeout: float | None = None) -> int:
            captured["wait_timeout"] = timeout
            return 0

        def poll(self) -> int | None:
            return 0

        def terminate(self) -> None:
            captured["terminated"] = True

    monkeypatch.setattr(launcher.os, "name", "nt")
    monkeypatch.setattr(launcher, "parse_args", lambda argv=None: args)
    monkeypatch.setattr(launcher, "ensure_env", lambda: Path(r"C:\service\.venv\Scripts\python.exe"))
    monkeypatch.setattr(
        launcher.subprocess,
        "Popen",
        lambda cmd, cwd, env: FakeProcess(cmd, cwd, env),
    )
    monkeypatch.setattr(launcher, "start_owner_watchdog", lambda child, config: launcher.threading.Event())

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
