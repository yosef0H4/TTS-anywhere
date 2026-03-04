#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY_DIR="$ROOT_DIR/python-server"

# Try common user install locations for uv if it's not already on PATH.
export PATH="/tmp:/tmp/bin:/tmp/.local/bin:/tmp/uv/bin:$HOME/.local/bin:$HOME/.cargo/bin:$HOME/bin:$PATH"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/tmp/.playwright-browsers}"

if [[ -z "${UV_BIN:-}" ]]; then
  if [[ -x "/tmp/uv/bin/uv" ]]; then
    UV_BIN="/tmp/uv/bin/uv"
  elif [[ -x "/tmp/.local/bin/uv" ]]; then
    UV_BIN="/tmp/.local/bin/uv"
  elif [[ -x "$HOME/.local/bin/uv" ]]; then
    UV_BIN="$HOME/.local/bin/uv"
  else
    UV_BIN="uv"
  fi
fi

cleanup() {
  if [[ -n "${PY_PID:-}" ]] && kill -0 "$PY_PID" 2>/dev/null; then
    kill "$PY_PID" || true
    wait "$PY_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

cd "$PY_DIR"
if command -v "$UV_BIN" >/dev/null 2>&1; then
  "$UV_BIN" sync
  "$UV_BIN" run preproc-server serve --host 127.0.0.1 --port 8091 > "$ROOT_DIR/test-artifacts/loop-server.log" 2>&1 &
else
  echo "uv not found. Set UV_BIN=/abs/path/to/uv or add it to PATH." >&2
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
