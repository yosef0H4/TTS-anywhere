from __future__ import annotations

import argparse
import uvicorn

from .app import create_app


def main() -> None:
    parser = argparse.ArgumentParser(description="Rapid text processing server")
    sub = parser.add_subparsers(dest="cmd", required=True)

    serve = sub.add_parser("serve", help="Run HTTP server")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8091)

    args = parser.parse_args()

    if args.cmd == "serve":
        uvicorn.run(create_app(), host=args.host, port=args.port)


if __name__ == "__main__":
    main()
