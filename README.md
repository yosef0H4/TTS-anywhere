# TTS Anywhere

TTS Anywhere is a desktop app for grabbing text from anywhere on your screen, cleaning it up when needed, and listening to it immediately. It is built around the Electron app experience first: capture a region, a full screen, the active window, or an image from your clipboard, run OCR, and send the result straight into playback.

The app treats cloud and local providers as equal options. It has native support for the Google Gemini SDK, OpenAI-compatible APIs, and local OCR/TTS adapters. In practice, many people will likely use cloud providers, but the app is built so either path can be the main one.

## What It Feels Like to Use

- Select part of your screen and have the extracted text read out loud right away.
- Capture the active window or the full screen with dedicated hotkeys.
- Paste an image from the clipboard when you already have the screenshot.
- Open the preprocessing lab when OCR needs help with noisy, low-contrast, or cluttered images.
- Let OCR feed directly into TTS, then edit the text if you want a second pass.
- Use the editor as a place to paste text, write your own text, or clean up something that was already read.
- Switch between providers without changing how you use the app.

## Best Way to Run It

The main experience is the Electron app.

Install dependencies:

```bash
npm install
```

Run the desktop app in development:

```bash
npm run dev:electron
```

Build the desktop app:

```bash
npm run build:electron
```

Build the Windows distributable:

```bash
npm run dist:win
```

If you only want the browser renderer during development:

```bash
npm run dev:web
```

## Common Workflows

### Capture text from the screen

Use the capture hotkeys or the app controls to:

- select a region
- capture the full screen
- capture the active window
- replay the last capture

The normal flow is OCR into immediate playback. The captured text is also available in the editor if you want to fix it, replace it, paste something else in, or run it again.

### OCR an existing image

You can paste an image from the clipboard or load one into the app, then run OCR on it the same way you would with a screen capture.

### Use the preprocessing lab

The preprocessing lab is for images that are hard to read cleanly on the first pass. Use it when text is small, blurry, low-contrast, or mixed with UI chrome. Box-based text region detection in the lab depends on a local RapidOCR or PaddleOCR service. If you want detection boxes and region-aware preprocessing, you need one of those local services running.

### Listen with TTS

OCR normally starts the readout immediately. The editor is still there for manual use: paste text, write your own text, fix OCR mistakes, or rerun playback with edited text. Playback controls let you pause, resume, skip through chunks, replay the latest capture, or adjust volume.

## Provider Support

### Cloud / API Support

| Provider path | What it supports |
| --- | --- |
| Gemini SDK | Google Gemini models through the native `@google/genai` SDK, including Gemini OCR/text flows and Gemini TTS |
| OpenAI-compatible API | Any service that exposes OpenAI-style OCR/chat and/or TTS endpoints. This includes hosted providers and local adapters |

### Local OCR Support

| Local stack | Type | Notes |
| --- | --- | --- |
| PaddleOCR service | Local OCR + text detection | Recommended managed local OCR stack; supports CPU and GPU launch paths |
| RapidOCR service | Local OCR + text detection | Lightweight local OCR alternative |
| H2OVL Mississippi | Local OCR | OpenAI-compatible GPU OCR service for `h2oai/h2ovl-mississippi-800m` |

### Local TTS Support

| Local stack | Type | Notes |
| --- | --- | --- |
| Edge TTS adapter | Local adapter / online voice service | Lightweight OpenAI-compatible TTS path exposed locally |
| KittenTTS adapter | Local TTS | CPU-oriented OpenAI-compatible adapter for KittenTTS |
| Kokoro adapter | Local TTS | OpenAI-compatible GPU TTS |
| Piper adapter | Local TTS | Lightweight OpenAI-compatible Piper backend |

## Notes on Local Services

- You do not need local OCR or TTS services for the basic cloud-provider flow.
- Cloud and local providers are both first-class options in the app.
- Local services are useful when you want self-hosting, lower cloud usage, or tighter control over preprocessing and model selection.
- Detection boxes and the full local preprocessing flow require a local RapidOCR or PaddleOCR service.
- The UI can launch the recommended managed local services directly for Paddle OCR + Detection and Edge TTS.

## Development

Useful commands:

```bash
npm run typecheck
npm run test
npm run build:web
npm run build:electron
```

The Python adapters and OCR services live under `services/` and have their own READMEs if you want to run or modify them directly.
