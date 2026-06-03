from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent
GPU_ENV_NAME = ".venv-gpu"
TORCH_CUDA_INDEX_URL = "https://download.pytorch.org/whl/cu129"
GPU_TORCH_PACKAGE = "torch==2.8.0"
GPU_TORCHVISION_PACKAGE = "torchvision==0.23.0"
TRANSFORMERS_SOURCE = "git+https://github.com/huggingface/transformers.git@1423d22f7a3b62e8c70ad67b58ec25cd9b675897"
PEFT_SOURCE = "git+https://github.com/huggingface/peft.git@5261e95817f7d37d23ab7f5cef7295364de1be96"
GPU_RUNTIME_PACKAGES = [TRANSFORMERS_SOURCE, PEFT_SOURCE, "huggingface_hub>=1.17.0", "accelerate==1.12.0", "pillow>=11.0.0", "sentencepiece>=0.2.0"]
FLASH_ATTN_WHEEL_URL = (
    "https://huggingface.co/ussoewwin/Flash-Attention-2_for_Windows/resolve/main/"
    "flash_attn-2.8.2+cu129torch2.8.0cxx11abiTRUE-cp311-cp311-win_amd64.whl"
)
LOCAL_UV_CACHE_DIR = Path(tempfile.gettempdir()) / "tts-electron-katib-uv-cache" if os.name == "nt" else PROJECT_ROOT / ".cache" / "uv"


@dataclass(frozen=True)
class OwnerWatchdogConfig:
    heartbeat_file: Path
    interval_ms: int
    grace_ms: int


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Katib Arabic OCR GPU-only launcher")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8096)
    parser.add_argument("--gpu-index-url", default=os.environ.get("KATIB_GPU_INDEX_URL", TORCH_CUDA_INDEX_URL))
    parser.add_argument("--torch-package", default=os.environ.get("KATIB_TORCH_PACKAGE", GPU_TORCH_PACKAGE))
    parser.add_argument("--torchvision-package", default=os.environ.get("KATIB_TORCHVISION_PACKAGE", GPU_TORCHVISION_PACKAGE))
    parser.add_argument("--flash-attn-wheel-url", default=os.environ.get("KATIB_FLASH_ATTN_WHEEL_URL", FLASH_ATTN_WHEEL_URL))
    parser.add_argument("--prepare-only", action="store_true", help="Prepare and verify the GPU environment without starting the API")
    return parser.parse_args(argv)


def venv_python(env_dir: Path) -> Path:
    return env_dir / "Scripts" / "python.exe" if os.name == "nt" else env_dir / "bin" / "python"


def run(cmd: list[str], *, env: dict[str, str]) -> None:
    subprocess.run(cmd, cwd=PROJECT_ROOT, env=env, check=True)


def ensure_nvidia_gpu_available() -> None:
    try:
        result = subprocess.run(["nvidia-smi", "-L"], cwd=PROJECT_ROOT, capture_output=True, text=True, timeout=15)
    except (FileNotFoundError, subprocess.TimeoutExpired) as error:
        raise SystemExit("Katib requires an NVIDIA CUDA GPU and nvidia-smi was not available.") from error
    if result.returncode != 0 or "GPU " not in result.stdout:
        detail = (result.stderr or result.stdout or "no NVIDIA GPU reported").strip()
        raise SystemExit(f"Katib requires an NVIDIA CUDA GPU and will not start without one: {detail}")
    print(f"[katib] NVIDIA GPU detected: {result.stdout.strip()}", flush=True)


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
    result = subprocess.run([str(env_python_path), "-c", script], cwd=PROJECT_ROOT, check=True, capture_output=True, text=True)
    payload = json.loads(result.stdout)
    version = payload.get("version")
    return version if isinstance(version, str) else None


def _parse_requirement(spec: str) -> tuple[str, str | None]:
    if "huggingface/transformers.git" in spec:
        return "transformers", "5.10.0.dev0"
    if "huggingface/peft.git" in spec:
        return "peft", "0.19.2.dev0"
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
    if package_name in {"torch", "torchvision"} and expected_version is not None:
        return installed_version.split("+", 1)[0] == expected_version
    if expected_version is not None and installed_version < expected_version:
        return False
    return True


