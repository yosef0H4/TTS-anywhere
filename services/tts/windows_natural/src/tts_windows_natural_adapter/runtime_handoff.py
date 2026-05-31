from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any


PACKAGE_ROOT = Path(__file__).resolve().parents[2]
PROJECT_ROOT = PACKAGE_ROOT
ANALYSIS_ROOT = PROJECT_ROOT / ".analysis"
NARRATOR_ANALYSIS_ROOT = ANALYSIS_ROOT / "narrator"
WATCH_ROOT = PROJECT_ROOT.parent / ".analysis" / "narrator-watch"


@dataclass(frozen=True)
class Candidate:
    address: str
    label: str
    reason: str


CANDIDATES: tuple[Candidate, ...] = (
    Candidate(
        address="140020f6c",
        label="speech_extension_activation",
        reason="Uses WindowsUdk.Speech.SpeechSynthesizerExtension and appears to create the extension-backed object.",
    ),
    Candidate(
        address="140025fa8",
        label="vendor_preferred_provider_selection",
        reason="Builds VendorPreferred and appears to select the preferred extension/provider.",
    ),
    Candidate(
        address="14001f2b0",
        label="app_extension_catalog_activation",
        reason="Activates Windows.ApplicationModel.AppExtensions.AppExtensionCatalog.",
    ),
    Candidate(
        address="14001f3c8",
        label="extension_factory_activation",
        reason="Activates WindowsUdk.ApplicationModel.AppExtensions.ExtensionFactory.",
    ),
    Candidate(
        address="1400230c0",
        label="speech_synthesizer_stop_path",
        reason="Manipulates the m_speechSynthesizer-like object and exposes object lifetime/layout clues.",
    ),
)


def _read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _parse_utc(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _load_functions() -> list[dict[str, Any]]:
    return _read_json(NARRATOR_ANALYSIS_ROOT / "Narrator.exe_functions.json")["functions"]


def _find_function(functions: list[dict[str, Any]], address: str) -> dict[str, Any] | None:
    for fn in functions:
        if fn.get("address", "").lower() == address.lower():
            return fn
    return None


def _load_decompiled_lines() -> list[str]:
    return (NARRATOR_ANALYSIS_ROOT / "Narrator.exe_decompiled.c").read_text(encoding="utf-8").splitlines()


def _extract_line_window(lines: list[str], address: str, radius: int = 12) -> list[str]:
    marker = f"Function: FUN_{address}"
    for idx, line in enumerate(lines):
        if marker in line:
            start = max(0, idx - radius)
            end = min(len(lines), idx + radius + 1)
            return [f"{i + 1}:{lines[i]}" for i in range(start, end)]
    return []


def _load_watch_summary() -> dict[str, Any]:
    latest = WATCH_ROOT / "latest.json"
    if latest.exists():
        return _read_json(latest)
    return {}


def _interesting_window(summary: dict[str, Any]) -> dict[str, Any]:
    events: list[dict[str, Any]] = summary.get("interesting_events", {}).get("sample", [])
    narrator_events = [e for e in events if e.get("provider") == "Microsoft-Windows-Narrator"]
    narrator_events.sort(key=lambda e: e.get("time_created", ""))

    first_time = _parse_utc(narrator_events[0]["time_created"]) if narrator_events else None
    if not first_time:
        return {
            "narrator_events": [],
            "comruntime_events_nearby": [],
            "window_start_utc": None,
            "window_end_utc": None,
        }

    window_start = first_time - timedelta(milliseconds=250)
    window_end = first_time + timedelta(seconds=1)

    def in_window(event: dict[str, Any]) -> bool:
        ts = _parse_utc(event.get("time_created"))
        return ts is not None and window_start <= ts <= window_end

    filtered = [e for e in events if in_window(e)]
    return {
        "window_start_utc": window_start.isoformat(),
        "window_end_utc": window_end.isoformat(),
        "narrator_events": [e for e in filtered if e.get("provider") == "Microsoft-Windows-Narrator"],
        "comruntime_events_nearby": [e for e in filtered if e.get("provider") == "Microsoft-Windows-COMRuntime"],
        "other_events_nearby": [
            e
            for e in filtered
            if e.get("provider") not in {"Microsoft-Windows-Narrator", "Microsoft-Windows-COMRuntime"}
        ],
    }


def analyze_runtime_handoff() -> dict[str, Any]:
    functions = _load_functions()
    lines = _load_decompiled_lines()
    watch = _load_watch_summary()

    candidates: list[dict[str, Any]] = []
    for candidate in CANDIDATES:
        fn = _find_function(functions, candidate.address)
        candidates.append(
            {
                "address": candidate.address,
                "label": candidate.label,
                "reason": candidate.reason,
                "function": fn,
                "decompiled_window": _extract_line_window(lines, candidate.address),
            }
        )

    return {
        "target_text": watch.get("target_text"),
        "watch_phase": watch.get("phase"),
        "narrator_voice": (watch.get("before_snapshot") or {}).get("narrator_registry", {}).get("SpeechVoice"),
        "event_window": _interesting_window(watch),
        "candidates": candidates,
    }
