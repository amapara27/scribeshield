"""Combine non-noisy telephony clips with rich-noisy clips into one renamed dataset.

Output layout:
- <out_dir>/audio/clip_<number>.wav
- <out_dir>/final_manifest.csv
"""

from __future__ import annotations

import argparse
import csv
import json
import shutil
from pathlib import Path
from typing import Any


NON_NOISY_SCENARIOS = {"clean_speech", "accented_speech"}


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Merge telephony non-noisy files + telephony_rich_noisy files into one "
            "final dataset and rename sequentially to clip_<number>.wav"
        )
    )
    parser.add_argument(
        "--run-dir",
        required=True,
        help="Run directory containing telephony/, telephony_rich_noisy/, and clips_rich_noise.jsonl",
    )
    parser.add_argument(
        "--out-dir",
        default=None,
        help="Output directory for merged dataset (default: <run-dir>/final_dataset)",
    )
    parser.add_argument(
        "--manifest",
        default="clips_rich_noise.jsonl",
        help="Manifest filename inside run-dir used to detect non-noisy rows",
    )
    parser.add_argument(
        "--start-index",
        type=int,
        default=1,
        help="Starting number for clip_<number>.wav",
    )
    return parser.parse_args()


def _load_manifest(path: Path) -> dict[str, dict[str, Any]]:
    if not path.exists():
        raise SystemExit(f"Manifest not found: {path}")
    rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    out: dict[str, dict[str, Any]] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        clip_id = str(row.get("clip_id") or "").strip()
        if clip_id:
            out[clip_id] = row
    return out


def _is_non_noisy_row(row: dict[str, Any] | None) -> bool:
    if not row:
        return False
    noise_profile = str(row.get("noise_profile") or "").strip().lower()
    scenario = str(row.get("scenario") or "").strip().lower()
    return noise_profile == "clean" or scenario in NON_NOISY_SCENARIOS


def _sorted_wavs(path: Path) -> list[Path]:
    if not path.exists():
        return []
    return sorted(p for p in path.glob("*.wav") if p.is_file())


def _collect_sources(run_dir: Path, manifest_rows: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    telephony_dir = run_dir / "telephony"
    rich_dir = run_dir / "telephony_rich_noisy"
    if not telephony_dir.exists():
        raise SystemExit(f"Missing telephony directory: {telephony_dir}")
    if not rich_dir.exists():
        raise SystemExit(f"Missing rich-noisy directory: {rich_dir}")

    selected: list[dict[str, Any]] = []

    for wav_path in _sorted_wavs(telephony_dir):
        clip_id = wav_path.stem
        row = manifest_rows.get(clip_id)
        if not _is_non_noisy_row(row):
            continue
        selected.append(
            {
                "source_clip_id": clip_id,
                "source_path": wav_path,
                "source_bucket": "telephony_non_noisy",
                "scenario": str((row or {}).get("scenario") or ""),
                "noise_profile": str((row or {}).get("noise_profile") or ""),
                "split": str((row or {}).get("split") or ""),
                "text": str((row or {}).get("text") or ""),
            }
        )

    for wav_path in _sorted_wavs(rich_dir):
        clip_id = wav_path.stem
        row = manifest_rows.get(clip_id)
        selected.append(
            {
                "source_clip_id": clip_id,
                "source_path": wav_path,
                "source_bucket": "telephony_rich_noisy",
                "scenario": str((row or {}).get("scenario") or ""),
                "noise_profile": str((row or {}).get("noise_profile") or ""),
                "split": str((row or {}).get("split") or ""),
                "text": str((row or {}).get("text") or ""),
            }
        )

    if not selected:
        raise SystemExit(
            "No source files selected. Check telephony/rich-noisy contents and manifest labels."
        )
    return selected


def _write_output(
    *,
    selected: list[dict[str, Any]],
    out_dir: Path,
    start_index: int,
) -> dict[str, int]:
    audio_dir = out_dir / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = out_dir / "final_manifest.csv"

    columns = [
        "clip_id",
        "audio_path",
        "source_bucket",
        "source_clip_id",
        "scenario",
        "noise_profile",
        "split",
        "text",
    ]
    telephony_non_noisy_count = 0
    rich_noisy_count = 0

    with manifest_path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=columns)
        writer.writeheader()

        for idx, item in enumerate(selected, start=start_index):
            clip_id = f"clip_{idx}"
            target = audio_dir / f"{clip_id}.wav"
            shutil.copy2(Path(item["source_path"]), target)

            source_bucket = str(item["source_bucket"])
            if source_bucket == "telephony_non_noisy":
                telephony_non_noisy_count += 1
            elif source_bucket == "telephony_rich_noisy":
                rich_noisy_count += 1

            writer.writerow(
                {
                    "clip_id": clip_id,
                    "audio_path": target.relative_to(out_dir).as_posix(),
                    "source_bucket": source_bucket,
                    "source_clip_id": item["source_clip_id"],
                    "scenario": item["scenario"],
                    "noise_profile": item["noise_profile"],
                    "split": item["split"],
                    "text": item["text"],
                }
            )

    return {
        "total": len(selected),
        "telephony_non_noisy": telephony_non_noisy_count,
        "rich_noisy": rich_noisy_count,
    }


def main() -> int:
    args = _parse_args()
    run_dir = Path(args.run_dir).expanduser().resolve()
    out_dir = (
        Path(args.out_dir).expanduser().resolve()
        if args.out_dir
        else (run_dir / "final_dataset").resolve()
    )
    manifest_path = run_dir / args.manifest

    manifest_rows = _load_manifest(manifest_path)
    selected = _collect_sources(run_dir, manifest_rows)
    counts = _write_output(selected=selected, out_dir=out_dir, start_index=args.start_index)

    print(f"Run dir: {run_dir}")
    print(f"Output dir: {out_dir}")
    print(f"Manifest used: {manifest_path}")
    print(f"Total files written: {counts['total']}")
    print(f"From telephony non-noisy: {counts['telephony_non_noisy']}")
    print(f"From rich-noisy: {counts['rich_noisy']}")
    print(f"Audio files: {out_dir / 'audio'}")
    print(f"Final manifest: {out_dir / 'final_manifest.csv'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

