# Repository Guidelines

## Project Structure & Module Organization
- `src/core/` holds chunking, OpenAI-compatible clients, shared models, and pipeline logic for renderer use.
- `src/web/` contains browser renderer entry/runtime; `src/ui/` contains templates and styles.
- `src/electron/` contains main/preload process code for desktop runtime.
- `services/tts-adapter/` is a standalone Python OpenAI-compatible TTS adapter project (FastAPI + CLI).
- Renderer tests live in `src/tests/*.test.ts`; adapter tests live in `services/tts-adapter/tests/`.

## Build, Test, and Development Commands
- Web/Electron app:
- `npm run dev:web`
- `npm run dev:electron`
- `npm run build:web`
- `npm run build:electron`
- `npm run typecheck`
- Python adapter (`services/tts-adapter`):
- `uv sync --group dev`
- `uv run tts-adapter-api --host 127.0.0.1 --port 8000`
- `uv run tts-adapter-cli synth --text "..." --out out.wav`
- `uv run python -m ruff check .`
- `uv run python -m mypy src/tts_adapter tests --python-version 3.11`
- `uv run python -m pytest`

## Coding Style & Naming Conventions
- TypeScript (strict) for app code, Python (strict typing) for adapter code.
- Use explicit types/interfaces; avoid `any` in TS and untyped public defs in Python.
- Use ES modules in TS and clear module boundaries by domain.
- Keep files focused; avoid monolithic single-file implementations.

## Testing Guidelines
- App: Vitest unit tests for core logic and API boundary behavior.
- Adapter: pytest for schemas/auth/endpoints/CLI smoke behavior.
- Before committing, run relevant typecheck + tests for changed area.

## Commit & Pull Request Guidelines
- Use Conventional Commits (for example `feat:`, `fix:`, `chore:`).
- Include user impact and commands run in PR/commit notes.
- Attach screenshots for UI-visible changes.

## Security & Configuration Tips
- Never commit secrets. Use env vars (`API_KEY`, OpenAI keys, etc.).
- For adapter local auth, bearer token is optional unless `API_KEY` is configured.
- TTS adapter is OpenAI-compatible at `/v1/audio/speech`; app can point TTS Base URL to local adapter.

## AGENTS.md Self-Maintenance Policy
- Goal: keep this file aligned with real repo behavior so agents stay reliable.
- Agents may propose edits to `AGENTS.md` when commands, architecture, or constraints drift.
- Required for any `AGENTS.md` update:
- Keep changes minimal and scoped to factual repo behavior.
- Never add secrets, tokens, machine-local private paths, or personal data.
- Do not silently change safety-critical policy; include a short rationale in commit/PR message.
- Validate referenced commands exist before writing them.
- Preferred workflow:
- Use a post-task check (hook/script/CI) that detects stale guidance and opens a patch.
- Human reviews and merges the `AGENTS.md` diff.
- Suggested CI checks:
- fail if `AGENTS.md` references removed commands/files
- fail if banned artifacts are committed (`__pycache__`, `.mypy_cache`, `.pytest_cache`, local venvs)

## Generated/Cache Artifacts
- Do not commit caches or local build artifacts.
- Ignore at minimum:
- `services/tts-adapter/.venv/`
- `services/tts-adapter/.mypy_cache/`
- `services/tts-adapter/.pytest_cache/`
- `services/tts-adapter/.ruff_cache/`
- `services/tts-adapter/**/__pycache__/`
- `services/tts-adapter/**/*.pyc`

## Windows Bridge
- Root scripts provide a lightweight remote command bridge for Windows-host execution:
- `windows_bridge_server.py`: run this on the Windows machine.
- `windows_bridge_client.py`: send command strings to the server.
- Suggested start command on Windows host:
- `python windows_bridge_server.py --host 0.0.0.0 --port 8765 --token <token>`
- Suggested client command:
- `python windows_bridge_client.py "uv run python .\\src\\tts_adapter\\cli.py synth --text \"hi\" --out test.wav" --server http://<host>:8765 --token <token>`
