from __future__ import annotations

import argparse
import json
import os
import statistics
import subprocess
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_TEXTS = {
    "short": "Hello world. This is a Windows natural voice timing test.",
    "medium": (
        "Sherlock Holmes is a fictional detective created by British author Arthur Conan Doyle. "
        "Holmes is known for observation, deduction, forensic science, and logical reasoning."
    ),
    "long": (
        "Sherlock Holmes is a fictional detective created by British author Arthur Conan Doyle. "
        "Referring to himself as a consulting detective in his stories, Holmes is known for his "
        "proficiency with observation, deduction, forensic science, and logical reasoning. "
        "This benchmark repeats synthesis enough times to reduce bias from a busy laptop."
    ),
}


@dataclass
class Sample:
    label: str
    round_index: int
    run_index: int
    elapsed_ms: float
    bytes_out: int


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Benchmark the Windows Natural TTS adapter.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8016)
    parser.add_argument("--rounds", type=int, default=3)
    parser.add_argument("--runs", type=int, default=10)
    parser.add_argument("--voice", default="")
    parser.add_argument("--warmup", type=int, default=1)
    parser.add_argument("--timeout", type=float, default=120.0)
    parser.add_argument("--concurrency", type=int, default=1)
    parser.add_argument("--busy-load", action="store_true", help="Run a CPU spinner during the benchmark.")
    return parser.parse_args()


def request_json(url: str, timeout: float) -> Any:
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def post_speech(endpoint: str, text: str, voice: str, timeout: float) -> tuple[float, int]:
    body = json.dumps(
        {
            "model": "windows-natural",
            "input": text,
            "voice": voice,
            "response_format": "wav",
        }
    ).encode("utf-8")
    request = urllib.request.Request(endpoint, data=body, headers={"Content-Type": "application/json"}, method="POST")
    start = time.perf_counter()
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = response.read()
    return (time.perf_counter() - start) * 1000, len(payload)


def start_server(host: str, port: int) -> subprocess.Popen[str]:
    out_path = ROOT / "benchmark-server.out.log"
    err_path = ROOT / "benchmark-server.err.log"
    out_handle = out_path.open("w", encoding="utf-8")
    err_handle = err_path.open("w", encoding="utf-8")
    return subprocess.Popen(
        ["uv", "run", "tts-windows-natural", "serve", "--host", host, "--port", str(port)],
        cwd=ROOT,
        stdout=out_handle,
        stderr=err_handle,
        text=True,
    )


def wait_ready(base_url: str, process: subprocess.Popen[str], timeout: float) -> None:
    deadline = time.perf_counter() + timeout
    while time.perf_counter() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"server exited early with code {process.returncode}")
        try:
            request_json(f"{base_url}/v1/models", 2)
            return
        except (urllib.error.URLError, TimeoutError):
            time.sleep(0.25)
    raise RuntimeError("server did not become ready")


def summarize(samples: list[Sample]) -> list[dict[str, Any]]:
    groups: dict[str, list[float]] = {}
    for sample in samples:
        groups.setdefault(sample.label, []).append(sample.elapsed_ms)
    summary: list[dict[str, Any]] = []
    for label, values in groups.items():
        ordered = sorted(values)
        p95_index = max(0, min(len(ordered) - 1, int(len(ordered) * 0.95) - 1))
        summary.append(
            {
                "label": label,
                "count": len(values),
                "median_ms": round(statistics.median(values), 2),
                "p95_ms": round(ordered[p95_index], 2),
                "min_ms": round(min(values), 2),
                "max_ms": round(max(values), 2),
                "stdev_ms": round(statistics.stdev(values), 2) if len(values) > 1 else 0,
            }
        )
    return summary


def run_concurrent_batch(endpoint: str, label: str, text: str, voice: str, concurrency: int, timeout: float) -> list[tuple[float, int]]:
    with ThreadPoolExecutor(max_workers=concurrency) as executor:
        futures = [executor.submit(post_speech, endpoint, text, voice, timeout) for _ in range(concurrency)]
        return [future.result() for future in as_completed(futures)]


def start_busy_load() -> subprocess.Popen[str] | None:
    if os.name != "nt":
        return None
    code = "import time\nend=time.time()+180\nwhile time.time()<end:\n    pass\n"
    return subprocess.Popen([sys.executable, "-c", code], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def main() -> int:
    args = parse_args()
    base_url = f"http://{args.host}:{args.port}"
    process = start_server(args.host, args.port)
    busy = start_busy_load() if args.busy_load else None
    samples: list[Sample] = []
    try:
        wait_ready(base_url, process, args.timeout)
        voices = request_json(f"{base_url}/v1/voices", args.timeout)
        voice = args.voice or str(voices["voices"][0]["id"])
        print(json.dumps({"event": "config", "voice": voice, "rounds": args.rounds, "runs": args.runs, "concurrency": args.concurrency, "busy_load": args.busy_load}), flush=True)
        for label, text in DEFAULT_TEXTS.items():
            for warmup_index in range(args.warmup):
                elapsed_ms, bytes_out = post_speech(f"{base_url}/v1/audio/speech", text, voice, args.timeout)
                print(json.dumps({"event": "warmup", "label": label, "run": warmup_index + 1, "elapsed_ms": round(elapsed_ms, 2), "bytes": bytes_out}), flush=True)
            for round_index in range(args.rounds):
                for run_index in range(args.runs):
                    if args.concurrency <= 1:
                        batch = [post_speech(f"{base_url}/v1/audio/speech", text, voice, args.timeout)]
                    else:
                        batch = run_concurrent_batch(f"{base_url}/v1/audio/speech", label, text, voice, args.concurrency, args.timeout)
                    for item_index, (elapsed_ms, bytes_out) in enumerate(batch, start=1):
                        sample = Sample(label, round_index + 1, run_index + 1, elapsed_ms, bytes_out)
                        samples.append(sample)
                        print(
                            json.dumps(
                                {
                                    "event": "sample",
                                    "label": sample.label,
                                    "round": sample.round_index,
                                    "run": sample.run_index,
                                    "item": item_index,
                                    "elapsed_ms": round(sample.elapsed_ms, 2),
                                    "bytes": sample.bytes_out,
                                }
                            ),
                            flush=True,
                        )
        print(json.dumps({"event": "summary", "summary": summarize(samples)}), flush=True)
        return 0
    finally:
        if busy is not None and busy.poll() is None:
            busy.kill()
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()


if __name__ == "__main__":
    raise SystemExit(main())
