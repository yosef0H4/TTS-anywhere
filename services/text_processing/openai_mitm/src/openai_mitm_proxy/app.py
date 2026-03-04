from __future__ import annotations

import base64
import datetime as dt
import json
import re
import uuid
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse

DATA_URL_RE = re.compile(r"^data:(?P<mime>[^;,]+)?(?P<meta>[^,]*),(?P<data>.*)$", re.DOTALL)


def utc_now() -> str:
  return dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d-%H%M%S-%fZ")


def sanitize_headers(headers: dict[str, str]) -> dict[str, str]:
  out: dict[str, str] = {}
  for key, value in headers.items():
    lk = key.lower()
    if lk in {"host", "content-length"}:
      continue
    out[key] = value
  return out


def guess_ext(mime: str | None) -> str:
  if not mime:
    return "bin"
  m = mime.lower()
  if "png" in m:
    return "png"
  if "jpeg" in m or "jpg" in m:
    return "jpg"
  if "webp" in m:
    return "webp"
  if "gif" in m:
    return "gif"
  if "bmp" in m:
    return "bmp"
  if "tiff" in m:
    return "tiff"
  return "bin"


def decode_data_url(url: str) -> tuple[bytes, str]:
  match = DATA_URL_RE.match(url)
  if not match:
    raise ValueError("not a data URL")
  mime = (match.group("mime") or "application/octet-stream").strip()
  meta = match.group("meta") or ""
  payload = match.group("data") or ""
  if ";base64" in meta.lower():
    return base64.b64decode(payload), mime
  return payload.encode("utf-8"), mime


def extract_and_save_images(payload: Any, image_dir: Path) -> list[dict[str, Any]]:
  saved: list[dict[str, Any]] = []

  def walk(node: Any, path: str) -> None:
    if isinstance(node, dict):
      if node.get("type") == "image_url":
        image_url = node.get("image_url")
        if isinstance(image_url, dict):
          url = image_url.get("url")
          if isinstance(url, str) and url.startswith("data:"):
            try:
              data, mime = decode_data_url(url)
              ext = guess_ext(mime)
              name = f"{len(saved)+1:03d}-{uuid.uuid4().hex[:8]}.{ext}"
              out_path = image_dir / name
              out_path.write_bytes(data)
              saved.append({
                "path": str(out_path),
                "bytes": len(data),
                "mime": mime,
                "json_path": path,
              })
            except Exception as exc:  # noqa: BLE001
              saved.append({"error": f"failed decode at {path}: {exc}"})
      for key, value in node.items():
        walk(value, f"{path}.{key}")
    elif isinstance(node, list):
      for i, value in enumerate(node):
        walk(value, f"{path}[{i}]")

  walk(payload, "$")
  return saved


def create_app(upstream: str, api_key: str, out_dir: Path, timeout_s: float) -> FastAPI:
  app = FastAPI(title="OpenAI MITM Proxy", version="0.1.0")
  out_dir.mkdir(parents=True, exist_ok=True)

  @app.get("/healthz")
  async def healthz() -> dict[str, Any]:
    return {"ok": True, "upstream": upstream}

  @app.api_route("/v1/{rest_of_path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
  async def forward(rest_of_path: str, request: Request) -> Response:
    req_id = f"{utc_now()}-{uuid.uuid4().hex[:8]}"
    req_dir = out_dir / req_id
    req_dir.mkdir(parents=True, exist_ok=True)
    image_dir = req_dir / "images"
    image_dir.mkdir(parents=True, exist_ok=True)

    body_bytes = await request.body()
    query = str(request.url.query)
    method = request.method
    target = f"{upstream.rstrip('/')}/v1/{rest_of_path}"
    if query:
      target = f"{target}?{query}"

    in_headers = dict(request.headers)
    fwd_headers = sanitize_headers(in_headers)
    if api_key:
      fwd_headers["Authorization"] = f"Bearer {api_key}"

    request_meta: dict[str, Any] = {
      "id": req_id,
      "method": method,
      "incoming_path": f"/v1/{rest_of_path}",
      "incoming_query": query,
      "target_url": target,
      "incoming_headers": in_headers,
      "forward_headers": fwd_headers,
      "body_bytes": len(body_bytes),
    }

    if body_bytes and "application/json" in in_headers.get("content-type", ""):
      try:
        payload = json.loads(body_bytes.decode("utf-8"))
        (req_dir / "request.json").write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
        request_meta["saved_images"] = extract_and_save_images(payload, image_dir)
      except Exception as exc:  # noqa: BLE001
        request_meta["request_json_error"] = str(exc)
    elif body_bytes:
      (req_dir / "request-body.bin").write_bytes(body_bytes)

    (req_dir / "request-meta.json").write_text(json.dumps(request_meta, indent=2, ensure_ascii=False), encoding="utf-8")

    try:
      async with httpx.AsyncClient(timeout=timeout_s) as client:
        upstream_resp = await client.request(method=method, url=target, headers=fwd_headers, content=body_bytes if body_bytes else None)
    except Exception as exc:  # noqa: BLE001
      err = {"error": str(exc), "id": req_id, "target_url": target}
      (req_dir / "response-error.json").write_text(json.dumps(err, indent=2, ensure_ascii=False), encoding="utf-8")
      return JSONResponse(err, status_code=502)

    resp_headers = dict(upstream_resp.headers)
    resp_body = upstream_resp.content
    response_meta: dict[str, Any] = {
      "id": req_id,
      "status_code": upstream_resp.status_code,
      "response_headers": resp_headers,
      "response_bytes": len(resp_body),
    }

    if "application/json" in resp_headers.get("content-type", ""):
      try:
        obj = upstream_resp.json()
        (req_dir / "response.json").write_text(json.dumps(obj, indent=2, ensure_ascii=False), encoding="utf-8")
      except Exception as exc:  # noqa: BLE001
        response_meta["response_json_error"] = str(exc)
        (req_dir / "response-body.bin").write_bytes(resp_body)
    else:
      (req_dir / "response-body.bin").write_bytes(resp_body)

    (req_dir / "response-meta.json").write_text(json.dumps(response_meta, indent=2, ensure_ascii=False), encoding="utf-8")

    passthrough_headers = sanitize_headers(resp_headers)
    return Response(content=resp_body, status_code=upstream_resp.status_code, headers=passthrough_headers)

  return app
