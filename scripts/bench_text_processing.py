#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import json
import math
import os
import signal
import statistics
import subprocess
import sys
import time
import urllib.request
import uuid
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_IMAGES_DIR = REPO_ROOT / "bench_data" / "images"
DEFAULT_RESULTS_DIR = REPO_ROOT / "bench_results"
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}

RUNS = [
    {
        "key": "rapid-cpu",
        "label": "Rapid CPU",
        "provider": "rapid",
        "device": "cpu",
        "base_url": "http://127.0.0.1:8091",
        "launcher": r"services\text_processing\rapid\scripts\host_both.bat",
    },
    {
        "key": "paddle-cpu",
        "label": "Paddle CPU",
        "provider": "paddle",
        "device": "cpu",
        "base_url": "http://127.0.0.1:8093",
        "launcher": r"services\text_processing\paddle\scripts\host_both.bat",
    },
    {
        "key": "rapid-gpu",
        "label": "Rapid GPU",
        "provider": "rapid",
        "device": "gpu",
        "base_url": "http://127.0.0.1:8091",
        "launcher": r"services\text_processing\rapid\scripts\host_both_gpu.bat",
    },
    {
        "key": "paddle-gpu",
        "label": "Paddle GPU",
        "provider": "paddle",
        "device": "gpu",
        "base_url": "http://127.0.0.1:8093",
        "launcher": r"services\text_processing\paddle\scripts\host_both_gpu.bat",
    },
]


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Guided benchmark for Rapid vs Paddle text detection and OCR")
    parser.add_argument("--images-dir", type=Path, default=DEFAULT_IMAGES_DIR)
    parser.add_argument("--results-json", type=Path, default=None)
    parser.add_argument("--warmup-count", type=int, default=1)
    parser.add_argument("--health-timeout", type=float, default=180.0)
    parser.add_argument("--mode", choices=["both", "detect", "ocr"], default="both")
    parser.add_argument("--limit", type=int, default=0, help="Limit number of benchmark images")
    parser.add_argument("--manual", action="store_true", help="Do not auto-launch Windows batch scripts")
    return parser.parse_args(argv)


def list_images(images_dir: Path, limit: int) -> list[Path]:
    if not images_dir.exists():
        raise FileNotFoundError(f"Image directory not found: {images_dir}")
    files = sorted(path for path in images_dir.iterdir() if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS)
    if limit > 0:
        files = files[:limit]
    if not files:
        raise FileNotFoundError(f"No benchmark images found in {images_dir}")
    return files


def http_json(
    url: str,
    *,
    method: str = "GET",
    body: bytes | None = None,
    content_type: str | None = None,
    timeout: float = 60.0,
) -> dict[str, object]:
    headers = {"User-Agent": "tts-electron-bench/1.0"}
    if content_type:
        headers["Content-Type"] = content_type
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        raw = response.read()
    payload = json.loads(raw.decode("utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"Expected JSON object from {url}")
    return payload


def wait_for_health(base_url: str, timeout_s: float) -> dict[str, object]:
    deadline = time.monotonic() + timeout_s
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            payload = http_json(f"{base_url}/healthz", timeout=5.0)
            if payload.get("ok") is True:
                return payload
        except Exception as error:  # noqa: BLE001
            last_error = error
        time.sleep(1.0)
    raise RuntimeError(f"Service at {base_url} did not become healthy in {timeout_s:.0f}s: {last_error}")


def discover_model(base_url: str, fallback_model: str) -> str:
    payload = http_json(f"{base_url}/v1/models", timeout=15.0)
    data = payload.get("data")
    if isinstance(data, list) and data:
        first = data[0]
        if isinstance(first, dict):
            model = first.get("id")
            if isinstance(model, str) and model:
                return model
    return fallback_model


def build_multipart(image_path: Path) -> tuple[bytes, str]:
    boundary = f"----tts-electron-bench-{uuid.uuid4().hex}"
    settings = json.dumps({"detector": {"include_polygons": False}})
    image_bytes = image_path.read_bytes()
    parts = [
        f"--{boundary}\r\n".encode("utf-8"),
        f'Content-Disposition: form-data; name="image"; filename="{image_path.name}"\r\n'.encode("utf-8"),
        b"Content-Type: application/octet-stream\r\n\r\n",
        image_bytes,
        b"\r\n",
        f"--{boundary}\r\n".encode("utf-8"),
        b'Content-Disposition: form-data; name="settings"\r\n\r\n',
        settings.encode("utf-8"),
        b"\r\n",
        f"--{boundary}--\r\n".encode("utf-8"),
    ]
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


def detect_once(base_url: str, image_path: Path) -> dict[str, object]:
    body, content_type = build_multipart(image_path)
    return http_json(
        f"{base_url}/v1/detect",
        method="POST",
        body=body,
        content_type=content_type,
        timeout=120.0,
    )


def guess_mime_type(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in {".jpg", ".jpeg"}:
        return "image/jpeg"
    if suffix == ".png":
        return "image/png"
    if suffix == ".webp":
        return "image/webp"
    if suffix == ".bmp":
        return "image/bmp"
    return "application/octet-stream"


def ocr_once(base_url: str, model: str, image_path: Path) -> dict[str, object]:
    payload = base64.b64encode(image_path.read_bytes()).decode("ascii")
    mime = guess_mime_type(image_path)
    body = json.dumps(
        {
            "model": model,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "Read all visible text."},
                        {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{payload}"}},
                    ],
                }
            ],
            "stream": False,
        }
    ).encode("utf-8")
    return http_json(
        f"{base_url}/v1/chat/completions",
        method="POST",
        body=body,
        content_type="application/json",
        timeout=120.0,
    )


