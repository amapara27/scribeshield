"""Generate benchmark_results.json for the demo backend.

Default behavior remains safe for hackathon demos:
- If no eval dataset is present, copy baseline benchmark JSON to the output path.
- If eval data is present, recompute per-clip metrics from transcript text.

Expected eval JSONL fields (per row):
- clip_id
- ground_truth (or reference_text/text)
- raw_text (or raw_transcript)
- corrected_text (or corrected_transcript)
Optional fields:
- category
- difficulty (Standard/Adversarial)
- medical_keywords (list[str] or comma-delimited str)
"""
from __future__ import annotations

import asyncio
import argparse
import csv
import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Sequence

BACKEND_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_DIR.parent
DEFAULT_RESULTS_PATH = BACKEND_DIR / "data" / "benchmark_results.json"
DEFAULT_RESULTS_EXAMPLE_PATH = BACKEND_DIR / "data" / "benchmark_results.json.example"
DEFAULT_EVAL_PATH = BACKEND_DIR / "data" / "benchmark_eval.jsonl"
DEFAULT_MANIFEST_PATH = BACKEND_DIR / "test_audio" / "benchmark" / "v1" / "manifest.csv"
DEFAULT_GENERATED_TELEPHONY_DIR = BACKEND_DIR / "audio_gen" / "output" / "run_5x_v2" / "telephony"
DEFAULT_BASE_WHISPER_MODEL_ID = "openai/whisper-small"

_WORD_RE = re.compile(r"[a-z0-9]+(?:'[a-z0-9]+)?")
_DIGIT_RE = re.compile(r"\d")
_SOURCE_CLIP_RE = re.compile(r"\((clip_[0-9]{4}_[a-z0-9_]+)\)")
_WHISPER_PIPELINE_CACHE: dict[str, Any] = {}
MODEL_BENCHMARK_SPECS: list[dict[str, str]] = [
    {
        "id": "base_whisper_small",
        "label": "Base Whisper Small",
        "provider": "base_whisper_small",
        "field": "base_whisper_small_text",
    },
    {
        "id": "fine_tuned_telephony",
        "label": "Whisper Fine-Tuned",
        "provider": "full_ft",
        "field": "full_ft_text",
    },
    {
        "id": "lora",
        "label": "Whisper LoRA",
        "provider": "lora",
        "field": "lora_text",
    },
    {
        "id": "scribe_v2",
        "label": "ScribeV2",
        "provider": "scribe_v2",
        "field": "scribe_v2_text",
    },
    {
        "id": "emergency_lora",
        "label": "Emergency LoRA",
        "provider": "emergency_lora",
        "field": "emergency_lora_text",
    },
]


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate backend/data/benchmark_results.json")
    parser.add_argument(
        "--source",
        type=Path,
        default=None,
        help="Baseline benchmark JSON to copy/augment (default: existing benchmark_results.json else .example)",
    )
    parser.add_argument(
        "--eval",
        type=Path,
        default=DEFAULT_EVAL_PATH,
        help="JSONL eval file with ground-truth/raw/corrected transcript text",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=DEFAULT_RESULTS_PATH,
        help="Output benchmark JSON path",
    )
    parser.add_argument(
        "--manifest",
        type=Path,
        default=DEFAULT_MANIFEST_PATH,
        help="Benchmark manifest CSV (ground_truth/keywords/category/difficulty metadata)",
    )
    parser.add_argument(
        "--run-pipeline",
        action="store_true",
        help=(
            "Generate eval rows by running the live preprocessing/scribe/verification/"
            "correction pipeline over benchmark audio before recomputing metrics"
        ),
    )
    parser.add_argument(
        "--verification-layer",
        choices=("on", "off"),
        default="on",
        help="Toggle the XGBoost/Tavily/Claude verification layer when --run-pipeline is used.",
    )
    parser.add_argument(
        "--base-whisper-model",
        default=DEFAULT_BASE_WHISPER_MODEL_ID,
        help="Transformers model id/path for the unfine-tuned Whisper baseline",
    )
    return parser.parse_args()


def _resolve_source_path(explicit: Path | None) -> Path:
    if explicit is not None:
        return explicit
    if DEFAULT_RESULTS_PATH.exists():
        return DEFAULT_RESULTS_PATH
    return DEFAULT_RESULTS_EXAMPLE_PATH


def _load_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise SystemExit(f"Benchmark source not found: {path}")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise SystemExit(f"Malformed benchmark source JSON ({path}): {exc}") from exc


def _load_manifest_rows(path: Path) -> dict[str, dict[str, str]]:
    if not path.exists():
        return {}
    try:
        with path.open("r", encoding="utf-8", newline="") as f:
            reader = csv.DictReader(f)
            out: dict[str, dict[str, str]] = {}
            for row in reader:
                clip_id = str((row or {}).get("clip_id") or "").strip()
                if not clip_id:
                    continue
                out[clip_id] = {str(k): str(v or "").strip() for k, v in row.items()}
            return out
    except Exception as exc:  # noqa: BLE001
        raise SystemExit(f"Malformed benchmark manifest CSV ({path}): {exc}") from exc


def _ordered_manifest_rows(manifest_rows_by_clip: dict[str, dict[str, str]]) -> list[dict[str, str]]:
    return [manifest_rows_by_clip[key] for key in sorted(manifest_rows_by_clip)]


def _ensure_backend_imports() -> None:
    for path in (BACKEND_DIR, REPO_ROOT):
        path_str = str(path)
        if path_str not in sys.path:
            sys.path.insert(0, path_str)


def _extract_source_clip_id(notes: str) -> str | None:
    match = _SOURCE_CLIP_RE.search(notes or "")
    if not match:
        return None
    return match.group(1)


