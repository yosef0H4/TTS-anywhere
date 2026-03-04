from __future__ import annotations

import argparse
from pathlib import Path

import uvicorn

from .app import create_app


def parse_args() -> argparse.Namespace:
  parser = argparse.ArgumentParser(prog="openai-mitm-proxy")
  sub = parser.add_subparsers(dest="command", required=True)

  serve = sub.add_parser("serve", help="Run MITM proxy server")
  serve.add_argument("--host", default="127.0.0.1")
  serve.add_argument("--port", type=int, default=8109)
  serve.add_argument("--upstream", default="https://api.openai.com", help="Upstream API root without /v1 suffix")
  serve.add_argument("--api-key", default="", help="Bearer API key for upstream; if empty, pass through incoming auth")
  serve.add_argument("--out-dir", default=".mitm-logs/openai", help="Directory for logs + saved images")
  serve.add_argument("--timeout", type=float, default=120.0)

  return parser.parse_args()


def main() -> None:
  args = parse_args()
  if args.command == "serve":
    app = create_app(
      upstream=args.upstream,
      api_key=args.api_key,
      out_dir=Path(args.out_dir),
      timeout_s=args.timeout,
    )
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
  main()
