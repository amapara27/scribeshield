from __future__ import annotations

from pathlib import Path

import pytest

from stt import runtime


def _touch(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("x", encoding="utf-8")


def test_validate_local_model_path_accepts_save_pretrained_layout(tmp_path: Path) -> None:
    for name in (
        "config.json",
        "preprocessor_config.json",
        "tokenizer_config.json",
        "tokenizer.json",
        "model.safetensors",
    ):
        _touch(tmp_path / name)

    result = runtime.validate_local_model_path(tmp_path)

    assert result.ready is True


def test_validate_local_model_path_reports_missing_files(tmp_path: Path) -> None:
    result = runtime.validate_local_model_path(tmp_path)

    assert result.ready is False
    assert "missing required files" in result.reason


def test_pipeline_words_to_scribe_words_uses_word_timestamps() -> None:
    payload = {
        "text": "metformin daily",
        "chunks": [
            {"text": "metformin", "timestamp": (0.0, 0.6)},
            {"text": "daily", "timestamp": (0.6, 1.0)},
        ],
    }

    words = runtime.pipeline_words_to_scribe_words(payload, duration_ms=1000)

    assert [word.text for word in words] == ["metformin", "daily"]
    assert words[0].start_ms == 0
    assert words[1].end_ms == 1000


def test_pipeline_words_to_scribe_words_falls_back_to_synthetic_timing() -> None:
    payload = {"text": "metformin daily", "chunks": []}

    words = runtime.pipeline_words_to_scribe_words(payload, duration_ms=1000)

    assert len(words) == 2
    assert words[0].speaker_id == "speaker_0"
    assert words[0].start_ms == 0


def test_get_batch_provider_auto_falls_back_to_scribe(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(runtime.settings, "STT_PROVIDER", "auto")
    monkeypatch.setattr(runtime.settings, "FINE_TUNED_STT_MODEL_PATH", tmp_path / "missing")
    monkeypatch.setattr(runtime, "DEFAULT_MODEL_PATH", (tmp_path / "missing_full").resolve())
    monkeypatch.setattr(runtime, "LEGACY_MODEL_PATH", (tmp_path / "missing_lora").resolve())
    monkeypatch.setattr(runtime, "OLD_DROPIN_MODEL_PATH", (tmp_path / "missing_dropin").resolve())
    runtime.reset_runtime_cache()

    provider = runtime.get_batch_provider()

    assert provider.name == "scribe_v2"


def test_get_batch_provider_explicit_local_raises_when_missing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(runtime.settings, "STT_PROVIDER", "full_ft")
    monkeypatch.setattr(runtime.settings, "FINE_TUNED_STT_MODEL_PATH", tmp_path / "missing")
    monkeypatch.setattr(runtime, "DEFAULT_MODEL_PATH", (tmp_path / "missing_full").resolve())
    monkeypatch.setattr(runtime, "OLD_DROPIN_MODEL_PATH", (tmp_path / "missing_dropin").resolve())
    runtime.reset_runtime_cache()

    with pytest.raises(RuntimeError, match="Fine-tuned STT model invalid"):
        runtime.get_batch_provider()


def test_get_batch_provider_honors_scribe_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(runtime.settings, "STT_PROVIDER", "auto")

    provider = runtime.get_batch_provider("scribe_v2")

    assert provider.name == "scribe_v2"


def test_get_batch_provider_honors_lora_override(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    lora = (tmp_path / "whisper_small_LoRA_normal").resolve()
    for name in (
        "adapter_config.json",
        "adapter_model.safetensors",
        "preprocessor_config.json",
        "tokenizer_config.json",
        "tokenizer.json",
    ):
        _touch(lora / name)

    monkeypatch.setattr(runtime.settings, "STT_PROVIDER", "auto")
    monkeypatch.setattr(runtime, "LEGACY_MODEL_PATH", lora)
    runtime.reset_runtime_cache()

    provider = runtime.get_batch_provider("lora")

    assert provider.name == "lora"
    assert isinstance(provider, runtime.FineTunedTelephonyBatchProvider)
    assert provider._model_path == lora


def test_get_batch_provider_honors_emergency_override(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    emergency = (tmp_path / "whisper_tiny_LoRA_emergency").resolve()
    for name in (
        "adapter_config.json",
        "adapter_model.safetensors",
        "preprocessor_config.json",
        "tokenizer_config.json",
        "tokenizer.json",
    ):
        _touch(emergency / name)

    monkeypatch.setattr(runtime.settings, "STT_PROVIDER", "auto")
    monkeypatch.setattr(runtime, "EMERGENCY_MODEL_PATH", emergency)
    runtime.reset_runtime_cache()

    provider = runtime.get_batch_provider("emergency_lora")

    assert provider.name == "emergency_lora"
    assert isinstance(provider, runtime.FineTunedTelephonyBatchProvider)
    assert provider._model_path == emergency


def test_normalize_provider_aliases() -> None:
    assert runtime._normalize_provider_name("fine_tuned_telephony") == "full_ft"
    assert runtime._normalize_provider_name("whisper_small_LoRA_normal") == "lora"
    assert runtime._normalize_provider_name("whisper_tiny_LoRA_emergency") == "emergency_lora"


def test_pipeline_device_auto_prefers_mps(monkeypatch: pytest.MonkeyPatch) -> None:
    class _MPSBackend:
        @staticmethod
        def is_available() -> bool:
            return True

    class _Backends:
        mps = _MPSBackend()

    class _Cuda:
        @staticmethod
        def is_available() -> bool:
            return False

    class _Torch:
        backends = _Backends()
        cuda = _Cuda()

    monkeypatch.setattr(runtime.settings, "FINE_TUNED_STT_DEVICE", "auto")

    assert runtime._pipeline_device(_Torch()) == "mps"


def test_torch_dtype_auto_prefers_float16_for_mps(monkeypatch: pytest.MonkeyPatch) -> None:
    class _MPSBackend:
        @staticmethod
        def is_available() -> bool:
            return True

    class _Backends:
        mps = _MPSBackend()

    class _Cuda:
        @staticmethod
        def is_available() -> bool:
            return False

    class _Torch:
        backends = _Backends()
        cuda = _Cuda()
        float16 = "float16"
        float32 = "float32"

    monkeypatch.setattr(runtime.settings, "FINE_TUNED_STT_DEVICE", "auto")
    monkeypatch.setattr(runtime.settings, "FINE_TUNED_STT_DTYPE", "auto")

    assert runtime._torch_dtype(_Torch()) == "float16"


def test_get_batch_provider_auto_uses_legacy_drop_in_path(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    legacy = tmp_path / "full_ft"
    for name in (
        "config.json",
        "preprocessor_config.json",
        "tokenizer_config.json",
        "tokenizer.json",
        "model.safetensors",
    ):
        _touch(legacy / name)

    monkeypatch.setattr(runtime, "DEFAULT_MODEL_PATH", (tmp_path / "stt" / "models" / "full_ft").resolve())
    monkeypatch.setattr(runtime, "LEGACY_MODEL_PATH", legacy.resolve())
    monkeypatch.setattr(runtime.settings, "STT_PROVIDER", "auto")
    monkeypatch.setattr(
        runtime.settings,
        "FINE_TUNED_STT_MODEL_PATH",
        runtime.DEFAULT_MODEL_PATH,
    )
    runtime.reset_runtime_cache()

    provider = runtime.get_batch_provider()

    assert provider.name == "full_ft"
    assert isinstance(provider, runtime.FineTunedTelephonyBatchProvider)
    assert provider._model_path == legacy.resolve()
