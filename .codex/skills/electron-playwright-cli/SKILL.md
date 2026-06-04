---
name: electron-playwright-cli
description: Use this repo's Electron Playwright CLI to inspect and control the running TTS Anywhere Electron dev window from coding agents. Trigger when debugging renderer behavior, Electron preload APIs, app state, settings UI, service UI, screenshots, console/page errors, or when asked to automate this project's dev window through CLI commands instead of MCP.
---

# Electron Playwright CLI

Use the repo CLI. Do not configure or use MCP for this project.

## Start the app

Run the agent Electron dev process first:

```bash
npm run dev:electron:agent
```

This opens the normal dev app, forces the renderer to load Vite from `http://localhost:5173`, clears `ELECTRON_RUN_AS_NODE`, and exposes a localhost-only CDP endpoint. The CDP port is selected dynamically, preferring `9333`, and written to `.cache/electron-agent-dev.json`.

Check the dev process health:

```bash
npm run pw:doctor
```

## Execute snippets

Run Playwright code against the same Electron renderer window:

```bash
npm run pw:exec -- "return await page.title()"
```

Available variables are `page`, `context`, `browser`, `expect`, `fs`, `path`, `logs`, and `debug`. Snippets run inside an async function, so use `await` and `return`.

Prefer `npm run pw:stdin` for anything more than a tiny one-liner. It avoids shell quoting mistakes and is easier for coding agents to revise. Prefer Playwright locators and `page.evaluate`. Avoid pixel or coordinate interaction unless there is no semantic alternative.

The CLI auto-connects to the CDP endpoint from `.cache/electron-agent-dev.json`. Use `--endpoint` only when attaching to a manually started Electron instance.

## Helper API

The snippet globals include `debug`, a repo-specific helper object for common Electron app workflows:

- `debug.pages()` lists attached Electron pages with CDP target id, URL, title, and selected state.
- `debug.snapshot({ maxItems? })` returns an AI-readable visible UI tree with roles, ids, text, values, disabled, pressed, and expanded state.
- `debug.inspect({ logLines?, maxItems?, screenshot? })` returns pages, service state, UI state, reading preview, recent logs, semantic snapshot, and an optional screenshot path.
- `debug.screenshot({ path?, fullPage? })` writes screenshots. Without `path`, it writes under `test-results/agent/`.
- `debug.writeFile(name, data)` and `debug.saveJson(name, data)` write artifacts under `test-results/agent/`.
- `debug.layout(label?)` reports root shell, settings drawer, and settings scroller positions. Use it when the UI looks shifted.
- `debug.settings.open()`, `debug.settings.scrollTo(selector, { block? })`, and `debug.settings.click(selector, { block? })` operate inside the settings drawer without scrolling the root app shell.
- `debug.services.state()` reads service selectors, chips, and status text.
- `debug.services.select(slot, label)` selects a TomSelect-backed service by visible label.
- `debug.services.launchSelected()` and `debug.services.stopSelected()` click service controls through DOM events.
- `debug.services.waitFor({ detect?, ocr?, tts? }, { timeout?, timeoutMs?, intervals? })` waits for service chip states.
- `debug.captureText(text, options)`, `debug.hotkey(action)`, `debug.readingPreviewState()`, and `debug.uiState()` use renderer test hooks when available.

## Common commands

Inspect app state:

```bash
npm run pw:exec -- "return await page.evaluate(() => window.__e2e?.getState?.())"
```

Check Electron preload bridge:

```bash
npm run pw:exec -- "return await page.evaluate(() => Boolean(window.electronAPI))"
```

Click a control:

```bash
npm run pw:exec -- "await page.locator('#btn-settings-toggle').click(); return await page.locator('#settings-drawer').getAttribute('aria-hidden')"
```

Click a settings control that may be below the visible drawer fold:

```powershell
@'
await debug.settings.open();
await debug.settings.click('#service-tts-select-ts-control', { block: 'center' });
return await debug.layout('after settings click');
'@ | npm run pw:stdin
```

Prefer `debug.settings.click` over raw `locator.click` for offscreen settings controls. Playwright's built-in scroll-into-view can otherwise try to scroll the Electron root surface instead of the settings pane.

Take a screenshot:

```bash
npm run pw:exec -- "await page.screenshot({ path: 'debug-electron.png', fullPage: true }); return 'debug-electron.png'"
```

Inspect visible text:

```bash
npm run pw:exec -- "return await page.locator('body').innerText()"
```

List attached Electron pages:

```powershell
@'
return await debug.pages();
'@ | npm run pw:stdin
```

Get an AI-readable UI snapshot before deciding what to click:

```powershell
@'
return await debug.snapshot();
'@ | npm run pw:stdin
```

Get a full first-pass inspection report:

```powershell
@'
return await debug.inspect({ logLines: 60 });
'@ | npm run pw:stdin
```

Read recent app logs:

```powershell
@'
return logs.tail({ lines: 40 });
'@ | npm run pw:stdin
```

Filter logs by category:

```powershell
@'
return logs.tail({ lines: 20, category: 'playback' });
'@ | npm run pw:stdin
```

