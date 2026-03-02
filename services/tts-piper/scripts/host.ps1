param([string]$HostAddress="127.0.0.1", [int]$Port=8011)
$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location $projectRoot
try {
  uv run tts-piper serve --host $HostAddress --port $Port
}
finally {
  Pop-Location
}
