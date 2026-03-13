from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent
TORCH_CUDA_INDEX_URL = "https://download.pytorch.org/whl/cu129"
CPU_ONNXRUNTIME_PACKAGE = "onnxruntime>=1.24.2"
GPU_ONNXRUNTIME_PACKAGE = "onnxruntime-gpu>=1.24.2"
GPU_TORCH_PACKAGE = "torch==2.8.0"
LOCAL_UV_CACHE_DIR = Path(tempfile.gettempdir()) / "tts-electron-rapid-uv-cache" if os.name == "nt" else PROJECT_ROOT / ".cache" / "uv"


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Rapid service launcher with uv-managed CPU/GPU environments")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8091)
    parser.add_argument("--enable-detect", action="store_true")
    parser.add_argument("--enable-openai-ocr", action="store_true")
    parser.add_argument("--detect-provider", default="cpu", choices=["cpu", "cuda", "dml"])
    parser.add_argument("--ocr-provider", default="cpu", choices=["cpu", "cuda", "dml"])
    return parser.parse_args(argv)


def venv_python(env_dir: Path) -> Path:
    return env_dir / "Scripts" / "python.exe" if os.name == "nt" else env_dir / "bin" / "python"


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


def _installed_version(env_python_path: Path, package: str) -> str | None:
    script = (
        "import importlib.metadata as m, json\n"
        f"name = {package!r}\n"
        "try:\n"
        "    print(json.dumps({'version': m.version(name)}))\n"
        "except m.PackageNotFoundError:\n"
        "    print(json.dumps({'version': None}))\n"
    )
    result = subprocess.run(
        [str(env_python_path), "-c", script],
        cwd=PROJECT_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    payload = json.loads(result.stdout)
    version = payload.get("version")
    return version if isinstance(version, str) else None


def _parse_requirement(spec: str) -> tuple[str, str | None]:
    if "==" in spec:
        name, expected = spec.split("==", 1)
        return name.strip(), expected.strip()
    if ">=" in spec:
        name, minimum = spec.split(">=", 1)
        return name.strip(), minimum.strip()
    return spec.strip(), None


def _runtime_matches(env_python_path: Path, package_spec: str) -> bool:
    package_name, expected_version = _parse_requirement(package_spec)
    installed_version = _installed_version(env_python_path, package_name)
    if installed_version is None:
        return False
    if expected_version is not None and installed_version < expected_version:
        return False
    return True


def choose_env(args: argparse.Namespace) -> tuple[Path, bool]:
    requested = {args.detect_provider if args.enable_detect else "cpu", args.ocr_provider if args.enable_openai_ocr else "cpu"}
    needs_gpu_env = any(provider == "cuda" for provider in requested)
    env_name = ".venv-gpu" if needs_gpu_env else ".venv-cpu"
    return PROJECT_ROOT / env_name, needs_gpu_env


def ensure_env(args: argparse.Namespace) -> Path:
    env_dir, needs_gpu_env = choose_env(args)
    env = os.environ.copy()
    env["UV_PROJECT_ENVIRONMENT"] = str(env_dir)
    env.setdefault("UV_CACHE_DIR", str(LOCAL_UV_CACHE_DIR))
    env.setdefault("UV_LINK_MODE", "copy")

    run(["uv", "sync", "--inexact"], env=env)

    env_python_path = venv_python(env_dir)
    if needs_gpu_env:
        if not _runtime_matches(env_python_path, GPU_ONNXRUNTIME_PACKAGE):
            uninstall_if_present(env_python_path, "onnxruntime")
            run(["uv", "pip", "install", "--python", str(env_python_path), GPU_ONNXRUNTIME_PACKAGE], env=env)
        if not _runtime_matches(env_python_path, GPU_TORCH_PACKAGE):
            uninstall_if_present(env_python_path, "torch")
            run(
                ["uv", "pip", "install", "--python", str(env_python_path), "--index-url", TORCH_CUDA_INDEX_URL, GPU_TORCH_PACKAGE],
                env=env,
            )
    else:
        if not _runtime_matches(env_python_path, CPU_ONNXRUNTIME_PACKAGE):
            uninstall_if_present(env_python_path, "onnxruntime-gpu")
            uninstall_if_present(env_python_path, "torch")
            run(["uv", "pip", "install", "--python", str(env_python_path), CPU_ONNXRUNTIME_PACKAGE], env=env)

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

    env = os.environ.copy()
    env.setdefault("UV_CACHE_DIR", str(LOCAL_UV_CACHE_DIR))
    env.setdefault("UV_LINK_MODE", "copy")
    try:
        subprocess.run(cmd, cwd=PROJECT_ROOT, check=True, env=env)
    except KeyboardInterrupt:
        return


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        raise SystemExit(0)