def percentile(sorted_values: list[float], fraction: float) -> float:
    if not sorted_values:
        return 0.0
    if len(sorted_values) == 1:
        return sorted_values[0]
    index = (len(sorted_values) - 1) * fraction
    lower = math.floor(index)
    upper = math.ceil(index)
    if lower == upper:
        return sorted_values[lower]
    weight = index - lower
    return sorted_values[lower] * (1.0 - weight) + sorted_values[upper] * weight


def summarize(timings_ms: list[float], failures: list[str]) -> dict[str, object]:
    sorted_values = sorted(timings_ms)
    return {
        "count": len(timings_ms),
        "success_count": len(timings_ms),
        "failure_count": len(failures),
        "avg_ms": round(statistics.fmean(timings_ms), 2) if timings_ms else None,
        "p50_ms": round(percentile(sorted_values, 0.50), 2) if timings_ms else None,
        "p95_ms": round(percentile(sorted_values, 0.95), 2) if timings_ms else None,
        "min_ms": round(min(timings_ms), 2) if timings_ms else None,
        "max_ms": round(max(timings_ms), 2) if timings_ms else None,
        "failures": failures,
    }


def time_call(callback, *args) -> tuple[float, dict[str, object]]:
    started = time.perf_counter()
    payload = callback(*args)
    elapsed_ms = (time.perf_counter() - started) * 1000.0
    return elapsed_ms, payload


def benchmark_task(*, task_name: str, callback, images: list[Path], warmup_count: int) -> dict[str, object]:
    print(f"Warmup {task_name}: {warmup_count} request(s)")
    for image_path in images[:warmup_count]:
        callback(image_path)

    timings_ms: list[float] = []
    failures: list[str] = []
    details: list[dict[str, object]] = []

    print(f"Measure {task_name}: {len(images)} image(s)")
    for image_path in images:
        try:
            elapsed_ms, payload = time_call(callback, image_path)
            if task_name == "detect" and payload.get("status") != "success":
                raise RuntimeError(str(payload))
            if task_name == "ocr":
                choices = payload.get("choices")
                if not isinstance(choices, list) or not choices:
                    raise RuntimeError(f"Unexpected OCR response: {payload}")
            timings_ms.append(elapsed_ms)
            details.append({"image": image_path.name, "elapsed_ms": round(elapsed_ms, 2), "status": "success"})
            print(f"  {image_path.name}: {elapsed_ms:.2f} ms")
        except Exception as error:  # noqa: BLE001
            message = f"{image_path.name}: {error}"
            failures.append(message)
            details.append({"image": image_path.name, "status": "failure", "error": str(error)})
            print(f"  {message}")

    summary = summarize(timings_ms, failures)
    summary["images"] = details
    return summary


