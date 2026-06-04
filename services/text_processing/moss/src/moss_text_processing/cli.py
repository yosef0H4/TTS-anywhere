from __future__ import annotations

import argparse
import os
from pathlib import Path

import uvicorn

SERVICE_ROOT = Path(__file__).resolve().parents[2]
os.environ.setdefault("HF_HOME", str(SERVICE_ROOT / ".hf-cache"))
os.environ.setdefault("PYTHONIOENCODING", "utf-8")

from .app import DEFAULT_LOCAL_MODEL_PATH, RuntimeConfig, create_app


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Hiro-MOSS-OCR server")
    sub = parser.add_subparsers(dest="cmd", required=True)
    serve = sub.add_parser("serve", help="Run HTTP server")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8098)
    serve.add_argument("--model-id", default="PatSnap/Hiro-MOSS-OCR-0.3B")
    serve.add_argument("--model-path", default=str(DEFAULT_LOCAL_MODEL_PATH))
    serve.add_argument("--prompt", default="Extract all text from this image. Return only the extracted text.")
    serve.add_argument("--max-new-tokens", type=int, default=1024)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    if args.cmd == "serve":
        config = RuntimeConfig(
            model_id=args.model_id,
            model_path=args.model_path,
            default_prompt=args.prompt,
            max_new_tokens=args.max_new_tokens,
        )
        uvicorn.run(create_app(config=config), host=args.host, port=args.port)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        raise SystemExit(0)
