"""FastAPI entry point for the CareCaller AI backend.

Primary routes match the frozen frontend contract in `frontend/src/services/api.ts`:

    POST /transcribe   - accepts an audio UploadFile, runs the 7-layer pipeline
    GET  /stream/token - single-use token for websocket auth
    WS   /stream       - realtime relay + correction events
    GET  /benchmark    - returns the cached benchmark JSON Person A produces
    GET  /health       - reachability check for Tavily, Claude, and store backend status
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Literal

from anthropic import AsyncAnthropic
from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from tavily import TavilyClient

from . import learning_loop, pipeline, realtime, storage
from .config import settings
from .schemas import (
    BenchmarkResponse,
    HealthResponse,
    LearningLoopResponse,
    StreamToken,
    TranscribeResponse,
)
from stt.runtime import batch_provider_status, ensure_runtime_ready

log = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)


@asynccontextmanager
async def lifespan(app: FastAPI):
    ensure_runtime_ready()
    log.info(
        "CareCaller backend starting (store=%s, model=%s, stt=%s)",
        storage.store_backend_label(),
        settings.CLAUDE_MODEL,
        batch_provider_status(),
    )
    yield
    log.info("CareCaller backend shutting down")


app = FastAPI(title="CareCaller AI Backend", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.FRONTEND_ORIGIN],
    # Any localhost / loopback port (Vite may use 8081+ if 8080 is busy).
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# GET /stream/token
# ---------------------------------------------------------------------------
@app.get("/stream/token", response_model=StreamToken)
async def stream_token() -> StreamToken:
    if not settings.elevenlabs_api_key():
        raise HTTPException(status_code=503, detail="ELEVENLABS_API_KEY is not configured")
    return StreamToken(**realtime.issue_stream_token())


# ---------------------------------------------------------------------------
# WS /stream
# ---------------------------------------------------------------------------
@app.websocket("/stream")
async def stream(websocket: WebSocket) -> None:
    await websocket.accept()
    token = websocket.query_params.get("token", "")
    if not realtime.consume_stream_token(token):
        await websocket.send_json(
            {"type": "error", "stage": "auth", "message": "Invalid or expired stream token"}
        )
        await websocket.close(code=4401)
        return

    upstream = realtime.ScribeRealtimeClient(
        api_key=settings.elevenlabs_api_key(),
        model_id=settings.SCRIBE_REALTIME_MODEL_ID,
    )
    try:
        await upstream.connect()
    except Exception as exc:  # noqa: BLE001
        await websocket.send_json(
            {
                "type": "error",
                "stage": "scribe_realtime",
                "message": f"Failed to connect realtime upstream: {exc}",
            }
        )
        await websocket.close(code=1011)
        return

    async def _client_to_upstream() -> None:
        while True:
            msg = await websocket.receive()
            msg_type = msg.get("type")
            if msg_type == "websocket.disconnect":
                raise WebSocketDisconnect()

            chunk = msg.get("bytes")
            if isinstance(chunk, (bytes, bytearray)):
                await upstream.send_audio_chunk(bytes(chunk), commit=False)
                continue

            text = msg.get("text")
            if isinstance(text, str) and text:
                try:
                    payload = json.loads(text)
                except json.JSONDecodeError:
                    payload = {}
                if payload.get("type") == "commit" or payload.get("commit") is True:
                    await upstream.commit()

    async def _upstream_to_client() -> None:
        while True:
            event = await upstream.recv()
            message_type = str(event.get("message_type", "")).lower()

            if message_type == "session_started":
                continue

            if message_type == "partial_transcript":
                await websocket.send_json(
                    {
                        "type": "partial",
                        "text": str(event.get("text", "")),
                        "words": realtime.frontend_words_from_realtime_event(event),
                    }
                )
                continue

            if message_type in {"committed_transcript", "committed_transcript_with_timestamps"}:
                committed_payload = {
                    "type": "committed",
                    "text": str(event.get("text", "")),
                    "words": realtime.frontend_words_from_realtime_event(event),
                }
                await websocket.send_json(committed_payload)

                scribe_words = realtime.scribe_words_from_realtime_event(event)
                if not scribe_words:
                    continue
                try:
                    corrected = await pipeline.run_pipeline_from_scribe_words(scribe_words)
                    await websocket.send_json(
                        {
                            "type": "correction",
                            "payload": corrected.model_dump(),
                        }
                    )
                except Exception as exc:  # noqa: BLE001
                    log.warning("Realtime correction pipeline failed: %s", exc)
                    await websocket.send_json(
                        {
                            "type": "error",
                            "stage": "pipeline",
                            "message": f"Realtime correction failed: {exc}",
                        }
                    )
                continue

            if "error" in message_type:
                await websocket.send_json(realtime.realtime_error_payload(event))
                continue

    tasks = [asyncio.create_task(_client_to_upstream()), asyncio.create_task(_upstream_to_client())]
    try:
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_EXCEPTION)
        for task in pending:
            task.cancel()
        for task in done:
            exc = task.exception()
            if exc and not isinstance(exc, WebSocketDisconnect):
                raise exc
    except WebSocketDisconnect:
        pass
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await upstream.close()
        try:
            await websocket.close()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# POST /transcribe
# ---------------------------------------------------------------------------
@app.post("/transcribe", response_model=TranscribeResponse)
async def transcribe(
    file: UploadFile = File(...),
    stt_model: Literal["auto", "scribe_v2", "full_ft"] | None = Form(None),
) -> TranscribeResponse:
    suffix = Path(file.filename or "upload.wav").suffix or ".wav"
    tmp_path: str | None = None
    try:
        with NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(await file.read())
            tmp_path = tmp.name

        return await pipeline.run_full_pipeline(
            tmp_path,
            stt_provider_override=stt_model,
        )

    except NotImplementedError as exc:
        # A Person A stub was hit. Surface the missing function name in the body.
        raise HTTPException(
            status_code=501,
            detail=f"Person A module not implemented: {exc}",
        )
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        log.exception("Pipeline failed")
        raise HTTPException(status_code=500, detail=f"Pipeline error: {exc}")
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


# ---------------------------------------------------------------------------
# GET /benchmark
# ---------------------------------------------------------------------------
@app.get("/benchmark", response_model=BenchmarkResponse)
def benchmark(
    clips: Literal["all", "adversarial", "standard"] = Query("all"),
) -> BenchmarkResponse:
    path = settings.BENCHMARK_RESULTS_PATH
    if not path.exists():
        raise HTTPException(
            status_code=503,
            detail=(
                "Benchmark results not generated yet — Person A: run "
                "scripts/run_benchmark.py to produce data/benchmark_results.json"
            ),
        )

    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise HTTPException(500, f"benchmark_results.json is malformed: {exc}")

    if clips != "all":
        wanted = "Adversarial" if clips == "adversarial" else "Standard"
        data["results"] = [
            r for r in data.get("results", []) if r.get("difficulty") == wanted
        ]

    return BenchmarkResponse.model_validate(data)


# ---------------------------------------------------------------------------
# GET /learning-loop
# ---------------------------------------------------------------------------
@app.get("/learning-loop", response_model=LearningLoopResponse)
def learning_loop_report() -> LearningLoopResponse:
    try:
        from xgb.reporting import load_learning_loop_report
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(500, f"learning-loop reporting unavailable: {exc}")

    payload = load_learning_loop_report()
    has_any = bool(
        payload.get("training_history")
        or payload.get("retraining_snapshots")
        or payload.get("feature_importance")
    )
    if not has_any:
        raise HTTPException(
            status_code=503,
            detail=(
                "Learning-loop artifacts not generated yet — train the XGBoost word-risk "
                "model to produce training history, retraining snapshots, and feature importance."
            ),
        )
    return LearningLoopResponse.model_validate(payload)


# ---------------------------------------------------------------------------
# GET /health
# ---------------------------------------------------------------------------
async def _ping_tavily() -> str:
    key = settings.TAVILY_API_KEY.get_secret_value()
    if not key:
        return "not_configured"
    try:
        client = TavilyClient(api_key=key)
        await asyncio.wait_for(
            asyncio.to_thread(
                client.search, query="acetaminophen", max_results=1, search_depth="basic"
            ),
            timeout=2.0,
        )
        return "reachable"
    except Exception as exc:  # noqa: BLE001
        return f"error: {type(exc).__name__}"


async def _ping_claude() -> str:
    key = settings.ANTHROPIC_API_KEY.get_secret_value()
    if not key:
        return "not_configured"
    try:
        client = AsyncAnthropic(api_key=key)
        await asyncio.wait_for(
            client.messages.create(
                model=settings.CLAUDE_MODEL,
                max_tokens=4,
                messages=[{"role": "user", "content": "ping"}],
            ),
            timeout=2.0,
        )
        return "reachable"
    except Exception as exc:  # noqa: BLE001
        return f"error: {type(exc).__name__}"


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    tavily_status, claude_status = await asyncio.gather(
        _ping_tavily(), _ping_claude()
    )
    return HealthResponse(
        status="ok",
        redis=storage.store_backend_label(),
        scribe=batch_provider_status(),
        tavily=tavily_status,
        claude=claude_status,
        learning_loop={
            "keyterm_count": learning_loop.keyterm_count(),
            "phonetic_map_size": learning_loop.phonetic_map_size(),
        },
        realtime=realtime.realtime_dependency_status(),
    )
