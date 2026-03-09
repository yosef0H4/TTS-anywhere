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
    serve.add_argument("--enable-detect", action="store_true", help="Enable Paddle detect-only endpoint")
    serve.add_argument("--enable-openai-ocr", action="store_true", help="Enable OpenAI-compatible OCR adapter endpoint")
    serve.add_argument("--detect-device", default="cpu", choices=["cpu", "gpu"], help="Execution device for detect endpoint")
    serve.add_argument("--ocr-device", default="cpu", choices=["cpu", "gpu"], help="Execution device for OpenAI OCR endpoint")
    serve.add_argument("--detect-model-name", default="PP-OCRv5_mobile_det", help="Paddle detection model name")
    serve.add_argument("--ocr-detection-model-name", default="PP-OCRv5_mobile_det", help="Paddle OCR detection model name")
    serve.add_argument("--ocr-recognition-model-name", default="PP-OCRv5_mobile_rec", help="Paddle OCR recognition model name")
    serve.add_argument("--cpu-threads", type=int, default=4, help="CPU thread count for detection and OCR")
    serve.add_argument("--detect-model-dir", default="", help="Optional local Paddle detection model directory")
    serve.add_argument("--ocr-detection-model-dir", default="", help="Optional local Paddle OCR detection model directory")
    serve.add_argument("--ocr-recognition-model-dir", default="", help="Optional local Paddle OCR recognition model directory")

    return parser.parse_args(argv)


def main() -> None:
    args = parse_args()

    if args.cmd == "serve":
        if not args.enable_detect and not args.enable_openai_ocr:
            raise SystemExit("At least one feature must be enabled: --enable-detect and/or --enable-openai-ocr")

        if args.enable_detect:
            resolve_device(args.detect_device)
        if args.enable_openai_ocr:
            resolve_device(args.ocr_device)

        config = RuntimeConfig(
            enable_detect=args.enable_detect,
            enable_openai_ocr=args.enable_openai_ocr,
            detect_device=args.detect_device,
            ocr_device=args.ocr_device,
            detect_model_name=args.detect_model_name,
            ocr_detection_model_name=args.ocr_detection_model_name,
            ocr_recognition_model_name=args.ocr_recognition_model_name,
            cpu_threads=args.cpu_threads,
            detect_model_dir=args.detect_model_dir.strip() or None,
            ocr_detection_model_dir=args.ocr_detection_model_dir.strip() or None,
            ocr_recognition_model_dir=args.ocr_recognition_model_dir.strip() or None,
        )
        uvicorn.run(create_app(config=config), host=args.host, port=args.port)


if __name__ == "__main__":
    main()
