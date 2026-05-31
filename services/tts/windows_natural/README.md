# TTS Windows Natural Adapter

OpenAI-compatible TTS adapter for local Windows Narrator natural voices such as `Microsoft Sonia (Natural)` and `Microsoft Ryan (Natural)`.

## What This Service Does

- Serves `/v1/audio/speech` with OpenAI-style speech synthesis.
- Exposes `/v1/models`, `/v1/voices`, `/v1/audio/voices`, and `/healthz`.
- Discovers installed Windows Settings/Narrator natural voice AppX packages.
- Builds a small C# helper locally at launch time.
- Generates WAV audio through the embedded Speech SDK file-output path, not by playing through a speaker or recording loopback.
- Extracts required local runtime material from the user's installed Windows speech runtime in memory at runtime.
- Exposes only voices that pass a real synthesis probe.

## Requirements

- Windows 11 x64 is the target runtime. Microsoft documents embedded speech on Windows as requiring Windows 11 or newer on x64 or Arm64.
- `uv` must be installed and available on `PATH`.
- .NET Framework C# compiler must exist at one of:
  - `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`
  - `C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe`
- Microsoft Visual C++ Redistributable 2015-2022 should be installed. Microsoft lists it as required for Speech SDK usage.
- At least one local Narrator natural voice must be installed by the user through Windows Settings.
- The Windows packaged speech runtime must exist locally, normally under:
  - `C:\Windows\SystemApps\MicrosoftWindows.Client.Core_cw5n1h2txyewy\SpeechSynthesizer`
  - `C:\Windows\SystemApps\MicrosoftWindows.Client.Core_cw5n1h2txyewy\SpeechSynthesizerExtension.dll`

## Installing Voices

Install voices from Windows:

1. Open Narrator settings with `Windows logo key + Ctrl + N`.
2. Find Narrator voice settings.
3. Use `Add natural voices`.
4. Install the desired voice, for example Ryan or Sonia.
5. Start this service and check `/v1/voices`.

Microsoft's Narrator documentation describes the `Add natural voices` flow in Narrator settings. Do not commit downloaded voice packages, extracted AppX packages, or copied Windows runtime files to this repo.

## Running

```powershell
cd services\tts\windows_natural
uv sync --group dev
uv run python -m tts_windows_natural_adapter.helper_manager --prepare
uv run tts-windows-natural --host 127.0.0.1 --port 8016
```

Or from the repo root:

```powershell
.\services\tts\windows_natural\scripts\host.bat
```

## Runtime Downloads And Local Files

The service downloads NuGet packages into `.cache/windows-natural-sdk` to build the local helper. These packages are third-party/Microsoft redistributables governed by their own licenses and must stay out of git.

The helper build output in `.build/windows-natural-helper` includes compiled code plus copied DLLs from NuGet and from the local Windows installation. This directory must stay out of git.

Installed Windows natural voice packages under `C:\Program Files\WindowsApps\MicrosoftWindows.Voice.*` are user-installed Microsoft packages. They are discovered and read from their installed location only. They must not be copied into this repository.

## Copyright And Secret Material Policy

- Do not commit Microsoft voice packages, extracted `.msix` content, copied Windows DLLs, NuGet package contents, generated helper binaries, analysis dumps, or acceptance audio files.
- Do not hardcode extracted runtime keys, license strings, or long proprietary strings in source.
- Runtime extraction must be in memory only.
- Do not persist extracted key/license material to disk, logs, JSON health output, test fixtures, or snapshots.
- If a user wants to use an unpacked legacy voice folder, they must provide their own local path through `WINDOWS_NATURAL_VOICE_PATHS`.
- This service does not auto-download voice packages.

## Configuration

- `WINDOWS_NATURAL_VOICE_PATHS`: optional semicolon-separated list of user-supplied local voice folders.
- `WINDOWS_NATURAL_DEFAULT_VOICE`: optional default voice id, for example `windows-natural:en-GB:RyanNeural`.
- `API_KEY`: optional bearer token for local API auth.

## Outputs

- `/v1/audio/speech` currently returns WAV only.
- Unsupported `response_format` values are rejected.
- Installed natural voices use direct embedded synthesis and should not produce audible playback during generation.

## References

- Microsoft Embedded Speech documentation: https://learn.microsoft.com/en-us/azure/ai-services/speech-service/embedded-speech
- Microsoft Narrator voice settings documentation: https://support.microsoft.com/en-us/windows/chapter-7-customizing-narrator-ce950246-c915-0d44-9be6-fb474387a285
- Microsoft Cognitive Services Speech SDK NuGet package: https://www.nuget.org/packages/Microsoft.CognitiveServices.Speech
