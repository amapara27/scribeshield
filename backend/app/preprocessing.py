"""Layer 1 — Audio Preprocessing.

OWNED BY PERSON A. See HANDOFF_PERSON_A.md for the full spec.
"""
from __future__ import annotations

import asyncio
import uuid
from pathlib import Path
from tempfile import gettempdir

try:
    from audio_preprocess.pipeline import preprocess_for_scribe
except Exception:  # pragma: no cover - fallback import style for alternate runners
    from backend.audio_preprocess.pipeline import preprocess_for_scribe  # type: ignore[no-redef]

from .config import settings


async def preprocess(input_path: str, *, stt_provider: str | None = None) -> str:
    """Run loudnorm → afftdn → 16kHz mono PCM WAV. Return path to cleaned WAV.

    For local Whisper models (full_ft / lora / emergency_lora), uses
    telephony_mode=True: skips denoising and applies
    8kHz→16kHz resampling to match the model's training distribution.

    Implementation notes:
        ffmpeg -y -i {input} \\
          -af "loudnorm=I=-16:LRA=11:TP=-1.5,afftdn=nf=-25" \\
          -ar 16000 -ac 1 -c:a pcm_s16le {output}

    Use asyncio.create_subprocess_exec so the event loop stays responsive.
    Raise an exception (any) on non-zero exit — the pipeline route turns it into a 500.
    """
    working_dir = Path(gettempdir()) / "carecaller_preprocessed"
    working_dir.mkdir(parents=True, exist_ok=True)

    ff, fp = settings.ffmpeg_ffprobe_explicit()
    result = await asyncio.to_thread(
        preprocess_for_scribe,
        input_path=input_path,
        output_dir=working_dir,
        job_id=f"call_{uuid.uuid4().hex[:10]}",
        timeout_s=120,
        ffmpeg_bin=ff,
        ffprobe_bin=fp,
        telephony_mode=(stt_provider in {"full_ft", "lora", "emergency_lora"}),
    )
    return str(result.output_path)
