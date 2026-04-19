# Backend Audio Preprocessing

This backend module adds a Scribe-focused preprocessing contract that always emits:

- 16kHz sample rate
- mono channel
- PCM signed 16-bit little-endian (`pcm_s16le`)
- WAV container

## Conda setup (Python 3.11 + pytest)

From repository root:

```bash
conda env create -f backend/environment.yml
conda activate village-hacks
```

`ffmpeg` and `ffprobe` must be available in `PATH`.

Examples:

- macOS (Homebrew): `brew install ffmpeg`
- Ubuntu/Debian: `sudo apt-get install ffmpeg`

## Public entrypoint

```python
from backend.audio_preprocess import preprocess_for_scribe

result = preprocess_for_scribe(
    input_path="/path/to/input_audio.wav",
    output_dir="/path/to/tmp",
    job_id="call_123",
)
```

## ffmpeg chain (fixed order)

`loudnorm=I=-16:LRA=11:TP=-1.5,afftdn=nf=-25,aresample=16000:resampler=soxr`

If `soxr` is unavailable in your ffmpeg build, the pipeline automatically retries with:
`loudnorm=I=-16:LRA=11:TP=-1.5,afftdn=nf=-25,aresample=16000`.

## Future /transcribe adapter

```python
from backend.audio_preprocess import prepare_transcribe_audio

payload = prepare_transcribe_audio(input_path="/path/to/input.wav", working_dir="/tmp")
# payload["preprocessed_wav_path"]
# payload["preprocessing_metrics"]
```

## ElevenLabs dataset generation

Build 5x scenario variants from a separator-delimited text file (`---` lines are ignored):

```bash
python -m backend.audio_gen.build_variants \
  --clips-file backend/audio_gen/clips.txt \
  --output backend/audio_gen/input/clips_5x_variants.csv
```

Run from repository root:

```bash
python -m backend.audio_gen.run \
  --input /path/to/clips.csv \
  --out-dir /path/to/output \
  --concurrency 3 \
  --model-id eleven_multilingual_v2 \
  --resume
```

The generator accepts either environment variable name:

- `ELEVENLABS_API_KEY`
- `ELEVEN_LABS_API_KEY`

To regenerate the shipped demo catalog and export it into both backend and frontend asset folders:

```bash
conda run -n village-hacks python -m backend.audio_gen.build_demo_audio
```

That wrapper reads `backend/audio_gen/input/demo_cards_20260412.csv`, validates the
matching `backend/test_audio/demo/scripts/*.txt`, expands the six base situations into
four takes each, generates telephony WAVs under `backend/audio_gen/output/demo_cards_20260412/`,
then copies the shipped files into:

- `backend/test_audio/demo/audio/`
- `frontend/public/demo-audio/`

It also rewrites `backend/test_audio/demo/manifest.csv` so the checked-in demo mapping
stays aligned with the canonical six-situation, twenty-four-take demo spec.
The demo wrapper does a clean rebuild by default; add `--resume` only when retrying a partial failure.

Ambient variants are remixed with richer beds like background conversation, room tone,
TV, or music rather than plain static.

Input requirements:

- Input file must be `.csv` or `.jsonl`
- Preflight validation is strict and fails before generation on schema/row errors
- Required grouping and numerics fields include:
  - `script_family_id`
  - `scenario_group`
  - `numeric_confusion_type` (`digit_vs_digit|dose_confusion|duration_confusion|none`)
- `voice_type` is validated against enums:
  - `neutral|telephony|accented|clinical`
- Medical/category consistency is enforced:
  - `medical_domain=true` requires category in `medical_conversation|clinical_triage|adverse_event_followup`
  - `medical_domain=false` rejects those medical-only categories
- Scenario rules are validated:
  - `clean_speech` requires `noise_profile=clean`
  - `clean_speech` requires `scenario_group=baseline`
  - `noisy_environment` requires `noise_profile` in `medium|high`
  - `noisy_environment` requires `scenario_group=noisy`
  - `accented_speech` requires non-empty `accent_profile`
  - `accented_speech` requires `scenario_group=accented`
  - `medical_conversation` requires `medical_domain=true` and non-empty `medical_subtype`
  - `medical_conversation` requires `scenario_group=medical`
