from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent
TORCH_CUDA_INDEX_URL = "https://download.pytorch.org/whl/cu128"


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Rapid service launcher with uv-managed CPU/GPU environments")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8091)
    parser.add_argument("--enable-detect", action="store_true")
    parser.add_argument("--enable-openai-ocr", action="store_true")
    parser.add_argument("--detect-provider", default="auto", choices=["auto", "cpu", "cuda", "dml"])
    parser.add_argument("--ocr-provider", default="auto", choices=["auto", "cpu", "cuda", "dml"])
    return parser.parse_args(argv)


def venv_python(env_dir: Path) -> Path:
    if os.name == "nt":
        return env_dir / "Scripts" / "python.exe"
    return env_dir / "bin" / "python"


def run(cmd: list[str], *, env: dict[str, str]) -> None:
    subprocess.run(cmd, cwd=PROJECT_ROOT, env=env, check=True)


def uninstall_if_present(env_python_path: Path, package: str) -> None:
    try:
        subprocess.run(
            ["uv", "pip", "uninstall", "--python", str(env_python_path), package],
            cwd=PROJECT_ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
    except subprocess.CalledProcessError:
        return


def choose_env(args: argparse.Namespace) -> tuple[Path, bool]:
    requested = {args.detect_provider if args.enable_detect else "cpu", args.ocr_provider if args.enable_openai_ocr else "cpu"}
    needs_gpu_env = any(provider in {"auto", "cuda"} for provider in requested)
    env_name = ".venv-gpu" if needs_gpu_env else ".venv-cpu"
    return PROJECT_ROOT / env_name, needs_gpu_env


def ensure_env(args: argparse.Namespace) -> Path:
    env_dir, needs_gpu_env = choose_env(args)
    env = os.environ.copy()
    env["UV_PROJECT_ENVIRONMENT"] = str(env_dir)

    run(["uv", "sync"], env=env)

    env_python_path = venv_python(env_dir)
    if needs_gpu_env:
        uninstall_if_present(env_python_path, "onnxruntime")
        run(["uv", "pip", "install", "--python", str(env_python_path), "onnxruntime-gpu>=1.24.2"], env=env)
        run(
            [
                "uv",
                "pip",
                "install",
                "--python",
                str(env_python_path),
                "--index-url",
                TORCH_CUDA_INDEX_URL,
                "torch>=2.4",
            ],
            env=env,
        )
    else:
        uninstall_if_present(env_python_path, "onnxruntime-gpu")
        uninstall_if_present(env_python_path, "torch")
        run(["uv", "pip", "install", "--python", str(env_python_path), "onnxruntime>=1.24.2"], env=env)

    return env_python_path


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    if not args.enable_detect and not args.enable_openai_ocr:
        raise SystemExit("At least one feature must be enabled: --enable-detect and/or --enable-openai-ocr")

    env_python_path = ensure_env(args)

    cmd = [
        str(env_python_path),
        "-m",
        "rapid_text_processing.cli",
        "serve",
        "--host",
        args.host,
        "--port",
        str(args.port),
        "--detect-provider",
        args.detect_provider,
        "--ocr-provider",
        args.ocr_provider,
    ]
    if args.enable_detect:
        cmd.append("--enable-detect")
    if args.enable_openai_ocr:
        cmd.append("--enable-openai-ocr")

    subprocess.run(cmd, cwd=PROJECT_ROOT, check=True)


if __name__ == "__main__":
    main()
