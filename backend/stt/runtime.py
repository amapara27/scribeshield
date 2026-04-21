"""Runtime STT provider resolution for batch transcription."""

from __future__ import annotations

import asyncio
import threading
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from app.config import BACKEND_DIR, settings
from app.schemas import ScribeResult, ScribeWord

DEFAULT_SPEAKER_ID = "speaker_0"
DEFAULT_MODEL_PATH = (BACKEND_DIR / "tuned_models" / "full_ft").resolve()
LEGACY_MODEL_PATH = (BACKEND_DIR / "tuned_models" / "whisper_small_LoRA_normal").resolve()
EMERGENCY_MODEL_PATH = (BACKEND_DIR / "tuned_models" / "whisper_tiny_LoRA_emergency").resolve()
OLD_DROPIN_MODEL_PATH = (BACKEND_DIR / "stt" / "models" / "full_ft").resolve()
_CACHE_LOCK = threading.Lock()
_LOCAL_PIPELINE_CACHE: dict[str, Any] = {
    "path": None,
    "pipeline": None,
}

LOCAL_WHISPER_PROVIDERS = {"full_ft", "lora", "emergency_lora"}
SUPPORTED_PROVIDER_TOKENS = {
    "auto",
    "scribe_v2",
    "full_ft",
    "fine_tuned_telephony",
    "lora",
    "whisper_small_lora_normal",
    "emergency",
    "emergency_lora",
    "whisper_tiny_lora_emergency",
}


class BatchSttProvider(Protocol):
    name: str

    async def transcribe_batch(self, wav_path: str, keyterms: list[str]) -> ScribeResult: ...


@dataclass(slots=True)
class ModelValidation:
    ready: bool
    reason: str
    path: Path
    model_format: str = "unknown"


@dataclass(slots=True)
class ResolvedModelLocation:
    validation: ModelValidation
    searched_paths: tuple[Path, ...]


def _normalize_provider_name(raw: str) -> str:
    value = raw.strip().lower()
    if value == "fine_tuned_telephony":
        return "full_ft"
    if value == "whisper_small_lora_normal":
        return "lora"
    if value in {"emergency", "whisper_tiny_lora_emergency"}:
        return "emergency_lora"
    if value in {"auto", "scribe_v2", "full_ft", "lora", "emergency_lora"}:
        return value
    raise RuntimeError(
        "Unsupported STT_PROVIDER="
        f"{raw!r}; expected one of: {', '.join(sorted(SUPPORTED_PROVIDER_TOKENS))}"
    )


def _required_model_files(path: Path) -> list[str]:
    missing: list[str] = []
    if not (path / "config.json").exists():
        missing.append("config.json")
    if not (path / "preprocessor_config.json").exists():
        missing.append("preprocessor_config.json")
    if not (path / "tokenizer_config.json").exists():
        missing.append("tokenizer_config.json")
    if not ((path / "tokenizer.json").exists() or (path / "vocab.json").exists()):
        missing.append("tokenizer.json or vocab.json")
    if not ((path / "model.safetensors").exists() or (path / "pytorch_model.bin").exists()):
        missing.append("model.safetensors or pytorch_model.bin")
    return missing


def _required_lora_adapter_files(path: Path) -> list[str]:
    missing: list[str] = []
    if not (path / "adapter_config.json").exists():
        missing.append("adapter_config.json")
    if not ((path / "adapter_model.safetensors").exists() or (path / "adapter_model.bin").exists()):
        missing.append("adapter_model.safetensors or adapter_model.bin")
    if not (path / "preprocessor_config.json").exists():
        missing.append("preprocessor_config.json")
    if not (path / "tokenizer_config.json").exists():
        missing.append("tokenizer_config.json")
    if not ((path / "tokenizer.json").exists() or (path / "vocab.json").exists()):
        missing.append("tokenizer.json or vocab.json")
    return missing