- For `noisy_environment` and `medical_conversation`, the generator injects synthetic
  background noise into clean audio before telephony conversion. `noise_profile=high`
  is stronger than `noise_profile=medium`.

Primary artifacts:

- `clips.jsonl`
- `generation_errors.jsonl`
- `run_metadata.json`
- `word_features.template.jsonl`
- `numeric_features.template.jsonl`
- `medical_entities.template.jsonl`

Resume determinism:

- `manifest_version` and `input_hash` are written to outputs
- resume mode hard-fails if current input hash differs from existing run metadata

## Run tests

From repository root:

```bash
pytest backend/tests
```

Or from inside `backend/`:

```bash
pytest tests
```

Integration tests auto-skip if `ffmpeg`/`ffprobe` are unavailable.

## Drop-in fine-tuned STT runtime

Batch `/transcribe` can use a locally fine-tuned Whisper model when it is placed at:

`backend/tuned_models/full_ft/`

Use a direct Hugging Face `save_pretrained()` export from Colab.

For convenience, `STT_PROVIDER=auto` also recognizes the legacy drop-in location:

`backend/stt/models/full_ft/`

Relevant env vars:

- `STT_PROVIDER=auto|scribe_v2|full_ft`
- `FINE_TUNED_STT_MODEL_PATH` (optional override)
- `FINE_TUNED_STT_LANGUAGE=english`
- `FINE_TUNED_STT_TASK=transcribe`
- `FINE_TUNED_STT_DEVICE=auto|cpu|cuda|mps`
- `FINE_TUNED_STT_DTYPE=auto|float32|float16`
- `FINE_TUNED_STT_WORD_TIMESTAMPS=false|true`

Default behavior:

- `auto`: use the local Whisper model if present and valid, otherwise fall back to Scribe v2
- `full_ft`: require the local model at startup
- `scribe_v2`: ignore the local model and force ElevenLabs

Realtime websocket transcription remains on Scribe v2 for now.

Latency note:

- On Apple Silicon, leave `FINE_TUNED_STT_DEVICE=auto` or set `mps` to use the GPU.
- `FINE_TUNED_STT_WORD_TIMESTAMPS=false` is faster and uses synthetic word timings for downstream compatibility.
- `FINE_TUNED_STT_WORD_TIMESTAMPS=true` is slower but preserves real word timestamps when available.

## Benchmark metrics generation

Generate `/benchmark` data at `backend/data/benchmark_results.json`:

```bash
python backend/scripts/run_benchmark.py --run-pipeline
```

The script also reads benchmark metadata from
`backend/test_audio/benchmark/v1/manifest.csv` (category, difficulty, ground truth,
medical keywords) so benchmark recomputation stays aligned with the versioned audio
manifest.

`--run-pipeline` uses the real preprocessing, Scribe, uncertainty, Tavily, and
Claude stack against the benchmark audio set, writes `backend/data/benchmark_eval.jsonl`,
then recomputes the final JSON artifact from those live eval rows.

If you already have eval rows and only want to recompute WER/CER, digit-level
accuracy, and medical keyword accuracy, provide `backend/data/benchmark_eval.jsonl`
with:

- `clip_id`
- `ground_truth` (or `reference_text` / `text`)
- `raw_text` (or `raw_transcript`)
- `corrected_text` (or `corrected_transcript`)

Optional fields:

- `category`
- `difficulty` (`Standard` or `Adversarial`)
- `medical_keywords` (list or comma-delimited string)

Reference format: `backend/data/benchmark_eval.jsonl.example`.

## Demo vs benchmark audio organization

Audio assets now live under `backend/test_audio/`:

```text
backend/test_audio/
  demo/
    manifest.csv
    audio/
  benchmark/
    v1/
      manifest.csv
      audio/standard/
      audio/adversarial/
```

Guidelines:

- Use `demo/` for fresh showcase clips.
- Keep benchmark sets versioned and stable (`benchmark/v1`, then `v2`, etc.).
- Keep benchmark audio filenames equal to `clip_id` (for example, `clip_11.wav`).
- Track metadata in each `manifest.csv`; audio binaries are git-ignored by default.
