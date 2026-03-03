param([string]$Text,[string]$Out="out.mp3",[string]$Voice="")
if ($Voice -ne "") {
  uv run tts-edge synth --text $Text --out $Out --voice $Voice
} else {
  uv run tts-edge synth --text $Text --out $Out
}