def _validate_single_model_path(path: Path) -> ModelValidation:
    model_path = path.expanduser().resolve()
    if not model_path.exists():
        return ModelValidation(
            ready=False,
            reason=f"missing model directory at {model_path}",
            path=model_path,
        )
    if not model_path.is_dir():
        return ModelValidation(
            ready=False,
            reason=f"model path is not a directory: {model_path}",
            path=model_path,
        )
    full_missing = _required_model_files(model_path)
    if not full_missing:
        return ModelValidation(
            ready=True,
            reason="full checkpoint files present",
            path=model_path,
            model_format="full",
        )

    lora_missing = _required_lora_adapter_files(model_path)
    if not lora_missing:
        return ModelValidation(
            ready=True,
            reason="LoRA adapter files present",
            path=model_path,
            model_format="lora_adapter",
        )

    return ModelValidation(
        ready=False,
        reason=(
            "missing required files for full checkpoint: "
            + ", ".join(full_missing)
            + "; missing required files for LoRA adapter: "
            + ", ".join(lora_missing)
        ),
        path=model_path,
    )


def _configured_model_path() -> Path:
    return settings.FINE_TUNED_STT_MODEL_PATH.expanduser().resolve()


def _dedupe_paths(paths: list[Path]) -> list[Path]:
    deduped: list[Path] = []
    seen: set[str] = set()
    for candidate in paths:
        key = str(candidate)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(candidate)
    return deduped


def _resolve_from_candidates(candidates: list[Path]) -> ResolvedModelLocation:
    if not candidates:
        raise RuntimeError("No model candidates configured")
    deduped = _dedupe_paths(candidates)
    validations = [_validate_single_model_path(candidate) for candidate in deduped]
    ready = next((item for item in validations if item.ready), None)
    if ready is not None:
        return ResolvedModelLocation(
            validation=ready,
            searched_paths=tuple(item.path for item in validations),
        )
    last = validations[-1]
    reason = "; ".join(validation.reason for validation in validations)
    return ResolvedModelLocation(
        validation=ModelValidation(ready=False, reason=reason, path=last.path),
        searched_paths=tuple(item.path for item in validations),
    )


def resolve_named_model_location(provider_name: str) -> ResolvedModelLocation:
    provider = _normalize_provider_name(provider_name)
    if provider == "auto":
        return _resolve_from_candidates(candidate_local_model_paths())
    if provider == "full_ft":
        return _resolve_from_candidates(candidate_full_ft_model_paths())
    if provider == "lora":
        return _resolve_from_candidates(candidate_lora_model_paths())
    if provider == "emergency_lora":
        return _resolve_from_candidates(candidate_emergency_model_paths())
    raise RuntimeError(f"No local model path resolution for provider={provider!r}")


def _provider_name_for_validation(validation: ModelValidation) -> str:
    if validation.model_format == "lora_adapter":
        if str(validation.path) == str(EMERGENCY_MODEL_PATH):
            return "emergency_lora"
        return "lora"
    return "full_ft"


def _provider_label(provider_name: str) -> str:
    provider = _normalize_provider_name(provider_name)
    labels = {
        "scribe_v2": "scribe_v2",
        "full_ft": "full_ft",
        "lora": "lora",
        "emergency_lora": "emergency_lora",
    }
    return labels.get(provider, provider)


def is_local_whisper_provider(provider_name: str | None) -> bool:
    if not provider_name:
        return False
    return _normalize_provider_name(provider_name) in LOCAL_WHISPER_PROVIDERS


def candidate_full_ft_model_paths() -> list[Path]:
    return _dedupe_paths(
        [
            _configured_model_path(),
            DEFAULT_MODEL_PATH,
            OLD_DROPIN_MODEL_PATH,
        ]
    )


def candidate_lora_model_paths() -> list[Path]:
    return _dedupe_paths([LEGACY_MODEL_PATH])


def candidate_emergency_model_paths() -> list[Path]:
    return _dedupe_paths([EMERGENCY_MODEL_PATH])


def candidate_local_model_paths() -> list[Path]:
    return _dedupe_paths(
        [
            *candidate_full_ft_model_paths(),
            *candidate_lora_model_paths(),
        ]
    )


def resolve_local_model_location(path: Path | None = None) -> ResolvedModelLocation:
    if path is not None:
        validation = _validate_single_model_path(path)
        return ResolvedModelLocation(validation=validation, searched_paths=(validation.path,))

    return _resolve_from_candidates(candidate_local_model_paths())


