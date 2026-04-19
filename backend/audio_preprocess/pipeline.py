"""Scribe-focused audio preprocessing pipeline powered by ffmpeg."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import uuid
from pathlib import Path
from time import perf_counter
from typing import Any

from .errors import (
    AudioFormatValidationError,
    AudioProbeError,
    AudioProcessingFailedError,
    AudioProcessingTimeoutError,
    FFmpegNotFoundError,
    UnsupportedOrCorruptAudioError,
)
from .models import AudioMetadata, PreprocessResult

TARGET_SAMPLE_RATE = 16_000
TARGET_CHANNELS = 1
TARGET_CODEC = "pcm_s16le"
TARGET_CONTAINER = "wav"
FILTER_CHAIN = "loudnorm=I=-16:LRA=11:TP=-1.5,afftdn=nf=-25,aresample=16000:resampler=soxr"
FALLBACK_FILTER_CHAIN = "loudnorm=I=-16:LRA=11:TP=-1.5,afftdn=nf=-25,aresample=16000"
# Telephony chain: skip denoising, downsample to 8kHz then back to 16kHz to recreate
# the narrowband ceiling that full_ft was trained on.
FILTER_CHAIN_TELEPHONY = "loudnorm=I=-16:LRA=11:TP=-1.5,aresample=8000,aresample=16000:resampler=soxr"
FALLBACK_FILTER_CHAIN_TELEPHONY = "loudnorm=I=-16:LRA=11:TP=-1.5,aresample=8000,aresample=16000"


def _windows_binary_candidates(binary_name: str) -> list[Path]:
    """Common install locations when PATH is stale (e.g. IDE-started Uvicorn)."""
    exe = f"{binary_name}.exe"
    out: list[Path] = []
    pf = os.environ.get("ProgramFiles", r"C:\Program Files")
    pfx86 = os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")
    local = os.environ.get("LOCALAPPDATA", "")
    for root in (
        Path(pf) / "ffmpeg" / "bin",
        Path(pfx86) / "ffmpeg" / "bin",
        Path(local) / "Microsoft" / "WinGet" / "Links",
    ):
        if root and (root / exe).is_file():
            out.append(root / exe)
    return out


def _resolve_binary(binary_name: str, *, explicit: str | None = None) -> str:
    """Resolve ffmpeg/ffprobe: optional full path from settings, then PATH, then Windows defaults."""
    if explicit:
        exp = Path(explicit).expanduser()
        if exp.is_file():
            return str(exp.resolve())
        which_explicit = shutil.which(explicit)
        if which_explicit:
            return which_explicit

    resolved = shutil.which(binary_name)
    if resolved:
        return resolved

    if sys.platform == "win32":
        for candidate in _windows_binary_candidates(binary_name):
            return str(candidate.resolve())

    raise FFmpegNotFoundError(
        f"Required binary '{binary_name}' was not found in PATH. Install ffmpeg/ffprobe first, "
        f"restart your terminal (and IDE) so PATH updates, or set FFMPEG_PATH / FFPROBE_PATH in backend/.env "
        f"to the full path of {binary_name}.exe."
    )


def _looks_like_corrupt_audio(stderr: str) -> bool:
    lowered = stderr.lower()
    signals = (
        "invalid data found",
        "could not find codec parameters",
        "error reading header",
        "moov atom not found",
        "unsupported codec",
    )
    return any(signal in lowered for signal in signals)


def _is_soxr_unavailable(stderr: str) -> bool:
    return "requested resampling engine is unavailable" in stderr.lower()


def _parse_metadata(probe_json: dict[str, Any], source_path: Path) -> AudioMetadata:
    streams = probe_json.get("streams", [])
    audio_stream = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if not audio_stream:
        raise AudioProbeError(f"No audio stream detected in '{source_path}'.")

    fmt = probe_json.get("format", {})

    try:
        sample_rate = int(audio_stream["sample_rate"])
        channels = int(audio_stream["channels"])
        codec_name = str(audio_stream["codec_name"])
        format_name = str(fmt.get("format_name", ""))
        duration_raw = audio_stream.get("duration") or fmt.get("duration") or 0.0
        duration_s = float(duration_raw)
    except (KeyError, TypeError, ValueError) as exc:
        raise AudioProbeError(
            f"ffprobe metadata for '{source_path}' is incomplete or invalid."
        ) from exc

    return AudioMetadata(
        format_name=format_name,
        codec_name=codec_name,
        sample_rate=sample_rate,
        channels=channels,
        duration_s=duration_s,
    )


def probe_audio_metadata(input_path: Path, *, ffprobe_bin: str, timeout_s: float) -> AudioMetadata:
    command = [
        ffprobe_bin,
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_streams",
        "-show_format",
        str(input_path),
    ]

    try:
        proc = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout_s,
        )
    except subprocess.TimeoutExpired as exc:
        raise AudioProcessingTimeoutError("ffprobe", timeout_s) from exc

    stderr = proc.stderr.strip()
    if proc.returncode != 0:
        if _looks_like_corrupt_audio(stderr):
            raise UnsupportedOrCorruptAudioError(
                f"Audio file '{input_path}' is unsupported or corrupt."
            )
        raise AudioProbeError(
            f"ffprobe failed for '{input_path}' with code {proc.returncode}: {stderr}"
        )

    try:
        payload = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise AudioProbeError(f"ffprobe returned invalid JSON for '{input_path}'.") from exc

    return _parse_metadata(payload, input_path)


def validate_output_metadata(metadata: AudioMetadata) -> None:
    issues: list[str] = []

    container_names = {part.strip() for part in metadata.format_name.split(",") if part.strip()}
    if TARGET_CONTAINER not in container_names:
        issues.append(
            f"container must include '{TARGET_CONTAINER}' (got '{metadata.format_name or 'unknown'}')"
        )

    if metadata.codec_name != TARGET_CODEC:
        issues.append(f"codec must be '{TARGET_CODEC}' (got '{metadata.codec_name}')")

    if metadata.sample_rate != TARGET_SAMPLE_RATE:
        issues.append(
            f"sample rate must be {TARGET_SAMPLE_RATE} Hz (got {metadata.sample_rate} Hz)"
        )

    if metadata.channels != TARGET_CHANNELS:
        issues.append(f"audio must be mono ({TARGET_CHANNELS} channel) (got {metadata.channels})")

    if issues:
        raise AudioFormatValidationError("; ".join(issues))


def build_ffmpeg_command(
    input_path: Path,
    output_path: Path,
    *,
    ffmpeg_bin: str,
    filter_chain: str = FILTER_CHAIN,
) -> list[str]:
    # FFmpeg accepts forward slashes on all platforms; Path(str) on Windows uses "\" otherwise.
    in_s = input_path.as_posix()
    out_s = output_path.as_posix()
    return [
        ffmpeg_bin,
        "-y",
        "-i",
        in_s,
        "-af",
        filter_chain,
        "-ac",
        str(TARGET_CHANNELS),
        "-ar",
        str(TARGET_SAMPLE_RATE),
        "-c:a",
        TARGET_CODEC,
        out_s,
    ]


def _output_path_for(input_path: Path, output_dir: Path, job_id: str | None) -> Path:
    stem = (job_id or input_path.stem or "audio").strip()
    safe_stem = "".join(ch if ch.isalnum() or ch in ("-", "_") else "_" for ch in stem)
    suffix = uuid.uuid4().hex[:8]
    return output_dir / f"{safe_stem}_{suffix}.wav"


def preprocess_for_scribe(
    input_path: str | Path,
    output_dir: str | Path,
    *,
    job_id: str | None = None,
    timeout_s: float = 120,
    ffmpeg_bin: str | None = None,
    ffprobe_bin: str | None = None,
    telephony_mode: bool = False,
) -> PreprocessResult:
    """Run fixed preprocessing chain and emit 16kHz mono PCM WAV for Scribe.

    Set telephony_mode=True for full_ft provider: skips denoising and
    applies 8kHz→16kHz resampling to match the model's training distribution.
    """

    start_total = perf_counter()

    src = Path(input_path).expanduser().resolve()
    dst_dir = Path(output_dir).expanduser()

    if not src.exists() or not src.is_file():
        raise FileNotFoundError(f"Input audio file does not exist: '{src}'")

    ffmpeg_bin = _resolve_binary("ffmpeg", explicit=ffmpeg_bin)
    ffprobe_bin = _resolve_binary("ffprobe", explicit=ffprobe_bin)

    timings_ms: dict[str, int] = {}

    start_probe_input = perf_counter()
    input_metadata = probe_audio_metadata(src, ffprobe_bin=ffprobe_bin, timeout_s=timeout_s)
    timings_ms["probe_input"] = int((perf_counter() - start_probe_input) * 1000)

    dst_dir.mkdir(parents=True, exist_ok=True)
    output_path = _output_path_for(src, dst_dir, job_id)

    active_chain = FILTER_CHAIN_TELEPHONY if telephony_mode else FILTER_CHAIN
    fallback_active_chain = FALLBACK_FILTER_CHAIN_TELEPHONY if telephony_mode else FALLBACK_FILTER_CHAIN

    command = build_ffmpeg_command(
        src,
        output_path,
        ffmpeg_bin=ffmpeg_bin,
        filter_chain=active_chain,
    )

    start_ffmpeg = perf_counter()
    try:
        proc = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout_s,
        )
    except subprocess.TimeoutExpired as exc:
        raise AudioProcessingTimeoutError("ffmpeg", timeout_s) from exc

    stderr = proc.stderr.strip()
    if proc.returncode != 0 and _is_soxr_unavailable(stderr):
        fallback_command = build_ffmpeg_command(
            src,
            output_path,
            ffmpeg_bin=ffmpeg_bin,
            filter_chain=fallback_active_chain,
        )
        try:
            proc = subprocess.run(
                fallback_command,
                check=False,
                capture_output=True,
                text=True,
                timeout=timeout_s,
            )
        except subprocess.TimeoutExpired as exc:
            raise AudioProcessingTimeoutError("ffmpeg", timeout_s) from exc
        command = fallback_command
        stderr = proc.stderr.strip()

    timings_ms["ffmpeg"] = int((perf_counter() - start_ffmpeg) * 1000)

    if proc.returncode != 0:
        if _looks_like_corrupt_audio(stderr):
            raise UnsupportedOrCorruptAudioError(
                f"Audio file '{src}' is unsupported or corrupt."
            )
        raise AudioProcessingFailedError(
            f"ffmpeg failed while preprocessing '{src}'.",
            returncode=proc.returncode,
            command=command,
            stderr=stderr,
        )

    if not output_path.exists():
        raise AudioProcessingFailedError(
            "ffmpeg exited successfully but output file was not created.",
            returncode=proc.returncode,
            command=command,
            stderr=stderr,
        )

    start_probe_output = perf_counter()
    output_metadata = probe_audio_metadata(output_path, ffprobe_bin=ffprobe_bin, timeout_s=timeout_s)
    timings_ms["probe_output"] = int((perf_counter() - start_probe_output) * 1000)

    validate_output_metadata(output_metadata)

    timings_ms["total"] = int((perf_counter() - start_total) * 1000)

    return PreprocessResult(
        output_path=output_path.resolve(),
        duration_s=output_metadata.duration_s,
        input_sample_rate=input_metadata.sample_rate,
        output_sample_rate=output_metadata.sample_rate,
        channels=output_metadata.channels,
        codec=output_metadata.codec_name,
        ffmpeg_command=command,
        timings_ms=timings_ms,
    )
