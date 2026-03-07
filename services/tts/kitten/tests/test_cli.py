from __future__ import annotations

from pathlib import Path

from tts_kitten_adapter import cli
from tts_kitten_adapter.app import KITTEN_MODELS


def test_parse_models_command(monkeypatch, capsys) -> None:
    original_parse_args = cli.argparse.ArgumentParser.parse_args
    monkeypatch.setattr(cli.argparse.ArgumentParser, "parse_args", lambda self: original_parse_args(self, ["models"]))

    exit_code = cli.main()
    output = capsys.readouterr().out

    assert exit_code == 0
    assert KITTEN_MODELS[0] in output


def test_voices_command_uses_selected_model(monkeypatch, capsys) -> None:
    captured: dict[str, object] = {}

    class FakeRuntime:
        def __init__(self, settings) -> None:
            captured["settings"] = settings

        def get_available_voices(self, model_id: str) -> list[str]:
            captured["model_id"] = model_id
            return ["Bella"]

    original_parse_args = cli.argparse.ArgumentParser.parse_args
    monkeypatch.setattr(cli.argparse.ArgumentParser, "parse_args", lambda self: original_parse_args(self, ["voices", "--model", KITTEN_MODELS[1]]))
    monkeypatch.setattr(cli, "KittenRuntime", FakeRuntime)

    exit_code = cli.main()
    output = capsys.readouterr().out

    assert exit_code == 0
    assert captured["model_id"] == KITTEN_MODELS[1]
    assert "Bella" in output


def test_synth_command_passes_model_and_voice(monkeypatch, tmp_path: Path) -> None:
    captured: dict[str, object] = {}

    class FakeRuntime:
        def __init__(self, settings) -> None:
            captured["settings"] = settings

        def synth_to_wav(self, text: str, model_id: str, voice: str, speed: float) -> bytes:
            captured["call"] = {"text": text, "model_id": model_id, "voice": voice, "speed": speed}
            return b"wav-bytes"

    original_parse_args = cli.argparse.ArgumentParser.parse_args
    monkeypatch.setattr(
        cli.argparse.ArgumentParser,
        "parse_args",
        lambda self: original_parse_args(
            self,
            [
                "synth",
                "--model",
                KITTEN_MODELS[2],
                "--voice",
                "Bella",
                "--speed",
                "1.2",
                "--text",
                "hello",
                "--out",
                str(tmp_path / "out.wav"),
            ],
        ),
    )
    monkeypatch.setattr(cli, "KittenRuntime", FakeRuntime)

    exit_code = cli.main()

    assert exit_code == 0
    assert captured["call"] == {"text": "hello", "model_id": KITTEN_MODELS[2], "voice": "Bella", "speed": 1.2}
    assert (tmp_path / "out.wav").read_bytes() == b"wav-bytes"
