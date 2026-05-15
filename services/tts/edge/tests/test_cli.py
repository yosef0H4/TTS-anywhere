from __future__ import annotations

import os
import time
from pathlib import Path
from types import SimpleNamespace

from tts_edge_adapter import cli


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


def test_hb_stale_after_interval_and_grace(tmp_path: Path) -> None:
    hb = tmp_path / "hb.json"
    hb.write_text("{}", encoding="utf-8")
    now = time.time()
    os.utime(hb, (now - 5, now - 5))

    cfg = cli.OwnerCfg(hb, 1000, 3000)

    assert cli.hb_stale(cfg, now=now) is True


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

    monkeypatch.setattr(cli, "create_app", lambda: app)
    monkeypatch.setattr(cli, "read_owner_cfg", lambda: cfg)
    monkeypatch.setattr(cli, "start_owner_watchdog", fake_watchdog)
    monkeypatch.setattr(cli.uvicorn, "Config", fake_config)
    monkeypatch.setattr(cli.uvicorn, "Server", FakeServer)

    exit_code = cli.cmd_serve(SimpleNamespace(host="127.0.0.1", port=8012))

    assert exit_code == 0
    assert captured["app"] is app
    assert captured["host"] == "127.0.0.1"
    assert captured["port"] == 8012
    assert captured["owner_cfg"] == cfg
    assert captured["run"] is True