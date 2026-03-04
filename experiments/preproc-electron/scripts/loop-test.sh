#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY_DIR="$ROOT_DIR/python-server"

cleanup() {
  if [[ -n "${PY_PID:-}" ]] && kill -0 "$PY_PID" 2>/dev/null; then
    kill "$PY_PID" || true
    wait "$PY_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

cd "$PY_DIR"
if command -v uv >/dev/null 2>&1; then
  uv sync
  uv run preproc-server serve --host 127.0.0.1 --port 8091 > "$ROOT_DIR/test-artifacts/loop-server.log" 2>&1 &
else
  echo "uv not found on PATH. Install uv first." >&2
  exit 1
fi
PY_PID=$!

for i in {1..30}; do
  if curl -fsS http://127.0.0.1:8091/healthz >/dev/null 2>&1; then
    break
  fi
  sleep 1
  if [[ "$i" -eq 30 ]]; then
    echo "Python server did not become healthy in time." >&2
    exit 1
  fi
done

cd "$ROOT_DIR"
PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/tmp/.playwright-browsers}" npm run test:e2e
