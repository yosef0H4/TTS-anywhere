@echo off
setlocal

set "HOST=%~1"
set "PORT=%~2"
if "%HOST%"=="" set "HOST=127.0.0.1"
if "%PORT%"=="" set "PORT=8091"

call "%~dp0\_serve.bat" "%HOST%" "%PORT%" "cpu" "cuda" "0" "1"
