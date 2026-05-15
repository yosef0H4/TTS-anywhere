from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent
TORCH_CUDA_INDEX_URL = "https://download.pytorch.org/whl/cu129"
CPU_ONNXRUNTIME_PACKAGE = "onnxruntime>=1.24.2"
GPU_ONNXRUNTIME_PACKAGE = "onnxruntime-gpu>=1.24.2"
GPU_TORCH_PACKAGE = "torch==2.8.0"
LOCAL_UV_CACHE_DIR = Path(tempfile.gettempdir()) / "tts-electron-rapid-uv-cache" if os.name == "nt" else PROJECT_ROOT / ".cache" / "uv"


@dataclass(frozen=True)
class OwnerWatchdogConfig:
    heartbeat_file: Path
    interval_ms: int
    grace_ms: int


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
        main()
    except KeyboardInterrupt:
        raise SystemExit(0)
