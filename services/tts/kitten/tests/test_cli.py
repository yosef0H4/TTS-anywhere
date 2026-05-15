from __future__ import annotations

import os
import time
from pathlib import Path
from types import SimpleNamespace

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


def test_read_owner_cfg_is_opt_in(tmp_path: Path) -> None:
    assert cli.read_owner_cfg({}) is None

    cfg = cli.read_owner_cfg(
        {
            "TTS_ANYWHERE_OWNER_MODE": "heartbeat-file",
            "TTS_ANYWHERE_OWNER_HEARTBEAT_FILE": str(tmp_path / "hb.json"),
            "TTS_ANYWHERE_OWNER_HEARTBEAT_INTERVAL_MS": "1500",
            "TTS_ANYWHERE_OWNER_GRACE_MS": "7000",
        }
    )

    assert cfg == cli.OwnerCfg(tmp_path / "hb.json", 1500, 7000)


def test_hb_stale_when_missing(tmp_path: Path) -> None:
    cfg = cli.OwnerCfg(tmp_path / "missing.json", 1000, 3000)

    assert cli.hb_stale(cfg) is True


def test_cmd_serve_uses_server_and_watchdog(monkeypatch, tmp_path: Path) -> None:
    captured: dict[str, object] = {}
    app = object()
    cfg = cli.OwnerCfg(tmp_path / "hb.json", 1000, 3000)

    class FakeServer:
        def __init__(self, config) -> None:
            captured["config"] = config
            self.should_exit = False

        def run(self) -> None:
            captured["run"] = True

    def fake_config(app_obj, host: str, port: int):
        captured["app"] = app_obj
        captured["host"] = host
        captured["port"] = port
        return object()

    def fake_watchdog(server, owner_cfg):
        captured["server"] = server
        captured["owner_cfg"] = owner_cfg
        return cli.threading.Event()

    monkeypatch.setattr(cli, "Settings", lambda: SimpleNamespace(port=8014))
    monkeypatch.setattr(cli, "create_app", lambda settings: app)
    monkeypatch.setattr(cli, "read_owner_cfg", lambda: cfg)
    monkeypatch.setattr(cli, "start_owner_watchdog", fake_watchdog)
    monkeypatch.setattr(cli.uvicorn, "Config", fake_config)
    monkeypatch.setattr(cli.uvicorn, "Server", FakeServer)

    exit_code = cli.cmd_serve(SimpleNamespace(host="127.0.0.1", port=None))

    assert exit_code == 0
    assert captured["app"] is app
    assert captured["host"] == "127.0.0.1"
    assert captured["port"] == 8014
    assert captured["owner_cfg"] == cfg
    assert captured["run"] is True
