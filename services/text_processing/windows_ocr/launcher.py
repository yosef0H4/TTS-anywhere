from __future__ import annotations

import argparse
import os
import subprocess
import sys
import tempfile
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent
ENV_NAME = ".venv"
LOCAL_UV_CACHE_DIR = Path(tempfile.gettempdir()) / "tts-electron-windows-ocr-uv-cache" if os.name == "nt" else PROJECT_ROOT / ".cache" / "uv"


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Windows OCR launcher with uv-managed environment")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8097)
    parser.add_argument("--language", default="")
    return parser.parse_args(argv)


def venv_python(env_dir: Path) -> Path:
    return env_dir / "Scripts" / "python.exe" if os.name == "nt" else env_dir / "bin" / "python"


def run(cmd: list[str], *, env: dict[str, str]) -> None:
    subprocess.run(cmd, cwd=PROJECT_ROOT, env=env, check=True)


def ensure_env() -> Path:
    env_dir = PROJECT_ROOT / ENV_NAME
    env = os.environ.copy()
    env["UV_PROJECT_ENVIRONMENT"] = str(env_dir)
    env.setdefault("UV_CACHE_DIR", str(LOCAL_UV_CACHE_DIR))
    env.setdefault("UV_LINK_MODE", "copy")
    run(["uv", "sync", "--group", "dev", "--inexact"], env=env)
    return venv_python(env_dir)


def main(argv: list[str] | None = None) -> None:
    if os.name != "nt":
        raise SystemExit("Windows OCR launcher is only supported on Windows.")

    args = parse_args(argv)
    env_python_path = ensure_env()

    cmd = [
        str(env_python_path),
        "-m",
        "windows_ocr_text_processing.cli",
        "serve",
        "--host",
        args.host,
        "--port",
        str(args.port),
    ]
    if args.language.strip():
        cmd.extend(["--language", args.language.strip()])

    env = os.environ.copy()
    env.setdefault("UV_CACHE_DIR", str(LOCAL_UV_CACHE_DIR))
    env.setdefault("UV_LINK_MODE", "copy")
    env["PYTHONPATH"] = str(PROJECT_ROOT / "src") + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")

    try:
        subprocess.run(cmd, cwd=PROJECT_ROOT, env=env, check=True)
    except KeyboardInterrupt:
        return


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except KeyboardInterrupt:
        raise SystemExit(0)
