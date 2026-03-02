param([string]$HostAddress="127.0.0.1", [int]$Port=8012)
uv run tts-edge serve --host $HostAddress --port $Port
