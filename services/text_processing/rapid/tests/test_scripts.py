from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest


SCRIPT_DIR = Path(__file__).resolve().parents[1] / "scripts"
SERVICE_ROOT = SCRIPT_DIR.parent


def _run_script(script_name: str, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["cmd.exe", "/c", str(SCRIPT_DIR / script_name)],
        cwd=SERVICE_ROOT,
        env=env,
        capture_output=True,
        text=True,
    )


@pytest.mark.skipif(sys.platform != "win32", reason="Windows batch launcher test")
@pytest.mark.parametrize(
    ("script_name", "expected_env", "expected_flags", "unexpected_flags"),
    [
        ("host_both.bat", ".venv-cpu", ["--enable-detect", "--enable-openai-ocr"], []),
        ("host_both_gpu.bat", ".venv-gpu", ["--enable-detect", "--enable-openai-ocr"], []),
        ("host_both_cpu_ocr_gpu.bat", ".venv-gpu", ["--enable-detect", "--enable-openai-ocr"], []),
        ("host_both_gpu_ocr_cpu.bat", ".venv-gpu", ["--enable-detect", "--enable-openai-ocr"], []),
        ("host_detect.bat", ".venv-cpu", ["--enable-detect"], ["--enable-openai-ocr"]),
        ("host_detect_gpu.bat", ".venv-gpu", ["--enable-detect"], ["--enable-openai-ocr"]),
        ("host_ocr.bat", ".venv-cpu", ["--enable-openai-ocr"], ["--enable-detect"]),
        ("host_ocr_gpu.bat", ".venv-gpu", ["--enable-openai-ocr"], ["--enable-detect"]),
    ],
)
def test_batch_scripts_dry_run_uses_bundled_uv(
    script_name: str,
    expected_env: str,
    expected_flags: list[str],
    unexpected_flags: list[str],
    tmp_path: Path,
) -> None:
    bundled_uv = tmp_path / "Programs" / "TTS Anywhere" / "resources" / "bin" / "uv.exe"
    bundled_uv.parent.mkdir(parents=True, exist_ok=True)
    bundled_uv.write_text("stub", encoding="utf8")

    result = _run_script(script_name, {**os.environ, "DRY_RUN": "1", "LOCALAPPDATA": str(tmp_path)})
    assert result.returncode == 0
    assert f"BUNDLED_UV={bundled_uv}" in result.stdout
    assert f"UV_CMD={bundled_uv}" in result.stdout
    assert f"UV_PROJECT_ENVIRONMENT={SERVICE_ROOT}\\{expected_env}" in result.stdout
    assert "py launcher.py" not in result.stdout
    assert "uv run" not in result.stdout
    assert "uv sync" not in result.stdout
    assert "uv pip install" not in result.stdout
    assert "launcher.py" in result.stdout
    for flag in expected_flags:
        assert flag in result.stdout
    for flag in unexpected_flags:
        assert flag not in result.stdout


@pytest.mark.skipif(sys.platform != "win32", reason="Windows batch launcher test")
def test_batch_scripts_dry_run_falls_back_to_global_uv(tmp_path: Path) -> None:
    fake_bin = tmp_path / "fake-bin"
    fake_bin.mkdir(parents=True, exist_ok=True)
    (fake_bin / "uv.cmd").write_text("@echo off\r\necho fake uv\r\n", encoding="utf8")

    result = _run_script(
        "host_both.bat",
        {
            **os.environ,
            "DRY_RUN": "1",
            "LOCALAPPDATA": str(tmp_path / "no-bundled-uv"),
            "PATH": f"{fake_bin};{os.environ.get('PATH', '')}",
        },
    )

    assert result.returncode == 0
    assert "UV_CMD=uv" in result.stdout


@pytest.mark.skipif(sys.platform != "win32", reason="Windows batch launcher test")
def test_batch_scripts_fail_when_no_uv_available(tmp_path: Path) -> None:
    result = _run_script(
        "host_both.bat",
        {"DRY_RUN": "1", "LOCALAPPDATA": str(tmp_path / "no-bundled-uv"), "PATH": os.environ.get("SystemRoot", r"C:\Windows") + r"\System32"},
    )

    assert result.returncode != 0
    assert "No uv installed. Install TTS Anywhere or add uv to PATH." in (result.stdout + result.stderr)


@pytest.mark.skipif(sys.platform != "win32", reason="Windows batch launcher test")
def test_batch_scripts_fail_when_no_feature_enabled(tmp_path: Path) -> None:
    bundled_uv = tmp_path / "Programs" / "TTS Anywhere" / "resources" / "bin" / "uv.exe"
    bundled_uv.parent.mkdir(parents=True, exist_ok=True)
    bundled_uv.write_text("stub", encoding="utf8")

    result = subprocess.run(
        ["cmd.exe", "/c", str(SCRIPT_DIR / "_serve.bat"), "127.0.0.1", "8091", "cpu", "cpu", "0", "0"],
        cwd=SERVICE_ROOT,
        env={**os.environ, "DRY_RUN": "1", "LOCALAPPDATA": str(tmp_path)},
        capture_output=True,
        text=True,
    )

    assert result.returncode != 0
    assert "At least one feature must be enabled." in (result.stdout + result.stderr)
