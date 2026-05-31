from __future__ import annotations

import argparse
import json
import sys

import uvicorn

from .app import Settings, WindowsNaturalRuntime, create_app
from .probe import run_probe
from .runtime_handoff import analyze_runtime_handoff


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Windows natural voice OpenAI-compatible adapter")
    sub = parser.add_subparsers(dest="command", required=True)

    serve = sub.add_parser("serve")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8016)

    sub.add_parser("voices")
    sub.add_parser("models")
    sub.add_parser("probe")
    sub.add_parser("handoff")

    synth = sub.add_parser("synth")
    synth.add_argument("--text", required=True)
    synth.add_argument("--out", required=True)
    synth.add_argument("--voice", required=True)

    return parser.parse_args(argv)


def main() -> int:
    args = parse_args()
    runtime = WindowsNaturalRuntime(Settings())
    if args.command == "serve":
        uvicorn.run(create_app(settings=Settings(), runtime=runtime), host=args.host, port=args.port)
        return 0
    if args.command == "voices":
        print(json.dumps(runtime.list_voices(), indent=2))
        return 0
    if args.command == "models":
        print(json.dumps(runtime.models_payload(), indent=2))
        return 0
    if args.command == "probe":
        print(json.dumps(run_probe(), indent=2))
        return 0
    if args.command == "handoff":
        print(json.dumps(analyze_runtime_handoff(), indent=2))
        return 0
    if args.command == "synth":
        wav = runtime.synth_to_wav_bytes(args.text, args.voice)
        with open(args.out, "wb") as handle:
            handle.write(wav)
        return 0
    print(f"Unsupported command: {args.command}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
