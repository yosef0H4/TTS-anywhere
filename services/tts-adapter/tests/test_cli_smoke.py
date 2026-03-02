from pathlib import Path


def test_cli_module_importable() -> None:
    import tts_adapter.cli as cli

    assert hasattr(cli, "main")


def test_project_files_exist() -> None:
    assert Path("pyproject.toml").exists()
