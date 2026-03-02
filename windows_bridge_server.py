#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


def _json_bytes(payload: dict[str, Any]) -> bytes:
    return json.dumps(payload, ensure_ascii=False).encode("utf-8")


class CommandHandler(BaseHTTPRequestHandler):
    server_version = "WindowsBridge/1.0"

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/run":
            self.send_error(404, "Not found")
            return

        token = self.headers.get("X-Bridge-Token", "")
        expected = os.environ.get("WINDOWS_BRIDGE_TOKEN", "")
        if expected and token != expected:
            self.send_response(401)
            body = _json_bytes({"ok": False, "error": "Unauthorized"})
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length)
            data = json.loads(raw.decode("utf-8"))
            cmd = str(data.get("cmd", "")).strip()
            cwd = str(data.get("cwd", "")).strip() or None
            timeout = int(data.get("timeout", 180))
        except Exception as exc:
            self.send_response(400)
            body = _json_bytes({"ok": False, "error": f"Bad request: {exc}"})
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if not cmd:
            self.send_response(400)
            body = _json_bytes({"ok": False, "error": "Missing cmd"})
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        try:
            completed = subprocess.run(
                cmd,
                cwd=cwd,
                shell=True,
                capture_output=True,
                text=True,
                timeout=timeout,
            )
            payload = {
                "ok": True,
                "returncode": completed.returncode,
                "stdout": completed.stdout,
                "stderr": completed.stderr,
                "cmd": cmd,
                "cwd": cwd,
            }
            body = _json_bytes(payload)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except subprocess.TimeoutExpired as exc:
            body = _json_bytes(
                {
                    "ok": False,
                    "error": f"Timeout after {timeout}s",
                    "stdout": exc.stdout or "",
                    "stderr": exc.stderr or "",
                }
            )
            self.send_response(408)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    def log_message(self, fmt: str, *args: object) -> None:
        print(f"[windows-bridge] {self.address_string()} - {fmt % args}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Run Windows command bridge server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument(
        "--token",
        default="",
        help="Optional auth token; if set, clients must send X-Bridge-Token",
    )
    args = parser.parse_args()

    if args.token:
        os.environ["WINDOWS_BRIDGE_TOKEN"] = args.token

    server = ThreadingHTTPServer((args.host, args.port), CommandHandler)
    print(f"Windows bridge listening on http://{args.host}:{args.port}")
    if os.environ.get("WINDOWS_BRIDGE_TOKEN"):
        print("Token auth: enabled")
    else:
        print("Token auth: disabled")
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

