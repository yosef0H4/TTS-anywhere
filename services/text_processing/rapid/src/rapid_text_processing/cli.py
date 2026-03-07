from __future__ import annotations

import argparse

import uvicorn

from .app import RuntimeConfig, create_app, resolve_execution_provider


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Rapid text processing server")
    sub = parser.add_subparsers(dest="cmd", required=True)

    serve = sub.add_parser("serve", help="Run HTTP server")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8091)
    serve.add_argument("--enable-detect", action="store_true", help="Enable RapidOCR detect-only endpoint")
    serve.add_argument("--enable-openai-ocr", action="store_true", help="Enable OpenAI-compatible OCR adapter endpoint")
    serve.add_argument("--detect-provider", default="auto", choices=["auto", "cpu", "cuda", "dml"], help="Execution provider for detect endpoint")
    serve.add_argument("--ocr-provider", default="auto", choices=["auto", "cpu", "cuda", "dml"], help="Execution provider for OpenAI OCR endpoint")

    return parser.parse_args(argv)


def main() -> None:
    args = parse_args()

    if args.cmd == "serve":
        if not args.enable_detect and not args.enable_openai_ocr:
            raise SystemExit("At least one feature must be enabled: --enable-detect and/or --enable-openai-ocr")

        # Resolve early so explicit GPU requests fail at startup instead of on first request.
        if args.enable_detect:
            resolve_execution_provider(args.detect_provider)
        if args.enable_openai_ocr:
            resolve_execution_provider(args.ocr_provider)

        config = RuntimeConfig(
            enable_detect=args.enable_detect,
            enable_openai_ocr=args.enable_openai_ocr,
            detect_execution_provider=args.detect_provider,
            ocr_execution_provider=args.ocr_provider,
        )
        uvicorn.run(create_app(config=config), host=args.host, port=args.port)


if __name__ == "__main__":
    main()
