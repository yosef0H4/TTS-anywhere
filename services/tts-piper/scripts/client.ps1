param([string]$Model="",[string]$Text,[string]$Out="out.wav")
$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location $projectRoot
try {
  if ($Model -ne "") {
    uv run tts-piper synth --model $Model --text $Text --out $Out
  } else {
    uv run tts-piper synth --text $Text --out $Out
  }
}
finally {
  Pop-Location
}
