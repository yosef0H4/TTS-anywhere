from __future__ import annotations

import argparse
import os
from pathlib import Path

from supertonic import TTS


DEFAULT_TEXT = "إِنَّ الْعِلْمَ نُورٌ."


def main() -> int:
    parser = argparse.ArgumentParser(description="Basic Supertonic TTS smoke test")
    parser.add_argument("--text", default=DEFAULT_TEXT)
    parser.add_argument("--out", default="test-results/supertonic-basic.wav")
    parser.add_argument("--runtime", choices=["cpu", "gpu"], default=os.environ.get("SUPERTONIC_RUNTIME", "cpu"))
    parser.add_argument("--voice", default="M1")
    args = parser.parse_args()

    if args.runtime == "gpu":
        import onnxruntime as ort
        import supertonic.config as supertonic_config
        import supertonic.loader as supertonic_loader

        providers = ort.get_available_providers()
        provider = "DmlExecutionProvider" if "DmlExecutionProvider" in providers else "CUDAExecutionProvider"
        if provider not in providers:
            raise SystemExit(f"GPU provider unavailable: {providers}")
        supertonic_config.DEFAULT_ONNX_PROVIDERS = [provider]
        supertonic_loader.DEFAULT_ONNX_PROVIDERS = [provider]

    tts = TTS(auto_download=True)
    style = tts.get_voice_style(voice_name=args.voice)
    wav, _duration = tts.synthesize(args.text, voice_style=style, lang="ar")
    target = Path(args.out)
    target.parent.mkdir(parents=True, exist_ok=True)
    tts.save_audio(wav, str(target))
    print(f"Wrote WAV: {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
