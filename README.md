# ScribeShield AI

ScribeShield AI is a healthcare speech-intelligence project for **high-risk phone call transcription**. It combines telephony-aware STT, uncertainty scoring, live medical-term verification, safe correction, and structured clinical extraction so a transcript is not just readable, but trustworthy enough to review.

This repository contains the full stack:

- a **FastAPI backend** for batch transcription, realtime streaming, verification, correction, extraction, benchmarking, and learning-loop reporting
- a **React + Vite frontend** branded as **ScribeShield** for the landing page, interactive demo, and benchmark dashboard
- synthetic **demo audio** and **benchmark assets** for repeatable evaluation
- optional **fine-tuned Whisper telephony STT** support alongside the baseline Scribe pipeline

The original hackathon brief framed the challenge around healthcare telephony STT failure modes. This README keeps that problem framing, but documents the **current implementation in this repo**.

## Why This Project Exists

Healthcare calls are where generic speech-to-text systems fail in the most dangerous ways.

- **8 kHz telephony audio** removes phonetic detail that many STT models rely on.
- **Medical language** is unforgiving: a wrong drug name, dosage, route, or follow-up instruction can change care.
- **Real calls are noisy**: speakerphone audio, TV in the background, interruptions, room noise, and variable call quality are common.
- **Speech varies widely**: accents, age, speed, and clinical handoff speech make benchmark-clean audio assumptions break down fast.
- **Plain transcripts hide uncertainty**: the biggest issue is not only being wrong, but looking confident while wrong.

The core idea behind ScribeShield AI is simple: if the system is uncertain, it should **surface that uncertainty, verify what it can, avoid unsafe guesses, and extract clinically useful structure only after correction**.

## What The App Does

At a high level, the pipeline turns an audio clip into four outputs:

1. a **raw transcript** with per-word confidence labels
2. a **corrected transcript** with verification-aware change tracking
3. a **clinical summary** with medications, symptoms, allergies, and follow-up actions
4. **latency and benchmark data** so the behavior is measurable, not hand-wavy

The frontend exposes three main experiences:

- `/` landing page with the problem framing and headline metrics
- `/demo` interactive comparison workspace with six canned healthcare situations plus file upload
- `/benchmark` dashboard for ablation data, per-clip results, and learning-loop visuals

## Problem Statement, In Product Terms

The project brief for ScribeShield AI focused on a real and important gap: **speech systems that work on clean demo audio often break on actual healthcare phone calls**. In this repo, that problem statement translates into a few design choices:

- low-confidence medical-looking words are treated as higher risk than ordinary words
- corrections are constrained by external verification instead of pure model rewriting
- unresolved terms can remain marked as **unverified** instead of being confidently hallucinated
- benchmark clips intentionally include noise, accent, and clinical-handoff style stressors
- the UI shows the before/after delta so failure is visible rather than hidden

## Pipeline Overview

The backend currently implements a 7-layer flow:

1. **Preprocessing**  
   `ffmpeg` normalizes loudness, denoises, and converts audio into a Scribe-friendly WAV contract.

2. **Batch STT**  
   The backend uses a selectable provider:
   - `scribe_v2` for ElevenLabs Scribe v2
   - `fine_tuned_telephony` for a local Whisper model
   - `auto` to prefer the local telephony model when available and otherwise fall back to Scribe

3. **Uncertainty scoring**  
   Each word is scored as `LOW`, `MEDIUM`, or `HIGH` confidence using multiple signals, including keyterms, phonetic history, and optional XGBoost risk features.

4. **Medical-term verification**  
   Low- or medium-confidence medical-shaped terms are sent through Tavily, capped and cached, to retrieve canonical spellings and aliases.

5. **Safe correction**  
   Claude corrects the transcript using the verified context. The hallucination guard only allows risky changes when there is verification support.

6. **Clinical extraction**  
   A second Claude pass extracts structured output such as medications, symptoms, allergies, follow-up actions, and whether an appointment appears necessary.

7. **Learning loop**  
   The backend records correction history, phonetic patterns, keyterms, and optional XGBoost artifacts that feed the benchmark and learning-loop UI.

