from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from PIL import Image


MODEL_ID = "oddadmix/Katib-Qwen3.5-0.8B-0.1"
MAX_IMAGE_LONG_EDGE = 1280


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Basic Katib OCR usage test")
    parser.add_argument("--image", default=str(Path(__file__).resolve().parents[3] / "test-fixtures" / "ocr" / "arabic-basic.png"))
    parser.add_argument("--prompt", default="Free OCR")
    parser.add_argument("--max-new-tokens", type=int, default=512)
    return parser.parse_args()


def resize_for_ocr(image: Image.Image, max_long_edge: int = MAX_IMAGE_LONG_EDGE) -> Image.Image:
    width, height = image.size
    longest = max(width, height)
    if longest <= max_long_edge:
        return image
    scale = max_long_edge / longest
    return image.resize((max(1, round(width * scale)), max(1, round(height * scale))), Image.Resampling.LANCZOS)


def main() -> None:
    args = parse_args()
    service_root = Path(__file__).resolve().parent
    os.environ.setdefault("HF_HOME", str(service_root / ".hf-cache"))
    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    import torch
    from transformers import AutoModelForImageTextToText, AutoProcessor

    if not torch.cuda.is_available():
        raise SystemExit("Katib basic usage requires CUDA and will not run on CPU.")

    image = resize_for_ocr(Image.open(args.image).convert("RGB"))
    processor = AutoProcessor.from_pretrained(MODEL_ID, trust_remote_code=True)
    model = AutoModelForImageTextToText.from_pretrained(
        MODEL_ID,
        dtype=torch.float16,
        device_map="auto",
        trust_remote_code=True,
    ).eval()

    messages = [{"role": "user", "content": [{"type": "image", "image": image}, {"type": "text", "text": args.prompt}]}]
    inputs = processor.apply_chat_template(
        messages,
        tokenize=True,
        add_generation_prompt=True,
        return_dict=True,
        return_tensors="pt",
    ).to(model.device)
    prompt_length = int(inputs["input_ids"].shape[1])
    with torch.inference_mode():
        output = model.generate(
            **inputs,
            max_new_tokens=args.max_new_tokens,
            do_sample=False,
            use_cache=True,
            pad_token_id=processor.tokenizer.eos_token_id,
        )
    text = processor.batch_decode([output[0][prompt_length:]], skip_special_tokens=True, clean_up_tokenization_spaces=False)[0].strip()
    print(text)


if __name__ == "__main__":
    main()
