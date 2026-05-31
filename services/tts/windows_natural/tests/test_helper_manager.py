from __future__ import annotations

import pytest

from tts_windows_natural_adapter import helper_manager


def test_read_extra_voice_roots() -> None:
    roots = helper_manager.read_extra_voice_roots({"WINDOWS_NATURAL_VOICE_PATHS": r"C:\Voices\Sonia;D:\Voices\Ryan"})
    assert roots == [r"C:\Voices\Sonia", r"D:\Voices\Ryan"]


def test_find_csc_exists() -> None:
    assert helper_manager.find_csc().exists()


def test_all_voice_roots_deduplicates(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(helper_manager, "discover_installed_voice_roots", lambda: [r"C:\Voices\Sonia"])
    roots = helper_manager.all_voice_roots({"WINDOWS_NATURAL_VOICE_PATHS": r"C:\Voices\Sonia;D:\Voices\Ryan"})
    assert roots == [r"C:\Voices\Sonia", r"D:\Voices\Ryan"]
