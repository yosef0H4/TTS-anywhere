from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent
GPU_ENV_NAME = ".venv-gpu"
TORCH_CUDA_INDEX_URL = "https://download.pytorch.org/whl/cu129"


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Hiro-MOSS-OCR GPU-only launcher")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8098)
    parser.add_argument("--prepare-only", action="store_true")
    return parser.parse_args(argv)


def venv_python(env_dir: Path) -> Path:
    return env_dir / "Scripts" / "python.exe" if os.name == "nt" else env_dir / "bin" / "python"


def run(cmd: list[str], env: dict[str, str]) -> None:
    subprocess.run(cmd, cwd=PROJECT_ROOT, env=env, check=True)


def ensure_nvidia_gpu_available() -> None:
    try:
        result = subprocess.run(["nvidia-smi", "-L"], cwd=PROJECT_ROOT, capture_output=True, text=True, timeout=15)
    except (FileNotFoundError, subprocess.TimeoutExpired) as error:
        raise SystemExit("Hiro-MOSS-OCR requires an NVIDIA CUDA GPU and nvidia-smi was not available.") from error
    if result.returncode != 0 or "GPU " not in result.stdout:
        detail = (result.stderr or result.stdout or "no NVIDIA GPU reported").strip()
        raise SystemExit(f"Hiro-MOSS-OCR requires an NVIDIA CUDA GPU and will not start without one: {detail}")


def ensure_env() -> Path:
    ensure_nvidia_gpu_available()
    env_dir = PROJECT_ROOT / GPU_ENV_NAME
    env = os.environ.copy()
    env.pop("VIRTUAL_ENV", None)
    env["UV_PROJECT_ENVIRONMENT"] = str(env_dir)
    env.setdefault("UV_LINK_MODE", "copy")
    env.setdefault("PYTHONIOENCODING", "utf-8")
    if not env_dir.exists():
        run(["uv", "venv", str(env_dir), "--python", "3.12"], env)
    env_python_path = venv_python(env_dir)
    run(["uv", "pip", "install", "--python", str(env_python_path), "--index-url", TORCH_CUDA_INDEX_URL, "torch==2.8.0"], env)
    run(
        [
            "uv",
            "pip",
            "install",
            "--python",
            str(env_python_path),
            "-e",
            ".",
            "transformers==4.57.6",
            "accelerate==1.12.0",
        ],
        env,
    )
    return env_python_path


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    env_python_path = ensure_env()
    if args.prepare_only:
        return
    env = os.environ.copy()
    env.pop("VIRTUAL_ENV", None)
    env.setdefault("HF_HOME", str(PROJECT_ROOT / ".hf-cache"))
    env.setdefault("PYTHONIOENCODING", "utf-8")
    env["PYTHONPATH"] = str(PROJECT_ROOT / "src") + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
    cmd = [str(env_python_path), "-m", "moss_text_processing.cli", "serve", "--host", args.host, "--port", str(args.port)]
    raise SystemExit(subprocess.call(cmd, cwd=PROJECT_ROOT, env=env))


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except KeyboardInterrupt:
        raise SystemExit(0)
