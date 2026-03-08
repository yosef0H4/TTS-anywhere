from __future__ import annotations

from pathlib import Path

import pytest

import launcher


def test_choose_env_prefers_gpu_when_any_feature_requests_gpu() -> None:
    args = launcher.parse_args(["--enable-detect", "--enable-openai-ocr", "--detect-device", "cpu", "--ocr-device", "gpu"])
    env_dir, needs_gpu = launcher.choose_env(args)

    assert needs_gpu is True
    assert env_dir == Path(launcher.PROJECT_ROOT / ".venv-gpu")


def test_choose_env_uses_cpu_when_all_requested_devices_are_cpu() -> None:
    args = launcher.parse_args(["--enable-detect", "--detect-device", "cpu"])
    env_dir, needs_gpu = launcher.choose_env(args)

    assert needs_gpu is False
    assert env_dir == Path(launcher.PROJECT_ROOT / ".venv-cpu")


def test_ensure_env_requires_gpu_index_url(monkeypatch: pytest.MonkeyPatch) -> None:
    args = launcher.parse_args(["--enable-detect", "--detect-device", "gpu"])
    monkeypatch.setattr(launcher, "run", lambda cmd, env: None)
    monkeypatch.setattr(launcher, "uninstall_if_present", lambda env_python_path, package: None)
    monkeypatch.setattr(launcher, "venv_python", lambda env_dir: Path("/tmp/python"))

    with pytest.raises(SystemExit, match="GPU launch requested"):
        launcher.ensure_env(args)
