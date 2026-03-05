from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import uvicorn

from tts_kokoro_adapter.app import KokoroRuntime, Settings, create_app


def cmd_serve(args: argparse.Namespace) -> int:
    settings = Settings()
    app = create_app(settings)
    uvicorn.run(app, host=args.host, port=args.port or settings.port)
    return 0


def cmd_models(_: argparse.Namespace) -> int:
    print(json.dumps([{"id": "kokoro", "object": "model", "owned_by": "kokoro"}], indent=2))
    return 0


def cmd_voices(_: argparse.Namespace) -> int:
    runtime = KokoroRuntime(Settings())
    voices = runtime.get_available_voices()
    print(json.dumps(voices, indent=2))
    return 0


def cmd_synth(args: argparse.Namespace) -> int:
    settings = Settings()
    runtime = KokoroRuntime(settings)
    voice = args.voice or settings.default_voice
    speed = args.speed if args.speed is not None else settings.default_speed

    wav_bytes = runtime.synth_to_wav(text=args.text, voice=voice, speed=speed)

    target = Path(args.out)
    target.write_bytes(wav_bytes)
    print(f"Wrote WAV: {target}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Kokoro OpenAI-compatible adapter")
    sub = parser.add_subparsers(dest="command", required=True)

    serve = sub.add_parser("serve", help="Start the API server")
    serve.add_argument("--host", default="127.0.0.1", help="Host to bind to")
    serve.add_argument("--port", type=int, default=None, help="Port to bind to (default: 8013)")

    sub.add_parser("models", help="List available models")

    sub.add_parser("voices", help="List available voices")

    synth = sub.add_parser("synth", help="Synthesize text to WAV file")
    synth.add_argument("--text", required=True, help="Text to synthesize")
    synth.add_argument("--out", required=True, help="Output WAV file path")
    synth.add_argument("--voice", required=False, default=None, help="Voice to use (default: af_heart)")
    synth.add_argument("--speed", type=float, required=False, default=None, help="Speech speed (default: 1.0)")

    args = parser.parse_args()
    if args.command == "serve":
        return cmd_serve(args)
    if args.command == "models":
        return cmd_models(args)
    if args.command == "voices":
        return cmd_voices(args)
    if args.command == "synth":
        return cmd_synth(args)

    print(f"Unsupported command: {args.command}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
