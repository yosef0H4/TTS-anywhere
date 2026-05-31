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


def test_discover_installed_voice_roots_falls_back_without_powershell(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    voice_root = tmp_path / "MicrosoftWindows.Voice.en-GB.Ryan.1_1.0.4.0_x64__cw5n1h2txyewy"
    voice_root.mkdir()
    (voice_root / "Tokens.xml").write_text("<Tokens />", encoding="utf-8")
    (tmp_path / "MicrosoftWindows.Voice.en-GB.Empty.1_1.0.4.0_x64__cw5n1h2txyewy").mkdir()

    monkeypatch.setattr(helper_manager.os, "name", "nt")
    monkeypatch.setattr(helper_manager, "WINDOWS_APPS_DIR", tmp_path)
    monkeypatch.setattr(helper_manager, "find_powershell", lambda: None)

    assert helper_manager.discover_installed_voice_roots() == [str(voice_root)]
