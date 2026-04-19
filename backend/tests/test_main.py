"""Smoke tests for the FastAPI app — every endpoint with Person A's stubs mocked."""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app import claude_correct, claude_extract, main, pipeline, scribe, uncertainty
from app.schemas import (
    ClinicalSummary,
    CorrectedWord,
    Medication,
    PipelineLatency,
    ScribeResult,
    ScribeWord,
    TranscribeResponse,
    VerifyResult,
    WordWithConfidence,
)


@pytest.fixture
def client(monkeypatch):
    # ---- Mock Person A: preprocessing returns a dummy path ----
    async def fake_preprocess(input_path: str) -> str:
        return input_path

    monkeypatch.setattr(pipeline.preprocessing, "preprocess", fake_preprocess)

    # ---- Mock Person A: scribe returns 3 words ----
    async def fake_transcribe(wav_path: str, keyterms: list[str]) -> ScribeResult:
        return ScribeResult(
            words=[
                ScribeWord(text="metformin", start_ms=0, end_ms=400, speaker_id="speaker_0"),
                ScribeWord(text="for", start_ms=400, end_ms=500, speaker_id="speaker_0"),
                ScribeWord(text="diabetes", start_ms=500, end_ms=900, speaker_id="speaker_0"),
            ],
            duration_ms=900,
        )

    monkeypatch.setattr(scribe, "transcribe_batch", fake_transcribe)

    # ---- Mock Person A: uncertainty returns parallel HIGH confidence words ----
    def fake_score(words, keyterms, phonetic_map, correction_history):
        return [
            WordWithConfidence(
                word=w.text,
                start_ms=w.start_ms,
                end_ms=w.end_ms,
                speaker_id=w.speaker_id,
                confidence="HIGH",
            )
            for w in words
        ]

    monkeypatch.setattr(uncertainty, "score_words", fake_score)

    # ---- Mock Person B: Claude correction returns identity ----
    class FakeCorrector:
        async def correct(self, raw_words, verifications, speakers):
            return [
                CorrectedWord(
                    word=w.word,
                    changed=False,
                    tavily_verified=False,
                    unverified=False,
                    speaker=speakers[i],  # type: ignore[arg-type]
                )
                for i, w in enumerate(raw_words)
            ]

    class FakeExtractor:
        async def extract(self, corrected, verifications) -> ClinicalSummary:
            return ClinicalSummary(
                medications=[
                    Medication(
                        name="metformin",
                        dosage="500 mg",
                        frequency="twice daily",
                        route="oral",
                        tavily_verified=False,
                    )
                ],
                symptoms=[],
                allergies=[],
                follow_up_actions=[],
                appointment_needed=False,
            )

    monkeypatch.setattr(claude_correct, "get_corrector", lambda: FakeCorrector())
    monkeypatch.setattr(claude_extract, "get_extractor", lambda: FakeExtractor())
    monkeypatch.setattr(main.settings, "STT_PROVIDER", "scribe_v2")

    return TestClient(main.app)


