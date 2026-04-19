from __future__ import annotations

import pytest

from app import uncertainty
from app.schemas import ScribeWord


def _w(text: str, start_ms: int, end_ms: int) -> ScribeWord:
    return ScribeWord(text=text, start_ms=start_ms, end_ms=end_ms, speaker_id="speaker_0")


def test_uncertainty_rule_based_without_xgboost(monkeypatch):
    monkeypatch.setattr(
        uncertainty._xgb_scorer,
        "score_words",
        lambda words, keyterms, correction_history: [None for _ in words],
    )

    words = [
        _w("metoformin", 0, 120),
        _w("500mg", 120, 260),
        _w("daily", 260, 360),
    ]
    scored = uncertainty.score_words(
        words=words,
        keyterms=["metformin"],
        phonetic_map={},
        correction_history={},
    )

    assert len(scored) == 3
    assert scored[0].confidence in ("LOW", "MEDIUM")
    assert any("phonetic_distance" in s for s in scored[0].uncertainty_signals)


def test_uncertainty_uses_xgboost_risk_when_available(monkeypatch):
    monkeypatch.setattr(
        uncertainty._xgb_scorer,
        "score_words",
        lambda words, keyterms, correction_history: [0.81 for _ in words],
    )

    words = [_w("hello", 0, 80)]
    scored = uncertainty.score_words(
        words=words,
        keyterms=[],
        phonetic_map={},
        correction_history={},
        stt_provider_name="scribe_v2",
    )

    assert scored[0].confidence == "LOW"
    assert any(sig.startswith("xgboost_risk:") for sig in scored[0].uncertainty_signals)


def test_uncertainty_skips_xgboost_for_emergency_provider(monkeypatch):
    called = {"xgb": False}

    def _score(words, keyterms, correction_history):
        called["xgb"] = True
        return [0.81 for _ in words]

    monkeypatch.setattr(uncertainty._xgb_scorer, "score_words", _score)

    words = [_w("metformin", 0, 90)]
    scored = uncertainty.score_words(
        words=words,
        keyterms=["metformin"],
        phonetic_map={},
        correction_history={},
        stt_provider_name="emergency_lora",
    )

    assert called["xgb"] is False
    assert all(not sig.startswith("xgboost_risk:") for sig in scored[0].uncertainty_signals)


@pytest.mark.parametrize("provider_name", ["full_ft", "lora", "emergency_lora"])
def test_whisper_medical_words_get_review_highlight(monkeypatch, provider_name: str):
    monkeypatch.setattr(
        uncertainty._xgb_scorer,
        "score_words",
        lambda words, keyterms, correction_history: [None for _ in words],
    )

    words = [_w("cephalexin", 0, 100)]
    scored = uncertainty.score_words(
        words=words,
        keyterms=["cephalexin"],
        phonetic_map={},
        correction_history={},
        stt_provider_name=provider_name,
    )

    assert scored[0].confidence in ("LOW", "MEDIUM")
    assert "whisper_medical_review" in scored[0].uncertainty_signals
