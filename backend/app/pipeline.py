"""End-to-end pipeline orchestration.

Sequences the 7 layers, measures per-layer latency, runs the hallucination guard,
and emits a TranscribeResponse that matches the frontend type contract exactly.

Person A's modules (preprocessing, scribe, uncertainty) are imported lazily so the
backend boots even before they're implemented. If a stub is hit at runtime, the
NotImplementedError propagates to the route handler, which returns a 501 with the
missing-function name.
"""
from __future__ import annotations

import logging
from time import perf_counter

from . import claude_correct, claude_extract, learning_loop, preprocessing, scribe, uncertainty
from .medical_patterns import matches_medical
from .schemas import (
    CorrectedWord,
    PipelineLatency,
    RawWord,
    ScribeWord,
    TranscribeResponse,
    WordWithConfidence,
)
from stt.runtime import get_batch_provider
from .tavily_verify import get_verifier

log = logging.getLogger(__name__)


def _ms_since(start: float) -> int:
    return int((perf_counter() - start) * 1000)


def resolve_speakers(words: list[ScribeWord]) -> list[str]:
    """Map raw speaker_0/speaker_1 ids to "Doctor"/"Patient".

    Heuristic: the speaker who first utters a drug-suffix or dosage word is the
    Doctor. Falls back to "speaker_0 = Doctor" if no medical word appears.
    """
    doctor_id: str | None = None
    for w in words:
        if matches_medical(w.text):
            doctor_id = w.speaker_id
            break
    if doctor_id is None and words:
        doctor_id = words[0].speaker_id

    return [
        "Doctor" if w.speaker_id == doctor_id else "Patient" for w in words
    ]


def _to_raw_words(
    scored: list[WordWithConfidence], speakers: list[str]
) -> list[RawWord]:
    out: list[RawWord] = []
    for i, w in enumerate(scored):
        out.append(
            RawWord(
                word=w.word,
                start_ms=w.start_ms,
                end_ms=w.end_ms,
                speaker=speakers[i],  # type: ignore[arg-type]
                confidence=w.confidence,
                uncertainty_signals=w.uncertainty_signals or None,
            )
        )
    return out


async def _run_post_scribe(
    scribe_words: list[ScribeWord],
    base_latencies: dict[str, int],
    *,
    stt_provider_name: str | None = None,
) -> TranscribeResponse:
    latencies = dict(base_latencies)
    speakers = resolve_speakers(scribe_words)
    keyterms = learning_loop.get_keyterms(top_n=100)

    # ---------------- Layer 3: uncertainty scoring (Person A) ------------------
    t = perf_counter()
    scored = uncertainty.score_words(
        words=scribe_words,
        keyterms=keyterms,
        phonetic_map=learning_loop.get_phonetic_map(),
        correction_history=learning_loop.get_correction_history(),
        stt_provider_name=stt_provider_name,
    )
    latencies["uncertainty"] = _ms_since(t)

    # ---------------- Layer 4: Tavily verification (Person B) ------------------
    t = perf_counter()
    # Whisper fine-tuned runs can emit fewer uncertainty flags even when medical
    # terms are present; force verification on medical-shaped tokens for parity.
    force_verify_medical_terms = stt_provider_name in {"full_ft", "lora", "emergency_lora"}
    flagged = [
        w
        for w in scored
        if matches_medical(w.word)
        and (
            force_verify_medical_terms
            or w.confidence in ("LOW", "MEDIUM")
        )
    ]
    verifier = get_verifier()
    verifications = await verifier.verify_batch(flagged)
    latencies["tavily"] = _ms_since(t)

    # ---------------- Layer 5 + 6: Claude correction & extraction (Person B) ---
    t = perf_counter()
    corrector = claude_correct.get_corrector()
    corrected: list[CorrectedWord] = await corrector.correct(
        raw_words=scored,
        verifications=verifications,
        speakers=speakers,
    )
    extractor = claude_extract.get_extractor()
    summary = await extractor.extract(corrected, verifications)
    latencies["claude"] = _ms_since(t)

    # ---------------- Layer 7: learning loop (Person B) ------------------------
    learning_loop.record_call(scored, corrected, verifications)

    latencies["total"] = sum(latencies.values())

    return TranscribeResponse(
        raw_transcript=_to_raw_words(scored, speakers),
        corrected_transcript=corrected,
        clinical_summary=summary,
        pipeline_latency_ms=PipelineLatency(**latencies),
    )


async def run_full_pipeline(
    audio_path: str,
    *,
    stt_provider_override: str | None = None,
) -> TranscribeResponse:
    latencies: dict[str, int] = {}

    # Resolve provider early so preprocessing can use the correct filter chain.
    batch_provider = get_batch_provider(stt_provider_override)
    stt_provider_name = getattr(batch_provider, "name", None)

    # ---------------- Layer 1: ffmpeg preprocessing (Person A) ----------------
    t = perf_counter()
    cleaned_path = await preprocessing.preprocess(audio_path, stt_provider=stt_provider_name)
    latencies["preprocessing"] = _ms_since(t)

    # ---------------- Layer 2: batch STT provider -------------------------------
    t = perf_counter()
    keyterms = learning_loop.get_keyterms(top_n=100)
    scribe_result = await batch_provider.transcribe_batch(cleaned_path, keyterms)
    latencies["scribe"] = _ms_since(t)

    return await _run_post_scribe(
        scribe_result.words,
        latencies,
        stt_provider_name=stt_provider_name,
    )


async def run_pipeline_from_scribe_words(
    words: list[ScribeWord],
    *,
    scribe_latency_ms: int = 0,
) -> TranscribeResponse:
    """Run layers 3-7 from already-transcribed Scribe words (realtime path)."""
    base_latencies = {
        "preprocessing": 0,
        "scribe": max(0, int(scribe_latency_ms)),
    }
    return await _run_post_scribe(words, base_latencies)
