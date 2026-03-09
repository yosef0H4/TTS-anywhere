from __future__ import annotations

from pathlib import Path

import launcher


def test_choose_env_prefers_gpu_when_any_feature_requests_cuda() -> None:
    args = launcher.parse_args(["--enable-detect", "--enable-openai-ocr", "--detect-provider", "cpu", "--ocr-provider", "cuda"])
    env_dir, needs_gpu = launcher.choose_env(args)

    assert needs_gpu is True
    assert env_dir == Path(launcher.PROJECT_ROOT / ".venv-gpu")


def test_choose_env_uses_cpu_when_all_requested_providers_are_cpu() -> None:
    args = launcher.parse_args(["--enable-detect", "--detect-provider", "cpu"])
    env_dir, needs_gpu = launcher.choose_env(args)

    assert needs_gpu is False
    assert env_dir == Path(launcher.PROJECT_ROOT / ".venv-cpu")


def test_ensure_env_skips_gpu_reinstall_when_runtime_matches(monkeypatch) -> None:
    args = launcher.parse_args(["--enable-detect", "--detect-provider", "cuda"])
    calls: list[list[str]] = []

    monkeypatch.setattr(launcher, "run", lambda cmd, env: calls.append(cmd))
    monkeypatch.setattr(launcher, "uninstall_if_present", lambda env_python_path, package: calls.append(["uninstall", package]))
    monkeypatch.setattr(launcher, "venv_python", lambda env_dir: Path("/tmp/python"))
    monkeypatch.setattr(
        launcher,
        "_runtime_matches",
        lambda env_python_path, package_spec: package_spec in {launcher.GPU_ONNXRUNTIME_PACKAGE, launcher.GPU_TORCH_PACKAGE},
    )

    launcher.ensure_env(args)

    assert calls == [["uv", "sync", "--inexact"]]


def test_ensure_env_reinstalls_cpu_runtime_when_missing(monkeypatch) -> None:
    args = launcher.parse_args(["--enable-detect", "--detect-provider", "cpu"])
    calls: list[list[str]] = []

    monkeypatch.setattr(launcher, "run", lambda cmd, env: calls.append(cmd))
    monkeypatch.setattr(launcher, "uninstall_if_present", lambda env_python_path, package: calls.append(["uninstall", package]))
    monkeypatch.setattr(launcher, "venv_python", lambda env_dir: Path("/tmp/python"))
    monkeypatch.setattr(launcher, "_runtime_matches", lambda env_python_path, package_spec: False)

    launcher.ensure_env(args)

    assert calls[0] == ["uv", "sync", "--inexact"]
    assert ["uninstall", "onnxruntime-gpu"] in calls
    assert ["uninstall", "torch"] in calls
    assert ["uv", "pip", "install", "--python", str(Path("/tmp/python")), launcher.CPU_ONNXRUNTIME_PACKAGE] in calls


def test_main_treats_keyboard_interrupt_as_clean_shutdown(monkeypatch) -> None:
    args = launcher.parse_args(["--enable-detect", "--detect-provider", "cpu"])
    monkeypatch.setattr(launcher, "parse_args", lambda argv=None: args)
    monkeypatch.setattr(launcher, "ensure_env", lambda parsed_args: Path("/tmp/python"))
    monkeypatch.setattr(launcher.subprocess, "run", lambda *args, **kwargs: (_ for _ in ()).throw(KeyboardInterrupt()))

    launcher.main([])
