from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

import uvicorn

from tts_edge_adapter.app import EdgeRuntime, Settings, create_app


def cmd_serve(args: argparse.Namespace) -> int:
    app = create_app()
    uvicorn.run(app, host=args.host, port=args.port)
    return 0


async def cmd_models_async(_: argparse.Namespace) -> int:
    runtime = EdgeRuntime(Settings())
    voices = await runtime.list_voices()
    print(json.dumps(voices, indent=2))
    return 0


async def cmd_synth_async(args: argparse.Namespace) -> int:
    cfg = Settings()
    runtime = EdgeRuntime(cfg)
    voice = args.voice or cfg.edge_default_voice
    out = await runtime.synth_to_mp3(text=args.text, voice=voice)
    target = Path(args.out)
    target.write_bytes(out.read_bytes())
    out.unlink(missing_ok=True)
    print(f"Wrote MP3: {target}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Edge TTS OpenAI-compatible adapter")
    sub = parser.add_subparsers(dest="command", required=True)

    serve = sub.add_parser("serve")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8012)

    sub.add_parser("models")

    synth = sub.add_parser("synth")
    synth.add_argument("--text", required=True)
    synth.add_argument("--out", required=True)
    synth.add_argument("--voice", default=None)

    args = parser.parse_args()

    if args.command == "serve":
        return cmd_serve(args)
    if args.command == "models":
        return asyncio.run(cmd_models_async(args))
    if args.command == "synth":
        return asyncio.run(cmd_synth_async(args))

    print(f"Unsupported command: {args.command}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