For realtime mode, the WebSocket path skips batch preprocessing and runs correction after committed Scribe chunks arrive.

## Key Features

- **Interactive demo library** with 6 healthcare situations and 4 takes each:
  `clear_call`, `ambient_noise`, `heavy_accent`, and `clinical_handoff`
- **Model comparison UI** that runs both:
  `fine_tuned_telephony` and `scribe_v2`
- **Upload support** for `.mp3` and `.wav` files
- **Benchmark API and dashboard** for WER, CER, digit accuracy, medical keyword accuracy, ablation rows, and aggregate lift
- **Learning-loop report API** for XGBoost training history, retraining snapshots, and feature importance
- **Realtime token + WebSocket endpoints** for streaming transcription
- **Synthetic data generation** utilities for demo and benchmark audio workflows

## Tech Stack

- **Frontend:** React 18, Vite, TypeScript, Tailwind, TanStack Query, Recharts
- **Backend:** FastAPI, Uvicorn, Pydantic
- **STT:** ElevenLabs Scribe v2, optional fine-tuned Whisper telephony runtime
- **LLM / verification:** Anthropic Claude, Tavily
- **Audio processing:** ffmpeg / ffprobe
- **ML / analytics:** scikit-learn, XGBoost, joblib, pandas, numpy
- **Testing:** pytest, pytest-asyncio, Vitest

## Repository Layout

```text
.
├── README.md
├── package.json                  # root convenience scripts for frontend
├── frontend/                     # React + Vite UI (landing, demo, benchmark)
│   ├── public/demo-audio/        # shipped demo clips used by /demo
│   └── src/
├── backend/
│   ├── app/                      # FastAPI routes and pipeline layers
│   ├── audio_preprocess/         # ffmpeg preprocessing contract
│   ├── audio_gen/                # synthetic audio generation + benchmark helpers
│   ├── data/                     # benchmark JSON and eval rows
│   ├── scripts/                  # benchmark generation scripts
│   ├── stt/                      # local telephony STT runtime helpers
│   ├── test_audio/               # demo and benchmark audio manifests
│   ├── tests/                    # backend tests
│   └── xgb/                      # word-risk model and learning-loop reporting
└── generation.py                 # repo-level helper script
```

## Prerequisites

Before running the stack locally, make sure you have:

- **Python 3.11**
- **Node.js / npm**
- **ffmpeg** and **ffprobe** available on `PATH`
- API keys for:
  - `ANTHROPIC_API_KEY`
  - `TAVILY_API_KEY`
  - `ELEVENLABS_API_KEY`

If you want the local telephony STT path, you also need a valid Whisper export. This repo already includes a legacy model location at `backend/whisper_small_telephony_final`, and `STT_PROVIDER=auto` knows how to use it when valid.

## Quick Start

### 1. Backend

From the repository root:

```bash
cd backend
conda env create -f environment.yml
conda activate village-hacks
cp .env.example .env
```

Fill in `backend/.env` with your API keys, then start the server:

