from __future__ import annotations

import asyncio

from fastapi.testclient import TestClient
from pydantic import SecretStr

from app import main, pipeline, realtime
from app.schemas import ClinicalSummary, PipelineLatency, TranscribeResponse


class _FakeRealtimeClient:
    def __init__(self, api_key: str, model_id: str):
        self.api_key = api_key
        self.model_id = model_id
        self._events = [
            {"message_type": "partial_transcript", "text": "hello"},
            {
                "message_type": "committed_transcript_with_timestamps",
                "text": "hello world",
                "words": [
                    {"type": "word", "text": "hello", "start": 0.0, "end": 0.2},
                    {"type": "word", "text": "world", "start": 0.2, "end": 0.45},
                ],
            },
        ]

    async def connect(self) -> None:
        return None

    async def send_audio_chunk(self, chunk: bytes, *, commit: bool = False) -> None:
        return None

    async def commit(self) -> None:
        return None

    async def recv(self):
        if self._events:
            return self._events.pop(0)
        await asyncio.sleep(3600)
        return {}

    async def close(self) -> None:
        return None


async def _fake_pipeline(
    words,
    *,
    scribe_latency_ms=0,
    stt_provider_name="scribe_v2",
    verification_enabled=True,
):
    del words, scribe_latency_ms, stt_provider_name, verification_enabled
    return TranscribeResponse(
        raw_transcript=[],
        corrected_transcript=[],
        clinical_summary=ClinicalSummary(),
        pipeline_latency_ms=PipelineLatency(
            preprocessing=0, scribe=0, uncertainty=1, tavily=1, claude=1, total=3
        ),
    )


def test_stream_token_route(monkeypatch):
    monkeypatch.setattr(main.settings, "ELEVENLABS_API_KEY", SecretStr("x"))
    client = TestClient(main.app)
    resp = client.get("/stream/token")
    assert resp.status_code == 200
    body = resp.json()
    assert body["token"]
    assert body["expires_in"] == main.settings.STREAM_TOKEN_TTL_SEC


def test_stream_ws_emits_partial_committed_and_correction(monkeypatch):
    monkeypatch.setattr(main.settings, "ELEVENLABS_API_KEY", SecretStr("x"))
    monkeypatch.setattr(realtime, "ScribeRealtimeClient", _FakeRealtimeClient)
    monkeypatch.setattr(pipeline, "run_pipeline_from_scribe_words", _fake_pipeline)

    client = TestClient(main.app)
    token = client.get("/stream/token").json()["token"]

    with client.websocket_connect(f"/stream?token={token}") as ws:
        ws.send_bytes(b"\x00\x01\x02\x03")

        partial = ws.receive_json()
        assert partial["type"] == "partial"
        assert partial["text"] == "hello"

        committed = ws.receive_json()
        assert committed["type"] == "committed"
        assert committed["text"] == "hello world"
        assert len(committed["words"]) == 2

        correction = ws.receive_json()
        assert correction["type"] == "correction"
        assert "payload" in correction
        assert correction["payload"]["pipeline_latency_ms"]["total"] == 3


def test_stream_token_is_single_use():
    token = realtime.issue_stream_token(ttl_sec=60)["token"]
    assert realtime.consume_stream_token(token) is True
    assert realtime.consume_stream_token(token) is False


def test_stream_ws_passes_verification_flag(monkeypatch):
    captured: dict[str, bool | None] = {"verification_enabled": None}

    async def fake_pipeline(
        words,
        *,
        scribe_latency_ms=0,
        stt_provider_name="scribe_v2",
        verification_enabled=True,
    ):
        del words, scribe_latency_ms, stt_provider_name
        captured["verification_enabled"] = verification_enabled
        return TranscribeResponse(
            raw_transcript=[],
            corrected_transcript=[],
            clinical_summary=ClinicalSummary(),
            pipeline_latency_ms=PipelineLatency(
                preprocessing=0, scribe=0, uncertainty=1, tavily=0, claude=0, total=1
            ),
        )

    monkeypatch.setattr(main.settings, "ELEVENLABS_API_KEY", SecretStr("x"))
    monkeypatch.setattr(realtime, "ScribeRealtimeClient", _FakeRealtimeClient)
    monkeypatch.setattr(pipeline, "run_pipeline_from_scribe_words", fake_pipeline)

    client = TestClient(main.app)
    token = client.get("/stream/token").json()["token"]

    with client.websocket_connect(f"/stream?token={token}&verification_enabled=false") as ws:
        ws.send_bytes(b"\x00\x01\x02\x03")
        ws.receive_json()
        ws.receive_json()
        correction = ws.receive_json()

    assert correction["type"] == "correction"
    assert correction["payload"]["pipeline_latency_ms"]["tavily"] == 0
    assert captured["verification_enabled"] is False
