from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import uvicorn

from tts_piper_adapter.app import PiperRuntime, Settings, create_app


def cmd_serve(args: argparse.Namespace) -> int:
    app = create_app()
    uvicorn.run(app, host=args.host, port=args.port)
    return 0


def cmd_models(_: argparse.Namespace) -> int:
    runtime = PiperRuntime(Settings())
    print(json.dumps(runtime.known_models(), indent=2))
    return 0


def cmd_synth(args: argparse.Namespace) -> int:
    runtime = PiperRuntime(Settings())
    model = args.model or Settings().piper_default_model
    out = runtime.synth_to_wav(text=args.text, model_id=model)
    target = Path(args.out)
    target.write_bytes(out.read_bytes())
    out.unlink(missing_ok=True)
    print(f"Wrote WAV: {target}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Piper OpenAI-compatible adapter")
    sub = parser.add_subparsers(dest="command", required=True)

    serve = sub.add_parser("serve")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8011)

    sub.add_parser("models")

    synth = sub.add_parser("synth")
    synth.add_argument("--model", required=False, default=None)
    synth.add_argument("--text", required=True)
    synth.add_argument("--out", required=True)

    args = parser.parse_args()
    if args.command == "serve":
        return cmd_serve(args)
    if args.command == "models":
        return cmd_models(args)
    if args.command == "synth":
        return cmd_synth(args)

    print(f"Unsupported command: {args.command}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
