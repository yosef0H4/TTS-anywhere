param([string]$HostAddress="127.0.0.1", [int]$Port=8012)
$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location $projectRoot
try {
  uv run tts-edge serve --host $HostAddress --port $Port
}
finally {
  Pop-Location
}
