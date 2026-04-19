from __future__ import annotations

import importlib.util
import json
from pathlib import Path


def _load_run_benchmark_module():
    path = Path(__file__).resolve().parents[1] / "scripts" / "run_benchmark.py"
    spec = importlib.util.spec_from_file_location("run_benchmark", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _baseline_payload() -> dict:
    return {
        "results": [
            {
                "clip_id": "clip_a",
                "category": "Medication Refill",
                "difficulty": "Standard",
                "raw_wer": 0.2,
                "corrected_wer": 0.1,
                "improvement_pct": 50.0,
            }
        ],
        "ablation": [],
        "metrics": {
            "verification_rate": 0.9,
            "unsafe_guess_rate": 0.0,
            "uncertainty_coverage": 0.8,
            "phonetic_hit_rate": 0.7,
        },
        "aggregate": {
            "avg_raw_wer": 0.2,
            "avg_corrected_wer": 0.1,
            "avg_improvement_pct": 50.0,
            "keyterm_impact_pct": 12.0,
        },
    }


def test_recompute_fallback_adds_optional_fields(tmp_path):
    mod = _load_run_benchmark_module()
    payload = _baseline_payload()

    out = mod._recompute(payload=payload, eval_path=tmp_path / "missing.jsonl")

    row = out["results"][0]
    assert row["raw_cer"] is None
    assert row["corrected_cer"] is None
    assert row["raw_digit_accuracy"] is None
    assert row["corrected_digit_accuracy"] is None
    assert row["raw_medical_keyword_accuracy"] is None
    assert row["corrected_medical_keyword_accuracy"] is None

    agg = out["aggregate"]
    assert agg["avg_raw_cer"] is None
    assert agg["avg_corrected_cer"] is None
    assert agg["avg_raw_digit_accuracy"] is None
    assert agg["avg_corrected_digit_accuracy"] is None
    assert agg["avg_raw_medical_keyword_accuracy"] is None
    assert agg["avg_corrected_medical_keyword_accuracy"] is None


def test_recompute_metrics_from_eval_rows(tmp_path):
    mod = _load_run_benchmark_module()
    payload = _baseline_payload()

    eval_row = {
        "clip_id": "clip_a",
        "category": "Medication Refill",
        "difficulty": "Standard",
        "ground_truth": "I take metformin 50 mg once daily",
        "raw_text": "I take metfornin 15 mg once daily",
        "corrected_text": "I take metformin 50 mg once daily",
    }

    eval_path = tmp_path / "benchmark_eval.jsonl"
    eval_path.write_text(json.dumps(eval_row) + "\n", encoding="utf-8")

    out = mod._recompute(payload=payload, eval_path=eval_path)

    row = out["results"][0]
    assert row["clip_id"] == "clip_a"
    assert row["corrected_wer"] <= row["raw_wer"]
    assert row["corrected_cer"] <= row["raw_cer"]
    assert row["corrected_digit_accuracy"] >= row["raw_digit_accuracy"]
    assert row["corrected_medical_keyword_accuracy"] >= row["raw_medical_keyword_accuracy"]

    agg = out["aggregate"]
    assert agg["avg_raw_cer"] is not None
    assert agg["avg_corrected_cer"] is not None
    assert agg["avg_raw_digit_accuracy"] is not None
    assert agg["avg_corrected_digit_accuracy"] is not None
    assert agg["avg_raw_medical_keyword_accuracy"] is not None
    assert agg["avg_corrected_medical_keyword_accuracy"] is not None


def test_recompute_builds_model_comparison_when_eval_rows_include_both_models(tmp_path):
    mod = _load_run_benchmark_module()
    payload = _baseline_payload()

    eval_row = {
        "clip_id": "clip_a",
        "category": "Medication Refill",
        "difficulty": "Standard",
        "ground_truth": "take metformin 50 mg daily",
        "raw_text": "take metfornin 15 mg daily",
        "corrected_text": "take metformin 50 mg daily",
        "base_whisper_small_text": "take metfornin 15 mg daily",
        "full_ft_text": "take metformin 50 mg daily",
        "medical_keywords": ["metformin"],
    }

    eval_path = tmp_path / "benchmark_eval.jsonl"
    eval_path.write_text(json.dumps(eval_row) + "\n", encoding="utf-8")

    out = mod._recompute(payload=payload, eval_path=eval_path)

    comparison = out["comparison"]
    assert comparison is not None
    assert comparison["base_model"]["avg_wer"] > comparison["fine_tuned_model"]["avg_wer"]
    assert comparison["delta"]["wer_reduction"] > 0
    assert comparison["delta"]["digit_accuracy_gain"] > 0
    assert comparison["delta"]["medical_keyword_accuracy_gain"] > 0


def test_resolve_benchmark_audio_path_prefers_manifest_audio(tmp_path):
    mod = _load_run_benchmark_module()
    manifest_path = tmp_path / "manifest.csv"
    audio_dir = tmp_path / "audio" / "standard"
    audio_dir.mkdir(parents=True)
    audio_path = audio_dir / "clip_01.wav"
    audio_path.write_bytes(b"wav")

    resolved = mod._resolve_benchmark_audio_path(
        {
            "clip_id": "clip_01",
            "audio_relpath": "audio/standard/clip_01.wav",
            "notes": "source: something (clip_0001_clean)",
        },
        manifest_path,
    )

    assert resolved == audio_path


def test_resolve_benchmark_audio_path_falls_back_to_generated_source(tmp_path):
    mod = _load_run_benchmark_module()
    manifest_path = tmp_path / "manifest.csv"
    generated_dir = tmp_path / "generated"
    generated_dir.mkdir()
    fallback = generated_dir / "clip_0002_clean.wav"
    fallback.write_bytes(b"wav")

    resolved = mod._resolve_benchmark_audio_path(
        {
            "clip_id": "clip_02",
            "audio_relpath": "audio/standard/clip_02.wav",
            "notes": "source: audio_gen/input/clips_5x_variants.csv (clip_0002_clean)",
        },
        manifest_path,
        generated_telephony_dir=generated_dir,
    )

    assert resolved == fallback


def test_build_ablation_rows_uses_live_eval_stage_texts():
    mod = _load_run_benchmark_module()

    rows, keyterm_impact_pct = mod._build_ablation_rows(
        [
            {
                "ground_truth": "I take metformin 50 mg once daily",
                "baseline_raw_text": "I take metfornin 15 mg once daily",
                "preprocessed_raw_text": "I take metfornin 50 mg once daily",
                "keyterm_raw_text": "I take metformin 50 mg once daily",
                "corrected_text": "I take metformin 50 mg once daily",
            }
        ],
        wer_scale=100.0,
    )

    assert [row["stage"] for row in rows] == [
        "Raw Scribe v2 (no preprocessing, no keyterms)",
        "+ Audio Preprocessing",
        "+ Dynamic Keyterms",
        "+ Tavily Verification + Safe Correction",
    ]
    assert rows[0]["wer"] > rows[1]["wer"]
    assert rows[1]["wer"] >= rows[2]["wer"]
    assert rows[2]["wer"] == rows[3]["wer"] == 0.0
    assert keyterm_impact_pct > 0


def test_error_hypothesis_indices_marks_substitutions_and_insertions():
    mod = _load_run_benchmark_module()

    indices = mod._error_hypothesis_indices(
        ["i", "take", "metformin"],
        ["i", "take", "metfornin", "today"],
    )

    assert indices == {2, 3}