def _resolve_benchmark_audio_path(
    manifest_row: dict[str, str],
    manifest_path: Path,
    generated_telephony_dir: Path = DEFAULT_GENERATED_TELEPHONY_DIR,
) -> Path:
    audio_relpath = str(manifest_row.get("audio_relpath") or "").strip()
    if audio_relpath:
        candidate = manifest_path.parent / audio_relpath
        if candidate.exists():
            return candidate

    source_clip_id = _extract_source_clip_id(str(manifest_row.get("notes") or ""))
    if source_clip_id:
        fallback = generated_telephony_dir / f"{source_clip_id}.wav"
        if fallback.exists():
            return fallback

    clip_id = str(manifest_row.get("clip_id") or "").strip() or "<unknown>"
    raise SystemExit(
        f"Benchmark audio missing for {clip_id}: expected {audio_relpath or 'manifest audio_relpath'}"
    )


def _round(value: float) -> float:
    return round(float(value), 4)


def _mean(values: Sequence[float]) -> float:
    if not values:
        return 0.0
    return _round(sum(values) / len(values))


def _mean_optional(values: Sequence[float | None]) -> float | None:
    present = [v for v in values if v is not None]
    if not present:
        return None
    return _mean(present)


def _coerce_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        out: list[str] = []
        for item in value:
            if isinstance(item, dict):
                tok = item.get("word") or item.get("text")
                if tok:
                    out.append(str(tok))
            elif item is not None:
                out.append(str(item))
        return " ".join(out)
    if isinstance(value, dict):
        text = value.get("text")
        return str(text) if text is not None else ""
    return str(value)


def _tokens(text: str) -> list[str]:
    return _WORD_RE.findall(text.lower())


def _digits(text: str) -> list[str]:
    return _DIGIT_RE.findall(text)


def _levenshtein(a: Sequence[str], b: Sequence[str]) -> int:
    if not a:
        return len(b)
    if not b:
        return len(a)

    prev = list(range(len(b) + 1))
    for i, ai in enumerate(a, start=1):
        cur = [i] + [0] * len(b)
        for j, bj in enumerate(b, start=1):
            ins = cur[j - 1] + 1
            delete = prev[j] + 1
            sub = prev[j - 1] + (0 if ai == bj else 1)
            cur[j] = min(ins, delete, sub)
        prev = cur
    return prev[-1]


def _error_rate_ratio(reference: Sequence[str], hypothesis: Sequence[str]) -> float:
    if not reference:
        return 0.0
    return _levenshtein(reference, hypothesis) / len(reference)


def _accuracy_ratio(reference: Sequence[str], hypothesis: Sequence[str]) -> float | None:
    if not reference:
        return None
    dist = _levenshtein(reference, hypothesis)
    value = 1.0 - (dist / len(reference))
    return max(0.0, min(1.0, value))


def _contains_phrase(tokens: Sequence[str], phrase: Sequence[str]) -> bool:
    size = len(phrase)
    if size == 0 or len(tokens) < size:
        return False
    for idx in range(0, len(tokens) - size + 1):
        if list(tokens[idx : idx + size]) == list(phrase):
            return True
    return False


def _error_hypothesis_indices(reference: Sequence[str], hypothesis: Sequence[str]) -> set[int]:
    rows = len(reference)
    cols = len(hypothesis)
    dp = [[0] * (cols + 1) for _ in range(rows + 1)]

    for i in range(rows + 1):
        dp[i][0] = i
    for j in range(cols + 1):
        dp[0][j] = j

    for i, ref_tok in enumerate(reference, start=1):
        for j, hyp_tok in enumerate(hypothesis, start=1):
            cost = 0 if ref_tok == hyp_tok else 1
            dp[i][j] = min(
                dp[i - 1][j] + 1,
                dp[i][j - 1] + 1,
                dp[i - 1][j - 1] + cost,
            )

    i = rows
    j = cols
    hypothesis_error_indices: set[int] = set()
    while i > 0 or j > 0:
        if i > 0 and j > 0:
            cost = 0 if reference[i - 1] == hypothesis[j - 1] else 1
            if dp[i][j] == dp[i - 1][j - 1] + cost:
                if cost:
                    hypothesis_error_indices.add(j - 1)
                i -= 1
                j -= 1
                continue
        if j > 0 and dp[i][j] == dp[i][j - 1] + 1:
            hypothesis_error_indices.add(j - 1)
            j -= 1
            continue
        if i > 0 and dp[i][j] == dp[i - 1][j] + 1:
            i -= 1
            continue
        break

    return hypothesis_error_indices


def _load_medical_terms() -> list[list[str]]:
    try:
        from app.keyterms import load_initial_keyterms  # type: ignore

        terms = load_initial_keyterms()
    except Exception:
        terms = [
            "metformin",
            "lisinopril",
            "atorvastatin",
            "amoxicillin",
            "ibuprofen",
            "acetaminophen",
            "warfarin",
            "insulin",
        ]

    tokenized = []
    for term in terms:
        toks = _tokens(str(term))
        if toks:
            tokenized.append(toks)
    return tokenized


def _parse_medical_keywords(value: Any) -> list[list[str]]:
    if value is None:
        return []
    if isinstance(value, str):
        parts = [p.strip() for p in value.split(",") if p.strip()]
    elif isinstance(value, list):
        parts = [str(v).strip() for v in value if str(v).strip()]
    else:
        parts = [str(value).strip()]

    out: list[list[str]] = []
    for item in parts:
        toks = _tokens(item)
        if toks:
            out.append(toks)
    return out


