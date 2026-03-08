from __future__ import annotations

import argparse
import os
import subprocess
import sys
import tempfile
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent
CPU_ENV_NAME = ".venv-cpu"
GPU_ENV_NAME = ".venv-gpu"
CPU_PADDLE_PACKAGE = "paddlepaddle==3.2.0"
GPU_PADDLE_PACKAGE = "paddlepaddle-gpu==3.3.0"
DEFAULT_GPU_INDEX_URL = "https://www.paddlepaddle.org.cn/packages/stable/cu129/"
LOCAL_UV_CACHE_DIR = (
    Path(tempfile.gettempdir()) / "tts-electron-paddle-uv-cache"
    if os.name == "nt"
    else PROJECT_ROOT / ".cache" / "uv"
)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Paddle service launcher with uv-managed CPU/GPU environments")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8093)
    parser.add_argument("--enable-detect", action="store_true")
    parser.add_argument("--enable-openai-ocr", action="store_true")
    parser.add_argument("--detect-device", default="auto", choices=["auto", "cpu", "gpu"])
    parser.add_argument("--ocr-device", default="auto", choices=["auto", "cpu", "gpu"])
    parser.add_argument("--detect-model-name", default="PP-OCRv5_mobile_det")
    parser.add_argument("--ocr-detection-model-name", default="PP-OCRv5_mobile_det")
    parser.add_argument("--ocr-recognition-model-name", default="PP-OCRv5_mobile_rec")
    parser.add_argument("--cpu-threads", type=int, default=4)
    parser.add_argument("--detect-model-dir", default="")
    parser.add_argument("--ocr-detection-model-dir", default="")
    parser.add_argument("--ocr-recognition-model-dir", default="")
    parser.add_argument("--gpu-package", default=os.environ.get("PADDLE_GPU_PACKAGE", GPU_PADDLE_PACKAGE))
    parser.add_argument("--gpu-index-url", default=os.environ.get("PADDLE_GPU_INDEX_URL", DEFAULT_GPU_INDEX_URL))
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
    requested = {
        args.detect_device if args.enable_detect else "cpu",
        args.ocr_device if args.enable_openai_ocr else "cpu",
    }
    needs_gpu_env = any(device in {"auto", "gpu"} for device in requested)
    env_name = GPU_ENV_NAME if needs_gpu_env else CPU_ENV_NAME
    return PROJECT_ROOT / env_name, needs_gpu_env


def ensure_env(args: argparse.Namespace) -> Path:
    env_dir, needs_gpu_env = choose_env(args)
    env = os.environ.copy()
    env["UV_PROJECT_ENVIRONMENT"] = str(env_dir)
    env.setdefault("UV_CACHE_DIR", str(LOCAL_UV_CACHE_DIR))
    env.setdefault("UV_LINK_MODE", "copy")

    run(["uv", "sync", "--group", "dev"], env=env)

    env_python_path = venv_python(env_dir)
    uninstall_if_present(env_python_path, "paddlepaddle")
    uninstall_if_present(env_python_path, "paddlepaddle-gpu")

    if needs_gpu_env:
        run(
            [
                "uv",
                "pip",
                "install",
                "--python",
                str(env_python_path),
                "--index-url",
                args.gpu_index_url.strip(),
                args.gpu_package,
            ],
            env=env,
        )
    else:
        run(["uv", "pip", "install", "--python", str(env_python_path), CPU_PADDLE_PACKAGE], env=env)

    return env_python_path


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    if not args.enable_detect and not args.enable_openai_ocr:
        raise SystemExit("At least one feature must be enabled: --enable-detect and/or --enable-openai-ocr")

    env_python_path = ensure_env(args)

    cmd = [
        str(env_python_path),
        "-m",
        "paddle_text_processing.cli",
        "serve",
        "--host",
        args.host,
        "--port",
        str(args.port),
        "--detect-device",
        args.detect_device,
        "--ocr-device",
        args.ocr_device,
        "--detect-model-name",
        args.detect_model_name,
        "--ocr-detection-model-name",
        args.ocr_detection_model_name,
        "--ocr-recognition-model-name",
        args.ocr_recognition_model_name,
        "--cpu-threads",
        str(args.cpu_threads),
    ]
    if args.detect_model_dir.strip():
        cmd.extend(["--detect-model-dir", args.detect_model_dir.strip()])
    if args.ocr_detection_model_dir.strip():
        cmd.extend(["--ocr-detection-model-dir", args.ocr_detection_model_dir.strip()])
    if args.ocr_recognition_model_dir.strip():
        cmd.extend(["--ocr-recognition-model-dir", args.ocr_recognition_model_dir.strip()])
    if args.enable_detect:
        cmd.append("--enable-detect")
    if args.enable_openai_ocr:
        cmd.append("--enable-openai-ocr")

    env = os.environ.copy()
    env.setdefault("UV_CACHE_DIR", str(LOCAL_UV_CACHE_DIR))
    env.setdefault("UV_LINK_MODE", "copy")
    env.setdefault("PADDLE_PDX_CACHE_HOME", str(PROJECT_ROOT / ".paddlex-cache"))
    env.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
    env.setdefault("PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT", "False")
    env["PYTHONPATH"] = str(PROJECT_ROOT / "src") + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
    if os.name != "nt":
        env.setdefault("HOME", str(PROJECT_ROOT))

    try:
        subprocess.run(cmd, cwd=PROJECT_ROOT, env=env, check=True)
    except KeyboardInterrupt:
        # Treat Ctrl+C from the console as a normal shutdown path.
        return


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except KeyboardInterrupt:
        raise SystemExit(0)
