#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = REPO_ROOT / "benchmarks" / "text_processing" / "public_images.json"
DEFAULT_OUTPUT_DIR = REPO_ROOT / "bench_data" / "images"


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Download the public OCR benchmark image set")
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    parser.add_argument("--force", action="store_true", help="Redownload files even if they already exist")
    return parser.parse_args(argv)


def load_manifest(path: Path) -> list[dict[str, str]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, list):
        raise ValueError(f"Manifest must be a list: {path}")
    rows: list[dict[str, str]] = []
    for item in payload:
        if not isinstance(item, dict):
            raise ValueError(f"Invalid manifest row in {path}: {item!r}")
        filename = item.get("filename")
        url = item.get("url")
        if not isinstance(filename, str) or not isinstance(url, str):
            raise ValueError(f"Manifest row missing filename/url: {item!r}")
        rows.append({"filename": filename, "url": url})
    return rows


def download(url: str, out_path: Path) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": "tts-electron-bench/1.0"})
    with urllib.request.urlopen(request, timeout=60) as response:
        data = response.read()
    out_path.write_bytes(data)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    manifest = load_manifest(args.manifest)
    out_dir = args.out_dir
    out_dir.mkdir(parents=True, exist_ok=True)

    downloaded = 0
    skipped = 0
    for row in manifest:
        out_path = out_dir / row["filename"]
        if out_path.exists() and not args.force:
            print(f"skip {out_path.name}")
            skipped += 1
            continue
        print(f"fetch {out_path.name}")
        download(row["url"], out_path)
        downloaded += 1

    print(f"done downloaded={downloaded} skipped={skipped} dir={out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
