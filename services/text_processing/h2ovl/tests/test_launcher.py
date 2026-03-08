from __future__ import annotations

from pathlib import Path

import launcher


def test_ensure_env_requires_python_311_on_windows(monkeypatch) -> None:
    args = launcher.parse_args([])
    calls: list[list[str]] = []

    monkeypatch.setattr(launcher, "run", lambda cmd, env: calls.append(cmd))
    monkeypatch.setattr(launcher, "venv_python", lambda env_dir: Path("/tmp/python"))
    monkeypatch.setattr(launcher, "_python_version", lambda env_python_path: "3.12")
    monkeypatch.setattr(launcher, "os", type("OS", (), {"name": "nt", "environ": launcher.os.environ, "pathsep": launcher.os.pathsep})())

    try:
        launcher.ensure_env(args)
    except SystemExit as error:
        assert "Python 3.11" in str(error)
    else:
        raise AssertionError("Expected SystemExit for non-3.11 Python")


def test_ensure_env_prefers_flash_attn_wheel_on_windows(monkeypatch) -> None:
    args = launcher.parse_args([])
    calls: list[list[str]] = []

    monkeypatch.setattr(launcher, "run", lambda cmd, env: calls.append(cmd))
    monkeypatch.setattr(launcher, "venv_python", lambda env_dir: Path("/tmp/python"))
    monkeypatch.setattr(launcher, "_python_version", lambda env_python_path: "3.11")
    monkeypatch.setattr(launcher, "_runtime_matches", lambda env_python_path, package_spec: True)
    monkeypatch.setattr(launcher, "_cuda_available", lambda env_python_path: True)
    monkeypatch.setattr(launcher, "_flash_attn_installed", lambda env_python_path: False)
    monkeypatch.setattr(launcher, "uninstall_if_present", lambda env_python_path, package: None)
    monkeypatch.setattr(launcher, "os", type("OS", (), {"name": "nt", "environ": launcher.os.environ, "pathsep": launcher.os.pathsep})())

    launcher.ensure_env(args)

    assert calls[0] == ["uv", "sync", "--group", "dev", "--inexact"]
    assert any(args.flash_attn_wheel_url in cmd for cmd in calls)
