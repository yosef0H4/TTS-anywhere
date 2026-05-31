from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[2]
BUILD_DIR = PROJECT_ROOT / ".build" / "windows-natural-helper"
CSHARP_DLL = "Microsoft.CognitiveServices.Speech.csharp.dll"
SPEECH_VERSION = "1.41.1"
PACKAGE_URLS = {
    "speech": f"https://www.nuget.org/api/v2/package/Microsoft.CognitiveServices.Speech/{SPEECH_VERSION}",
    "embedded": f"https://www.nuget.org/api/v2/package/Microsoft.CognitiveServices.Speech.Extension.Embedded.TTS/{SPEECH_VERSION}",
    "onnx": f"https://www.nuget.org/api/v2/package/Microsoft.CognitiveServices.Speech.Extension.ONNX.Runtime/{SPEECH_VERSION}",
    "telemetry": f"https://www.nuget.org/api/v2/package/Microsoft.CognitiveServices.Speech.Extension.Telemetry/{SPEECH_VERSION}",
    "naudio": "https://www.nuget.org/api/v2/package/NAudio/1.10.0",
}
RUNTIME_DLL_SOURCES = {
    "speech": Path("speech/runtimes/win-x64/native"),
    "embedded": Path("embedded/runtimes/win-x64/native"),
    "onnx": Path("onnx/runtimes/win-x64/native"),
    "telemetry": Path("telemetry/runtimes/win-x64/native"),
}
CSC_CANDIDATES = (
    Path(r"C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
    Path(r"C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe"),
)
HELPER_EXE = BUILD_DIR / "windows_natural_helper.exe"
SYSTEM_SPEECH_SYNTHESIZER_DIR = Path(
    r"C:\Windows\SystemApps\MicrosoftWindows.Client.Core_cw5n1h2txyewy\SpeechSynthesizer"
)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Prepare the Windows natural helper")
    parser.add_argument("--prepare", action="store_true")
    return parser.parse_args(argv)


def find_csc() -> Path:
    for candidate in CSC_CANDIDATES:
        if candidate.exists():
            return candidate
    raise RuntimeError("Could not find the .NET Framework C# compiler (csc.exe).")


def cache_dir() -> Path:
    return PROJECT_ROOT / ".cache" / "windows-natural-sdk"


def _download(url: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(url) as response, destination.open("wb") as handle:
        shutil.copyfileobj(response, handle)


def ensure_sdk_packages() -> Path:
    root = cache_dir()
    root.mkdir(parents=True, exist_ok=True)
    for name, url in PACKAGE_URLS.items():
        package_dir = root / name
        if package_dir.exists():
            continue
        package_dir.mkdir(parents=True, exist_ok=True)
        archive_path = root / f"{name}.zip"
        if not archive_path.exists():
            _download(url, archive_path)
        shutil.unpack_archive(str(archive_path), str(package_dir), "zip")
    return root


def compile_helper() -> Path:
    sdk_root = ensure_sdk_packages()
    BUILD_DIR.mkdir(parents=True, exist_ok=True)
    helper_source = PROJECT_ROOT / "src" / "tts_windows_natural_adapter" / "windows_natural_helper.cs"
    csc = find_csc()
    compile_cmd = [
        str(csc),
        "/nologo",
        "/target:exe",
        f"/out:{HELPER_EXE}",
        "/reference:System.Web.Extensions.dll",
        f"/reference:{sdk_root / 'speech' / 'lib' / 'net462' / CSHARP_DLL}",
        f"/reference:{sdk_root / 'naudio' / 'lib' / 'net35' / 'NAudio.dll'}",
        str(helper_source),
    ]
    subprocess.run(compile_cmd, cwd=PROJECT_ROOT, check=True)

    copy_helper_runtime(sdk_root)
    return HELPER_EXE


def copy_helper_runtime(sdk_root: Path) -> None:
    shutil.copy2(sdk_root / "speech" / "lib" / "net462" / CSHARP_DLL, BUILD_DIR / CSHARP_DLL)
    shutil.copy2(sdk_root / "naudio" / "lib" / "net35" / "NAudio.dll", BUILD_DIR / "NAudio.dll")
    for relative in RUNTIME_DLL_SOURCES.values():
        source_dir = sdk_root / relative
        for dll in source_dir.glob("*.dll"):
            shutil.copy2(dll, BUILD_DIR / dll.name)
    if SYSTEM_SPEECH_SYNTHESIZER_DIR.exists():
        for dll in SYSTEM_SPEECH_SYNTHESIZER_DIR.glob("*.dll"):
            shutil.copy2(dll, BUILD_DIR / dll.name)


def ensure_helper() -> Path:
    helper_source = PROJECT_ROOT / "src" / "tts_windows_natural_adapter" / "windows_natural_helper.cs"
    if HELPER_EXE.exists() and HELPER_EXE.stat().st_mtime >= helper_source.stat().st_mtime:
        copy_helper_runtime(ensure_sdk_packages())
        return HELPER_EXE
    return compile_helper()


def discover_installed_voice_roots() -> list[str]:
    if os.name != "nt":
        return []
    script = (
        "Get-AppxPackage | "
        "Where-Object { $_.Name -like 'MicrosoftWindows.Voice.*' -and $_.InstallLocation } | "
        "Select-Object -ExpandProperty InstallLocation"
    )
    result = subprocess.run(
        ["powershell", "-NoProfile", "-Command", script],
        cwd=PROJECT_ROOT,
        capture_output=True,
        text=True,
        check=True,
    )
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def read_extra_voice_roots(env: dict[str, str] | None = None) -> list[str]:
    source = env or os.environ
    raw = source.get("WINDOWS_NATURAL_VOICE_PATHS", "").strip()
    if not raw:
        return []
    return [part.strip() for part in raw.split(";") if part.strip()]


def all_voice_roots(env: dict[str, str] | None = None) -> list[str]:
    seen: set[str] = set()
    roots: list[str] = []
    ordered_roots = [
        *read_extra_voice_roots(env),
        *discover_installed_voice_roots(),
    ]
    for root in ordered_roots:
        normalized = str(Path(root))
        if normalized in seen:
            continue
        seen.add(normalized)
        roots.append(normalized)
    return roots


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.prepare:
        helper = ensure_helper()
        payload = {
            "helper_exe": str(helper),
            "voice_roots": all_voice_roots(),
        }
        print(json.dumps(payload))
        return 0
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
