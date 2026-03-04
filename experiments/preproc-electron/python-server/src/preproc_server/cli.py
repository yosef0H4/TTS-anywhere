from __future__ import annotations

import argparse
import uvicorn


def main() -> None:
    parser = argparse.ArgumentParser(description="Run preprocessing RapidOCR API server")
    sub = parser.add_subparsers(dest="command", required=True)

    serve = sub.add_parser("serve", help="Run FastAPI server")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8091)

    args = parser.parse_args()

    if args.command == "serve":
      uvicorn.run("preproc_server.app:create_app", host=args.host, port=args.port, factory=True)


if __name__ == "__main__":
    main()
