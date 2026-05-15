from __future__ import annotations

import argparse
import os
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent
ENV_NAME = ".venv"
LOCAL_UV_CACHE_DIR = Path(tempfile.gettempdir()) / "tts-electron-windows-ocr-uv-cache" if os.name == "nt" else PROJECT_ROOT / ".cache" / "uv"


@dataclass(frozen=True)
class OwnerWatchdogConfig:
    heartbeat_file: Path
    interval_ms: int
    grace_ms: int


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
