"""Create richer noisy variants (conversation + ambience + music)"""

from __future__ import annotations

import argparse
import json
import random
import re
from pathlib import Path
from typing import Any

from .audio import (
    resolve_binary,
    transcode_to_pcm_wav,
    transcode_with_rich_background,
    verify_audio_file,
)
from .constants import CLEAN_SAMPLE_RATE, MONO_CHANNELS, PCM_CODEC, TELEPHONY_SAMPLE_RATE, WAV_CONTAINER
from .models import AudioExpectation


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Remix noisy clips with richer background layers")
    parser.add_argument(
        "--run-dir",
        default="backend/audio_gen/output/run_5x_v2",
        help="Run output directory containing clips.jsonl/raw/clean/telephony",
    )
    parser.add_argument(
        "--manifest-in",
        default="clips.jsonl",
        help="Input manifest filename inside run-dir",
    )
    parser.add_argument(
        "--manifest-out",
        default="clips_rich_noise.jsonl",
        help="Output manifest filename inside run-dir",
    )
    parser.add_argument(
        "--conversation-tracks",
        type=int,
        default=3,
        help="Number of background conversation tracks to mix per clip",
    )
    parser.add_argument(
        "--timeout-s",
        type=float,
        default=180.0,
        help="ffmpeg/ffprobe timeout in seconds",
    )
    return parser.parse_args()


def remix_run_dir(
    *,
    run_dir: Path,
    manifest_in_name: str = "clips.jsonl",
    manifest_out_name: str = "clips_rich_noise.jsonl",
    conversation_tracks: int = 3,
    timeout_s: float = 180.0,
) -> dict[str, Any]:
    manifest_in = run_dir / manifest_in_name
    manifest_out = run_dir / manifest_out_name

    if not manifest_in.exists():
        raise SystemExit(f"Input manifest not found: {manifest_in}")

    rows = [json.loads(line) for line in manifest_in.read_text(encoding="utf-8").splitlines() if line.strip()]
    if not rows:
        raise SystemExit("Input manifest is empty")

    clean_rich_dir = run_dir / "clean_rich_noisy"
    telephony_rich_dir = run_dir / "telephony_rich_noisy"
    clean_rich_dir.mkdir(parents=True, exist_ok=True)
    telephony_rich_dir.mkdir(parents=True, exist_ok=True)

    ffmpeg_bin = resolve_binary("ffmpeg")
    ffprobe_bin = resolve_binary("ffprobe")

    clean_expected = AudioExpectation(
        sample_rate=CLEAN_SAMPLE_RATE,
        codec_name=PCM_CODEC,
        channels=MONO_CHANNELS,
        container_name=WAV_CONTAINER,
    )
    telephony_expected = AudioExpectation(
        sample_rate=TELEPHONY_SAMPLE_RATE,
        codec_name=PCM_CODEC,
        channels=MONO_CHANNELS,
        container_name=WAV_CONTAINER,
    )

    conversation_pool = _conversation_pool(rows=rows, run_dir=run_dir)
    if len(conversation_pool) < 2:
        raise SystemExit("Need at least 2 clean_speech clips in conversation pool for remixing")

    updated_rows: list[dict[str, Any]] = []
    failed: list[dict[str, str]] = []

    for row in rows:
        clip_id = str(row.get("clip_id", "")).strip()
        if _is_target_noisy_row(row):
            safe_name = _safe_filename(clip_id)
            source_raw = run_dir / "raw" / f"{safe_name}.source"
            clean_out = clean_rich_dir / f"{safe_name}.wav"
            telephony_out = telephony_rich_dir / f"{safe_name}.wav"

            noise_profile = str(row.get("noise_profile", "medium")).strip().lower()
            selected_tracks = _choose_conversation_tracks(
                pool=conversation_pool,
                exclude_clip_id=clip_id,
                count=max(1, conversation_tracks),
                seed=clip_id,
            )

            try:
                transcode_with_rich_background(
                    foreground_input_path=source_raw,
                    conversation_input_paths=selected_tracks,
                    output_path=clean_out,
                    sample_rate=CLEAN_SAMPLE_RATE,
                    ffmpeg_bin=ffmpeg_bin,
                    timeout_s=timeout_s,
                    noise_profile=noise_profile,
                )
                verify_audio_file(
                    path=clean_out,
                    expected=clean_expected,
                    ffprobe_bin=ffprobe_bin,
                    timeout_s=timeout_s,
                )

                transcode_to_pcm_wav(
                    input_path=clean_out,
                    output_path=telephony_out,
                    sample_rate=TELEPHONY_SAMPLE_RATE,
                    ffmpeg_bin=ffmpeg_bin,
                    timeout_s=timeout_s,
                    background_noise_profile=None,
                )
                verify_audio_file(
                    path=telephony_out,
                    expected=telephony_expected,
                    ffprobe_bin=ffprobe_bin,
                    timeout_s=timeout_s,
                )

                new_row = dict(row)
                new_row["audio_clean_path"] = clean_out.resolve().relative_to(run_dir.resolve()).as_posix()
                new_row["audio_telephony_path"] = (
                    telephony_out.resolve().relative_to(run_dir.resolve()).as_posix()
                )
                new_row["noise_components"] = "conversation+ambience+music"
                new_row["noise_render"] = "rich_background_v1"
                updated_rows.append(new_row)
            except Exception as exc:  # pragma: no cover - batch robustness
                failed.append({"clip_id": clip_id, "error": str(exc)})
                updated_rows.append(dict(row))
        else:
            updated_rows.append(dict(row))

    with manifest_out.open("w", encoding="utf-8") as f:
        for row in updated_rows:
            f.write(json.dumps(row) + "\n")

    summary = {
        "manifest_in": str(manifest_in),
        "manifest_out": str(manifest_out),
        "total_rows": len(rows),
        "target_noisy_rows": sum(1 for row in rows if _is_target_noisy_row(row)),
        "updated_noisy_rows": sum(1 for row in updated_rows if row.get("noise_render") == "rich_background_v1"),
        "failed_rows": len(failed),
    }
    (run_dir / "rich_noise_summary.json").write_text(
        json.dumps({"summary": summary, "failures": failed}, indent=2),
        encoding="utf-8",
    )
    return summary


