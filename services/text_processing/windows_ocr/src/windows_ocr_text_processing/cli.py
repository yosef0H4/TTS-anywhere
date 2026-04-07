from __future__ import annotations

import argparse
import uvicorn

from .app import RuntimeConfig, create_app


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Windows OCR text processing server")
    sub = parser.add_subparsers(dest="cmd", required=True)

    serve = sub.add_parser("serve", help="Run HTTP server")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8097)
    serve.add_argument("--language", default="", help="Optional OCR language tag, for example en-US")
    serve.add_argument("--max-new-tokens", type=int, default=2048)

    return parser.parse_args(argv)


def main() -> None:
    args = parse_args()
    if args.cmd == "serve":
        config = RuntimeConfig(
            language_tag=args.language.strip() or None,
            max_new_tokens=args.max_new_tokens,
        )
        uvicorn.run(create_app(config=config), host=args.host, port=args.port)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        raise SystemExit(0)
