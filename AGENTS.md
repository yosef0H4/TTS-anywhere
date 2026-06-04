# Repository Guidelines

## Project Structure & Module Organization
- `src/core/` holds chunking, OpenAI-compatible clients, shared models, logging, settings, and pipeline logic.
- `src/web/` contains the Electron renderer runtime. It is still built by Vite, but it is not maintained as a standalone browser app.
- `src/ui/` contains renderer templates, styles, icons, fonts, and layout helpers.
- `src/electron/` contains Electron main/preload process code, native capture orchestration, provider IPC, managed service launch, and packaging/runtime service sync.
- `services/nodehotkey/` is the local native Node package for Windows hotkeys, clipboard, capture, overlays, and input sending.
- `services/tts/*` contains OpenAI-compatible local TTS adapters.
- `services/text_processing/*` contains local OCR/text-region services.
- Renderer/unit tests live in `src/tests/*.test.ts`; Electron E2E tests live in `tests/e2e/electron-*.spec.ts`.

## Build, Test, and Development Commands
- `npm run dev:electron`: run the Electron app in development.
- `npm run dev:electron:debug`: run Electron with the localhost CDP endpoint used by `pw:exec`/`pw:stdin`.
- `npm run dev:renderer`: start the Vite renderer dev server used by Electron dev/test workflows.
- `npm run build:renderer`: build the renderer bundle with Vite.
- `npm run build:electron`: build renderer and Electron main/preload output.
- `npm run dist:win`: build the Windows distributable.
- `npm run typecheck`: TypeScript check for the renderer-side TS project.
- `npm run check:no-any`: ESLint strict `any` check for TS/Electron/test code.
- `npm run test`: default focused Vitest suite.
- `npm run test:e2e:electron`: Playwright Electron E2E tests.
- `npm run pw:exec -- "return await page.title()"`: execute a short Playwright snippet against `dev:electron:debug`.
- `npm run pw:stdin`: execute a multiline Playwright snippet against `dev:electron:debug`.

## Python Service Commands
- Run Python service commands from the specific service directory.
- Common setup: `uv sync --group dev`.
- Common validation: `uv run python -m pytest`.
- Many services expose a `launcher.py`, `cli.py`, or README-specific command; prefer the service README and `stack.service.json` for the current launch path.
- Managed Electron launch currently treats Paddle OCR and Edge TTS as the recommended first-class local stack.

## Coding Style & Naming Conventions
- TypeScript is strict; avoid `any` and keep module boundaries clear by domain.
- Python services should keep typed public functions and narrow adapter-specific modules.
- Use ES modules in TS.
- Keep files focused; avoid monolithic single-file implementations.

## Testing Guidelines
- App logic: Vitest unit tests in `src/tests/`.
- Desktop behavior: Playwright Electron tests in `tests/e2e/electron-*.spec.ts`.
- Runtime debugging: use `npm run dev:electron:debug` plus `npm run pw:exec` or `npm run pw:stdin`.
- Before committing, run the checks relevant to the changed area.

## Commit & Pull Request Guidelines
- Use Conventional Commits, for example `feat:`, `fix:`, or `chore:`.
- Include user impact and commands run in PR/commit notes.
- Attach screenshots for UI-visible changes.

## Security & Configuration Tips
- Never commit secrets. Use env vars such as `API_KEY` and provider keys.
- Local OpenAI-compatible services generally expose `/v1` endpoints; auth is service-specific and often optional unless `API_KEY` is configured.
- Do not commit generated audio, screenshots, logs, model caches, virtualenvs, or local runtime output.

## AGENTS.md Self-Maintenance Policy
- Keep this file aligned with real repo behavior so agents stay reliable.
- Agents may propose edits to `AGENTS.md` when commands, architecture, or constraints drift.
- Required for any `AGENTS.md` update:
- Keep changes minimal and scoped to factual repo behavior.
- Never add secrets, tokens, machine-local private paths, or personal data.
- Do not silently change safety-critical policy; include a short rationale in commit/PR message.
- Validate referenced commands exist before writing them.
- Suggested CI checks:
- fail if `AGENTS.md` references removed commands/files
- fail if banned artifacts are committed (`__pycache__`, `.mypy_cache`, `.pytest_cache`, `.venv*`, logs, test output)

## Generated/Cache Artifacts
- Do not commit caches or local build artifacts.
- Ignore at minimum:
- `dist/`
- `dist-electron/`
- `.bundle-resources/`
- `.cache/`
- `logs/`
- `playwright-report/`
- `test-results/`
- `bench_data/`
- `bench_results/`
- `**/__pycache__/`
- `**/*.pyc`
- `services/**/.venv*/`
- `services/**/.pytest_cache/`
- `services/**/.mypy_cache/`
- `services/**/.ruff_cache/`
- `services/**/.hf-cache/`
- `services/**/.paddlex-cache/`
- generated `.wav`, screenshots, benchmark outputs, and service logs

## Windows Bridge
- Root scripts provide a lightweight remote command bridge for Windows-host execution:
- `windows_bridge_server.py`: run this on the Windows machine.
- `windows_bridge_client.py`: send command strings to the server.
- Suggested start command on Windows host:
- `python windows_bridge_server.py --host 0.0.0.0 --port 8765 --token <token>`
- Suggested client command:
- `python windows_bridge_client.py "npm run typecheck" --server http://<host>:8765 --token <token>`
