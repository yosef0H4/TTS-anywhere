#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from typing import Any


def run_remote(
    server: str,
    cmd: str,
    *,
    cwd: str | None,
    timeout: int,
    token: str,
) -> dict[str, Any]:
    payload = {
        "cmd": cmd,
        "cwd": cwd,
        "timeout": timeout,
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url=f"{server.rstrip('/')}/run",
        data=data,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Bridge-Token": token,
        },
    )

    with urllib.request.urlopen(req, timeout=timeout + 5) as resp:
        body = resp.read().decode("utf-8")
        return json.loads(body)


def main() -> int:
    parser = argparse.ArgumentParser(description="Run command on Windows bridge host")
    parser.add_argument("cmd", help="Command string to run remotely")
    parser.add_argument("--server", default="http://127.0.0.1:8765")
    parser.add_argument("--cwd", default=None)
    parser.add_argument("--timeout", type=int, default=300)
    parser.add_argument("--token", default=os.environ.get("WINDOWS_BRIDGE_TOKEN", ""))
    args = parser.parse_args()

    try:
        result = run_remote(
            server=args.server,
            cmd=args.cmd,
            cwd=args.cwd,
            timeout=args.timeout,
            token=args.token,
        )
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        print(f"HTTP {exc.code}: {body}", file=sys.stderr)
        return 2
    except Exception as exc:
        print(f"Request failed: {exc}", file=sys.stderr)
        return 2

    stdout = str(result.get("stdout", ""))
    stderr = str(result.get("stderr", ""))
    code = int(result.get("returncode", 1))

    if stdout:
        print(stdout, end="" if stdout.endswith("\n") else "\n")
    if stderr:
        print(stderr, file=sys.stderr, end="" if stderr.endswith("\n") else "\n")

    return code


if __name__ == "__main__":
    raise SystemExit(main())