Take a screenshot:

```powershell
@'
return await debug.screenshot({ fullPage: true });
'@ | npm run pw:stdin
```

Save structured debug output under `test-results/agent/`:

```powershell
@'
const report = await debug.inspect({ screenshot: false });
return await debug.saveJson('inspect-report.json', report);
'@ | npm run pw:stdin
```

Fake captured text, play it, and inspect active chunks:

```powershell
@'
const text = [
  'For other uses, see Sherlock Holmes (disambiguation).',
  'Sherlock Holmes is a fictional detective created by British author Arthur Conan Doyle.',
  'Referring to himself as a consulting detective, Holmes is known for observation and deduction.'
].join(' ');

await debug.captureText(text, { autoReader: true, startPlayback: true });
return await debug.readingPreviewState();
'@ | npm run pw:stdin
```

Clear text before cache-sensitive TTS generation tests:

```powershell
@'
await page.evaluate(() => {
  const raw = document.getElementById('raw-text');
  if (!(raw instanceof HTMLTextAreaElement)) throw new Error('Missing #raw-text textarea');
  raw.value = '';
  raw.dispatchEvent(new Event('input', { bubbles: true }));
  raw.dispatchEvent(new Event('change', { bubbles: true }));
});
return await debug.uiState();
'@ | npm run pw:stdin
```

Fake playback hotkeys:

```powershell
@'
await debug.hotkey('next_chunk');
return await debug.uiState();
'@ | npm run pw:stdin
```

Launch selected services, wait for OCR/TTS, write text, and play:

```powershell
@'
await debug.services.select('ocr', 'Hiro-MOSS NVIDIA');
await debug.services.select('tts', 'Supertonic NVIDIA');
await debug.services.launchSelected();
await debug.services.waitFor({ ocr: 'Running', tts: 'Running' }, { timeout: 20 * 60_000 });

const drawer = page.locator('#settings-drawer');
if ((await drawer.getAttribute('aria-hidden').catch(() => 'true')) === 'false') {
  await page.locator('#btn-settings-toggle').click();
  await expect(drawer).toHaveAttribute('aria-hidden', 'true');
}

await page.evaluate(() => {
  const raw = document.getElementById('raw-text');
  if (!(raw instanceof HTMLTextAreaElement)) throw new Error('Missing #raw-text textarea');
  raw.value = 'hello world';
  raw.dispatchEvent(new Event('input', { bubbles: true }));
  raw.dispatchEvent(new Event('change', { bubbles: true }));
});

await page.locator('#btn-play').click();
await expect.poll(async () => {
  return await page.evaluate(() => window.__e2e?.getPlaybackMetrics?.().sessionStarts ?? 0);
}, { timeout: 120000 }).toBeGreaterThan(0);

return await page.evaluate(() => ({
  state: window.__e2e?.getState?.(),
  metrics: window.__e2e?.getPlaybackMetrics?.(),
  services: window.__e2e?.getServiceState?.(),
  statusText: document.getElementById('status-text')?.textContent ?? null
}));
'@ | npm run pw:stdin
```

Inspect service controls without relying on screenshots:

```powershell
@'
return await debug.services.state();
'@ | npm run pw:stdin
```

Run a longer file:

```bash
npm run pw:exec -- --file scripts/debug-snippet.mjs
```

Pipe a snippet:

```bash
printf "return await page.title()" | npm run pw:stdin
```

Bash heredoc for multiline snippets:

```bash
npm run pw:stdin <<'EOF'
await page.locator('#btn-settings-toggle').click();
return await page.locator('#settings-drawer').getAttribute('aria-hidden');
EOF
```

PowerShell here-string for multiline snippets:

```powershell
@'
await page.locator('#btn-settings-toggle').click();
return await page.locator('#settings-drawer').getAttribute('aria-hidden');
'@ | npm run pw:stdin
```

## Debugging guidance

- Use `page.locator(...)`, role locators, and `page.evaluate(...)` for deterministic inspection.
- Use Bash heredocs or PowerShell here-strings for multiline snippets instead of packing complex code into one shell argument.
- Use `window.__e2e` for renderer test hooks when present.
- Use `window.electronAPI` to inspect preload-backed Electron behavior from the renderer.
- Use `logs.tail(...)` before changing code when the bug may involve Electron, service launchers, OCR/TTS requests, or playback timing.
- Use `debug.snapshot()` before guessing selectors on an unfamiliar screen.
- Use `debug.inspect()` for a first-pass report with pages, service state, UI state, recent logs, semantic snapshot, and screenshot path.
- Use `debug.screenshot(...)` for visual context, but pair it with DOM state like `debug.readingPreviewState()` when checking highlights/classes.
- Use `debug.captureText(...)` and `debug.hotkey(...)` instead of real global hotkeys for deterministic bug reproduction.
- Use `--page <pattern>` if multiple pages are attached.
- If the CLI cannot connect, run `npm run pw:doctor`. If it reports a stale or missing endpoint, restart `npm run dev:electron:agent`.
- Treat snippets as arbitrary local code execution; use only in development.

## Self-Maintenance