def _medical_keyword_accuracy_ratio(
    reference_text: str,
    hypothesis_text: str,
    medical_terms: list[list[str]],
    explicit_keywords: list[list[str]],
) -> float | None:
    ref_tokens = _tokens(reference_text)
    hyp_tokens = _tokens(hypothesis_text)

    reference_terms = explicit_keywords or [
        term for term in medical_terms if _contains_phrase(ref_tokens, term)
    ]
    if not reference_terms:
        return None

    matches = 0
    for term in reference_terms:
        if _contains_phrase(hyp_tokens, term):
            matches += 1

    return matches / len(reference_terms)


def _scale_from_source(payload: dict[str, Any]) -> tuple[float, float]:
    """Return (wer_scale, rate_scale).

    Scale is either 1.0 (ratio style, 0..1) or 100.0 (percent style, 0..100).
    """

    wer_scale = 1.0
    for row in payload.get("results", []):
        raw = row.get("raw_wer")
        if isinstance(raw, (int, float)) and raw > 1.0:
            wer_scale = 100.0
            break

    rate_scale = 1.0
    metrics = payload.get("metrics", {})
    verification_rate = metrics.get("verification_rate") if isinstance(metrics, dict) else None
    if isinstance(verification_rate, (int, float)) and verification_rate > 1.0:
        rate_scale = 100.0

    return wer_scale, rate_scale


def _scaled_optional(value: float | None, scale: float) -> float | None:
    if value is None:
        return None
    return _round(value * scale)


def _compute_text_metrics(
    *,
    reference_text: str,
    hypothesis_text: str,
    medical_terms: list[list[str]],
    explicit_keywords: list[list[str]],
    wer_scale: float,
    rate_scale: float,
) -> dict[str, float | None]:
    word_error = _error_rate_ratio(_tokens(reference_text), _tokens(hypothesis_text))
    char_error = _error_rate_ratio(
        list("".join(_tokens(reference_text))),
        list("".join(_tokens(hypothesis_text))),
    )
    digit_acc = _accuracy_ratio(_digits(reference_text), _digits(hypothesis_text))
    medical_acc = _medical_keyword_accuracy_ratio(
        reference_text,
        hypothesis_text,
        medical_terms,
        explicit_keywords,
    )
    return {
        "wer": _round(word_error * wer_scale),
        "cer": _round(char_error * wer_scale),
        "digit_accuracy": _scaled_optional(digit_acc, rate_scale),
        "medical_keyword_accuracy": _scaled_optional(medical_acc, rate_scale),
        "word_error_ratio": word_error,
    }


def _compute_result_row(
    row: dict[str, Any],
    source_rows_by_clip: dict[str, dict[str, Any]],
    manifest_rows_by_clip: dict[str, dict[str, str]],
    medical_terms: list[list[str]],
    wer_scale: float,
    rate_scale: float,
) -> dict[str, Any]:
    clip_id = str(row.get("clip_id", "")).strip()
    if not clip_id:
        raise ValueError("eval row missing clip_id")

    source = source_rows_by_clip.get(clip_id, {})
    manifest = manifest_rows_by_clip.get(clip_id, {})

    reference_text = _coerce_text(
        row.get("ground_truth")
        or row.get("reference_text")
        or row.get("text")
        or manifest.get("ground_truth")
    )
    raw_text = _coerce_text(
        row.get("baseline_raw_text")
        or row.get("raw_text")
        or row.get("raw_transcript")
    )
    corrected_text = _coerce_text(
        row.get("corrected_text") or row.get("corrected_transcript")
    )
    if not reference_text:
        raise ValueError(f"eval row {clip_id} missing ground_truth/reference_text/text")

    explicit_keywords = _parse_medical_keywords(
        row.get("medical_keywords") or manifest.get("medical_keywords")
    )
    raw_metrics = _compute_text_metrics(
        reference_text=reference_text,
        hypothesis_text=raw_text,
        medical_terms=medical_terms,
        explicit_keywords=explicit_keywords,
        wer_scale=wer_scale,
        rate_scale=rate_scale,
    )
    corrected_metrics = _compute_text_metrics(
        reference_text=reference_text,
        hypothesis_text=corrected_text,
        medical_terms=medical_terms,
        explicit_keywords=explicit_keywords,
        wer_scale=wer_scale,
        rate_scale=rate_scale,
    )

    improvement_pct = 0.0
    raw_word_error = float(raw_metrics["word_error_ratio"] or 0.0)
    corrected_word_error = float(corrected_metrics["word_error_ratio"] or 0.0)
    if raw_word_error > 0:
        improvement_pct = max(0.0, ((raw_word_error - corrected_word_error) / raw_word_error) * 100.0)

    difficulty_raw = str(
        row.get("difficulty")
        or source.get("difficulty")
        or manifest.get("difficulty")
        or "Standard"
    ).strip()
    difficulty = "Adversarial" if difficulty_raw.lower().startswith("ad") else "Standard"

    return {
        "clip_id": clip_id,
        "category": str(
            row.get("category")
            or source.get("category")
            or manifest.get("category")
            or "Unknown"
        ),
        "difficulty": difficulty,
        "raw_wer": raw_metrics["wer"],
        "corrected_wer": corrected_metrics["wer"],
        "raw_cer": raw_metrics["cer"],
        "corrected_cer": corrected_metrics["cer"],
        "raw_digit_accuracy": raw_metrics["digit_accuracy"],
        "corrected_digit_accuracy": corrected_metrics["digit_accuracy"],
        "raw_medical_keyword_accuracy": raw_metrics["medical_keyword_accuracy"],
        "corrected_medical_keyword_accuracy": corrected_metrics["medical_keyword_accuracy"],
        "improvement_pct": _round(improvement_pct),
    }


