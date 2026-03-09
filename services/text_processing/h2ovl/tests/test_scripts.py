from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest


SCRIPT_DIR = Path(__file__).resolve().parents[1] / "scripts"
SERVICE_ROOT = SCRIPT_DIR.parent


def _run_script(env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["cmd.exe", "/c", str(SCRIPT_DIR / "host.bat")],
        cwd=SERVICE_ROOT,
        env=env,
        capture_output=True,
        text=True,
    )


@pytest.mark.skipif(sys.platform != "win32", reason="Windows batch launcher test")
def test_batch_script_dry_run_uses_bundled_uv(tmp_path: Path) -> None:
    bundled_uv = tmp_path / "Programs" / "TTS Anywhere" / "resources" / "bin" / "uv.exe"
    bundled_uv.parent.mkdir(parents=True, exist_ok=True)
    bundled_uv.write_text("stub", encoding="utf8")

    result = _run_script({**os.environ, "DRY_RUN": "1", "LOCALAPPDATA": str(tmp_path)})
    assert result.returncode == 0
    assert f"BUNDLED_UV={bundled_uv}" in result.stdout
    assert f"UV_CMD={bundled_uv}" in result.stdout
    assert f"UV_PROJECT_ENVIRONMENT={SERVICE_ROOT}\\.venv-gpu" in result.stdout
    assert "py launcher.py" not in result.stdout
    assert "uv run" not in result.stdout
    assert "uv sync" not in result.stdout
    assert "uv pip install" not in result.stdout
    assert "launcher.py" in result.stdout


@pytest.mark.skipif(sys.platform != "win32", reason="Windows batch launcher test")
def test_batch_script_dry_run_falls_back_to_global_uv(tmp_path: Path) -> None:
    fake_bin = tmp_path / "fake-bin"
    fake_bin.mkdir(parents=True, exist_ok=True)
    (fake_bin / "uv.cmd").write_text("@echo off\r\necho fake uv\r\n", encoding="utf8")

    result = _run_script(
        {
            **os.environ,
            "DRY_RUN": "1",
            "LOCALAPPDATA": str(tmp_path / "no-bundled-uv"),
            "PATH": f"{fake_bin};{os.environ.get('PATH', '')}",
        }
    )

    assert result.returncode == 0
    assert "UV_CMD=uv" in result.stdout


@pytest.mark.skipif(sys.platform != "win32", reason="Windows batch launcher test")
def test_batch_script_fails_when_no_uv_available(tmp_path: Path) -> None:
    result = _run_script(
        {"DRY_RUN": "1", "LOCALAPPDATA": str(tmp_path / "no-bundled-uv"), "PATH": os.environ.get("SystemRoot", r"C:\Windows") + r"\System32"}
    )

    assert result.returncode != 0
    assert "No uv installed. Install TTS Anywhere or add uv to PATH." in (result.stdout + result.stderr)