def test_transcribe_end_to_end(client):
    resp = client.post(
        "/transcribe",
        files={"file": ("test.wav", b"RIFF....fake-audio", "audio/wav")},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert len(body["raw_transcript"]) == 3
    assert body["raw_transcript"][0]["word"] == "metformin"
    assert body["raw_transcript"][0]["speaker"] in ("Doctor", "Patient")
    assert body["clinical_summary"]["medications"][0]["name"] == "metformin"
    # Hallucination guard invariant: every changed word must be tavily_verified
    for cw in body["corrected_transcript"]:
        if cw["changed"]:
            assert cw["tavily_verified"] is True
    assert "preprocessing" in body["pipeline_latency_ms"]
    assert "total" in body["pipeline_latency_ms"]


def test_transcribe_passes_requested_stt_model(monkeypatch):
    captured: dict[str, str | None] = {"stt_model": None}

    async def fake_run_full_pipeline(audio_path: str, *, stt_provider_override: str | None = None):
        del audio_path
        captured["stt_model"] = stt_provider_override
        return TranscribeResponse(
            raw_transcript=[],
            corrected_transcript=[],
            clinical_summary=ClinicalSummary(),
            pipeline_latency_ms=PipelineLatency(
                preprocessing=0,
                scribe=0,
                uncertainty=0,
                tavily=0,
                claude=0,
                total=0,
            ),
        )

    monkeypatch.setattr(main.pipeline, "run_full_pipeline", fake_run_full_pipeline)

    fresh = TestClient(main.app)
    resp = fresh.post(
        "/transcribe",
        data={"stt_model": "full_ft"},
        files={"file": ("test.wav", b"RIFF....fake-audio", "audio/wav")},
    )

    assert resp.status_code == 200, resp.text
    assert captured["stt_model"] == "full_ft"


def test_transcribe_returns_501_when_person_a_stub(monkeypatch):
    """Without the fixture overrides, the real preprocessing stub raises NotImplementedError."""
    # Force the stub state for a fresh client (don't use the mocked fixture)
    async def stub_preprocess(input_path: str) -> str:
        raise NotImplementedError("preprocessing.preprocess — Person A")

    monkeypatch.setattr(pipeline.preprocessing, "preprocess", stub_preprocess)

    fresh = TestClient(main.app)
    resp = fresh.post(
        "/transcribe",
        files={"file": ("test.wav", b"RIFF", "audio/wav")},
    )
    assert resp.status_code == 501
    assert "Person A" in resp.json()["detail"]


def test_benchmark_returns_503_when_missing(monkeypatch, tmp_path):
    monkeypatch.setattr(main.settings, "BENCHMARK_RESULTS_PATH", tmp_path / "missing.json")
    fresh = TestClient(main.app)
    resp = fresh.get("/benchmark")
    assert resp.status_code == 503
    assert "Person A" in resp.json()["detail"]


def test_benchmark_serves_cached_json(monkeypatch, tmp_path):
    src = main.settings.BENCHMARK_RESULTS_PATH.parent / "benchmark_results.json.example"
    if not src.exists():
        pytest.skip("benchmark example file missing")
    target = tmp_path / "benchmark_results.json"
    target.write_text(src.read_text(encoding="utf-8"), encoding="utf-8")
    monkeypatch.setattr(main.settings, "BENCHMARK_RESULTS_PATH", target)

    fresh = TestClient(main.app)
    resp = fresh.get("/benchmark")
    assert resp.status_code == 200
    body = resp.json()
    assert "results" in body
    assert "ablation" in body
    assert "metrics" in body
    assert "aggregate" in body
    assert "comparison" in body
    assert "raw_cer" in body["results"][0]
    assert "corrected_cer" in body["results"][0]
    assert "raw_digit_accuracy" in body["results"][0]
    assert "corrected_digit_accuracy" in body["results"][0]
    assert "raw_medical_keyword_accuracy" in body["results"][0]
    assert "corrected_medical_keyword_accuracy" in body["results"][0]
    assert "avg_raw_cer" in body["aggregate"]
    assert "avg_corrected_cer" in body["aggregate"]
    assert "avg_raw_digit_accuracy" in body["aggregate"]
    assert "avg_corrected_digit_accuracy" in body["aggregate"]
    assert "avg_raw_medical_keyword_accuracy" in body["aggregate"]
    assert "avg_corrected_medical_keyword_accuracy" in body["aggregate"]


def test_benchmark_filters_by_difficulty(monkeypatch, tmp_path):
    payload = {
        "results": [
            {
                "clip_id": "a",
                "category": "x",
                "difficulty": "Standard",
                "raw_wer": 0.1,
                "corrected_wer": 0.05,
                "improvement_pct": 50.0,
            },
            {
                "clip_id": "b",
                "category": "y",
                "difficulty": "Adversarial",
                "raw_wer": 0.2,
                "corrected_wer": 0.05,
                "improvement_pct": 75.0,
            },
        ],
        "ablation": [],
        "metrics": {
            "verification_rate": 0.0,
            "unsafe_guess_rate": 0.0,
            "uncertainty_coverage": 0.0,
            "phonetic_hit_rate": 0.0,
        },
        "aggregate": {
            "avg_raw_wer": 0.0,
            "avg_corrected_wer": 0.0,
            "avg_improvement_pct": 0.0,
            "keyterm_impact_pct": 0.0,
        },
    }
    target = tmp_path / "benchmark_results.json"
    target.write_text(json.dumps(payload), encoding="utf-8")
    monkeypatch.setattr(main.settings, "BENCHMARK_RESULTS_PATH", target)

    fresh = TestClient(main.app)
    resp = fresh.get("/benchmark?clips=adversarial")
    assert resp.status_code == 200
    results = resp.json()["results"]
    assert len(results) == 1
    assert results[0]["clip_id"] == "b"


def test_learning_loop_returns_503_when_missing():
    fresh = TestClient(main.app)
    resp = fresh.get("/learning-loop")
    assert resp.status_code == 503


def test_learning_loop_serves_report(monkeypatch):
    monkeypatch.setattr(
        "xgb.reporting.load_learning_loop_report",
        lambda: {
            "metric_name": "logloss",
            "training_history": [
                {"round": 0, "train_value": 0.62, "validation_value": 0.71},
                {"round": 1, "train_value": 0.51, "validation_value": 0.6},
            ],
            "retraining_snapshots": [
                {
                    "snapshot_index": 1,
                    "timestamp_utc": "2026-04-12T00:00:00+00:00",
                    "clip_count": 4,
                    "row_count": 80,
                    "accuracy": 0.8,
                    "f1": 0.77,
                    "auc": 0.84,
                    "best_iteration": 12,
                }
            ],
            "feature_importance": [
                {"feature": "cat__word_text_metformin", "importance": 0.42}
            ],
            "summary": {
                "history_rounds": 2,
                "snapshot_count": 1,
                "latest_clip_count": 4,
                "latest_row_count": 80,
                "latest_accuracy": 0.8,
                "latest_f1": 0.77,
                "latest_auc": 0.84,
            },
        },
    )

    fresh = TestClient(main.app)
    resp = fresh.get("/learning-loop")
    assert resp.status_code == 200
    body = resp.json()
    assert body["metric_name"] == "logloss"
    assert len(body["training_history"]) == 2
    assert len(body["retraining_snapshots"]) == 1
    assert len(body["feature_importance"]) == 1


def test_health_returns_in_memory(monkeypatch):
    async def fake_ping():
        return "not_configured"

    monkeypatch.setattr(main, "_ping_tavily", fake_ping)
    monkeypatch.setattr(main, "_ping_claude", fake_ping)
    monkeypatch.setattr(main, "batch_provider_status", lambda: "scribe_v2 (forced)")

    fresh = TestClient(main.app)
    resp = fresh.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["redis"] == "in-memory"
    assert "scribe" in body
    assert "learning_loop" in body
    assert "realtime" in body
