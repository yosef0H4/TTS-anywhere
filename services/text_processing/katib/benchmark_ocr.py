from __future__ import annotations

import argparse
import json
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont


MODEL_ID = "oddadmix/Katib-Qwen3.5-0.8B-0.1"
PROMPT = "Free OCR"
TARGETS = {
    "arabic-basic": ["اختبار", "العربية", "الاجتماع"],
    "english-basic": ["quick", "Invoice", "09:30"],
    "english-degraded": ["quick", "Invoice", "09:30"],
    "arabic-degraded": ["اختبار", "العربية", "الاجتماع"],
    "english-screenshot-card": ["Practical", "Katib", "Transformers"],
}


@dataclass(frozen=True)
class CaseResult:
    image: str
    long_edge: int
    prompt_tokens: int
    new_tokens: int
    seconds: float
    matched: int
    expected: int
    text: str


def parse_args() -> argparse.Namespace:
    root = Path(__file__).resolve().parents[3]
    parser = argparse.ArgumentParser(description="Benchmark Katib OCR speed/quality by image resize cap")
    parser.add_argument("--fixtures-dir", default=str(root / "test-fixtures" / "ocr"))
    parser.add_argument("--long-edges", default="640,896,1024,1280")
    parser.add_argument("--max-new-tokens", type=int, default=192)
    parser.add_argument("--output", default=str(root / "test-results" / "katib-benchmark.json"))
    return parser.parse_args()


def configure_env() -> None:
    service_root = Path(__file__).resolve().parent
    os.environ.setdefault("HF_HOME", str(service_root / ".hf-cache"))
    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")


def load_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        "C:/Windows/Fonts/arial.ttf",
        "C:/Windows/Fonts/segoeui.ttf",
        "C:/Windows/Fonts/tahoma.ttf",
    ]
    for candidate in candidates:
        if Path(candidate).exists():
            return ImageFont.truetype(candidate, size)
    return ImageFont.load_default()


def ensure_degraded_fixtures(fixtures_dir: Path) -> None:
    variants = [
        ("english-basic.png", "english-degraded.png"),
        ("arabic-basic.png", "arabic-degraded.png"),
    ]
    for source_name, target_name in variants:
        target = fixtures_dir / target_name
        if target.exists():
            continue
        image = Image.open(fixtures_dir / source_name).convert("RGB")
        image = image.resize((round(image.width * 0.72), round(image.height * 0.72)), Image.Resampling.BICUBIC)
        image = image.filter(ImageFilter.GaussianBlur(radius=0.65))
        draw = ImageDraw.Draw(image)
        font = load_font(10)
        for y in range(0, image.height, 18):
            draw.line((0, y, image.width, y), fill=(235, 235, 235), width=1)
        draw.text((image.width - 116, image.height - 18), "slight blur", fill=(130, 130, 130), font=font)
        image.save(target)

    screenshot_card_path = fixtures_dir / "english-screenshot-card.png"
    if not screenshot_card_path.exists():
        image = Image.new("RGB", (1920, 1080), (34, 31, 28))
        draw = ImageDraw.Draw(image)
        title_font = load_font(30)
        body_font = load_font(22)
        draw.rounded_rectangle((96, 420, 900, 560), radius=12, fill=(0, 0, 0))
        draw.text((130, 455), "Practical recommendation", fill=(255, 255, 255), font=title_font)
        draw.text(
            (130, 500),
            "For Katib specifically, use its documented Unsloth or Transformers path.",
            fill=(238, 238, 238),
            font=body_font,
        )
        draw.rectangle((1880, 20, 1890, 1060), fill=(78, 65, 57))
        image.save(screenshot_card_path)


def resize_for_ocr(image: Image.Image, long_edge: int) -> Image.Image:
    longest = max(image.size)
    if longest <= long_edge:
        return image
    scale = long_edge / longest
    return image.resize((max(1, round(image.width * scale)), max(1, round(image.height * scale))), Image.Resampling.LANCZOS)


def run_case(processor: object, model: object, torch: object, image_path: Path, long_edge: int, max_new_tokens: int) -> CaseResult:
    image = resize_for_ocr(Image.open(image_path).convert("RGB"), long_edge)
    messages = [{"role": "user", "content": [{"type": "image", "image": image}, {"type": "text", "text": PROMPT}]}]
    inputs = processor.apply_chat_template(
        messages,
        tokenize=True,
        add_generation_prompt=True,
        return_dict=True,
        return_tensors="pt",
    ).to(model.device)
    prompt_tokens = int(inputs["input_ids"].shape[1])
    start = time.perf_counter()
    with torch.inference_mode():
        output = model.generate(
            **inputs,
            max_new_tokens=max_new_tokens,
            do_sample=False,
            use_cache=True,
            pad_token_id=processor.tokenizer.eos_token_id,
        )
    seconds = time.perf_counter() - start
    new_tokens = int(output.shape[1] - prompt_tokens)
    text = processor.batch_decode([output[0][prompt_tokens:]], skip_special_tokens=True, clean_up_tokenization_spaces=False)[0].strip()
    expected = TARGETS.get(image_path.stem, [])
    matched = sum(1 for term in expected if term.casefold() in text.casefold())
    return CaseResult(image_path.name, long_edge, prompt_tokens, new_tokens, seconds, matched, len(expected), text)


def main() -> None:
    args = parse_args()
    configure_env()
    fixtures_dir = Path(args.fixtures_dir)
    ensure_degraded_fixtures(fixtures_dir)

    import torch
    from transformers import AutoModelForImageTextToText, AutoProcessor

    if not torch.cuda.is_available():
        raise SystemExit("Katib benchmark requires CUDA and will not run on CPU.")

    processor = AutoProcessor.from_pretrained(MODEL_ID, trust_remote_code=True)
    model = AutoModelForImageTextToText.from_pretrained(MODEL_ID, dtype=torch.float16, device_map="auto", trust_remote_code=True).eval()

    long_edges = [int(part.strip()) for part in args.long_edges.split(",") if part.strip()]
    results: list[CaseResult] = []
    for long_edge in long_edges:
        for image_path in sorted(fixtures_dir.glob("*.png")):
            if image_path.stem not in TARGETS:
                continue
            result = run_case(processor, model, torch, image_path, long_edge, args.max_new_tokens)
            results.append(result)
            print(
                f"{result.image} edge={result.long_edge} tokens={result.prompt_tokens}+{result.new_tokens} "
                f"seconds={result.seconds:.2f} match={result.matched}/{result.expected} text={result.text[:120]}",
                flush=True,
            )

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps([result.__dict__ for result in results], ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
