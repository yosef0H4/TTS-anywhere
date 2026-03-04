@echo off
setlocal

set ROOT_DIR=%~dp0
cd /d "%ROOT_DIR%"

if not exist ".venv" (
  echo [openai-mitm] creating virtual environment via uv sync...
  uv sync
) else (
  echo [openai-mitm] syncing dependencies...
  uv sync
)

if "%OPENAI_MITM_UPSTREAM%"=="" set OPENAI_MITM_UPSTREAM=https://api.openai.com
if "%OPENAI_MITM_HOST%"=="" set OPENAI_MITM_HOST=127.0.0.1
if "%OPENAI_MITM_PORT%"=="" set OPENAI_MITM_PORT=8109
if "%OPENAI_MITM_OUT_DIR%"=="" set OPENAI_MITM_OUT_DIR=.mitm-logs/openai

echo [openai-mitm] starting on %OPENAI_MITM_HOST%:%OPENAI_MITM_PORT% forwarding to %OPENAI_MITM_UPSTREAM%
uv run openai-mitm-proxy serve --host %OPENAI_MITM_HOST% --port %OPENAI_MITM_PORT% --upstream %OPENAI_MITM_UPSTREAM% --api-key "%OPENAI_MITM_API_KEY%" --out-dir "%OPENAI_MITM_OUT_DIR%"

endlocal
