"""Layer 3 — Multi-signal uncertainty detection.

OWNED BY PERSON A. See HANDOFF_PERSON_A.md for the full spec.
"""
from __future__ import annotations

import logging
from statistics import median

from .config import settings
from .medical_patterns import matches_medical, normalize
from .phonetic import normalized_levenshtein
from .schemas import ScribeWord, WordWithConfidence

log = logging.getLogger(__name__)


def _levenshtein(a: str, b: str) -> int:
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, start=1):
        curr = [i] + [0] * len(b)
        for j, cb in enumerate(b, start=1):
            cost = 0 if ca == cb else 1
            curr[j] = min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
        prev = curr
    return prev[-1]


def _bucket(score: float) -> str:
    if score < 0.25:
        return "HIGH"
    if score < 0.5:
        return "MEDIUM"
    return "LOW"


class _XGBoostRiskScorer:
    """Optional runtime scorer backed by `xgb.infer`."""

    def score_words(
        self,
        words: list[ScribeWord],
        keyterms: list[str],
        correction_history: dict[str, int],
    ) -> list[float | None]:
        if not words:
            return []
        try:
            from xgb.infer import score_transcript_words
        except Exception:
            return [None for _ in words]

        try:
            result = score_transcript_words(
                clip_id="runtime",
                words=words,
                clip_metadata={},
                keyterms=keyterms,
                correction_frequency=correction_history,
                model_path=settings.XGBOOST_MODEL_PATH,
                low_threshold=settings.XGBOOST_LOW_THRESHOLD,
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("XGBoost inference failed; falling back to rule-based: %s", exc)
            return [None for _ in words]

        if result is None:
            return [None for _ in words]

        risks: list[float | None] = [None for _ in words]
        for item in result.word_scores:
            if 0 <= item.word_index < len(risks):
                risks[item.word_index] = item.risk
        return risks


_xgb_scorer = _XGBoostRiskScorer()


def score_words(
    words: list[ScribeWord],
    keyterms: list[str],
    phonetic_map: dict[str, str],
    correction_history: dict[str, int],
    *,
    stt_provider_name: str | None = None,
) -> list[WordWithConfidence]:
    """Compute composite confidence per word from four signals.

    Signals (combine into a single score 0..1):
        1. Timing irregularity — duration vs rolling 5-word median; z-score > 1.5 → +0.3
        2. Keyterm mismatch     — word matches medical_patterns.matches_medical()
                                  but is NOT in the keyterm set → +0.25
        3. Phonetic distance    — min Levenshtein to keyterms; dist 1 or 2 → +0.3
        4. Correction likelihood — word appears in correction_history → +0.15

    Buckets: <0.25 HIGH, 0.25–0.5 MEDIUM, ≥0.5 LOW

    For LOW/MEDIUM words, populate uncertainty_signals with the names of the
    contributing signals so the frontend tooltip can render them, e.g.
        ["timing_irregularity", "phonetic_distance: 1", "keyterm_mismatch"]

    Return a list parallel to `words` (same length, same order, same speaker_id).
    """
    if not words:
        return []

    keyterms_norm = {normalize(k) for k in keyterms if k}
    durations = [max(0, w.end_ms - w.start_ms) for w in words]

    xgb_risks = _xgb_scorer.score_words(words, keyterms, correction_history)

    out: list[WordWithConfidence] = []
    for i, w in enumerate(words):
        word_norm = normalize(w.text)
        score = 0.0
        signals: list[str] = []

        # 1) Timing irregularity (rolling 5-word median with z-style check)
        left = max(0, i - 2)
        right = min(len(words), i + 3)
        window = durations[left:right]
        med = float(median(window)) if window else 0.0
        if window:
            mean = sum(window) / len(window)
            variance = sum((d - mean) ** 2 for d in window) / max(1, len(window))
            std = variance ** 0.5
            z_like = abs((durations[i] - med) / std) if std > 1e-6 else 0.0
            if z_like > 1.5:
                score += 0.30
                signals.append("timing_irregularity")

        # 2) Keyterm mismatch
        if word_norm and matches_medical(word_norm) and word_norm not in keyterms_norm:
            score += 0.25
            signals.append("keyterm_mismatch")

        # 3) Phonetic distance to nearest keyterm
        nearest_dist: int | None = None
        if word_norm and keyterms_norm:
            # Small optimization: use normalized distance to shortlist.
            shortlist: list[tuple[str, float]] = []
            for kt in keyterms_norm:
                shortlist.append((kt, normalized_levenshtein(word_norm, kt)))
            shortlist.sort(key=lambda x: x[1])
            for kt, _ in shortlist[:12]:
                dist = _levenshtein(word_norm, kt)
                if nearest_dist is None or dist < nearest_dist:
                    nearest_dist = dist
                if dist == 0:
                    break

        if nearest_dist in (1, 2):
            score += 0.30
            signals.append(f"phonetic_distance: {nearest_dist}")

        # 4) Correction likelihood from prior calls
        history_hits = correction_history.get(word_norm, 0)
        if history_hits > 0 or word_norm in phonetic_map:
            score += 0.15
            signals.append("correction_likelihood")

        # 5) Fine-tuned Whisper review boost
        # Whisper outputs can be semantically plausible while still requiring
        # verification on medication terms, so force at least MEDIUM review on
        # medical-shaped tokens for this provider.
        if (
            stt_provider_name == "full_ft"
            and word_norm
            and matches_medical(word_norm)
            and score < 0.25
        ):
            score = 0.25
            signals.append("whisper_medical_review")

        xgb_risk = xgb_risks[i] if i < len(xgb_risks) else None
        if xgb_risk is not None:
            # Use the more conservative signal (max risk) to reduce silent failures.
            if xgb_risk >= settings.XGBOOST_LOW_THRESHOLD:
                score = max(score, settings.XGBOOST_LOW_THRESHOLD)
            elif xgb_risk >= settings.XGBOOST_MEDIUM_THRESHOLD:
                score = max(score, settings.XGBOOST_MEDIUM_THRESHOLD)
            if xgb_risk >= settings.XGBOOST_MEDIUM_THRESHOLD:
                signals.append(f"xgboost_risk: {xgb_risk:.2f}")

        score = max(0.0, min(1.0, score))
        confidence = _bucket(score)

        out.append(
            WordWithConfidence(
                word=w.text,
                start_ms=w.start_ms,
                end_ms=w.end_ms,
                speaker_id=w.speaker_id,
                confidence=confidence,  # type: ignore[arg-type]
                uncertainty_signals=signals if confidence in ("LOW", "MEDIUM") else [],
            )
        )

    return out
