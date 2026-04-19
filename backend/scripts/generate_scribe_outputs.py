"""Run benchmark clips through STT providers and save scribe JSON outputs.

Outputs per-provider subdirs and a merged manifest for XGBoost dataset generation.
clip_ids are prefixed with provider name (e.g. scribev2__clip_01) to keep rows distinct.
"""

from __future__ import annotations

import asyncio
import csv
import json
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from xgb.features import (  # type: ignore  # noqa: E402
    DEFAULT_MERGED_CORRECTED_PATH,
    DEFAULT_MERGED_MANIFEST_PATH,
    DEFAULT_SCRIBE_OUTPUTS_DIR,
)

MANIFEST_PATH = BACKEND_DIR / "test_audio/benchmark/v1/manifest.csv"
AUDIO_BASE = BACKEND_DIR / "test_audio/benchmark/v1"
OUTPUT_BASE = DEFAULT_SCRIBE_OUTPUTS_DIR
MERGED_MANIFEST_PATH = DEFAULT_MERGED_MANIFEST_PATH
MERGED_CORRECTED_PATH = DEFAULT_MERGED_CORRECTED_PATH

# whisper-small LoRA path (non-production)
LORA_MODEL_PATH = BACKEND_DIR / "tuned_models/whisper_small_LoRA_normal"
EMERGENCY_LORA_MODEL_PATH = BACKEND_DIR / "tuned_models/whisper_tiny_LoRA_emergency"


async def transcribe_all(provider_name: str, rows: list[dict], out_dir: Path) -> list[dict]:
    """Transcribe all clips with one provider. Returns merged manifest rows."""
    from stt.runtime import (  # type: ignore
        FineTunedTelephonyBatchProvider,
        ScribeV2BatchProvider,
        validate_local_model_path,
    )

    out_dir.mkdir(parents=True, exist_ok=True)

    if provider_name == "scribe_v2":
        provider = ScribeV2BatchProvider()
    elif provider_name == "lora":
        validation = validate_local_model_path(LORA_MODEL_PATH)
        if not validation.ready:
            raise RuntimeError(f"LoRA model invalid at {LORA_MODEL_PATH}: {validation.reason}")
        provider = FineTunedTelephonyBatchProvider(model_path=LORA_MODEL_PATH)
    elif provider_name == "emergency_lora":
        validation = validate_local_model_path(EMERGENCY_LORA_MODEL_PATH)
        if not validation.ready:
            raise RuntimeError(
                f"Emergency LoRA model invalid at {EMERGENCY_LORA_MODEL_PATH}: {validation.reason}"
            )
        provider = FineTunedTelephonyBatchProvider(
            model_path=EMERGENCY_LORA_MODEL_PATH,
            provider_name="emergency_lora",
        )
    elif provider_name == "full_ft":
        provider = FineTunedTelephonyBatchProvider()
    else:
        raise ValueError(f"Unsupported provider_name={provider_name!r}")

    manifest_rows = []
    for row in rows:
        clip_id = f"{provider_name}__{row['clip_id']}"
        wav_path = AUDIO_BASE / row["audio_relpath"]
        if not wav_path.exists():
            print(f"  SKIP {clip_id}: {wav_path} not found")
            continue

        print(f"  {clip_id}...")
        result = await provider.transcribe_batch(str(wav_path), keyterms=[])

        payload = {
            "clip_id": clip_id,
            "words": [
                {
                    "text": w.text,
                    "start_ms": w.start_ms,
                    "end_ms": w.end_ms,
                    "speaker_id": w.speaker_id,
                    "confidence": w.confidence,
                }
                for w in result.words
            ],
        }
        (out_dir / f"{clip_id}.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")

        manifest_rows.append({**row, "clip_id": clip_id})

    return manifest_rows


async def main() -> None:
    with MANIFEST_PATH.open(encoding="utf-8") as f:
        source_rows = list(csv.DictReader(f))

    all_manifest_rows: list[dict] = []

    providers_to_run = [
        ("scribe_v2", "Scribe V2"),
        ("lora", "whisper-small LoRA"),
        ("emergency_lora", "whisper-tiny LoRA emergency"),
        ("full_ft", "whisper-small full_ft"),
    ]

    for provider_key, label in providers_to_run:
        print(f"\n=== {label} ===")
        out_dir = OUTPUT_BASE / provider_key
        rows = await transcribe_all(provider_key, source_rows, out_dir)
        all_manifest_rows.extend(rows)

    # Write merged manifest (for --manifest arg)
    OUTPUT_BASE.mkdir(parents=True, exist_ok=True)
    fieldnames = list(source_rows[0].keys()) if source_rows else []
    with MERGED_MANIFEST_PATH.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(all_manifest_rows)

    # Write merged corrected (for --corrected arg, same ground_truth)
    with MERGED_CORRECTED_PATH.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["clip_id", "corrected_text"])
        writer.writeheader()
        for row in all_manifest_rows:
            writer.writerow({"clip_id": row["clip_id"], "corrected_text": row["ground_truth"]})

    print(f"\nDone. Merged manifest -> {MERGED_MANIFEST_PATH}")
    print("\nNext: build XGBoost dataset with:")
    print(f"  cd {BACKEND_DIR}")
    print(f"  python -m xgb.train --rebuild \\")
    print(f"    --manifest {MERGED_MANIFEST_PATH} \\")
    print(f"    --corrected {MERGED_CORRECTED_PATH} \\")
    print(f"    --scribe {OUTPUT_BASE}")


if __name__ == "__main__":
    asyncio.run(main())