def validate_local_model_path(path: Path | None = None) -> ModelValidation:
    return resolve_local_model_location(path).validation


def _wave_duration_ms(path: Path) -> int:
    try:
        with wave.open(str(path), "rb") as handle:
            rate = handle.getframerate()
            frames = handle.getnframes()
            if rate <= 0:
                return 0
            return int((frames / rate) * 1000)
    except Exception:
        return 0


def _synthetic_words_from_text(text: str, *, duration_ms: int) -> list[ScribeWord]:
    tokens = [token for token in text.split() if token.strip()]
    if not tokens:
        return []
    per_word = max(80, duration_ms // max(len(tokens), 1)) if duration_ms > 0 else 120
    out: list[ScribeWord] = []
    cursor = 0
    for token in tokens:
        start = cursor
        end = start + per_word
        out.append(
            ScribeWord(
                text=token,
                start_ms=start,
                end_ms=end,
                speaker_id=DEFAULT_SPEAKER_ID,
            )
        )
        cursor = end + 20
    return out


def pipeline_words_to_scribe_words(payload: dict[str, Any], *, duration_ms: int) -> list[ScribeWord]:
    chunks = payload.get("chunks")
    out: list[ScribeWord] = []
    if isinstance(chunks, list):
        for chunk in chunks:
            if not isinstance(chunk, dict):
                continue
            text = str(chunk.get("text") or "").strip()
            timestamp = chunk.get("timestamp")
            if not text or not isinstance(timestamp, (tuple, list)) or len(timestamp) != 2:
                continue
            start_raw, end_raw = timestamp
            if start_raw is None or end_raw is None:
                continue
            try:
                start_ms = max(0, int(float(start_raw) * 1000))
                end_ms = max(start_ms, int(float(end_raw) * 1000))
            except (TypeError, ValueError):
                continue
            out.append(
                ScribeWord(
                    text=text,
                    start_ms=start_ms,
                    end_ms=end_ms,
                    speaker_id=DEFAULT_SPEAKER_ID,
                )
            )
    if out:
        return out

    text = str(payload.get("text") or "").strip()
    return _synthetic_words_from_text(text, duration_ms=duration_ms)


def _torch_dtype(torch_module: Any) -> Any | None:
    value = settings.FINE_TUNED_STT_DTYPE.strip().lower()
    if value == "auto":
        configured = settings.FINE_TUNED_STT_DEVICE.strip().lower()
        if configured == "cuda":
            if bool(getattr(torch_module.cuda, "is_available", lambda: False)()):
                return getattr(torch_module, "float16", None)
            return getattr(torch_module, "float32", None)
        if configured == "mps":
            if _mps_available(torch_module):
                return getattr(torch_module, "float16", None)
            return getattr(torch_module, "float32", None)
        if (
            configured == "auto"
            and (
                bool(getattr(torch_module.cuda, "is_available", lambda: False)())
                or _mps_available(torch_module)
            )
        ):
            return getattr(torch_module, "float16", None)
        return getattr(torch_module, "float32", None)
    if value == "float16":
        return getattr(torch_module, "float16", None)
    if value == "float32":
        return getattr(torch_module, "float32", None)
    raise RuntimeError(
        f"Unsupported FINE_TUNED_STT_DTYPE={settings.FINE_TUNED_STT_DTYPE!r}; expected auto, float16, or float32"
    )


def _mps_available(torch_module: Any) -> bool:
    backends = getattr(torch_module, "backends", None)
    mps_backend = getattr(backends, "mps", None)
    is_available = getattr(mps_backend, "is_available", None)
    if callable(is_available):
        try:
            return bool(is_available())
        except Exception:
            return False
    return False


def _pipeline_device(torch_module: Any) -> int | str:
    configured = settings.FINE_TUNED_STT_DEVICE.strip().lower()
    if configured == "cpu":
        return -1
    if configured == "cuda":
        return 0 if bool(getattr(torch_module.cuda, "is_available", lambda: False)()) else -1
    if configured == "mps":
        return "mps" if _mps_available(torch_module) else -1
    if configured != "auto":
        raise RuntimeError(
            f"Unsupported FINE_TUNED_STT_DEVICE={settings.FINE_TUNED_STT_DEVICE!r}; expected auto, cpu, cuda, or mps"
        )
    if _mps_available(torch_module):
        return "mps"
    return 0 if bool(getattr(torch_module.cuda, "is_available", lambda: False)()) else -1


def _hf_pretrained_kwargs() -> dict[str, Any]:
    token = settings.huggingface_token()
    if not token:
        return {}
    return {"token": token}


def _load_local_pipeline(model_path: Path) -> Any:
    with _CACHE_LOCK:
        if _LOCAL_PIPELINE_CACHE["path"] == str(model_path) and _LOCAL_PIPELINE_CACHE["pipeline"] is not None:
            return _LOCAL_PIPELINE_CACHE["pipeline"]

        validation = _validate_single_model_path(model_path)
        if not validation.ready:
            raise RuntimeError(f"Fine-tuned STT model invalid: {validation.reason}")

        try:
            import torch  # type: ignore[import-not-found]
            from transformers import pipeline  # type: ignore[import-not-found]
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(
                "Fine-tuned STT runtime dependencies are missing. Install torch, transformers, sentencepiece, safetensors, and librosa."
            ) from exc

        if validation.model_format == "full":
            pipeline_kwargs: dict[str, Any] = {
                "task": "automatic-speech-recognition",
                "model": str(model_path),
                "tokenizer": str(model_path),
                "feature_extractor": str(model_path),
                "device": _pipeline_device(torch),
                "model_kwargs": {
                    "torch_dtype": _torch_dtype(torch),
                    "low_cpu_mem_usage": True,
                },
            }
            pipeline_kwargs.update(_hf_pretrained_kwargs())
            pipe = pipeline(**pipeline_kwargs)
        elif validation.model_format == "lora_adapter":
            try:
                from peft import PeftConfig, PeftModel  # type: ignore[import-not-found]
                from transformers import (  # type: ignore[import-not-found]
                    AutoModelForSpeechSeq2Seq,
                    AutoProcessor,
                )
            except Exception as exc:  # noqa: BLE001
                raise RuntimeError(
                    "LoRA adapter model detected but dependencies are missing. "
                    "Install peft (and ensure torch/transformers are installed)."
                ) from exc

            hf_pretrained_kwargs = _hf_pretrained_kwargs()
            peft_config = PeftConfig.from_pretrained(str(model_path), **hf_pretrained_kwargs)
            base_model_ref = str(getattr(peft_config, "base_model_name_or_path", "") or "").strip()
            if not base_model_ref:
                raise RuntimeError(
                    f"LoRA adapter config at {model_path} is missing base_model_name_or_path"
                )

            # Prefer tokenizer/feature extractor shipped with adapter; fallback to base model.
            try:
                processor = AutoProcessor.from_pretrained(str(model_path), **hf_pretrained_kwargs)
            except Exception:
                processor = AutoProcessor.from_pretrained(base_model_ref, **hf_pretrained_kwargs)

            base_model = AutoModelForSpeechSeq2Seq.from_pretrained(
                base_model_ref,
                torch_dtype=_torch_dtype(torch),
                low_cpu_mem_usage=True,
                **hf_pretrained_kwargs,
            )
            model = PeftModel.from_pretrained(base_model, str(model_path), **hf_pretrained_kwargs)

            # Merge adapter into base model when supported to simplify inference.
            if hasattr(model, "merge_and_unload"):
                try:
                    model = model.merge_and_unload()
                except Exception:
                    pass

            pipe = pipeline(
                task="automatic-speech-recognition",
                model=model,
                tokenizer=processor.tokenizer,
                feature_extractor=processor.feature_extractor,
                device=_pipeline_device(torch),
            )
        else:
            raise RuntimeError(f"Unsupported model format: {validation.model_format}")

        _LOCAL_PIPELINE_CACHE["path"] = str(model_path)
        _LOCAL_PIPELINE_CACHE["pipeline"] = pipe
        return pipe


class ScribeV2BatchProvider:
    name = "scribe_v2"

    async def transcribe_batch(self, wav_path: str, keyterms: list[str]) -> ScribeResult:
        from app import scribe

        return await scribe.transcribe_batch(wav_path, keyterms)


class FineTunedTelephonyBatchProvider:
    name = "full_ft"

    def __init__(self, model_path: Path | None = None, *, provider_name: str = "full_ft"):
        if model_path is None:
            validation = resolve_named_model_location(provider_name).validation
        else:
            validation = resolve_local_model_location(model_path).validation
        if not validation.ready:
            raise RuntimeError(f"Fine-tuned STT model invalid: {validation.reason}")
        self._model_path = validation.path
        self.name = _normalize_provider_name(provider_name)

    async def transcribe_batch(self, wav_path: str, keyterms: list[str]) -> ScribeResult:
        del keyterms
        pipe = _load_local_pipeline(self._model_path)
        duration_ms = _wave_duration_ms(Path(wav_path))
        generate_kwargs = {
            "language": settings.FINE_TUNED_STT_LANGUAGE,
            "task": settings.FINE_TUNED_STT_TASK,
        }
        if settings.FINE_TUNED_STT_WORD_TIMESTAMPS:
            payload = await asyncio.to_thread(
                pipe,
                wav_path,
                return_timestamps="word",
                generate_kwargs=generate_kwargs,
            )
        else:
            payload = await asyncio.to_thread(
                pipe,
                wav_path,
                generate_kwargs=generate_kwargs,
            )
        if not isinstance(payload, dict):
            raise RuntimeError("Unexpected Whisper pipeline output shape")
        words = pipeline_words_to_scribe_words(payload, duration_ms=duration_ms)
        return ScribeResult(words=words, duration_ms=duration_ms)


def get_batch_provider(provider_override: str | None = None) -> BatchSttProvider:
    provider = _normalize_provider_name(provider_override or settings.STT_PROVIDER)
    if provider == "scribe_v2":
        return ScribeV2BatchProvider()
    if provider in LOCAL_WHISPER_PROVIDERS:
        resolved = resolve_named_model_location(provider).validation
        if not resolved.ready:
            raise RuntimeError(f"Fine-tuned STT model invalid: {resolved.reason}")
        return FineTunedTelephonyBatchProvider(
            model_path=resolved.path,
            provider_name=provider,
        )

    validation = resolve_named_model_location("auto").validation
    if validation.ready:
        return FineTunedTelephonyBatchProvider(
            model_path=validation.path,
            provider_name=_provider_name_for_validation(validation),
        )
    return ScribeV2BatchProvider()


def ensure_runtime_ready() -> None:
    provider = _normalize_provider_name(settings.STT_PROVIDER)
    if provider not in LOCAL_WHISPER_PROVIDERS:
        return
    local_model = resolve_named_model_location(provider).validation
    if not local_model.ready:
        raise RuntimeError(f"Fine-tuned STT model invalid: {local_model.reason}")
    _load_local_pipeline(local_model.path)


def batch_provider_status() -> str:
    provider = _normalize_provider_name(settings.STT_PROVIDER)
    loaded_path = _LOCAL_PIPELINE_CACHE["path"]
    if provider == "scribe_v2":
        return "scribe_v2 (forced)"
    if provider in LOCAL_WHISPER_PROVIDERS:
        resolved = resolve_named_model_location(provider)
        validation = resolved.validation
        label = _provider_label(provider)
        if validation.ready:
            if loaded_path == str(validation.path):
                return f"{label} (forced; loaded from {validation.path})"
            return f"{label} (forced; ready at {validation.path})"
        return f"{label} (forced; invalid: {validation.reason})"
    resolved = resolve_named_model_location("auto")
    validation = resolved.validation
    searched = ", ".join(str(path) for path in resolved.searched_paths)
    if validation.ready:
        label = _provider_label(_provider_name_for_validation(validation))
        if loaded_path == str(validation.path):
            return f"{label} (auto; loaded from {validation.path})"
        return f"{label} (auto; ready at {validation.path})"
    return f"scribe_v2 (auto fallback; searched {searched}; local model unavailable: {validation.reason})"


def reset_runtime_cache() -> None:
    with _CACHE_LOCK:
        _LOCAL_PIPELINE_CACHE["path"] = None
        _LOCAL_PIPELINE_CACHE["pipeline"] = None
