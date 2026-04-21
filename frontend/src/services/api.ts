import type {
  TranscribeResponse,
  StreamToken,
  BenchmarkResponse,
  HealthResponse,
  LearningLoopResponse,
  SttModelOption,
} from "@/types/api";

const API_URL = import.meta.env.VITE_API_URL || "";

type VerificationRequestOptions = {
  verificationEnabled?: boolean;
};

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const data: unknown = await res.json();
    if (data && typeof data === "object" && "detail" in data) {
      const d = (data as { detail: unknown }).detail;
      if (typeof d === "string") return d;
      if (Array.isArray(d))
        return d
          .map((x) => (typeof x === "object" && x && "msg" in x ? String((x as { msg: unknown }).msg) : String(x)))
          .join("; ");
    }
  } catch {
    /* ignore */
  }
  return res.statusText || `HTTP ${res.status}`;
}

/**
 * POST /transcribe — upload audio file, get full pipeline result
 */
export async function transcribeAudio(
  file: File,
  sttModel?: SttModelOption,
  options?: VerificationRequestOptions,
): Promise<TranscribeResponse> {
  const formData = new FormData();
  formData.append("file", file);
  if (sttModel) formData.append("stt_model", sttModel);
  if (options?.verificationEnabled !== undefined) {
    formData.append("verification_enabled", String(options.verificationEnabled));
  }

  const res = await fetch(`${API_URL}/transcribe`, {
    method: "POST",
    body: formData,
  });

  if (!res.ok) throw new Error(await readErrorMessage(res));
  return res.json();
}

/**
 * GET /stream/token — get single-use token for WebSocket auth
 */
export async function getStreamToken(): Promise<StreamToken> {
  const res = await fetch(`${API_URL}/stream/token`);
  if (!res.ok) throw new Error(await readErrorMessage(res));
  return res.json();
}

/**
 * GET /benchmark — run benchmark and get WER results
 */
export async function fetchBenchmark(filter: "all" | "adversarial" | "standard" = "all"): Promise<BenchmarkResponse> {
  const res = await fetch(`${API_URL}/benchmark?clips=${filter}`);
  if (!res.ok) throw new Error(await readErrorMessage(res));
  return res.json();
}

export async function fetchLearningLoop(): Promise<LearningLoopResponse> {
  const res = await fetch(`${API_URL}/learning-loop`);
  if (!res.ok) throw new Error(await readErrorMessage(res));
  return res.json();
}

/**
 * GET /health — check backend health
 */
export async function checkHealth(): Promise<HealthResponse> {
  const res = await fetch(`${API_URL}/health`);
  if (!res.ok) throw new Error(await readErrorMessage(res));
  return res.json();
}

/**
 * Create WebSocket connection for live streaming
 */
export function createStreamSocket(token: string, options?: VerificationRequestOptions): WebSocket {
  const wsUrl = API_URL.replace(/^http/, "ws");
  const params = new URLSearchParams({ token });
  if (options?.verificationEnabled !== undefined) {
    params.set("verification_enabled", String(options.verificationEnabled));
  }
  return new WebSocket(`${wsUrl}/stream?${params.toString()}`);
}
