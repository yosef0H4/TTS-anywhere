from __future__ import annotations

import importlib
import sys
import types

import pytest


def _load_cli_module() -> object:
    fake_torch = types.SimpleNamespace(
        library=types.SimpleNamespace(register_fake=lambda name, func=None: func, _original_register_fake=lambda name, func=None: func)
    )
    sys.modules["torch"] = fake_torch
    sys.modules.pop("h2ovl_text_processing.app", None)
    sys.modules.pop("h2ovl_text_processing.cli", None)
    return importlib.import_module("h2ovl_text_processing.cli")


def test_parse_args_for_serve() -> None:
    cli = _load_cli_module()
    args = cli.parse_args(["serve", "--host", "127.0.0.1", "--port", "8095"])

    assert args.cmd == "serve"
    assert args.host == "127.0.0.1"
    assert args.port == 8095


def test_main_starts_server(monkeypatch: pytest.MonkeyPatch) -> None:
    cli = _load_cli_module()
    captured: dict[str, object] = {}
    args = cli.parse_args(["serve"])

    monkeypatch.setattr(cli, "parse_args", lambda argv=None: args)
    monkeypatch.setattr(cli, "create_app", lambda config: (captured.setdefault("config", config), object())[1])
    monkeypatch.setattr(cli.uvicorn, "run", lambda app, host, port: captured.update({"app": app, "host": host, "port": port}))

    cli.main()

    assert captured["host"] == "127.0.0.1"
    assert captured["port"] == 8095
