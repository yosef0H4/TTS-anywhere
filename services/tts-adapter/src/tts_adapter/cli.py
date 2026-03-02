from __future__ import annotations

import argparse
from pathlib import Path

from tts_adapter.config import AppSettings
from tts_adapter.services.adapter_registry import AdapterRegistry


def run_synth(args: argparse.Namespace) -> int:
    settings = AppSettings()
    registry = AdapterRegistry(settings=settings, allow_cpu=bool(args.allow_cpu))
    adapter = registry.get(args.model)

    wav_bytes = adapter.synthesize(
        args.text,
        speed=args.speed,
        voice=args.voice,
        audio_prompt_path=args.audio_prompt,
    )

    output_path = Path(args.out)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(wav_bytes)
    print(f"Wrote WAV: {output_path}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="TTS Adapter CLI")
    subparsers = parser.add_subparsers(dest="command", required=True)

    synth = subparsers.add_parser("synth", help="Synthesize WAV file")
    synth.add_argument("--text", required=True)
    synth.add_argument("--out", required=True)
    synth.add_argument("--model", default="namaa-saudi-tts")
    synth.add_argument("--voice", default="alloy")
    synth.add_argument("--speed", type=float, default=1.0)
    synth.add_argument("--audio-prompt", default=None)
    synth.add_argument("--allow-cpu", action="store_true")

    args = parser.parse_args()

    if args.command == "synth":
        return run_synth(args)

    raise ValueError(f"Unsupported command: {args.command}")


if __name__ == "__main__":
    raise SystemExit(main())
