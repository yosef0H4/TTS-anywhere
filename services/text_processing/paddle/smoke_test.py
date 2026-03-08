from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from urllib import error, parse, request


def _fetch_json(url: str, data: bytes | None = None, headers: dict[str, str] | None = None) -> tuple[int, dict]:
    req = request.Request(url, data=data, headers=headers or {})
    try:
        with request.urlopen(req, timeout=30) as res:
            return res.status, json.loads(res.read().decode("utf-8"))
    except error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            payload = {"raw": body}
        return exc.code, payload


def main() -> int:
    parser = argparse.ArgumentParser(description="Smoke-test the live Paddle detect server")
    parser.add_argument("--base-url", default="http://127.0.0.1:8093")
    parser.add_argument("--image", default=str(Path(__file__).with_name("tmp.webp")))
    args = parser.parse_args()

    health_status, health = _fetch_json(f"{args.base_url.rstrip('/')}/healthz")
    if health_status != 200 or not health.get("ok"):
        print(f"health check failed: status={health_status} body={health}", file=sys.stderr)
        return 1

    image_path = Path(args.image)
    if not image_path.exists():
        print(f"missing image: {image_path}", file=sys.stderr)
        return 1

    boundary = "codex-boundary"
    settings = json.dumps({"detector": {"include_polygons": False}})
    image_bytes = image_path.read_bytes()
    payload = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="settings"\r\n\r\n'
        f"{settings}\r\n"
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="image"; filename="{image_path.name}"\r\n'
        f"Content-Type: image/webp\r\n\r\n"
    ).encode("utf-8") + image_bytes + f"\r\n--{boundary}--\r\n".encode("utf-8")

    status, body = _fetch_json(
        f"{args.base_url.rstrip('/')}/v1/detect",
        data=payload,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    if status != 200:
        print(f"detect http failed: status={status} body={body}", file=sys.stderr)
        return 1
    if body.get("status") != "success":
        print(f"detect failed: {body}", file=sys.stderr)
        return 1

    raw_boxes = body.get("raw_boxes")
    if not isinstance(raw_boxes, list) or len(raw_boxes) == 0:
        print(f"detect returned no boxes: {body}", file=sys.stderr)
        return 1

    print(
        json.dumps(
            {
                "health": {
                    "runtime": health.get("runtime"),
                    "execution_provider": health.get("execution_provider"),
                },
                "raw_count": len(raw_boxes),
                "metrics": body.get("metrics"),
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