def _add_optional_fields(payload: dict[str, Any]) -> dict[str, Any]:
    for row in payload.get("results", []):
        if isinstance(row, dict):
            row.setdefault("raw_cer", None)
            row.setdefault("corrected_cer", None)
            row.setdefault("raw_digit_accuracy", None)
            row.setdefault("corrected_digit_accuracy", None)
            row.setdefault("raw_medical_keyword_accuracy", None)
            row.setdefault("corrected_medical_keyword_accuracy", None)

    aggregate = payload.setdefault("aggregate", {})
    if isinstance(aggregate, dict):
        aggregate.setdefault("avg_raw_cer", None)
        aggregate.setdefault("avg_corrected_cer", None)
        aggregate.setdefault("avg_raw_digit_accuracy", None)
        aggregate.setdefault("avg_corrected_digit_accuracy", None)
        aggregate.setdefault("avg_raw_medical_keyword_accuracy", None)
        aggregate.setdefault("avg_corrected_medical_keyword_accuracy", None)

    metrics = payload.setdefault("metrics", {})
    if isinstance(metrics, dict):
        metrics.setdefault("digit_accuracy_coverage", None)
        metrics.setdefault("medical_keyword_accuracy_coverage", None)

    payload.setdefault("comparison", None)
    payload.setdefault("model_benchmarks", [])
    return payload


def _apply_manifest_metadata(
    payload: dict[str, Any],
    manifest_rows_by_clip: dict[str, dict[str, str]],
) -> dict[str, Any]:
    if not manifest_rows_by_clip:
        return payload

    for row in payload.get("results", []):
        if not isinstance(row, dict):
            continue
        clip_id = str(row.get("clip_id") or "").strip()
        if not clip_id:
            continue
        manifest = manifest_rows_by_clip.get(clip_id)
        if not manifest:
            continue

        manifest_category = str(manifest.get("category") or "").strip()
        if manifest_category:
            row["category"] = manifest_category

        manifest_difficulty = str(manifest.get("difficulty") or "").strip()
        if manifest_difficulty:
            row["difficulty"] = (
                "Adversarial"
                if manifest_difficulty.lower().startswith("ad")
                else "Standard"
            )

    return payload


