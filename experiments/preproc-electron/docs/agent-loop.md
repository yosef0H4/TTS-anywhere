# Agent Feedback Loop

## Start services

Terminal A:
```bash
cd experiments/preproc-electron/python-server
uv sync
uv run preproc-server serve --host 127.0.0.1 --port 8091
```

Terminal B:
```bash
cd experiments/preproc-electron
npm install
npm run dev:web
```

## Iteration loop

1. Run Playwright spec or console commands.
2. Inspect screenshots and numeric state from `lab.getState()`.
3. Apply fix.
4. Re-run the same scenario.

## Commands

```bash
npm run test:e2e
npm run test:e2e:ui
npm run test:e2e:update
```