def main() -> int:
    args = parse_args()
    summary = remix_run_dir(
        run_dir=Path(args.run_dir),
        manifest_in_name=args.manifest_in,
        manifest_out_name=args.manifest_out,
        conversation_tracks=args.conversation_tracks,
        timeout_s=args.timeout_s,
    )

    print(json.dumps(summary, indent=2))
    return 0


def _is_target_noisy_row(row: dict[str, Any]) -> bool:
    scenario = str(row.get("scenario", "")).strip().lower()
    noise_profile = str(row.get("noise_profile", "")).strip().lower()
    return scenario in {"noisy_environment", "medical_conversation"} and noise_profile in {
        "medium",
        "high",
    }


def _conversation_pool(*, rows: list[dict[str, Any]], run_dir: Path) -> list[tuple[str, Path]]:
    out: list[tuple[str, Path]] = []
    for row in rows:
        if str(row.get("scenario", "")).strip().lower() != "clean_speech":
            continue
        clip_id = str(row.get("clip_id", "")).strip()
        clean_path = run_dir / str(row.get("audio_clean_path", "")).strip()
        if clean_path.exists() and clean_path.is_file():
            out.append((clip_id, clean_path))
    return out


def _choose_conversation_tracks(
    *,
    pool: list[tuple[str, Path]],
    exclude_clip_id: str,
    count: int,
    seed: str,
) -> list[Path]:
    candidates = [path for clip_id, path in pool if clip_id != exclude_clip_id]
    if not candidates:
        candidates = [path for _, path in pool]
    rng = random.Random(seed)
    if len(candidates) <= count:
        rng.shuffle(candidates)
        return candidates
    return rng.sample(candidates, k=count)


def _safe_filename(raw: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_-]+", "_", raw).strip("_")
    return cleaned or "clip"


if __name__ == "__main__":
    raise SystemExit(main())
