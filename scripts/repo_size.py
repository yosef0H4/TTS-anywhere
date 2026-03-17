#!/usr/bin/env python3
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Measure repository file size using git-tracked and unignored files only."
        )
    )
    parser.add_argument(
        "--exclude",
        action="append",
        default=["demo"],
        help="Top-level path prefix to exclude. Can be passed multiple times.",
    )
    return parser.parse_args()


def format_size(size_bytes: int) -> str:
    mib = size_bytes / 1024 / 1024
    return f"{size_bytes} bytes ({mib:.2f} MiB)"


def main() -> int:
    args = parse_args()
    root = Path.cwd()
    exclude_prefixes = tuple(
        prefix.strip("/\\") for prefix in args.exclude if prefix.strip("/\\")
    )

    try:
        result = subprocess.run(
            ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
            capture_output=True,
            text=False,
            check=True,
        )
    except FileNotFoundError:
        print("git was not found on PATH.", file=sys.stderr)
        return 1
    except subprocess.CalledProcessError as exc:
        sys.stderr.write(exc.stderr.decode("utf-8", "replace"))
        return exc.returncode

    total_size = 0
    file_count = 0

    for raw_path in result.stdout.split(b"\0"):
        if not raw_path:
            continue

        rel_path = Path(raw_path.decode("utf-8", "surrogateescape"))
        if rel_path.parts and rel_path.parts[0] in exclude_prefixes:
            continue

        abs_path = root / rel_path
        if not abs_path.is_file():
            continue

        total_size += abs_path.stat().st_size
        file_count += 1

    print(f"Files counted: {file_count}")
    print(f"Excluded prefixes: {', '.join(exclude_prefixes) if exclude_prefixes else '(none)'}")
    print(f"Total size: {format_size(total_size)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
