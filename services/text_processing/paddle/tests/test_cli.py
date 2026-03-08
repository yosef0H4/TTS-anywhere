from __future__ import annotations

from paddle_text_processing import cli


def test_parse_args() -> None:
    args = cli.parse_args(
        [
            "serve",
            "--enable-detect",
            "--enable-openai-ocr",
            "--detect-device",
            "cpu",
            "--ocr-device",
            "gpu",
            "--detect-model-dir",
            "models/det",
            "--ocr-recognition-model-dir",
            "models/rec",
        ]
    )

    assert args.cmd == "serve"
    assert args.enable_detect is True
    assert args.enable_openai_ocr is True
    assert args.detect_device == "cpu"
    assert args.ocr_device == "gpu"
    assert args.detect_model_dir == "models/det"
    assert args.ocr_recognition_model_dir == "models/rec"


def test_main_starts_server(monkeypatch) -> None:
    captured: dict[str, object] = {}

    original_parse_args = cli.parse_args
    monkeypatch.setattr(
        cli,
        "parse_args",
        lambda: original_parse_args(["serve", "--enable-detect", "--enable-openai-ocr", "--detect-device", "cpu", "--ocr-device", "cpu"]),
    )
    monkeypatch.setattr(cli, "resolve_device", lambda device: None)
    monkeypatch.setattr(cli, "create_app", lambda config: (captured.setdefault("config", config), object())[1])
    monkeypatch.setattr(cli.uvicorn, "run", lambda app, host, port: captured.update({"app": app, "host": host, "port": port}))

    cli.main()

    config = captured["config"]
    assert getattr(config, "enable_detect") is True
    assert getattr(config, "enable_openai_ocr") is True
    assert getattr(config, "detect_device") == "cpu"
    assert getattr(config, "ocr_device") == "cpu"
    assert captured["host"] == "127.0.0.1"
    assert captured["port"] == 8093
