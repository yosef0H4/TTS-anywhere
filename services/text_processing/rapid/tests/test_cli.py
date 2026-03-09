from __future__ import annotations

import pytest

from rapid_text_processing import cli


def test_parse_args_with_feature_flags() -> None:
    args = cli.parse_args(
        [
            "serve",
            "--enable-detect",
            "--enable-openai-ocr",
            "--detect-provider",
            "cpu",
            "--ocr-provider",
            "cuda",
        ]
    )

    assert args.cmd == "serve"
    assert args.enable_detect is True
    assert args.enable_openai_ocr is True
    assert args.detect_provider == "cpu"
    assert args.ocr_provider == "cuda"


def test_parse_args_rejects_auto_provider() -> None:
    with pytest.raises(SystemExit):
        cli.parse_args(["serve", "--enable-detect", "--detect-provider", "auto"])


def test_main_requires_at_least_one_feature(monkeypatch: pytest.MonkeyPatch) -> None:
    original_parse_args = cli.parse_args
    monkeypatch.setattr(cli, "parse_args", lambda: original_parse_args(["serve"]))

    with pytest.raises(SystemExit, match="At least one feature must be enabled"):
        cli.main()


def test_main_rejects_unavailable_explicit_gpu(monkeypatch: pytest.MonkeyPatch) -> None:
    original_parse_args = cli.parse_args
    monkeypatch.setattr(cli, "parse_args", lambda: original_parse_args(["serve", "--enable-detect", "--detect-provider", "cuda"]))

    with pytest.raises(RuntimeError, match="CUDA execution provider requested but not available"):
        cli.main()


def test_main_starts_server_with_resolved_config(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    original_parse_args = cli.parse_args
    monkeypatch.setattr(
        cli,
        "parse_args",
        lambda: original_parse_args(["serve", "--enable-openai-ocr", "--detect-provider", "cpu", "--ocr-provider", "cpu"]),
    )
    monkeypatch.setattr(cli, "resolve_execution_provider", lambda provider: None)
    monkeypatch.setattr(cli, "create_app", lambda config: (captured.setdefault("config", config), object())[1])
    monkeypatch.setattr(cli.uvicorn, "run", lambda app, host, port: captured.update({"app": app, "host": host, "port": port}))

    cli.main()

    config = captured["config"]
    assert getattr(config, "enable_detect") is False
    assert getattr(config, "enable_openai_ocr") is True
    assert getattr(config, "detect_execution_provider") == "cpu"
    assert getattr(config, "ocr_execution_provider") == "cpu"
    assert captured["host"] == "127.0.0.1"
    assert captured["port"] == 8091
