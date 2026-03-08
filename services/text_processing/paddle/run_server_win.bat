@echo off
setlocal

REM Paddle Text Processing (Windows)
REM - Creates/uses .venv-win
REM - Syncs dependencies
REM - Runs server on 127.0.0.1:8095

set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

set "UV_PROJECT_ENVIRONMENT=.venv-win"
set "UV_LINK_MODE=copy"
set "PADDLE_PDX_CACHE_HOME=%SCRIPT_DIR%.paddlex-cache"
set "PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True"
set "PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT=False"

echo [paddle] Using UV_PROJECT_ENVIRONMENT=%UV_PROJECT_ENVIRONMENT%
where uv >nul 2>nul
if errorlevel 1 (
  echo [paddle] ERROR: 'uv' not found in PATH.
  echo [paddle] Install uv first: https://docs.astral.sh/uv/
  exit /b 1
)

echo [paddle] Syncing dependencies...
uv sync
if errorlevel 1 (
  echo [paddle] ERROR: uv sync failed.
  exit /b 1
)

echo [paddle] Starting server on http://127.0.0.1:8095 ...
uv run paddle-text-processing serve --device cpu --host 127.0.0.1 --port 8095
set "EXIT_CODE=%ERRORLEVEL%"

echo [paddle] Server exited with code %EXIT_CODE%.
exit /b %EXIT_CODE%
