# Repository Guidelines

  ## Project Structure & Module Organization
  - `src/core/` holds speech chunking, OpenAI client services, and reusable models/pipeline code; keep business logic here so both Electron
  and web builds stay thin.
  - `src/web/` exposes the Vite SPA entry (`main.ts`, `app.ts`), while `src/ui/` stores renderer templates and `styles.css`.
  - `src/electron/` contains the main process (`main.ts`) and bridge preload (`preload.ts`). These compile into `dist-electron/`, whereas
  renderer assets land in `dist/`.
  - Tests sit in `src/tests/*.test.ts`; sample fixtures live next to the files they cover.

  ## Build, Test, and Development Commands
  - `npm run dev:web` – launches the Vite dev server for quick renderer-only tweaks.
  - `npm run dev:electron` – concurrently watches `tsconfig.electron.json`, serves Vite, and launches Electron with `VITE_DEV_SERVER_URL`.
  - `npm run build:web` / `npm run build:electron` – produce production bundles; the Electron build first runs the web build before compiling
  main/preload TypeScript.
  - `npm run typecheck` – strict TypeScript verification without emitting output.

  ## Coding Style & Naming Conventions
  - TypeScript everywhere; prefer ES modules with named exports. Use 2-space indentation and double quotes (see `vite.config.ts`).
  - File naming follows kebab-case (`settings-store.test.ts`); keep renderer components or utilities co-located with their domain modules
  under `src/core` subfolders.
  - Run Prettier (if installed globally) before submitting; otherwise rely on `tsc` + reviewer feedback.

  ## Testing Guidelines
  - Vitest drives unit coverage. Group scenarios per domain (`chunking`, `openai-client`, `settings-store`) and mirror the folder layout
  under `src/tests`.
  - Use descriptive `describe` blocks (`describe("chunkParagraph")`) and deterministic fixtures to keep the single-threaded test pool
  reliable.
  - Execute `npm test` before every PR; CI expects green runs plus meaningful assertions around API boundary cases.

  ## Commit & Pull Request Guidelines
  - The workspace snapshot lacks an initialized `.git` directory, so adopt Conventional Commits (`feat: add renderer toolbar`, `fix: guard
  empty SSML`).
  - Reference linked issues in the body, attach screenshots/gifs for UI changes, and mention dev/test commands executed.
  - PR descriptions should outline user impact, risk level, and any follow-up tasks for packaging or release.

  ## Security & Configuration Tips
  - Store secrets such as `OPENAI_API_KEY` in `.env` files that are excluded from packaging; never hard-code tokens under `src/`.
  - When running Electron locally, confirm `VITE_DEV_SERVER_URL` matches the served port (default `http://localhost:5173`).
  - Keep production builds signed and generated via `electron-builder` once app IDs/certificates are configured.
