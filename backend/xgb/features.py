"""Feature building for word-level risk modeling."""

from __future__ import annotations

import csv
import json
import math
import re
from dataclasses import asdict, dataclass
from difflib import SequenceMatcher
from pathlib import Path
from statistics import median
from typing import Any, Iterable, Sequence

from app.keyterms import load_initial_keyterms
from app.medical_patterns import matches_medical, normalize
from app.phonetic import normalized_levenshtein
from app.schemas import ScribeWord

PACKAGE_DIR = Path(__file__).resolve().parent
DATA_DIR = PACKAGE_DIR / "data"
ARTIFACTS_DIR = PACKAGE_DIR / "artifacts"
REPORTS_DIR = PACKAGE_DIR / "reports"

DEFAULT_DATASET_PATH = DATA_DIR / "word_risk_dataset.csv"
DEFAULT_LEARNING_STATE_PATH = DATA_DIR / "learning_state.json"
DEFAULT_RETRAINING_SNAPSHOTS_PATH = DATA_DIR / "retraining_snapshots.csv"
DEFAULT_SCRIBE_OUTPUTS_DIR = DATA_DIR / "scribe_outputs"
DEFAULT_MERGED_MANIFEST_PATH = DATA_DIR / "merged_manifest.csv"
DEFAULT_MERGED_CORRECTED_PATH = DATA_DIR / "merged_corrected.csv"
DEFAULT_XGB_MODEL_PATH = ARTIFACTS_DIR / "word_risk_xgb.joblib"
DEFAULT_FEATURE_SCHEMA_PATH = ARTIFACTS_DIR / "feature_schema.json"
DEFAULT_TRAINING_HISTORY_PATH = ARTIFACTS_DIR / "training_history.json"

NUMERIC_TOKEN_RE = re.compile(r"^\d+(?:\.\d+)?(?:mg|mcg|ml|g|iu|units?)?$", re.I)

CATEGORICAL_FEATURES = [
    "word_text",
    "previous_word",
    "next_word",
    "speaker",
    "noise_profile",
    "accent_profile",
    "scenario",
]

NUMERIC_FEATURES = [
    "is_numeric",
    "is_medical_candidate",
    "matches_keyterm",
    "phonetic_distance_to_nearest_keyterm",
    "timing_irregularity_score",
    "pause_before_ms",
    "pause_after_ms",
    "word_duration_ms",
    "has_interruptions",
    "is_low_confidence_from_stt",
    "correction_frequency",
]

ROW_METADATA_COLUMNS = [
    "clip_id",
    "word_index",
    "start_ms",
    "end_ms",
    "split",
]

DATASET_COLUMNS = (
    ROW_METADATA_COLUMNS
    + CATEGORICAL_FEATURES
    + NUMERIC_FEATURES
    + ["needs_verification"]
)


@dataclass(slots=True)
class AlignmentOp:
    """One sequence-alignment operation."""

    tag: str
    src_start: int
    src_end: int
    dst_start: int
    dst_end: int


@dataclass(slots=True)
class WordFeatureRow:
    """A single word-level feature row."""

    clip_id: str
    word_index: int
    start_ms: int
    end_ms: int
    split: str
    word_text: str
    previous_word: str
    next_word: str
    speaker: str
    is_numeric: int
    is_medical_candidate: int
    matches_keyterm: int
    phonetic_distance_to_nearest_keyterm: float
    timing_irregularity_score: float
    pause_before_ms: int
    pause_after_ms: int
    word_duration_ms: int
    noise_profile: str
    accent_profile: str
    scenario: str
    has_interruptions: int
    is_low_confidence_from_stt: int
    correction_frequency: int
    needs_verification: int | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def ensure_directories() -> None:
    """Create package-owned data directories."""
    for path in (DATA_DIR, ARTIFACTS_DIR, REPORTS_DIR):
        path.mkdir(parents=True, exist_ok=True)