This skill and its CLI are allowed to evolve. The purpose of `scripts/pw-electron-exec.mjs`, `scripts/electron-agent-dev.mjs`, and this `SKILL.md` is to make agents able to operate the app reliably.

When an agent hits friction while using the Electron UI, it should fix the tool or skill if the problem is repeatable and not just a one-off app bug. Good reasons to patch the tooling:

- A repeated UI flow requires fragile one-off snippets.
- A selector, TomSelect control, hidden drawer, viewport issue, stale CDP endpoint, or launch timing issue makes automation unreliable.
- The agent needs the same inspection data more than once.
- Screenshots or reports are being written to random paths instead of `test-results/agent/`.
- The skill docs describe an old command, port, helper, or app behavior.

Prefer small reusable helpers over adding more single-purpose npm commands. Add helpers to `scripts/pw-electron-exec.mjs`, document them here, and verify with:

```bash
npm run test:pw-exec
npm run check:no-any
```

If the change touches Electron launch behavior, also run:

```bash
npm run pw:doctor
```

Then exercise the helper with a real multiline `npm run pw:stdin` snippet against the running app. Keep generated screenshots, reports, and other artifacts under `test-results/agent/`.

## Live debugging loop

When a bug is confusing, use the CLI as a live diagnostic loop instead of guessing:

1. Capture the current app state, recent logs, and a screenshot before editing code.
2. Reproduce the bug in the same Electron window with `debug.captureText(...)`, `debug.hotkey(...)`, locators, or direct `page.evaluate(...)`.
3. Compare what the UI shows with renderer state and recent log events.
4. Add a tiny temporary log/probe only if the existing logs do not explain the issue.
5. Make the smallest code change, wait for Vite hot reload, and test the exact scenario again.
6. Remove temporary probes before finishing unless they are useful permanent diagnostics.

Good first pass:

```powershell
@'
return await debug.inspect({ logLines: 80 });
'@ | npm run pw:stdin
```

For playback bugs, narrow logs by category and correlate them with DOM state:

```powershell
@'
return {
  status: await page.locator('#status-text').textContent().catch(() => null),
  metrics: await page.evaluate(() => window.__e2e?.getPlaybackMetrics?.()),
  reading: await debug.readingPreviewState(),
  playbackLogs: logs.tail({ lines: 120, category: 'playback' })
};
'@ | npm run pw:stdin
```

For service or provider bugs, read the service/API logs before changing provider code:

```powershell
@'
return {
  ui: await debug.uiState(),
  apiLogs: logs.tail({ lines: 80, category: 'api' }),
  stackLogs: logs.tail({ lines: 80, category: 'stack' }),
  electronLogs: logs.tail({ lines: 80, category: 'electron' })
};
'@ | npm run pw:stdin
```

For hot reload bugs, make a reversible visible probe, verify it appears without `page.reload()`, then revert it and verify it disappears:

```powershell
@'
return {
  markerVisible: await page.getByText('HMR Probe').count(),
  url: page.url(),
  readyState: await page.evaluate(() => document.readyState)
};
'@ | npm run pw:stdin
```

Prefer this style because it gives the agent cause-and-effect evidence: what the renderer believed, what Electron/services logged, what the user could see, and whether the fix changed the live app.

## Common mistakes

- Do not use `--stdin` through `npm run pw:exec`; npm may swallow or reinterpret it. Use `npm run pw:stdin`.
- Do not use one npm command per UI action. Put the flow in a multiline `pw:stdin` snippet, and add reusable helpers to `scripts/pw-electron-exec.mjs` when a pattern repeats.
- Do not click controls behind the settings drawer. If Playwright says `#settings-drawer` intercepts pointer events, close it with `#btn-settings-toggle` first.
- Do not raw-click service launch controls when viewport/layout can hide them. Use `debug.services.launchSelected()` and `debug.services.stopSelected()`.
- Do not set TomSelect-backed service dropdown DOM values directly. Use `debug.services.select(slot, label)` so the visible selection and renderer state update together.
- Do not wait for text processing to run when the selected text processing service is `__none__`; wait for OCR and TTS chips for playback.
- Do not assume writing `textarea.value` is enough. Dispatch `input` and `change` events after setting `#raw-text`.
- Do not test fresh TTS generation by writing the exact same text over existing text. The app reuses matching chunks and cached audio for efficiency. Clear `#raw-text` first, dispatch `input`/`change`, then write the test text.
- Do not rely only on screenshots to decide whether highlighting is correct. Check `.active-chunk` through `debug.readingPreviewState()`.
- Do not send real OS/global hotkeys when a fake `debug.hotkey(...)` or `debug.captureText(...)` path can test the same renderer behavior.
- Do not ignore recent logs; `logs.tail({ category: 'playback' })` often explains chunk/session timing.
- Do not write screenshots/reports to random repo paths. Prefer `debug.screenshot()`, `debug.writeFile(...)`, and `debug.saveJson(...)`, which default to `test-results/agent/`.
- Do not close the browser or Electron app from snippets unless explicitly asked. The CLI already disconnects without closing the dev window.
