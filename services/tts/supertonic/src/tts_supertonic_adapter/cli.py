from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path

import uvicorn

from tts_supertonic_adapter.app import DEFAULT_VOICE_ID, SUPERTONIC_MODEL_ID, Settings, SupertonicRuntime, create_app


@dataclass(frozen=True)
class OwnerCfg:
    hb: Path
    interval_ms: int
    grace_ms: int


def parse_pos_int(raw: str | None, default: int) -> int:
    try:
        value = int((raw or "").strip())
    except ValueError:
        return default
    return value if value > 0 else default


def read_owner_cfg(env: dict[str, str] | None = None) -> OwnerCfg | None:
    source = env or os.environ
    if source.get("TTS_ANYWHERE_OWNER_MODE", "").strip().lower() != "heartbeat-file":
        return None
    hb = source.get("TTS_ANYWHERE_OWNER_HEARTBEAT_FILE", "").strip()
    if not hb:
        return None
    return OwnerCfg(
        hb=Path(hb),
        interval_ms=parse_pos_int(source.get("TTS_ANYWHERE_OWNER_HEARTBEAT_INTERVAL_MS"), 2000),
        grace_ms=parse_pos_int(source.get("TTS_ANYWHERE_OWNER_GRACE_MS"), 8000),
    )


def hb_stale(cfg: OwnerCfg, now: float | None = None) -> bool:
    try:
        last = cfg.hb.stat().st_mtime
    except FileNotFoundError:
        return True
    current = time.time() if now is None else now
    return (current - last) * 1000 > cfg.interval_ms + cfg.grace_ms


def start_owner_watchdog(server: uvicorn.Server, cfg: OwnerCfg | None) -> threading.Event:
    stop = threading.Event()
    if cfg is None:
        return stop
    thread = threading.Thread(target=_watch_owner, args=(server, cfg, stop), daemon=True)
    thread.start()
    return stop


def _watch_owner(server: uvicorn.Server, cfg: OwnerCfg, stop: threading.Event) -> None:
    poll = max(0.5, min(2.0, cfg.interval_ms / 1000.0))
    while not stop.wait(poll):
        if server.should_exit:
            return
        if hb_stale(cfg):
            server.should_exit = True
            return


def run_server(app: object, host: str, port: int) -> None:
    server = uvicorn.Server(uvicorn.Config(app, host=host, port=port))
    stop = start_owner_watchdog(server, read_owner_cfg())
    try:
        server.run()
    finally:
        stop.set()


def cmd_serve(args: argparse.Namespace) -> int:
    os.environ["SUPERTONIC_RUNTIME"] = args.runtime
    settings = Settings()
    app = create_app(settings)
    run_server(app, args.host, args.port or settings.port)
    return 0


def cmd_models(_: argparse.Namespace) -> int:
    print(json.dumps([{"id": SUPERTONIC_MODEL_ID, "object": "model", "owned_by": "Supertone"}], indent=2))
    return 0


def cmd_voices(_: argparse.Namespace) -> int:
    print(json.dumps([DEFAULT_VOICE_ID], indent=2))
    return 0


def cmd_synth(args: argparse.Namespace) -> int:
    os.environ["SUPERTONIC_RUNTIME"] = args.runtime
    runtime = SupertonicRuntime(Settings())
    wav_bytes = runtime.synth_to_wav(text=args.text, voice=args.voice, speed=args.speed)
    target = Path(args.out)
    target.write_bytes(wav_bytes)
    print(f"Wrote WAV: {target}")
    return 0


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s:%(name)s:%(message)s")
    parser = argparse.ArgumentParser(description="Supertonic OpenAI-compatible adapter")
    sub = parser.add_subparsers(dest="command", required=True)

    serve = sub.add_parser("serve", help="Start the API server")
    serve.add_argument("--host", default="127.0.0.1", help="Host to bind to")
    serve.add_argument("--port", type=int, default=None, help="Port to bind to")
    serve.add_argument("--runtime", choices=["cpu", "gpu"], default=os.environ.get("SUPERTONIC_RUNTIME", "cpu"))

    sub.add_parser("models", help="List available models")
    sub.add_parser("voices", help="List available voices")

    synth = sub.add_parser("synth", help="Synthesize text to WAV file")
    synth.add_argument("--text", required=True, help="Text to synthesize")
    synth.add_argument("--out", required=True, help="Output WAV file path")
    synth.add_argument("--voice", required=False, default=None, help="Voice to use")
    synth.add_argument("--speed", type=float, required=False, default=None, help="Speech speed")
    synth.add_argument("--runtime", choices=["cpu", "gpu"], default=os.environ.get("SUPERTONIC_RUNTIME", "cpu"))

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