def print_leaderboard(results: dict[str, dict[str, dict[str, object]]]) -> None:
    sections = [
        ("detect_cpu", "Detect CPU"),
        ("ocr_cpu", "OCR CPU"),
        ("detect_gpu", "Detect GPU"),
        ("ocr_gpu", "OCR GPU"),
    ]
    print("\nLeaderboard")
    print("===========")
    for key, title in sections:
        rows: list[tuple[str, dict[str, object]]] = []
        for run in RUNS:
            provider_key = run["provider"]
            device = run["device"]
            task = "detect" if key.startswith("detect_") else "ocr"
            if device != key.split("_", 1)[1]:
                continue
            payload = results.get(run["key"], {}).get(task)
            if payload:
                rows.append((run["label"], payload))
        rows.sort(key=lambda item: float(item[1]["avg_ms"]) if item[1]["avg_ms"] is not None else float("inf"))
        print(f"\n{title}")
        for index, (label, payload) in enumerate(rows, start=1):
            avg = payload["avg_ms"]
            p50 = payload["p50_ms"]
            p95 = payload["p95_ms"]
            success = payload["success_count"]
            failures = payload["failure_count"]
            print(f"{index}. {label}: avg={avg} ms p50={p50} ms p95={p95} ms success={success} failures={failures}")


def prompt_run(run: dict[str, str]) -> None:
    print(f"\nStart {run['label']} now:")
    print(f"  {run['launcher']}")
    input("Press Enter when the service is running...")


def prompt_stop(run: dict[str, str]) -> None:
    input(f"Stop {run['label']} now, then press Enter to continue...")


def start_launcher(run: dict[str, str]) -> subprocess.Popen[bytes]:
    launcher_path = REPO_ROOT / Path(run["launcher"].replace("\\", "/"))
    if not launcher_path.exists():
        raise FileNotFoundError(f"Launcher not found: {launcher_path}")
    host = run["base_url"].split("://", 1)[1].split(":", 1)[0]
    port = run["base_url"].rsplit(":", 1)[1]
    cmd = ["cmd.exe", "/c", str(launcher_path), host, port]
    creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    return subprocess.Popen(cmd, cwd=REPO_ROOT, creationflags=creationflags)


def stop_launcher(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    if os.name == "nt":
        ctrl_break = getattr(signal, "CTRL_BREAK_EVENT", None)
        if ctrl_break is not None:
            try:
                process.send_signal(ctrl_break)
                process.wait(timeout=15)
                return
            except Exception:  # noqa: BLE001
                pass
    process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    images = list_images(args.images_dir, args.limit)
    args.warmup_count = max(0, min(args.warmup_count, len(images)))
    results: dict[str, dict[str, dict[str, object]]] = {}
    auto_launch = os.name == "nt" and not args.manual

    print(f"Using {len(images)} image(s) from {args.images_dir}")
    if args.warmup_count:
        print(f"Warmup requests per task: {args.warmup_count}")
    print(f"Launch mode: {'automatic' if auto_launch else 'manual'}")

    for run in RUNS:
        process: subprocess.Popen[bytes] | None = None
        if auto_launch:
            print(f"\nLaunching {run['label']} with {run['launcher']}")
            process = start_launcher(run)
        else:
            prompt_run(run)

        try:
            health = wait_for_health(run["base_url"], args.health_timeout)
            print(f"Healthy: {run['label']} at {run['base_url']} -> {json.dumps(health)}")
            run_results: dict[str, dict[str, object]] = {}
            if args.mode in {"both", "detect"}:
                detect_callback = lambda image_path, base_url=run["base_url"]: detect_once(base_url, image_path)
                run_results["detect"] = benchmark_task(
                    task_name="detect",
                    callback=detect_callback,
                    images=images,
                    warmup_count=args.warmup_count,
                )
            if args.mode in {"both", "ocr"}:
                model = discover_model(run["base_url"], run["provider"])
                print(f"OCR model: {model}")
                ocr_callback = lambda image_path, base_url=run["base_url"], model=model: ocr_once(base_url, model, image_path)
                run_results["ocr"] = benchmark_task(
                    task_name="ocr",
                    callback=ocr_callback,
                    images=images,
                    warmup_count=args.warmup_count,
                )
            results[run["key"]] = run_results
        finally:
            if process is not None:
                print(f"Stopping {run['label']}")
                stop_launcher(process)
                time.sleep(2.0)
            else:
                prompt_stop(run)

    print_leaderboard(results)

    results_json = args.results_json
    if results_json is None:
        DEFAULT_RESULTS_DIR.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        results_json = DEFAULT_RESULTS_DIR / f"text-processing-bench-{stamp}.json"
    results_json.parent.mkdir(parents=True, exist_ok=True)
    results_json.write_text(
        json.dumps(
            {
                "images_dir": str(args.images_dir),
                "image_count": len(images),
                "warmup_count": args.warmup_count,
                "mode": args.mode,
                "results": results,
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"\nSaved results to {results_json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
