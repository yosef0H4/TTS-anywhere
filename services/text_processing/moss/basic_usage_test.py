from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path


DEFAULT_MODEL_PATH = Path(__file__).resolve().parent / ".hf-cache" / "models--PatSnap--Hiro-MOSS-OCR-0.3B"
DEFAULT_IMAGE_PATH = Path(__file__).resolve().parents[3] / "test-fixtures" / "ocr" / "english-basic.png"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Basic Hiro-MOSS-OCR smoke test")
    parser.add_argument("--model-path", default=str(DEFAULT_MODEL_PATH))
    parser.add_argument("--image", default=str(DEFAULT_IMAGE_PATH))
    parser.add_argument("--task", choices=["text", "math", "table"], default="text")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    os.environ.setdefault("HF_HOME", str(Path(__file__).resolve().parent / ".hf-cache"))
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    import torch
    from transformers import AutoModelForCausalLM

    if not torch.cuda.is_available():
        raise SystemExit("Hiro-MOSS-OCR basic usage requires CUDA and will not run on CPU.")

    model = AutoModelForCausalLM.from_pretrained(
        args.model_path,
        trust_remote_code=True,
        dtype=torch.bfloat16,
        device_map={"": 0},
    ).eval()
    with torch.inference_mode():
        texts = model.generate(args.image, task=args.task)
    print((texts[0] if texts else "").strip())


if __name__ == "__main__":
    main()