def _recompute(
    payload: dict[str, Any],
    eval_path: Path,
    manifest_rows_by_clip: dict[str, dict[str, str]] | None = None,
) -> dict[str, Any]:
    manifest_rows_by_clip = manifest_rows_by_clip or {}
    payload = _apply_manifest_metadata(payload, manifest_rows_by_clip)
    if not eval_path.exists():
        return _add_optional_fields(payload)

    lines = [line.strip() for line in eval_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    if not lines:
        return _add_optional_fields(payload)

    source_rows = payload.get("results", [])
    source_rows_by_clip = {
        str(item.get("clip_id")): item
        for item in source_rows
        if isinstance(item, dict) and item.get("clip_id")
    }

    wer_scale, rate_scale = _scale_from_source(payload)
    medical_terms = _load_medical_terms()

    parsed_eval_rows: list[dict[str, Any]] = []
    computed_results: list[dict[str, Any]] = []
    for idx, line in enumerate(lines, start=1):
        try:
            row = json.loads(line)
        except json.JSONDecodeError as exc:
            raise SystemExit(f"Malformed eval JSONL at line {idx}: {exc}") from exc
        if not isinstance(row, dict):
            raise SystemExit(f"Malformed eval JSONL at line {idx}: expected object")
        parsed_eval_rows.append(row)
        try:
            computed_results.append(
                _compute_result_row(
                    row=row,
                    source_rows_by_clip=source_rows_by_clip,
                    manifest_rows_by_clip=manifest_rows_by_clip,
                    medical_terms=medical_terms,
                    wer_scale=wer_scale,
                    rate_scale=rate_scale,
                )
            )
        except ValueError as exc:
            raise SystemExit(f"Invalid eval row at line {idx}: {exc}") from exc

    aggregate = payload.setdefault("aggregate", {})
    if not isinstance(aggregate, dict):
        aggregate = {}

    aggregate.update(
        {
            "avg_raw_wer": _mean([r["raw_wer"] for r in computed_results]),
            "avg_corrected_wer": _mean([r["corrected_wer"] for r in computed_results]),
            "avg_raw_cer": _mean([r["raw_cer"] for r in computed_results]),
            "avg_corrected_cer": _mean([r["corrected_cer"] for r in computed_results]),
            "avg_improvement_pct": _mean([r["improvement_pct"] for r in computed_results]),
            "avg_raw_digit_accuracy": _mean_optional(
                [r.get("raw_digit_accuracy") for r in computed_results]
            ),
            "avg_corrected_digit_accuracy": _mean_optional(
                [r.get("corrected_digit_accuracy") for r in computed_results]
            ),
            "avg_raw_medical_keyword_accuracy": _mean_optional(
                [r.get("raw_medical_keyword_accuracy") for r in computed_results]
            ),
            "avg_corrected_medical_keyword_accuracy": _mean_optional(
                [r.get("corrected_medical_keyword_accuracy") for r in computed_results]
            ),
        }
    )

    total = len(computed_results)
    raw_digit_count = sum(1 for r in computed_results if r.get("raw_digit_accuracy") is not None)
    raw_medical_count = sum(
        1 for r in computed_results if r.get("raw_medical_keyword_accuracy") is not None
    )
    metrics = payload.setdefault("metrics", {})
    if isinstance(metrics, dict):
        digit_coverage = (raw_digit_count / total) if total else None
        medical_coverage = (raw_medical_count / total) if total else None
        metrics["digit_accuracy_coverage"] = _scaled_optional(digit_coverage, rate_scale)
        metrics["medical_keyword_accuracy_coverage"] = _scaled_optional(
            medical_coverage, rate_scale
        )

    payload["results"] = computed_results
    payload["aggregate"] = aggregate
    payload["comparison"] = _compute_model_comparison(
        eval_rows=parsed_eval_rows,
        manifest_rows_by_clip=manifest_rows_by_clip,
        medical_terms=medical_terms,
        wer_scale=wer_scale,
        rate_scale=rate_scale,
    )
    payload["model_benchmarks"] = _compute_model_benchmarks(
        eval_rows=parsed_eval_rows,
        manifest_rows_by_clip=manifest_rows_by_clip,
        medical_terms=medical_terms,
        wer_scale=wer_scale,
        rate_scale=rate_scale,
    )
    return payload


def _compute_model_benchmarks(
    *,
    eval_rows: Sequence[dict[str, Any]],
    manifest_rows_by_clip: dict[str, dict[str, str]],
    medical_terms: list[list[str]],
    wer_scale: float,
    rate_scale: float,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for spec in MODEL_BENCHMARK_SPECS:
        summary = _model_summary_from_eval_rows(
            eval_rows=eval_rows,
            manifest_rows_by_clip=manifest_rows_by_clip,
            medical_terms=medical_terms,
            hypothesis_field=spec["field"],
            wer_scale=wer_scale,
            rate_scale=rate_scale,
        )
        if not summary:
            continue
        rows.append(
            {
                "id": spec["id"],
                "label": spec["label"],
                "clip_count": summary["clip_count"],
                "avg_wer": summary["avg_wer"],
                "avg_cer": summary["avg_cer"],
                "avg_digit_accuracy": summary["avg_digit_accuracy"],
                "avg_medical_keyword_accuracy": summary["avg_medical_keyword_accuracy"],
            }
        )
    return rows


def _model_summary_from_eval_rows(
    *,
    eval_rows: Sequence[dict[str, Any]],
    manifest_rows_by_clip: dict[str, dict[str, str]],
    medical_terms: list[list[str]],
    hypothesis_field: str,
    wer_scale: float,
    rate_scale: float,
) -> dict[str, Any] | None:
    per_clip: list[dict[str, Any]] = []
    for row in eval_rows:
        clip_id = str(row.get("clip_id") or "").strip()
        hypothesis_text = _coerce_text(row.get(hypothesis_field))
        if not clip_id or not hypothesis_text:
            continue
        manifest = manifest_rows_by_clip.get(clip_id, {})
        reference_text = _coerce_text(
            row.get("ground_truth")
            or row.get("reference_text")
            or row.get("text")
            or manifest.get("ground_truth")
        )
        if not reference_text:
            continue
        explicit_keywords = _parse_medical_keywords(
            row.get("medical_keywords") or manifest.get("medical_keywords")
        )
        metrics = _compute_text_metrics(
            reference_text=reference_text,
            hypothesis_text=hypothesis_text,
            medical_terms=medical_terms,
            explicit_keywords=explicit_keywords,
            wer_scale=wer_scale,
            rate_scale=rate_scale,
        )
        per_clip.append(
            {
                "clip_id": clip_id,
                "wer": metrics["wer"],
                "cer": metrics["cer"],
                "digit_accuracy": metrics["digit_accuracy"],
                "medical_keyword_accuracy": metrics["medical_keyword_accuracy"],
            }
        )

    if not per_clip:
        return None

    return {
        "clip_count": len(per_clip),
        "avg_wer": _mean([float(row["wer"]) for row in per_clip if row["wer"] is not None]),
        "avg_cer": _mean([float(row["cer"]) for row in per_clip if row["cer"] is not None]),
        "avg_digit_accuracy": _mean_optional(
            [row["digit_accuracy"] for row in per_clip]
        ),
        "avg_medical_keyword_accuracy": _mean_optional(
            [row["medical_keyword_accuracy"] for row in per_clip]
        ),
        "results": per_clip,
    }


def _compute_model_comparison(
    *,
    eval_rows: Sequence[dict[str, Any]],
    manifest_rows_by_clip: dict[str, dict[str, str]],
    medical_terms: list[list[str]],
    wer_scale: float,
    rate_scale: float,
) -> dict[str, Any] | None:
    base_model_id = next(
        (
            str(row.get("base_whisper_model_id") or "").strip()
            for row in eval_rows
            if isinstance(row, dict) and str(row.get("base_whisper_model_id") or "").strip()
        ),
        DEFAULT_BASE_WHISPER_MODEL_ID,
    )
    fine_tuned_model_id = next(
        (
            str(row.get("fine_tuned_model_id") or "").strip()
            for row in eval_rows
            if isinstance(row, dict) and str(row.get("fine_tuned_model_id") or "").strip()
        ),
        "full_ft",
    )

    base_model = _model_summary_from_eval_rows(
        eval_rows=eval_rows,
        manifest_rows_by_clip=manifest_rows_by_clip,
        medical_terms=medical_terms,
        hypothesis_field="base_whisper_small_text",
        wer_scale=wer_scale,
        rate_scale=rate_scale,
    )
    fine_tuned_model = _model_summary_from_eval_rows(
        eval_rows=eval_rows,
        manifest_rows_by_clip=manifest_rows_by_clip,
        medical_terms=medical_terms,
        hypothesis_field="full_ft_text",
        wer_scale=wer_scale,
        rate_scale=rate_scale,
    )
    if not base_model or not fine_tuned_model:
        return None

    clip_lookup = {
        row["clip_id"]: row
        for row in base_model["results"]
        if isinstance(row, dict) and row.get("clip_id")
    }
    per_clip: list[dict[str, Any]] = []
    for fine_row in fine_tuned_model["results"]:
        if not isinstance(fine_row, dict):
            continue
        clip_id = str(fine_row.get("clip_id") or "").strip()
        if not clip_id:
            continue
        base_row = clip_lookup.get(clip_id)
        if not base_row:
            continue
        per_clip.append(
            {
                "clip_id": clip_id,
                "base_wer": base_row.get("wer"),
                "fine_tuned_wer": fine_row.get("wer"),
                "wer_reduction": _round(
                    float(base_row.get("wer") or 0.0) - float(fine_row.get("wer") or 0.0)
                ),
            }
        )

    return {
        "base_model": {
            "id": base_model_id,
            "label": "Base Whisper Small",
            "clip_count": base_model["clip_count"],
            "avg_wer": base_model["avg_wer"],
            "avg_cer": base_model["avg_cer"],
            "avg_digit_accuracy": base_model["avg_digit_accuracy"],
            "avg_medical_keyword_accuracy": base_model["avg_medical_keyword_accuracy"],
        },
        "fine_tuned_model": {
            "id": fine_tuned_model_id,
            "label": "Fine-Tuned Telephony",
            "clip_count": fine_tuned_model["clip_count"],
            "avg_wer": fine_tuned_model["avg_wer"],
            "avg_cer": fine_tuned_model["avg_cer"],
            "avg_digit_accuracy": fine_tuned_model["avg_digit_accuracy"],
            "avg_medical_keyword_accuracy": fine_tuned_model["avg_medical_keyword_accuracy"],
        },
        "delta": {
            "wer_reduction": _round(
                float(base_model["avg_wer"]) - float(fine_tuned_model["avg_wer"])
            ),
            "cer_reduction": _round(
                float(base_model["avg_cer"]) - float(fine_tuned_model["avg_cer"])
            ),
            "digit_accuracy_gain": _round(
                float(fine_tuned_model["avg_digit_accuracy"] or 0.0)
                - float(base_model["avg_digit_accuracy"] or 0.0)
            ),
            "medical_keyword_accuracy_gain": _round(
                float(fine_tuned_model["avg_medical_keyword_accuracy"] or 0.0)
                - float(base_model["avg_medical_keyword_accuracy"] or 0.0)
            ),
        },
        "per_clip": per_clip,
    }


def _join_text(parts: Sequence[str]) -> str:
    return " ".join(part.strip() for part in parts if part and part.strip())


def _scaled_ratio(value: float | None, scale: float) -> float:
    if value is None:
        return 0.0
    return _round(value * scale)


def _build_ablation_rows(
    eval_rows: Sequence[dict[str, Any]],
    *,
    wer_scale: float,
    verification_enabled: bool = True,
) -> tuple[list[dict[str, Any]], float]:
    if not eval_rows:
        return [], 0.0

    reference_tokens = [_tokens(str(row.get("ground_truth") or "")) for row in eval_rows]
    stage_keys = [
        (
            "baseline_raw_text",
            "Raw Scribe v2 (no preprocessing, no keyterms)",
            "Direct Scribe pass on the source telephony clip with no preprocessing or benchmark keyterms.",
        ),
        (
            "preprocessed_raw_text",
            "+ Audio Preprocessing",
            "Runs the ffmpeg preprocessing chain before transcription, still with no benchmark keyterms.",
        ),
        (
            "keyterm_raw_text",
            "+ Dynamic Keyterms",
            "Feeds the live learning-loop keyterms into Scribe before any verification or correction.",
        ),
        (
            "corrected_text",
            (
                "+ Tavily Verification + Safe Correction"
                if verification_enabled
                else "+ Verification Layer Disabled"
            ),
            (
                "Applies the full uncertainty, verification, and Claude correction pipeline with the hallucination guard."
                if verification_enabled
                else "Keeps preprocessing, dynamic keyterms, and rule-based uncertainty, but skips XGBoost, Tavily, and Claude so corrected text is a raw pass-through."
            ),
        ),
    ]

    rows: list[dict[str, Any]] = []
    previous_wer: float | None = None
    stage_wers: dict[str, float] = {}

    for key, stage_name, description in stage_keys:
        values: list[float] = []
        for reference, eval_row in zip(reference_tokens, eval_rows):
            hypothesis = _tokens(str(eval_row.get(key) or ""))
            values.append(_error_rate_ratio(reference, hypothesis))
        avg_wer = _mean(values)
        stage_wers[key] = avg_wer
        scaled_wer = _round(avg_wer * wer_scale)
        delta = 0.0 if previous_wer is None else _round(scaled_wer - previous_wer)
        rows.append(
            {
                "stage": stage_name,
                "wer": scaled_wer,
                "delta": delta,
                "description": description,
            }
        )
        previous_wer = scaled_wer

    keyterm_stage = stage_wers.get("keyterm_raw_text", 0.0)
    preprocessed_stage = stage_wers.get("preprocessed_raw_text", 0.0)
    keyterm_impact_pct = 0.0
    if preprocessed_stage > 0:
        keyterm_impact_pct = max(0.0, ((preprocessed_stage - keyterm_stage) / preprocessed_stage) * 100.0)

    return rows, _round(keyterm_impact_pct)


def _load_whisper_pipeline(model_ref: str) -> Any:
    cached = _WHISPER_PIPELINE_CACHE.get(model_ref)
    if cached is not None:
        return cached

    try:
        from transformers import pipeline  # type: ignore[import-not-found]
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(
            "Benchmark comparison needs torch and transformers installed."
        ) from exc

    pipeline_kwargs: dict[str, Any] = {
        "task": "automatic-speech-recognition",
        "model": model_ref,
        "tokenizer": model_ref,
        "feature_extractor": model_ref,
        "device": -1,
        "model_kwargs": {"low_cpu_mem_usage": True},
    }
    token = _huggingface_token()
    if token:
        pipeline_kwargs["token"] = token

    pipe = pipeline(**pipeline_kwargs)
    _WHISPER_PIPELINE_CACHE[model_ref] = pipe
    return pipe


def _huggingface_token() -> str:
    token = os.getenv("HF_TOKEN", "").strip() or os.getenv("HUGGINGFACE_HUB_TOKEN", "").strip()
    if token:
        return token

    _ensure_backend_imports()
    try:
        from app.config import settings  # type: ignore
    except Exception:  # noqa: BLE001
        return ""
    return settings.huggingface_token()


def _default_transcribe_kwargs() -> dict[str, Any]:
    return {
        "language": "en",
        "task": "transcribe",
    }


async def _transcribe_with_whisper_model(model_ref: str, wav_path: Path) -> str:
    pipe = _load_whisper_pipeline(model_ref)
    payload = await asyncio.to_thread(
        pipe,
        str(wav_path),
        return_timestamps="word",
        generate_kwargs=_default_transcribe_kwargs(),
    )
    if not isinstance(payload, dict):
        raise RuntimeError(f"Unexpected ASR output while transcribing {wav_path.name}")
    return _coerce_text(payload.get("text"))


async def _maybe_add_model_comparison_transcripts(
    eval_row: dict[str, Any],
    *,
    audio_path: Path,
    fine_tuned_model_path: Path | None,
    base_model_id: str,
) -> None:
    try:
        eval_row["base_whisper_small_text"] = await _transcribe_with_whisper_model(
            base_model_id,
            audio_path,
        )
    except Exception as exc:  # noqa: BLE001
        eval_row["base_whisper_small_error"] = str(exc)

    if fine_tuned_model_path is None:
        return

    try:
        eval_row["full_ft_text"] = await _transcribe_with_whisper_model(
            str(fine_tuned_model_path),
            audio_path,
        )
    except Exception as exc:  # noqa: BLE001
        # Keep benchmark generation working even if comparison models are unavailable locally.
        eval_row["model_comparison_error"] = str(exc)


async def _add_model_benchmark_transcripts(
    eval_rows: Sequence[dict[str, Any]],
    *,
    audio_paths_by_clip: dict[str, Path],
    base_whisper_model_id: str,
) -> None:
    from stt.runtime import get_batch_provider, resolve_named_model_location  # type: ignore

    for spec in MODEL_BENCHMARK_SPECS:
        provider_name = spec["provider"]
        hypothesis_field = spec["field"]
        error_field = f"{hypothesis_field}_error"

        if all(_coerce_text(row.get(hypothesis_field)) for row in eval_rows):
            continue

        if provider_name == "base_whisper_small":
            for eval_row in eval_rows:
                clip_id = str(eval_row.get("clip_id") or "").strip()
                if not clip_id:
                    continue
                audio_path = audio_paths_by_clip.get(clip_id)
                if audio_path is None:
                    eval_row[error_field] = f"missing benchmark audio for clip {clip_id}"
                    continue
                try:
                    eval_row[hypothesis_field] = await _transcribe_with_whisper_model(
                        base_whisper_model_id,
                        audio_path,
                    )
                except Exception as exc:  # noqa: BLE001
                    eval_row[error_field] = str(exc)
            continue

        if provider_name != "scribe_v2":
            validation = resolve_named_model_location(provider_name).validation
            if not validation.ready:
                reason = f"provider unavailable: {validation.reason}"
                for eval_row in eval_rows:
                    eval_row[error_field] = reason
                continue

        try:
            provider = get_batch_provider(provider_name)
        except Exception as exc:  # noqa: BLE001
            reason = f"provider init failed: {exc}"
            for eval_row in eval_rows:
                eval_row[error_field] = reason
            continue

        for eval_row in eval_rows:
            clip_id = str(eval_row.get("clip_id") or "").strip()
            if not clip_id:
                continue
            audio_path = audio_paths_by_clip.get(clip_id)
            if audio_path is None:
                eval_row[error_field] = f"missing benchmark audio for clip {clip_id}"
                continue
            try:
                result = await provider.transcribe_batch(str(audio_path), [])
                eval_row[hypothesis_field] = _join_text([word.text for word in result.words])
            except Exception as exc:  # noqa: BLE001
                eval_row[error_field] = str(exc)


async def _generate_eval_rows_via_pipeline(
    manifest_rows_by_clip: dict[str, dict[str, str]],
    *,
    manifest_path: Path,
    wer_scale: float,
    rate_scale: float,
    base_whisper_model_id: str,
    verification_enabled: bool,
) -> tuple[list[dict[str, Any]], dict[str, float], list[dict[str, Any]], float]:
    _ensure_backend_imports()

    from app import learning_loop, pipeline, preprocessing, scribe  # type: ignore
    from app.claude_correct import reset_corrector  # type: ignore
    from app.storage import store  # type: ignore
    from app.tavily_verify import reset_verifier  # type: ignore
    from stt.runtime import resolve_local_model_location  # type: ignore

    store.reset()
    reset_verifier()
    reset_corrector()
    fine_tuned_validation = resolve_local_model_location().validation
    fine_tuned_model_path = fine_tuned_validation.path if fine_tuned_validation.ready else None

    eval_rows: list[dict[str, Any]] = []
    audio_paths_by_clip: dict[str, Path] = {}
    verified_changes = 0
    unresolved_flagged = 0
    unsafe_changes = 0
    total_changed = 0
    phonetic_hits = 0
    total_error_tokens = 0
    flagged_error_tokens = 0

    for manifest_row in _ordered_manifest_rows(manifest_rows_by_clip):
        clip_id = str(manifest_row.get("clip_id") or "").strip()
        reference_text = str(manifest_row.get("ground_truth") or "").strip()
        if not clip_id or not reference_text:
            raise SystemExit(
                f"Benchmark manifest row is missing clip_id or ground_truth: {manifest_row}"
            )

        audio_path = _resolve_benchmark_audio_path(manifest_row, manifest_path)
        audio_paths_by_clip[clip_id] = audio_path
        cleaned_path = await preprocessing.preprocess(str(audio_path))

        baseline_result = await scribe.transcribe_batch(str(audio_path), [])
        preprocessed_result = await scribe.transcribe_batch(cleaned_path, [])
        keyterms = learning_loop.get_keyterms(top_n=100)
        keyterm_result = await scribe.transcribe_batch(cleaned_path, keyterms)
        final_result = await pipeline.run_pipeline_from_scribe_words(
            keyterm_result.words,
            verification_enabled=verification_enabled,
        )

        baseline_raw_text = _join_text([word.text for word in baseline_result.words])
        preprocessed_raw_text = _join_text([word.text for word in preprocessed_result.words])
        keyterm_raw_text = _join_text([word.text for word in keyterm_result.words])
        corrected_text = _join_text([word.word for word in final_result.corrected_transcript])

        eval_row = {
            "clip_id": clip_id,
            "category": str(manifest_row.get("category") or "Unknown"),
            "difficulty": str(manifest_row.get("difficulty") or "Standard"),
            "ground_truth": reference_text,
            "raw_text": baseline_raw_text,
            "corrected_text": corrected_text,
            "baseline_raw_text": baseline_raw_text,
            "preprocessed_raw_text": preprocessed_raw_text,
            "keyterm_raw_text": keyterm_raw_text,
            "medical_keywords": str(manifest_row.get("medical_keywords") or ""),
            "base_whisper_model_id": base_whisper_model_id,
            "fine_tuned_model_id": "full_ft",
        }
        await _maybe_add_model_comparison_transcripts(
            eval_row,
            audio_path=audio_path,
            fine_tuned_model_path=fine_tuned_model_path,
            base_model_id=base_whisper_model_id,
        )
        eval_rows.append(eval_row)

        raw_tokens = _tokens(keyterm_raw_text)
        reference_tokens = _tokens(reference_text)
        error_indices = _error_hypothesis_indices(reference_tokens, raw_tokens)
        total_error_tokens += len(error_indices)

        token_confidences: list[str] = []
        for raw_word in final_result.raw_transcript:
            word_tokens = _tokens(raw_word.word)
            if not word_tokens:
                continue
            token_confidences.extend([raw_word.confidence] * len(word_tokens))

        for idx in error_indices:
            if idx < len(token_confidences) and token_confidences[idx] in {"LOW", "MEDIUM"}:
                flagged_error_tokens += 1

        for raw_word, corrected_word in zip(
            final_result.raw_transcript,
            final_result.corrected_transcript,
        ):
            if corrected_word.changed:
                total_changed += 1
                if corrected_word.tavily_verified:
                    verified_changes += 1
                    if any(
                        signal.startswith("phonetic_distance")
                        for signal in (raw_word.uncertainty_signals or [])
                    ):
                        phonetic_hits += 1
                else:
                    unsafe_changes += 1
            elif corrected_word.unverified:
                unresolved_flagged += 1

    await _add_model_benchmark_transcripts(
        eval_rows,
        audio_paths_by_clip=audio_paths_by_clip,
        base_whisper_model_id=base_whisper_model_id,
    )

    verification_denominator = verified_changes + unresolved_flagged
    metrics = {
        "verification_rate": _scaled_ratio(
            (verified_changes / verification_denominator) if verification_denominator else None,
            rate_scale,
        ),
        "unsafe_guess_rate": _scaled_ratio(
            (unsafe_changes / total_changed) if total_changed else None,
            rate_scale,
        ),
        "uncertainty_coverage": _scaled_ratio(
            (flagged_error_tokens / total_error_tokens) if total_error_tokens else None,
            rate_scale,
        ),
        "phonetic_hit_rate": _scaled_ratio(
            (phonetic_hits / verified_changes) if verified_changes else None,
            rate_scale,
        ),
    }
    ablation, keyterm_impact_pct = _build_ablation_rows(
        eval_rows,
        wer_scale=wer_scale,
        verification_enabled=verification_enabled,
    )
    return eval_rows, metrics, ablation, keyterm_impact_pct


def main() -> int:
    args = _parse_args()
    source = _resolve_source_path(args.source)
    payload = _load_json(source)
    manifest_rows_by_clip = _load_manifest_rows(args.manifest)
    wer_scale, rate_scale = _scale_from_source(payload)

    if args.run_pipeline:
        verification_enabled = args.verification_layer == "on"
        eval_rows, metrics, ablation, keyterm_impact_pct = asyncio.run(
            _generate_eval_rows_via_pipeline(
                manifest_rows_by_clip,
                manifest_path=args.manifest,
                wer_scale=wer_scale,
                rate_scale=rate_scale,
                base_whisper_model_id=args.base_whisper_model,
                verification_enabled=verification_enabled,
            )
        )
        args.eval.parent.mkdir(parents=True, exist_ok=True)
        args.eval.write_text(
            "".join(json.dumps(row) + "\n" for row in eval_rows),
            encoding="utf-8",
        )
        payload["metrics"] = {
            **(payload.get("metrics") if isinstance(payload.get("metrics"), dict) else {}),
            **metrics,
        }
        payload["ablation"] = ablation
        aggregate = payload.get("aggregate")
        if not isinstance(aggregate, dict):
            aggregate = {}
        aggregate["keyterm_impact_pct"] = keyterm_impact_pct
        payload["aggregate"] = aggregate

    payload = _recompute(payload, args.eval, manifest_rows_by_clip=manifest_rows_by_clip)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    if args.run_pipeline:
        print(f"Wrote live benchmark eval rows and recomputed artifact: {args.out}")
    elif args.eval.exists():
        print(f"Wrote recomputed benchmark artifact from eval rows: {args.out}")
    else:
        print(f"Wrote benchmark artifact from baseline source: {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
