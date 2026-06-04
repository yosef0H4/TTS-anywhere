from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent
LOCAL_UV_CACHE_DIR = Path(tempfile.gettempdir()) / "tts-electron-supertonic-uv-cache" if os.name == "nt" else PROJECT_ROOT / ".cache" / "uv"


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Supertonic TTS launcher")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--runtime", choices=["cpu", "gpu", "nvidia"], default=os.environ.get("SUPERTONIC_RUNTIME", "cpu"))
    return parser.parse_args(argv)


def venv_python(env_dir: Path) -> Path:
    return env_dir / "Scripts" / "python.exe" if os.name == "nt" else env_dir / "bin" / "python"


def run(cmd: list[str], *, env: dict[str, str]) -> None:
    print(f"[supertonic] RUN {' '.join(cmd)}", flush=True)
    subprocess.run(cmd, cwd=PROJECT_ROOT, env=env, check=True)


def ensure_nvidia_gpu_available() -> None:
    try:
        result = subprocess.run(["nvidia-smi", "-L"], cwd=PROJECT_ROOT, capture_output=True, text=True, timeout=15)
    except (FileNotFoundError, subprocess.TimeoutExpired) as error:
        raise SystemExit("Supertonic GPU requires an NVIDIA CUDA GPU and nvidia-smi was not available.") from error
    if result.returncode != 0 or "GPU " not in result.stdout:
        detail = (result.stderr or result.stdout or "no NVIDIA GPU reported").strip()
        raise SystemExit(f"Supertonic GPU requires an NVIDIA CUDA GPU and will not start without one: {detail}")
    print(f"[supertonic] NVIDIA GPU detected: {result.stdout.strip()}", flush=True)


def env_dir_for_runtime(runtime: str) -> Path:
    if runtime == "nvidia":
        return PROJECT_ROOT / ".venv-nvidia"
    return PROJECT_ROOT / (".venv-gpu" if runtime == "gpu" else ".venv-cpu")


def package_installed(env_python_path: Path, module_name: str) -> bool:
    if not env_python_path.exists():
        return False
    probe = f"import importlib.util, sys; sys.exit(0 if importlib.util.find_spec({module_name!r}) else 1)\n"
    result = subprocess.run([str(env_python_path), "-c", probe], cwd=PROJECT_ROOT)
    return result.returncode == 0


def ensure_env(args: argparse.Namespace) -> Path:
    if args.runtime in {"gpu", "nvidia"}:
        ensure_nvidia_gpu_available()

    env_dir = env_dir_for_runtime(args.runtime)
    env = os.environ.copy()
    env.pop("VIRTUAL_ENV", None)
    env["UV_PROJECT_ENVIRONMENT"] = str(env_dir)
    env.setdefault("UV_CACHE_DIR", str(LOCAL_UV_CACHE_DIR))
    env.setdefault("UV_LINK_MODE", "copy")
    try:
        run(["uv", "sync", "--group", "dev", "--inexact"], env=env)
    except subprocess.CalledProcessError:
        print("[supertonic] Recreating environment after sync failure.", flush=True)
        if env_dir.exists():
            shutil.rmtree(env_dir, ignore_errors=True)
        run(["uv", "sync", "--group", "dev", "--inexact"], env=env)

    env_python_path = venv_python(env_dir)
    if args.runtime == "nvidia":
        ensure_torch_cuda(env_python_path, env)
        ensure_torch_runtime(env_python_path)
    else:
        ensure_onnxruntime(env_python_path, env, args.runtime)
        ensure_runtime(env_python_path, args.runtime)
    ensure_adapter_package(env_python_path, env)
    return env_python_path


def ensure_onnxruntime(env_python_path: Path, env: dict[str, str], runtime: str) -> None:
    required_package = "onnxruntime-directml" if runtime == "gpu" and os.name == "nt" else ("onnxruntime-gpu[cuda,cudnn]" if runtime == "gpu" else "onnxruntime")
    if runtime == "cpu" and package_installed(env_python_path, "onnxruntime"):
        print(f"[supertonic] onnxruntime already installed for {runtime}; skipping download.", flush=True)
        return
    print(f"[supertonic] Installing {required_package} with uv.", flush=True)
    run(["uv", "pip", "install", "--python", str(env_python_path), required_package], env=env)


