"""Pydantic models — both the public response shapes (frozen by frontend/src/types/api.ts)
and the internal types that flow between pipeline layers.

The internal types (ScribeWord, ScribeResult, WordWithConfidence, VerifyResult, Correction)
are imported by Person A's modules and Person B's modules so the contract is enforced at
type-check time.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Public response shapes — must match frontend/src/types/api.ts EXACTLY
# ---------------------------------------------------------------------------

Speaker = Literal["Doctor", "Patient"]
ConfidenceLevel = Literal["LOW", "MEDIUM", "HIGH"]


class RawWord(BaseModel):
    word: str
    start_ms: int
    end_ms: int
    speaker: Speaker
    confidence: ConfidenceLevel
    uncertainty_signals: list[str] | None = None


class CorrectedWord(BaseModel):
    word: str
    changed: bool
    tavily_verified: bool
    unverified: bool
    speaker: Speaker


class Medication(BaseModel):
    name: str
    dosage: str
    frequency: str
    route: str
    tavily_verified: bool = False


class ClinicalSummary(BaseModel):
    medications: list[Medication] = Field(default_factory=list)
    symptoms: list[str] = Field(default_factory=list)
    allergies: list[str] = Field(default_factory=list)
    follow_up_actions: list[str] = Field(default_factory=list)
    appointment_needed: bool = False


class PipelineLatency(BaseModel):
    preprocessing: int
    scribe: int
    uncertainty: int
    tavily: int
    claude: int
    total: int


class TranscribeResponse(BaseModel):
    raw_transcript: list[RawWord]
    corrected_transcript: list[CorrectedWord]
    clinical_summary: ClinicalSummary
    pipeline_latency_ms: PipelineLatency


class HealthResponse(BaseModel):
    status: str
    redis: str
    scribe: str
    tavily: str
    claude: str
    learning_loop: dict[str, int] | None = None
    realtime: str | None = None


class StreamToken(BaseModel):
    token: str
    expires_in: int


# Benchmark response — passed through from cached JSON, validated loosely
class AblationRow(BaseModel):
    stage: str
    wer: float
    delta: float
    description: str


class BenchmarkClipResult(BaseModel):
    clip_id: str
    category: str
    difficulty: Literal["Standard", "Adversarial"]
    raw_wer: float
    corrected_wer: float
    raw_cer: float | None = None
    corrected_cer: float | None = None
    raw_digit_accuracy: float | None = None
    corrected_digit_accuracy: float | None = None
    raw_medical_keyword_accuracy: float | None = None
    corrected_medical_keyword_accuracy: float | None = None
    improvement_pct: float


class BenchmarkMetrics(BaseModel):
    verification_rate: float
    unsafe_guess_rate: float
    uncertainty_coverage: float
    phonetic_hit_rate: float
    digit_accuracy_coverage: float | None = None
    medical_keyword_accuracy_coverage: float | None = None


class BenchmarkAggregate(BaseModel):
    avg_raw_wer: float
    avg_corrected_wer: float
    avg_raw_cer: float | None = None
    avg_corrected_cer: float | None = None
    avg_raw_digit_accuracy: float | None = None
    avg_corrected_digit_accuracy: float | None = None
    avg_raw_medical_keyword_accuracy: float | None = None
    avg_corrected_medical_keyword_accuracy: float | None = None
    avg_improvement_pct: float
    keyterm_impact_pct: float


class BenchmarkModelSummary(BaseModel):
    id: str
    label: str
    clip_count: int
    avg_wer: float
    avg_cer: float | None = None
    avg_digit_accuracy: float | None = None
    avg_medical_keyword_accuracy: float | None = None


class BenchmarkModelDelta(BaseModel):
    wer_reduction: float
    cer_reduction: float | None = None
    digit_accuracy_gain: float | None = None
    medical_keyword_accuracy_gain: float | None = None


class BenchmarkModelPerClip(BaseModel):
    clip_id: str
    base_wer: float
    fine_tuned_wer: float
    wer_reduction: float


class BenchmarkModelComparison(BaseModel):
    base_model: BenchmarkModelSummary
    fine_tuned_model: BenchmarkModelSummary
    delta: BenchmarkModelDelta
    per_clip: list[BenchmarkModelPerClip] = Field(default_factory=list)


class BenchmarkResponse(BaseModel):
    results: list[BenchmarkClipResult]
    ablation: list[AblationRow]
    metrics: BenchmarkMetrics
    aggregate: BenchmarkAggregate
    comparison: BenchmarkModelComparison | None = None
    model_benchmarks: list[BenchmarkModelSummary] = Field(default_factory=list)


class LearningLoopHistoryPoint(BaseModel):
    round: int
    train_value: float
    validation_value: float | None = None


class LearningLoopSnapshot(BaseModel):
    snapshot_index: int
    timestamp_utc: str
    clip_count: int
    row_count: int
    accuracy: float
    f1: float
    auc: float | None = None
    best_iteration: int


class LearningLoopFeatureImportance(BaseModel):
    feature: str
    importance: float


class LearningLoopSummary(BaseModel):
    history_rounds: int
    snapshot_count: int
    latest_clip_count: int | None = None
    latest_row_count: int | None = None
    latest_accuracy: float | None = None
    latest_f1: float | None = None
    latest_auc: float | None = None


class LearningLoopResponse(BaseModel):
    metric_name: str | None = None
    training_history: list[LearningLoopHistoryPoint]
    retraining_snapshots: list[LearningLoopSnapshot]
    feature_importance: list[LearningLoopFeatureImportance]
    summary: LearningLoopSummary


# ---------------------------------------------------------------------------
# Internal pipeline dataclasses — flow between layers, not serialized to client
# ---------------------------------------------------------------------------


@dataclass
class ScribeWord:
    """One word from ElevenLabs Scribe v2 batch transcription. Person A returns these."""

    text: str
    start_ms: int
    end_ms: int
    speaker_id: str  # "speaker_0" / "speaker_1" — Person C maps to Doctor/Patient
    confidence: float | None = None


@dataclass
class ScribeResult:
    """Output of Person A's `scribe.transcribe_batch()`."""

    words: list[ScribeWord]
    audio_events: list[str] = field(default_factory=list)
    duration_ms: int = 0


@dataclass
class WordWithConfidence:
    """A scored word emitted by Person A's `uncertainty.score_words()`."""

    word: str
    start_ms: int
    end_ms: int
    speaker_id: str
    confidence: ConfidenceLevel
    uncertainty_signals: list[str] = field(default_factory=list)


@dataclass
class VerifyResult:
    """Result of a single Tavily verification call."""

    original: str
    status: Literal["VERIFIED", "UNVERIFIED"]
    canonical: str | None = None
    source_url: str | None = None
    aliases: list[str] = field(default_factory=list)


@dataclass
class Correction:
    """Internal correction record produced by Claude + applied by the pipeline."""

    index: int
    original: str
    corrected: str
    tavily_verified: bool
    unverified: bool
