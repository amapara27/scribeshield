import { afterEach, describe, expect, it, vi } from "vitest";

import { createStreamSocket, transcribeAudio } from "@/services/api";

const responsePayload = {
  raw_transcript: [],
  corrected_transcript: [],
  clinical_summary: {
    medications: [],
    symptoms: [],
    allergies: [],
    follow_up_actions: [],
    appointment_needed: false,
  },
  pipeline_latency_ms: {
    preprocessing: 0,
    scribe: 0,
    uncertainty: 0,
    tavily: 0,
    claude: 0,
    total: 0,
  },
};

describe("api helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends verification_enabled on transcribe requests when provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(responsePayload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const file = new File(["audio"], "demo.wav", { type: "audio/wav" });
    await transcribeAudio(file, "scribe_v2", { verificationEnabled: false });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = init.body as FormData;
    expect(body.get("stt_model")).toBe("scribe_v2");
    expect(body.get("verification_enabled")).toBe("false");
  });

  it("adds verification_enabled to realtime websocket URLs when provided", () => {
    class FakeWebSocket {
      url: string;

      constructor(url: string | URL) {
        this.url = String(url);
      }
    }

    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);

    const socket = createStreamSocket("token-123", { verificationEnabled: false }) as unknown as FakeWebSocket;
    expect(socket.url).toContain("/stream?token=token-123");
    expect(socket.url).toContain("verification_enabled=false");
  });
});
