---
name: electron-playwright-cli
description: Use this repo's Electron Playwright CLI to inspect and control the running TTS Anywhere Electron dev window from coding agents. Trigger when debugging renderer behavior, Electron preload APIs, app state, settings UI, service UI, screenshots, console/page errors, or when asked to automate this project's dev window through CLI commands instead of MCP.
---

# Electron Playwright CLI

Use the repo CLI. Do not configure or use MCP for this project.

## Start the app

Run the debug Electron dev process first:

```bash
npm run dev:electron:debug
```

This opens the normal dev app and exposes a localhost-only CDP endpoint on `http://127.0.0.1:9222`.

## Execute snippets

Run Playwright code against the same Electron renderer window:

```bash
npm run pw:exec -- "return await page.title()"
```

Available variables are `page`, `context`, `browser`, `expect`, `fs`, `path`, `logs`, and `debug`. Snippets run inside an async function, so use `await` and `return`.

Prefer `npm run pw:stdin` for anything more than a tiny one-liner. It avoids shell quoting mistakes and is easier for coding agents to revise. Prefer Playwright locators and `page.evaluate`. Avoid pixel or coordinate interaction unless there is no semantic alternative.

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

Take a screenshot:

```bash
npm run pw:exec -- "await page.screenshot({ path: 'debug-electron.png', fullPage: true }); return 'debug-electron.png'"
```

Inspect visible text:

```bash
npm run pw:exec -- "return await page.locator('body').innerText()"
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
return await debug.screenshot({ path: 'test-results/agent-window.png', fullPage: true });
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
await page.locator('#btn-launch-selected-services').click();

const readServices = async () => ({
  ocr: (await page.locator('#service-ocr-status-chip').textContent())?.trim(),
  tts: (await page.locator('#service-tts-status-chip').textContent())?.trim(),
  ttsUrl: await page.locator('#tts-url').inputValue().catch(() => '')
});

await expect.poll(readServices, {
  timeout: 20 * 60_000,
  intervals: [1000, 2000, 5000, 10000]
}).toMatchObject({
  ocr: 'Running',
  tts: 'Running'
});

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
  statusText: document.getElementById('status-text')?.textContent ?? null
}));
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
- Use `debug.screenshot(...)` for visual context, but pair it with DOM state like `debug.readingPreviewState()` when checking highlights/classes.
- Use `debug.captureText(...)` and `debug.hotkey(...)` instead of real global hotkeys for deterministic bug reproduction.
- Use `--page <pattern>` if multiple pages are attached.
- If the CLI cannot connect, start or restart `npm run dev:electron:debug`.
- Treat snippets as arbitrary local code execution; use only in development.

## Common mistakes

- Do not use `--stdin` through `npm run pw:exec`; npm may swallow or reinterpret it. Use `npm run pw:stdin`.
- Do not click controls behind the settings drawer. If Playwright says `#settings-drawer` intercepts pointer events, close it with `#btn-settings-toggle` first.
- Do not wait for text processing to run when the selected text processing service is `__none__`; wait for OCR and TTS chips for playback.
- Do not assume writing `textarea.value` is enough. Dispatch `input` and `change` events after setting `#raw-text`.
- Do not rely only on screenshots to decide whether highlighting is correct. Check `.active-chunk` through `debug.readingPreviewState()`.
- Do not send real OS/global hotkeys when a fake `debug.hotkey(...)` or `debug.captureText(...)` path can test the same renderer behavior.
- Do not ignore recent logs; `logs.tail({ category: 'playback' })` often explains chunk/session timing.
- Do not close the browser or Electron app from snippets unless explicitly asked. The CLI already disconnects without closing the dev window.
