from __future__ import annotations

from paddle_text_processing import cli


def test_parse_args() -> None:
    args = cli.parse_args(["serve", "--device", "cpu", "--det-model-dir", "models/det"])

    assert args.cmd == "serve"
    assert args.device == "cpu"
    assert args.det_model_dir == "models/det"


def test_main_starts_server(monkeypatch) -> None:
    captured: dict[str, object] = {}

    original_parse_args = cli.parse_args
    monkeypatch.setattr(cli, "parse_args", lambda: original_parse_args(["serve", "--device", "cpu"]))
    monkeypatch.setattr(cli, "resolve_device", lambda device: None)
    monkeypatch.setattr(cli, "create_app", lambda config: (captured.setdefault("config", config), object())[1])
    monkeypatch.setattr(cli.uvicorn, "run", lambda app, host, port: captured.update({"app": app, "host": host, "port": port}))

    cli.main()

    config = captured["config"]
    assert getattr(config, "device") == "cpu"
    assert getattr(config, "det_model_dir") is None
    assert captured["host"] == "127.0.0.1"
    assert captured["port"] == 8093