def _python_version(env_python_path: Path) -> str:
    result = subprocess.run(
        [str(env_python_path), "-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"],
        cwd=PROJECT_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def _cuda_available(env_python_path: Path) -> bool:
    script = "import json, torch; print(json.dumps({'cuda': bool(torch.cuda.is_available())}))\n"
    try:
        result = subprocess.run([str(env_python_path), "-c", script], cwd=PROJECT_ROOT, check=True, capture_output=True, text=True)
    except subprocess.CalledProcessError:
        return False
    payload = json.loads(result.stdout)
    return bool(payload.get("cuda"))


def _flash_attn_installed(env_python_path: Path) -> bool:
    return _installed_version(env_python_path, "flash_attn") is not None


def _recreate_env(env_dir: Path, env: dict[str, str]) -> None:
    if env_dir.exists():
        shutil.rmtree(env_dir, ignore_errors=True)
    run(["uv", "sync", "--group", "dev", "--inexact"], env=env)


def _ensure_package(env_python_path: Path, env: dict[str, str], package_spec: str, *, index_url: str | None = None) -> None:
    if _runtime_matches(env_python_path, package_spec):
        return
    package_name, _ = _parse_requirement(package_spec)
    uninstall_if_present(env_python_path, package_name)
    cmd = ["uv", "pip", "install", "--python", str(env_python_path)]
    if index_url:
        cmd.extend(["--index-url", index_url])
    cmd.append(package_spec)
    run(cmd, env=env)


def ensure_env(args: argparse.Namespace) -> Path:
    ensure_nvidia_gpu_available()
    env_dir = PROJECT_ROOT / GPU_ENV_NAME
    env = os.environ.copy()
    env.pop("VIRTUAL_ENV", None)
    env["UV_PROJECT_ENVIRONMENT"] = str(env_dir)
    env.setdefault("UV_CACHE_DIR", str(LOCAL_UV_CACHE_DIR))
    env.setdefault("UV_LINK_MODE", "copy")
    env.setdefault("HF_HUB_DISABLE_XET", "1")
    env.setdefault("PYTHONIOENCODING", "utf-8")

    try:
        run(["uv", "sync", "--group", "dev", "--inexact"], env=env)
    except subprocess.CalledProcessError:
        print("[katib] Recreating managed GPU environment after sync failure.")
        _recreate_env(env_dir, env)

    env_python_path = venv_python(env_dir)
    python_version = _python_version(env_python_path)
    if os.name == "nt" and python_version != "3.11":
        raise SystemExit(f"Katib Windows support is pinned to Python 3.11, but this launcher resolved Python {python_version}.")

    try:
        if not _runtime_matches(env_python_path, args.torch_package) or not _cuda_available(env_python_path):
            uninstall_if_present(env_python_path, "torch")
            uninstall_if_present(env_python_path, "torchvision")
            uninstall_if_present(env_python_path, "flash_attn")
            _ensure_package(env_python_path, env, args.torch_package, index_url=args.gpu_index_url)
        if not _runtime_matches(env_python_path, args.torchvision_package) or not _cuda_available(env_python_path):
            uninstall_if_present(env_python_path, "torchvision")
            _ensure_package(env_python_path, env, args.torchvision_package, index_url=args.gpu_index_url)
    except subprocess.CalledProcessError as error:
        if "METADATA" in str(error) or "RECORD" in str(error):
            print("[katib] Recreating managed GPU environment after corrupted torch metadata.")
            _recreate_env(env_dir, env)
            env_python_path = venv_python(env_dir)
            _ensure_package(env_python_path, env, args.torch_package, index_url=args.gpu_index_url)
            _ensure_package(env_python_path, env, args.torchvision_package, index_url=args.gpu_index_url)
        else:
            raise
    for package_spec in GPU_RUNTIME_PACKAGES:
        _ensure_package(env_python_path, env, package_spec)
    if os.name == "nt" and not _flash_attn_installed(env_python_path):
        try:
            run(["uv", "pip", "install", "--python", str(env_python_path), args.flash_attn_wheel_url], env=env)
        except subprocess.CalledProcessError:
            print("[katib] Flash-Attention wheel install failed; continuing without it.")
    return env_python_path


def ensure_cuda(env_python_path: Path) -> None:
    script = (
        "import json\n"
        "import torch\n"
        "payload = {\n"
        "  'cuda': bool(torch.cuda.is_available()),\n"
        "  'device_name': torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,\n"
        "  'flash_attn': None,\n"
        "}\n"
        "try:\n"
        "  import flash_attn\n"
        "  payload['flash_attn'] = True\n"
        "except Exception:\n"
        "  payload['flash_attn'] = False\n"
        "print(json.dumps(payload))\n"
    )
    result = subprocess.run([str(env_python_path), "-c", script], cwd=PROJECT_ROOT, check=True, capture_output=True, text=True)
    payload = json.loads(result.stdout)
    if not payload.get("cuda"):
        raise SystemExit("Katib requires a CUDA GPU and will not start without one.")
    print(f"[katib] Using GPU: {payload.get('device_name')}")
    print(f"[katib] Flash-Attention active: {payload.get('flash_attn')}")


def parse_positive_int(raw: str | None, default: int) -> int:
    try:
        value = int((raw or "").strip())
    except ValueError:
        return default
    return value if value > 0 else default


def read_owner_watchdog_config(env: dict[str, str] | None = None) -> OwnerWatchdogConfig | None:
    source = env or os.environ
    if source.get("TTS_ANYWHERE_OWNER_MODE", "").strip().lower() != "heartbeat-file":
        return None
    heartbeat_file = source.get("TTS_ANYWHERE_OWNER_HEARTBEAT_FILE", "").strip()
    if not heartbeat_file:
        return None
    return OwnerWatchdogConfig(
        heartbeat_file=Path(heartbeat_file),
        interval_ms=parse_positive_int(source.get("TTS_ANYWHERE_OWNER_HEARTBEAT_INTERVAL_MS"), 2000),
        grace_ms=parse_positive_int(source.get("TTS_ANYWHERE_OWNER_GRACE_MS"), 8000),
    )


def heartbeat_is_stale(config: OwnerWatchdogConfig, now: float | None = None) -> bool:
    try:
        last_updated = config.heartbeat_file.stat().st_mtime
    except FileNotFoundError:
        return True
    current_time = time.time() if now is None else now
    return (current_time - last_updated) * 1000 > config.interval_ms + config.grace_ms


def start_owner_watchdog(child: subprocess.Popen[object], config: OwnerWatchdogConfig | None) -> threading.Event:
    stop_event = threading.Event()
    if config is None:
        return stop_event
    thread = threading.Thread(target=_watch_owner_heartbeat, args=(child, config, stop_event), daemon=True)
    thread.start()
    return stop_event


def _watch_owner_heartbeat(child: subprocess.Popen[object], config: OwnerWatchdogConfig, stop_event: threading.Event) -> None:
    poll_seconds = max(0.5, min(2.0, config.interval_ms / 1000.0))
    while not stop_event.wait(poll_seconds):
        if child.poll() is not None:
            return
        if not heartbeat_is_stale(config):
            continue
        try:
            child.terminate()
        except OSError:
            return
        try:
            child.wait(timeout=max(1.0, config.grace_ms / 1000.0))
        except subprocess.TimeoutExpired:
            try:
                child.kill()
            except OSError:
                return
        return


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    env_python_path = ensure_env(args)
    ensure_cuda(env_python_path)
    if args.prepare_only:
        return

    env = os.environ.copy()
    env.pop("VIRTUAL_ENV", None)
    env.setdefault("UV_CACHE_DIR", str(LOCAL_UV_CACHE_DIR))
    env.setdefault("UV_LINK_MODE", "copy")
    env.setdefault("HF_HOME", str(PROJECT_ROOT / ".hf-cache"))
    env.setdefault("HF_HUB_DISABLE_XET", "1")
    env.setdefault("PYTHONIOENCODING", "utf-8")
    env["PYTHONPATH"] = str(PROJECT_ROOT / "src") + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")

    cmd = [str(env_python_path), "-m", "katib_text_processing.cli", "serve", "--host", args.host, "--port", str(args.port)]
    owner_watchdog = read_owner_watchdog_config(env)
    child: subprocess.Popen[object] | None = None
    stop_event = threading.Event()
    try:
        child = subprocess.Popen(cmd, cwd=PROJECT_ROOT, env=env)
        stop_event = start_owner_watchdog(child, owner_watchdog)
        return_code = child.wait()
        if return_code != 0:
            raise subprocess.CalledProcessError(return_code, cmd)
    except KeyboardInterrupt:
        if child and child.poll() is None:
            child.terminate()
        return
    finally:
        stop_event.set()


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except KeyboardInterrupt:
        raise SystemExit(0)
