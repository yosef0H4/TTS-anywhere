from __future__ import annotations

import argparse
import os
import subprocess
import sys
import tempfile
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent
ENV_NAME = ".venv"
LOCAL_UV_CACHE_DIR = Path(tempfile.gettempdir()) / "tts-electron-windows-natural-uv-cache"


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Windows natural voice launcher with uv-managed environment")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8016)
    return parser.parse_args(argv)


def venv_python(env_dir: Path) -> Path:
    return env_dir / "Scripts" / "python.exe"


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


def ensure_helper(python_exe: Path) -> None:
    env = os.environ.copy()
    env["PYTHONPATH"] = str(PROJECT_ROOT / "src") + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
    subprocess.run(
        [str(python_exe), "-m", "tts_windows_natural_adapter.helper_manager", "--prepare"],
        cwd=PROJECT_ROOT,
        env=env,
        check=True,
    )


def main(argv: list[str] | None = None) -> None:
    if os.name != "nt":
        raise SystemExit("Windows natural launcher is only supported on Windows.")

    args = parse_args(argv)
    python_exe = ensure_env()
    ensure_helper(python_exe)

    env = os.environ.copy()
    env.setdefault("UV_CACHE_DIR", str(LOCAL_UV_CACHE_DIR))
    env.setdefault("UV_LINK_MODE", "copy")
    env["PYTHONPATH"] = str(PROJECT_ROOT / "src") + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")

    cmd = [
        str(python_exe),
        "-m",
        "tts_windows_natural_adapter.cli",
        "serve",
        "--host",
        args.host,
        "--port",
        str(args.port),
    ]

    try:
        subprocess.run(cmd, cwd=PROJECT_ROOT, env=env, check=True)
    except KeyboardInterrupt:
        return


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except KeyboardInterrupt:
        raise SystemExit(0)
