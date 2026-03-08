from __future__ import annotations

import argparse
import os
from pathlib import Path

import uvicorn

SERVICE_ROOT = Path(__file__).resolve().parents[2]
os.environ.setdefault("PADDLE_PDX_CACHE_HOME", str(SERVICE_ROOT / ".paddlex-cache"))
os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
os.environ.setdefault("PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT", "False")

from .app import RuntimeConfig, create_app, resolve_device


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Paddle text processing server")
    sub = parser.add_subparsers(dest="cmd", required=True)

    serve = sub.add_parser("serve", help="Run HTTP server")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8093)
    serve.add_argument("--device", default="auto", choices=["auto", "cpu", "gpu"], help="Execution device for Paddle detection")
    serve.add_argument("--model-name", default="PP-OCRv5_mobile_det", help="Paddle detection model name")
    serve.add_argument("--cpu-threads", type=int, default=4, help="CPU thread count for detection")
    serve.add_argument("--det-model-dir", default="", help="Optional local Paddle detection model directory")

    return parser.parse_args(argv)


def main() -> None:
    args = parse_args()

    if args.cmd == "serve":
        resolve_device(args.device)
        config = RuntimeConfig(
            device=args.device,
            model_name=args.model_name,
            det_model_dir=args.det_model_dir.strip() or None,
            cpu_threads=args.cpu_threads,
        )
        uvicorn.run(create_app(config=config), host=args.host, port=args.port)


if __name__ == "__main__":
    main()