def coerce_transcript_text(value: Any) -> str:
    """Convert transcript payloads into a single text string."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts: list[str] = []
        for item in value:
            if isinstance(item, dict):
                text = item.get("word") or item.get("text")
                if text:
                    parts.append(str(text))
            elif item is not None:
                parts.append(str(item))
        return " ".join(parts)
    if isinstance(value, dict):
        text = value.get("text")
        return str(text) if text is not None else ""
    return str(value)


def transcript_tokens(text: str) -> list[str]:
    """Tokenize transcript text deterministically for alignment."""
    return [token for token in text.split() if token.strip()]


def is_numeric_token(token: str) -> bool:
    """Return whether the token is numeric or dosage-like."""
    word = normalize(token)
    if not word:
        return False
    return bool(NUMERIC_TOKEN_RE.match(word))


def load_manifest_rows(path: Path) -> dict[str, dict[str, str]]:
    """Load manifest CSV rows keyed by clip_id."""
    with path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        rows: dict[str, dict[str, str]] = {}
        for row in reader:
            clip_id = str((row or {}).get("clip_id") or "").strip()
            if clip_id:
                rows[clip_id] = {str(k): str(v or "").strip() for k, v in row.items()}
        return rows


def load_corrected_rows(path: Path) -> dict[str, dict[str, Any]]:
    """Load corrected transcript rows keyed by clip_id."""
    suffix = path.suffix.lower()
    if suffix == ".csv":
        with path.open("r", encoding="utf-8", newline="") as handle:
            reader = csv.DictReader(handle)
            return {
                str((row or {}).get("clip_id") or "").strip(): dict(row)
                for row in reader
                if str((row or {}).get("clip_id") or "").strip()
            }

    rows: dict[str, dict[str, Any]] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        payload = json.loads(line)
        if not isinstance(payload, dict):
            continue
        clip_id = str(payload.get("clip_id") or "").strip()
        if clip_id:
            rows[clip_id] = payload
    return rows


def _payload_from_scribe_path(path: Path) -> list[dict[str, Any]]:
    if path.is_dir():
        payloads: list[dict[str, Any]] = []
        for child in sorted(path.rglob("*.json")):
            payload = json.loads(child.read_text(encoding="utf-8"))
            if isinstance(payload, dict):
                if not payload.get("clip_id"):
                    payload["clip_id"] = child.stem
                payloads.append(payload)
        return payloads

    if path.suffix.lower() == ".json":
        payload = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(payload, dict):
            return [payload]
        if isinstance(payload, list):
            return [item for item in payload if isinstance(item, dict)]
        return []

    payloads = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            data = json.loads(line)
            if isinstance(data, dict):
                payloads.append(data)
    return payloads


def load_scribe_payloads(path: Path) -> dict[str, dict[str, Any]]:
    """Load Scribe JSON payloads keyed by clip_id."""
    rows: dict[str, dict[str, Any]] = {}
    for payload in _payload_from_scribe_path(path):
        clip_id = str(payload.get("clip_id") or "").strip()
        if not clip_id:
            continue
        rows[clip_id] = payload
    return rows


def scribe_words_from_payload(payload: dict[str, Any]) -> list[ScribeWord]:
    """Parse Scribe payloads into internal words."""
    words_blob = payload.get("words")
    if not isinstance(words_blob, list):
        transcripts = payload.get("transcripts")
        if isinstance(transcripts, list) and transcripts:
            first = transcripts[0]
            if isinstance(first, dict):
                words_blob = first.get("words")
    if not isinstance(words_blob, list):
        return []

    out: list[ScribeWord] = []
    for item in words_blob:
        if not isinstance(item, dict):
            continue
        text = str(item.get("text") or "").strip()
        if not text:
            continue
        token_type = str(item.get("type") or "word").lower()
        if token_type not in {"word", ""}:
            continue
        try:
            start_ms = int(round(float(item.get("start", item.get("start_ms", 0))) * 1000))
            end_ms = int(round(float(item.get("end", item.get("end_ms", 0))) * 1000))
        except (TypeError, ValueError):
            start_ms = 0
            end_ms = 0
        if "start_ms" in item:
            start_ms = int(item.get("start_ms") or 0)
        if "end_ms" in item:
            end_ms = int(item.get("end_ms") or 0)
        if end_ms < start_ms:
            end_ms = start_ms

        confidence_value = item.get("confidence")
        try:
            confidence = float(confidence_value) if confidence_value is not None else None
        except (TypeError, ValueError):
            confidence = None

        out.append(
            ScribeWord(
                text=text,
                start_ms=start_ms,
                end_ms=end_ms,
                speaker_id=str(item.get("speaker_id") or "speaker_0"),
                confidence=confidence,
            )
        )
    return out


def corrected_text_from_row(row: dict[str, Any]) -> str:
    """Extract corrected transcript text from one record."""
    return coerce_transcript_text(
        row.get("corrected_text")
        or row.get("corrected_transcript")
        or row.get("ground_truth")
        or row.get("reference_text")
        or row.get("text")
    )


def align_tokens(source_tokens: Sequence[str], target_tokens: Sequence[str]) -> list[AlignmentOp]:
    """Align normalized source and target tokens."""
    source_norm = [normalize(token) for token in source_tokens]
    target_norm = [normalize(token) for token in target_tokens]
    matcher = SequenceMatcher(a=source_norm, b=target_norm, autojunk=False)
    return [
        AlignmentOp(
            tag=tag,
            src_start=i1,
            src_end=i2,
            dst_start=j1,
            dst_end=j2,
        )
        for tag, i1, i2, j1, j2 in matcher.get_opcodes()
    ]


def _mark_indices(indices: set[int], start: int, end: int, total: int) -> None:
    for idx in range(max(0, start), min(total, end)):
        indices.add(idx)


def risky_word_indices(
    source_tokens: Sequence[str],
    target_tokens: Sequence[str],
) -> tuple[set[int], list[AlignmentOp]]:
    """Identify source-token indices that need verification."""
    ops = align_tokens(source_tokens, target_tokens)
    risky: set[int] = set()
    total = len(source_tokens)

    for op in ops:
        if op.tag == "equal":
            continue
        if op.tag in {"replace", "delete"}:
            _mark_indices(risky, op.src_start, op.src_end, total)
            continue
        if op.tag == "insert":
            if total == 0:
                continue
            left = max(0, op.src_start - 1)
            right = min(total - 1, op.src_start)
            risky.add(left)
            risky.add(right)

    return risky, ops


def timing_irregularity_scores(words: Sequence[ScribeWord]) -> list[float]:
    """Compute a rolling z-like duration irregularity score."""
    if not words:
        return []

    durations = [max(0, word.end_ms - word.start_ms) for word in words]
    scores: list[float] = []
    for idx, duration in enumerate(durations):
        left = max(0, idx - 2)
        right = min(len(durations), idx + 3)
        window = durations[left:right]
        med = float(median(window)) if window else 0.0
        mean = sum(window) / len(window) if window else 0.0
        variance = (
            sum((sample - mean) ** 2 for sample in window) / len(window)
            if window
            else 0.0
        )
        std = math.sqrt(variance)
        if std <= 1e-6:
            scores.append(0.0)
        else:
            scores.append(abs((duration - med) / std))
    return scores


def nearest_keyterm_distance(word: str, keyterms: Iterable[str]) -> float:
    """Return normalized distance to the nearest keyterm."""
    token = normalize(word)
    normalized_keyterms = [normalize(keyterm) for keyterm in keyterms if normalize(keyterm)]
    if not token or not normalized_keyterms:
        return 1.0
    return min(normalized_levenshtein(token, keyterm) for keyterm in normalized_keyterms)


def resolved_speakers(words: Sequence[ScribeWord]) -> list[str]:
    """Resolve doctor/patient labels using the same heuristic as app.pipeline."""
    doctor_id: str | None = None
    for word in words:
        if matches_medical(word.text):
            doctor_id = word.speaker_id
            break
    if doctor_id is None and words:
        doctor_id = words[0].speaker_id
    return [
        "Doctor" if word.speaker_id == doctor_id else "Patient"
        for word in words
    ]


def default_keyterms() -> list[str]:
    """Return the seeded keyterm list."""
    return load_initial_keyterms()


def build_word_rows_for_clip(
    *,
    clip_id: str,
    words: Sequence[ScribeWord],
    clip_metadata: dict[str, Any] | None = None,
    corrected_text: str | None = None,
    keyterms: Iterable[str] | None = None,
    correction_frequency: dict[str, int] | None = None,
    stt_low_confidence_threshold: float = 0.8,
) -> list[WordFeatureRow]:
    """Build feature rows for one clip."""
    metadata = clip_metadata or {}
    correction_frequency = correction_frequency or {}
    keyterm_list = list(keyterms or default_keyterms())
    normalized_keyterms = {normalize(keyterm) for keyterm in keyterm_list if normalize(keyterm)}
    speakers = resolved_speakers(words)
    durations = timing_irregularity_scores(words)

    risky_indices: set[int] = set()
    if corrected_text is not None:
        source_tokens = [word.text for word in words]
        corrected_tokens = transcript_tokens(corrected_text)
        risky_indices, _ = risky_word_indices(source_tokens, corrected_tokens)

    split_value = str(metadata.get("split") or "")
    noise_profile = str(metadata.get("noise_profile") or "unknown")
    accent_profile = str(metadata.get("accent_profile") or "unknown")
    scenario = str(metadata.get("scenario") or "unknown")
    has_interruptions = int(str(metadata.get("has_interruptions") or "").lower() == "true")
    if not has_interruptions and isinstance(metadata.get("has_interruptions"), bool):
        has_interruptions = int(bool(metadata.get("has_interruptions")))

    rows: list[WordFeatureRow] = []
    for idx, word in enumerate(words):
        prev_word = words[idx - 1].text if idx > 0 else ""
        next_word = words[idx + 1].text if idx + 1 < len(words) else ""
        pause_before_ms = 0
        if idx > 0:
            pause_before_ms = max(0, word.start_ms - words[idx - 1].end_ms)
        pause_after_ms = 0
        if idx + 1 < len(words):
            pause_after_ms = max(0, words[idx + 1].start_ms - word.end_ms)

        normalized_word = normalize(word.text)
        stt_confidence = getattr(word, "confidence", None)
        is_low_confidence = int(
            stt_confidence is not None and float(stt_confidence) < stt_low_confidence_threshold
        )

        rows.append(
            WordFeatureRow(
                clip_id=clip_id,
                word_index=idx,
                start_ms=word.start_ms,
                end_ms=word.end_ms,
                split=split_value,
                word_text=normalized_word or word.text.lower(),
                previous_word=normalize(prev_word),
                next_word=normalize(next_word),
                speaker=speakers[idx] if idx < len(speakers) else "Doctor",
                is_numeric=int(is_numeric_token(word.text)),
                is_medical_candidate=int(matches_medical(word.text)),
                matches_keyterm=int(normalized_word in normalized_keyterms),
                phonetic_distance_to_nearest_keyterm=nearest_keyterm_distance(word.text, keyterm_list),
                timing_irregularity_score=float(durations[idx]),
                pause_before_ms=pause_before_ms,
                pause_after_ms=pause_after_ms,
                word_duration_ms=max(0, word.end_ms - word.start_ms),
                noise_profile=noise_profile,
                accent_profile=accent_profile,
                scenario=scenario,
                has_interruptions=has_interruptions,
                is_low_confidence_from_stt=is_low_confidence,
                correction_frequency=int(correction_frequency.get(normalized_word, 0)),
                needs_verification=int(idx in risky_indices) if corrected_text is not None else None,
            )
        )
    return rows


def build_training_rows(
    *,
    manifest_rows: dict[str, dict[str, Any]],
    corrected_rows: dict[str, dict[str, Any]],
    scribe_payloads: dict[str, dict[str, Any]],
    keyterms: Iterable[str] | None = None,
    correction_frequency: dict[str, int] | None = None,
) -> list[WordFeatureRow]:
    """Build rows across all clips with complete inputs."""
    out: list[WordFeatureRow] = []
    for clip_id, corrected_row in corrected_rows.items():
        manifest_row = manifest_rows.get(clip_id)
        scribe_payload = scribe_payloads.get(clip_id)
        if manifest_row is None or scribe_payload is None:
            continue
        corrected_text = corrected_text_from_row(corrected_row)
        words = scribe_words_from_payload(scribe_payload)
        out.extend(
            build_word_rows_for_clip(
                clip_id=clip_id,
                words=words,
                clip_metadata=manifest_row,
                corrected_text=corrected_text,
                keyterms=keyterms,
                correction_frequency=correction_frequency,
            )
        )
    return out


def write_dataset_rows(rows: Sequence[WordFeatureRow], path: Path = DEFAULT_DATASET_PATH) -> None:
    """Write the full dataset CSV."""
    ensure_directories()
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(DATASET_COLUMNS))
        writer.writeheader()
        for row in rows:
            writer.writerow(row.to_dict())


def append_dataset_rows(rows: Sequence[WordFeatureRow], path: Path = DEFAULT_DATASET_PATH) -> None:
    """Append rows to the dataset CSV."""
    ensure_directories()
    file_exists = path.exists()
    with path.open("a", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(DATASET_COLUMNS))
        if not file_exists:
            writer.writeheader()
        for row in rows:
            writer.writerow(row.to_dict())


def dataset_columns() -> list[str]:
    """Return the canonical dataset columns."""
    return list(DATASET_COLUMNS)