```bash
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

If you prefer `venv` instead of Conda:

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

### 2. Frontend

In a second terminal:

```bash
cd frontend
npm install
cp .env.example .env
npm run dev
```

The frontend reads `frontend/.env`, so make sure `VITE_API_URL` matches the backend port:

```bash
VITE_API_URL=http://127.0.0.1:8000
```

Or use the root convenience scripts:

```bash
npm run install:frontend
npm run dev
```

## Environment Variables

### Backend

`backend/.env.example` includes the main knobs:

- `ANTHROPIC_API_KEY`
- `TAVILY_API_KEY`
- `ELEVENLABS_API_KEY`
- `CLAUDE_MODEL`
- `TAVILY_CALL_CAP`
- `TAVILY_CACHE_TTL_SEC`
- `FRONTEND_ORIGIN`
- `STT_PROVIDER`
- `FINE_TUNED_STT_MODEL_PATH`
- `FINE_TUNED_STT_LANGUAGE`
- `FINE_TUNED_STT_TASK`
- `FINE_TUNED_STT_DEVICE`
- `FINE_TUNED_STT_DTYPE`
- `FINE_TUNED_STT_WORD_TIMESTAMPS`
- `FFMPEG_PATH`
- `FFPROBE_PATH`

### Frontend

`frontend/.env.example` currently uses:

- `VITE_API_URL`

## Running The Main Workflows

### Interactive Demo

The `/demo` page ships with six base situations generated from `backend/audio_gen/input/demo_cards_20260412.csv`:

- medication refill
- post-op follow-up
- new symptom report
- allergy review
- dose timing check
- rapid med list

Each situation expands into four takes:

- `clear_call`
- `ambient_noise`
- `heavy_accent`
- `clinical_handoff`

Those WAVs are copied into both:

- `backend/test_audio/demo/audio/`
- `frontend/public/demo-audio/`

You can also upload your own `.mp3` or `.wav` file from the demo UI, which posts to `POST /transcribe`.

### Regenerating Demo Audio

```bash
conda run -n village-hacks python -m backend.audio_gen.build_demo_audio
```

This rebuilds the demo catalog from the canonical CSV and script files, then syncs assets into the backend and frontend demo locations.

### Benchmark Data

The benchmark dashboard pulls from `GET /benchmark`, backed by:

- `backend/data/benchmark_results.json`
- `backend/data/benchmark_eval.jsonl`
- `backend/test_audio/benchmark/v1/manifest.csv`

To recompute benchmark results from the live pipeline:

```bash
python backend/scripts/run_benchmark.py --run-pipeline
```

This runs the pipeline against the benchmark audio, writes eval rows, and regenerates the JSON consumed by the frontend.

## API Surface

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/transcribe` | Upload audio and run the full batch pipeline |
| `GET` | `/stream/token` | Mint a short-lived token for realtime streaming |
| `WS` | `/stream?token=...` | Realtime transcription + correction events |
| `GET` | `/benchmark` | Return benchmark results, optionally filtered by difficulty |
| `GET` | `/learning-loop` | Return persisted learning-loop / XGBoost reporting data |
| `GET` | `/health` | Report backend, STT, Tavily, Claude, and realtime dependency health |

## STT Provider Modes

The backend supports three batch STT settings through `STT_PROVIDER` or the optional `stt_model` form field on `/transcribe`:

- `auto`
  Prefer the local fine-tuned telephony model when present, otherwise fall back to Scribe v2
- `fine_tuned_telephony`
  Require the local Whisper model
- `scribe_v2`
  Force ElevenLabs Scribe v2

The demo UI compares `fine_tuned_telephony` against `scribe_v2` side by side when you run a clip.

## Tests

### Backend

```bash
cd backend
pytest -q
```

Important coverage areas in `backend/tests/` include:

- FastAPI route contract tests
- pipeline unit and integration tests
- hallucination-guard behavior
- benchmark generation
- STT runtime selection
- streaming and learning-loop reporting

### Frontend

```bash
cd frontend
npm test
```

Additional useful commands:

```bash
cd frontend
npm run lint
npm run build
```

Or from the repo root:

```bash
npm run test
npm run lint
npm run build
```

## Troubleshooting

### `ffmpeg` or `ffprobe` not found

Install `ffmpeg`, restart the terminal, and if your IDE still cannot see it, set:

- `FFMPEG_PATH`
- `FFPROBE_PATH`

in `backend/.env`.

### Port `8000` is blocked

Start the backend on another local port:

```bash
uvicorn app.main:app --reload --host 127.0.0.1 --port 8001
```

Then update `frontend/.env`:

```bash
VITE_API_URL=http://127.0.0.1:8001
```

### Demo loads but benchmark is empty

Regenerate the benchmark artifact:

```bash
python backend/scripts/run_benchmark.py --run-pipeline
```

## What Makes This Repo Interesting

This is not just a transcription wrapper. The more interesting design choice is the safety posture:

- it explicitly models **uncertainty**
- it uses **retrieval-backed verification** for risky medical terms
- it prefers **flagging** over silent guessing
- it packages the result into a **reviewable clinical summary**
- it ships with **repeatable demo and benchmark assets** instead of relying on one lucky example

That combination is what connects the original problem statement to the current codebase: the goal is not only to transcribe healthcare calls, but to do it in a way that acknowledges how costly a wrong transcript can be.
