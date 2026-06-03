from __future__ import annotations

import argparse
import os
from pathlib import Path

import uvicorn

SERVICE_ROOT = Path(__file__).resolve().parents[2]
os.environ.setdefault("HF_HOME", str(SERVICE_ROOT / ".hf-cache"))

from .app import DEFAULT_MODEL_ID, RuntimeConfig, create_app


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Katib Arabic OCR server")
    sub = parser.add_subparsers(dest="cmd", required=True)

    serve = sub.add_parser("serve", help="Run HTTP server")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8096)
    serve.add_argument("--model-id", default=DEFAULT_MODEL_ID)
    serve.add_argument("--cache-dir", default="", help="Optional Hugging Face cache directory")
    serve.add_argument("--prompt", default="Free OCR")
    serve.add_argument("--max-new-tokens", type=int, default=2048)

    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    if args.cmd == "serve":
        config = RuntimeConfig(
            model_id=args.model_id,
            hf_cache_dir=args.cache_dir.strip() or None,
            default_prompt=args.prompt,
            max_new_tokens=args.max_new_tokens,
        )
        uvicorn.run(create_app(config=config), host=args.host, port=args.port)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        raise SystemExit(0)