def ensure_runtime(env_python_path: Path, runtime: str) -> None:
    script = (
        "import json, onnxruntime as ort\n"
        "print(json.dumps({'providers': ort.get_available_providers()}))\n"
    )
    result = subprocess.run([str(env_python_path), "-c", script], cwd=PROJECT_ROOT, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout or "ONNX Runtime probe failed").strip())
    payload = json.loads(result.stdout)
    providers = payload.get("providers") or []
    if runtime == "gpu":
        required_provider = "DmlExecutionProvider" if os.name == "nt" else "CUDAExecutionProvider"
        if required_provider not in providers:
            raise SystemExit(f"Supertonic GPU requires {required_provider}. Available ONNX providers: {providers}")
    if runtime == "cpu" and "CPUExecutionProvider" not in providers:
        raise SystemExit(f"Supertonic CPU requires CPUExecutionProvider. Available ONNX providers: {providers}")
    print(f"[supertonic] ONNX providers for {runtime}: {providers}", flush=True)


def ensure_torch_cuda(env_python_path: Path, env: dict[str, str]) -> None:
    if package_installed(env_python_path, "torch"):
        print("[supertonic] torch already installed for nvidia; skipping download.", flush=True)
    else:
        run(["uv", "pip", "install", "--python", str(env_python_path), "torch", "--index-url", "https://download.pytorch.org/whl/cu128"], env=env)
    for package in ("onnx", "huggingface_hub"):
        if not package_installed(env_python_path, package):
            run(["uv", "pip", "install", "--python", str(env_python_path), package], env=env)


def ensure_torch_runtime(env_python_path: Path) -> None:
    script = (
        "import json, torch\n"
        "print(json.dumps({'cuda': torch.cuda.is_available(), 'device': torch.cuda.get_device_name(0) if torch.cuda.is_available() else None}))\n"
    )
    result = subprocess.run([str(env_python_path), "-c", script], cwd=PROJECT_ROOT, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout or "Torch CUDA probe failed").strip())
    payload = json.loads(result.stdout)
    if not payload.get("cuda"):
        raise SystemExit(f"Supertonic NVIDIA requires CUDA Torch. Probe result: {payload}")
    print(f"[supertonic] Torch CUDA device: {payload.get('device')}", flush=True)


def ensure_adapter_package(env_python_path: Path, env: dict[str, str]) -> None:
    run(["uv", "pip", "install", "--python", str(env_python_path), "--editable", str(PROJECT_ROOT)], env=env)


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    env_python_path = ensure_env(args)
    env = os.environ.copy()
    env.pop("VIRTUAL_ENV", None)
    env.setdefault("UV_CACHE_DIR", str(LOCAL_UV_CACHE_DIR))
    env.setdefault("UV_LINK_MODE", "copy")
    env.setdefault("HF_HOME", str(PROJECT_ROOT / ".hf-cache"))
    env.setdefault("PYTHONIOENCODING", "utf-8")
    env.setdefault("PYTHONUTF8", "1")
    env["SUPERTONIC_RUNTIME"] = args.runtime
    env["SUPERTONIC_PORT"] = str(args.port or (8019 if args.runtime == "nvidia" else (8018 if args.runtime == "gpu" else 8017)))
    env["PYTHONPATH"] = str(PROJECT_ROOT / "src") + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
    print(f"[supertonic] HF_HOME={env['HF_HOME']}", flush=True)
    cmd = [
        str(env_python_path),
        "-m",
        "tts_supertonic_adapter.cli",
        "serve",
        "--runtime",
        args.runtime,
        "--host",
        args.host,
        "--port",
        env["SUPERTONIC_PORT"],
    ]
    raise SystemExit(subprocess.run(cmd, cwd=PROJECT_ROOT, env=env).returncode)


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except KeyboardInterrupt:
        raise SystemExit(0)
