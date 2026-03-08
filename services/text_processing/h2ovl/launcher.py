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
GPU_ENV_NAME = ".venv-gpu"
TORCH_CUDA_INDEX_URL = "https://download.pytorch.org/whl/cu129"
GPU_TORCH_PACKAGE = "torch==2.8.0"
GPU_TORCHVISION_PACKAGE = "torchvision==0.23.0"
GPU_RUNTIME_PACKAGES = [
    "transformers==4.57.3",
    "accelerate==1.12.0",
    "timm==1.0.24",
    "peft==0.18.1",
]
FLASH_ATTN_WHEEL_URL = (
    "https://huggingface.co/ussoewwin/Flash-Attention-2_for_Windows/resolve/main/"
    "flash_attn-2.8.2+cu129torch2.8.0cxx11abiTRUE-cp311-cp311-win_amd64.whl"
)
LOCAL_UV_CACHE_DIR = (
    Path(tempfile.gettempdir()) / "tts-electron-h2ovl-uv-cache"
    if os.name == "nt"
    else PROJECT_ROOT / ".cache" / "uv"
)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="H2OVL Mississippi GPU-only launcher")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8095)
    parser.add_argument("--gpu-index-url", default=os.environ.get("H2OVL_GPU_INDEX_URL", TORCH_CUDA_INDEX_URL))
    parser.add_argument("--torch-package", default=os.environ.get("H2OVL_TORCH_PACKAGE", GPU_TORCH_PACKAGE))
    parser.add_argument("--torchvision-package", default=os.environ.get("H2OVL_TORCHVISION_PACKAGE", GPU_TORCHVISION_PACKAGE))
    parser.add_argument("--flash-attn-wheel-url", default=os.environ.get("H2OVL_FLASH_ATTN_WHEEL_URL", FLASH_ATTN_WHEEL_URL))
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
    script = (
        "import json\n"
        "import torch\n"
        "print(json.dumps({'cuda': bool(torch.cuda.is_available())}))\n"
    )
    try:
        result = subprocess.run(
            [str(env_python_path), "-c", script],
            cwd=PROJECT_ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
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
    env_dir = PROJECT_ROOT / GPU_ENV_NAME
    env = os.environ.copy()
    env["UV_PROJECT_ENVIRONMENT"] = str(env_dir)
    env.setdefault("UV_CACHE_DIR", str(LOCAL_UV_CACHE_DIR))
    env.setdefault("UV_LINK_MODE", "copy")

    try:
        run(["uv", "sync", "--group", "dev", "--inexact"], env=env)
    except subprocess.CalledProcessError:
        print("[h2ovl] Recreating managed GPU environment after sync failure.")
        _recreate_env(env_dir, env)

    env_python_path = venv_python(env_dir)
    python_version = _python_version(env_python_path)
    if os.name == "nt" and python_version != "3.11":
        raise SystemExit(f"H2OVL Windows support is pinned to Python 3.11, but this launcher resolved Python {python_version}.")

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
            print("[h2ovl] Recreating managed GPU environment after corrupted torch metadata.")
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
            run(
                [
                    "uv",
                    "pip",
                    "install",
                    "--python",
                    str(env_python_path),
                    args.flash_attn_wheel_url,
                ],
                env=env,
            )
        except subprocess.CalledProcessError:
            print("[h2ovl] Flash-Attention wheel install failed; falling back to SDPA.")
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
    result = subprocess.run(
        [str(env_python_path), "-c", script],
        cwd=PROJECT_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    payload = json.loads(result.stdout)
    if not payload.get("cuda"):
        raise SystemExit("H2OVL requires a CUDA GPU and will not start without one.")
    print(f"[h2ovl] Using GPU: {payload.get('device_name')}")
    print(f"[h2ovl] Flash-Attention active: {payload.get('flash_attn')}")


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    env_python_path = ensure_env(args)
    ensure_cuda(env_python_path)

    env = os.environ.copy()
    env.setdefault("UV_CACHE_DIR", str(LOCAL_UV_CACHE_DIR))
    env.setdefault("UV_LINK_MODE", "copy")
    env.setdefault("HF_HOME", str(PROJECT_ROOT / ".hf-cache"))
    env["PYTHONPATH"] = str(PROJECT_ROOT / "src") + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")

    cmd = [
        str(env_python_path),
        "-m",
        "h2ovl_text_processing.cli",
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
