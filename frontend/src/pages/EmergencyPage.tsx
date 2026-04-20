import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Pause, Play, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { transcribeAudio } from "@/services/api";
import type { ClinicalSummary, ProcessingStage, TranscribeResponse } from "@/types/api";

type EmergencySample = {
  id: string;
  sourceClipId: string;
  label: string;
  description: string;
  severity: "Critical" | "Urgent";
  challenge: string;
  durationSec: number;
  wav: string;
};

type AudioSelection = {
  id: string;
  label: string;
  description: string;
  src: string;
  sourceKind: "sample" | "upload";
};

type RoutingPriority = "RED" | "ORANGE" | "YELLOW";

type RoutingDecision = {
  priority: RoutingPriority;
  disposition: string;
  rationale: string[];
};

type CachedEmergencyRun = {
  result: TranscribeResponse;
  selection: AudioSelection;
  file: File;
};

const EMERGENCY_SAMPLES: EmergencySample[] = [
  {
    id: "chest_collapse_nitroglycerin",
    sourceClipId: "em_0001_noisy_high_accent_heavy",
    label: "Chest Collapse + Nitro",
    description: "Caller reports sudden collapse, chest clutching, and uncertainty about giving nitroglycerin.",
    severity: "Critical",
    challenge: "High noise + heavy accent",
    durationSec: 9.8,
    wav: "/emergency-audio/chest-collapse-nitroglycerin.wav",
  },
  {
    id: "stroke_warfarin_handoff",
    sourceClipId: "em_0008_medical_high_accent_heavy",
    label: "Stroke + Warfarin",
    description: "Facial droop and slurred speech with anticoagulant risk in a hard clinical handoff take.",
    severity: "Critical",
    challenge: "Clinical phrasing + heavy accent",
    durationSec: 11.9,
    wav: "/emergency-audio/stroke-warfarin-handoff.wav",
  },
  {
    id: "antibiotic_anaphylaxis",
    sourceClipId: "em_0019_noisy_high_accent_heavy",
    label: "Antibiotic Anaphylaxis",
    description: "Rapid airway tightening and hives after ciprofloxacin in a noisy, high-stress take.",
    severity: "Critical",
    challenge: "High noise + heavy accent",
    durationSec: 9.8,
    wav: "/emergency-audio/antibiotic-anaphylaxis.wav",
  },
  {
    id: "fentanyl_overdose_naloxone",
    sourceClipId: "em_0049_noisy_high",
    label: "Fentanyl Overdose",
    description: "Blue lips, fentanyl patch exposure, and naloxone instructions needed immediately.",
    severity: "Critical",
    challenge: "High noise + fast pacing",
    durationSec: 9.7,
    wav: "/emergency-audio/fentanyl-overdose-naloxone.wav",
  },
  {
    id: "head_injury_anticoagulant",
    sourceClipId: "em_0041_medical",
    label: "Head Injury + Rivaroxaban",
    description: "Fall with head trauma, visible bleeding, and anticoagulant mention in a clinical-style take.",
    severity: "Critical",
    challenge: "Clinical phrasing + medication detail",
    durationSec: 9.1,
    wav: "/emergency-audio/head-injury-anticoagulant.wav",
  },
];

const DEFAULT_WAVEFORM = [0.34, 0.48, 0.67, 0.83, 0.56, 0.42, 0.51, 0.72, 0.91, 0.61, 0.4, 0.63, 0.79, 0.58, 0.36, 0.66, 0.84, 0.59, 0.41, 0.54, 0.76, 0.89, 0.57, 0.38, 0.49, 0.71, 0.82, 0.6, 0.35, 0.53, 0.75, 0.88, 0.62, 0.43, 0.5, 0.73, 0.86, 0.61, 0.39, 0.52, 0.7, 0.8, 0.6, 0.42, 0.47, 0.69];

const formatTime = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) return "0:00";
  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

const formatLatency = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) return "<1 ms";
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10_000 ? 1 : 2)} s`;
  return `${value} ms`;
};

const formatClipLength = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) return "Custom upload";
  return `${value.toFixed(1)}s clip`;
};

const realtimeSpeedLabel = (latencyMs: number, clipDurationSec: number) => {
  if (!Number.isFinite(latencyMs) || latencyMs <= 0 || !Number.isFinite(clipDurationSec) || clipDurationSec <= 0) {
    return null;
  }

  const clipDurationMs = clipDurationSec * 1000;
  const speedRatio = clipDurationMs / latencyMs;
  if (speedRatio >= 1) return `${speedRatio.toFixed(speedRatio >= 10 ? 0 : 1)}x faster than realtime`;
  return `${(1 / speedRatio).toFixed(1)}x slower than realtime`;
};

const transcriptRevealDelayMs = (word: string) => {
  if (/[.!?]$/.test(word)) return 150;
  if (/[,;:]$/.test(word)) return 90;
  return 36;
};

const LATENCY_STAGES = [
  { key: "preprocessing", label: "Prep" },
  { key: "scribe", label: "Tiny LoRA STT" },
  { key: "uncertainty", label: "Uncertainty" },
  { key: "tavily", label: "Verify" },
  { key: "claude", label: "Summary" },
] as const;

const generateFallbackWaveform = (seedText: string, bars = 46) => {
  let seed = 0;
  for (const char of seedText) seed = (seed * 31 + char.charCodeAt(0)) >>> 0;
  return Array.from({ length: bars }, (_, index) => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const base = 0.28 + ((seed % 1000) / 1000) * 0.55;
    const sway = Math.sin(index / 2.7) * 0.08;
    return Math.max(0.16, Math.min(0.96, base + sway));
  });
};

const extractWaveformPeaks = async (blob: Blob, seedText: string, bars = 46) => {
  if (typeof window === "undefined") return generateFallbackWaveform(seedText, bars);

  const AudioContextCtor =
    window.AudioContext ??
    ((window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
  if (!AudioContextCtor) return generateFallbackWaveform(seedText, bars);

  const audioContext = new AudioContextCtor();
  try {
    const buffer = await blob.arrayBuffer();
    const audioBuffer = await audioContext.decodeAudioData(buffer.slice(0));
    const channel = audioBuffer.getChannelData(0);
    const blockSize = Math.max(1, Math.floor(channel.length / bars));
    const peaks = Array.from({ length: bars }, (_, index) => {
      const start = index * blockSize;
      const end = Math.min(start + blockSize, channel.length);
      let sum = 0;
      for (let i = start; i < end; i += 1) sum += Math.abs(channel[i]);
      const average = end > start ? sum / (end - start) : 0;
      return Math.max(0.16, Math.min(0.96, average * 4.2 + 0.14));
    });
    const hasRealSignal = peaks.some((peak) => peak > 0.22);
    return hasRealSignal ? peaks : generateFallbackWaveform(seedText, bars);
  } catch {
    return generateFallbackWaveform(seedText, bars);
  } finally {
    await audioContext.close();
  }
};

const buildRoutingDecision = (result: TranscribeResponse | null): RoutingDecision => {
  if (!result) {
    return {
      priority: "YELLOW",
      disposition: "Await transcript",
      rationale: ["Run an emergency sample to generate routing guidance."],
    };
  }

  const summary = result.clinical_summary;
  const corrected = result.corrected_transcript.map((item) => item.word).join(" ");
  const searchCorpus = [
    corrected,
    ...summary.symptoms,
    ...summary.follow_up_actions,
    ...summary.allergies,
  ]
    .join(" ")
    .toLowerCase();

  const criticalSignals = [
    "chest pain",
    "shortness of breath",
    "trouble breathing",
    "anaphylaxis",
    "facial droop",
    "slurred speech",
    "stroke",
    "seizure",
    "unconscious",
  ];
  const urgentSignals = [
    "high fever",
    "worsening pain",
    "vomiting",
    "dehydration",
    "tachycardia",
    "palpitations",
    "allergic reaction",
    "bleeding",
  ];

  const matchedCritical = criticalSignals.filter((term) => searchCorpus.includes(term));
  if (matchedCritical.length > 0) {
    return {
      priority: "RED",
      disposition: "Immediate emergency escalation",
      rationale: matchedCritical.map((term) => `Critical signal detected: ${term}`),
    };
  }

  const matchedUrgent = urgentSignals.filter((term) => searchCorpus.includes(term));
  if (matchedUrgent.length > 0) {
    return {
      priority: "ORANGE",
      disposition: "Urgent clinician callback (within 15 minutes)",
      rationale: matchedUrgent.map((term) => `Urgent signal detected: ${term}`),
    };
  }

  return {
    priority: "YELLOW",
    disposition: "Standard emergency desk follow-up (same day)",
    rationale: ["No critical trigger terms were detected in transcript or summary."],
  };
};

const summaryHasContent = (summary: ClinicalSummary | undefined): boolean => {
  if (!summary) return false;
  return (
    summary.medications.length > 0 ||
    summary.symptoms.length > 0 ||
    summary.allergies.length > 0 ||
    summary.follow_up_actions.length > 0
  );
};

const EmergencyPage = () => {
  const [selectedSampleId, setSelectedSampleId] = useState<string>(EMERGENCY_SAMPLES[0].id);
  const [stage, setStage] = useState<ProcessingStage>("idle");
  const [result, setResult] = useState<TranscribeResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [selection, setSelection] = useState<AudioSelection | null>(null);
  const [audioCurrentTime, setAudioCurrentTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [isAudioPlaying, setIsAudioPlaying] = useState(false);
  const [waveformPeaks, setWaveformPeaks] = useState<number[]>(DEFAULT_WAVEFORM);
  const [revealedWordCount, setRevealedWordCount] = useState(0);

  const fileRef = useRef<File | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const waveformLoadIdRef = useRef(0);
  const cachedEmergencyRunsRef = useRef<Record<string, CachedEmergencyRun>>({});
  const cachedWaveformPeaksRef = useRef<Record<string, number[]>>({});
  const revealedTranscriptKeysRef = useRef<Set<string>>(new Set());

  const isProcessing = stage === "uploading";
  const routingDecision = useMemo(() => buildRoutingDecision(result), [result]);
  const loadedSample = useMemo(
    () => EMERGENCY_SAMPLES.find((item) => item.id === selection?.id) ?? null,
    [selection?.id],
  );
  const lowConfidenceCount = result?.raw_transcript.filter((word) => word.confidence !== "HIGH").length ?? 0;
  const correctedWords = useMemo(
    () => result?.corrected_transcript.slice(0, revealedWordCount) ?? [],
    [result, revealedWordCount],
  );
  const correctedText = correctedWords.map((word) => word.word).join(" ").trim();
  const isTranscriptAnimating = !!result && revealedWordCount < result.corrected_transcript.length;
  const transcriptWordLabel = result
    ? isTranscriptAnimating
      ? `${revealedWordCount}/${result.corrected_transcript.length} words`
      : `${result.corrected_transcript.length} words`
    : "0 words";
  const modelLatencyMs = result?.pipeline_latency_ms.scribe ?? 0;
  const postProcessingLatencyMs = result
    ? Math.max(
        0,
        result.pipeline_latency_ms.uncertainty + result.pipeline_latency_ms.tavily + result.pipeline_latency_ms.claude,
      )
    : 0;
  const effectiveAudioDuration = audioDuration > 0 ? audioDuration : loadedSample?.durationSec ?? 0;
  const speedLabel = result ? realtimeSpeedLabel(result.pipeline_latency_ms.total, effectiveAudioDuration) : null;
  const transcriptRevealKey = selection && result ? `${selection.id}:corrected` : null;

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    audio.currentTime = 0;
    setAudioCurrentTime(0);
    setAudioDuration(0);
    setIsAudioPlaying(false);
  }, [selection?.src]);

  useEffect(() => {
    return () => {
      if (selection?.sourceKind === "upload") {
        URL.revokeObjectURL(selection.src);
      }
    };
  }, [selection]);

  useEffect(() => {
    if (!result?.corrected_transcript.length) {
      setRevealedWordCount(0);
      return;
    }

    if (transcriptRevealKey && revealedTranscriptKeysRef.current.has(transcriptRevealKey)) {
      setRevealedWordCount(result.corrected_transcript.length);
      return;
    }

    let cancelled = false;
    let timeoutId: number | null = null;

    const step = (nextCount: number) => {
      if (cancelled) return;
      setRevealedWordCount(nextCount);
      if (nextCount >= result.corrected_transcript.length) {
        if (transcriptRevealKey) revealedTranscriptKeysRef.current.add(transcriptRevealKey);
        return;
      }

      const previousWord = result.corrected_transcript[nextCount - 1]?.word ?? "";
      timeoutId = window.setTimeout(() => step(nextCount + 1), transcriptRevealDelayMs(previousWord));
    };

    step(1);

    return () => {
      cancelled = true;
      if (timeoutId !== null) window.clearTimeout(timeoutId);
    };
  }, [result, transcriptRevealKey]);

  const runEmergencyTranscription = useCallback(async (file: File, nextSelection: AudioSelection) => {
    setStage("uploading");
    setErrorMessage(null);
    setResult(null);
    setRevealedWordCount(0);
    setSelection(nextSelection);
    fileRef.current = file;

    const loadId = ++waveformLoadIdRef.current;
    void extractWaveformPeaks(file, nextSelection.id).then((peaks) => {
      cachedWaveformPeaksRef.current[nextSelection.id] = peaks;
      if (waveformLoadIdRef.current === loadId) setWaveformPeaks(peaks);
    });

    try {
      const payload = await transcribeAudio(file, "emergency_lora");
      cachedEmergencyRunsRef.current[nextSelection.id] = {
        result: payload,
        selection: nextSelection,
        file,
      };
      setResult(payload);
      setStage("done");
    } catch (e) {
      setResult(null);
      setStage("error");
      setErrorMessage(e instanceof Error ? e.message : "Emergency transcription failed");
    }
  }, []);

  const runSelectedSample = useCallback(async () => {
    const sample = EMERGENCY_SAMPLES.find((item) => item.id === selectedSampleId);
    if (!sample) return;

    const cached = cachedEmergencyRunsRef.current[sample.id];
    if (cached) {
      fileRef.current = cached.file;
      setErrorMessage(null);
      setStage("done");
      setSelection(cached.selection);
      setResult(cached.result);
      setRevealedWordCount(0);
      setWaveformPeaks(cachedWaveformPeaksRef.current[sample.id] ?? generateFallbackWaveform(sample.id));
      return;
    }

    try {
      const response = await fetch(sample.wav);
      if (!response.ok) {
        throw new Error(`Missing emergency sample at ${sample.wav}. Add audio files under frontend/public/emergency-audio/.`);
      }
      const blob = await response.blob();
      const file = new File([blob], `${sample.id}.wav`, { type: blob.type || "audio/wav" });
      await runEmergencyTranscription(file, {
        id: sample.id,
        label: sample.label,
        description: sample.description,
        src: sample.wav,
        sourceKind: "sample",
      });
    } catch (e) {
      setStage("error");
      setErrorMessage(e instanceof Error ? e.message : "Failed to run emergency sample");
    }
  }, [runEmergencyTranscription, selectedSampleId]);

  const rerunCurrentAudio = useCallback(async () => {
    const currentFile = fileRef.current;
    const currentSelection = selection;
    if (!currentFile || !currentSelection) {
      setErrorMessage("Load an emergency sample or upload audio first.");
      return;
    }
    await runEmergencyTranscription(currentFile, currentSelection);
  }, [runEmergencyTranscription, selection]);

  const handleUploadClick = useCallback(() => {
    uploadInputRef.current?.click();
  }, []);

  const handleFileSelected = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    const extension = file.name.split(".").pop()?.toLowerCase();
    const allowedExtensions = new Set(["mp3", "wav"]);
    const allowedMimeTypes = new Set(["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/wave"]);
    if ((!extension || !allowedExtensions.has(extension)) && !allowedMimeTypes.has(file.type)) {
      setErrorMessage("Please upload an MP3 or WAV file.");
      return;
    }

    if (selection?.sourceKind === "upload") {
      URL.revokeObjectURL(selection.src);
    }

    const objectUrl = URL.createObjectURL(file);
    await runEmergencyTranscription(file, {
      id: `upload_${Date.now()}`,
      label: file.name.replace(/\.[^.]+$/, ""),
      description: "User-uploaded emergency call for routing triage.",
      src: objectUrl,
      sourceKind: "upload",
    });
  }, [runEmergencyTranscription, selection]);

  const togglePlayback = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      try {
        await audio.play();
        setIsAudioPlaying(true);
      } catch {
        setIsAudioPlaying(false);
      }
      return;
    }
    audio.pause();
    setIsAudioPlaying(false);
  }, []);

  return (
    <div className="min-h-screen bg-secondary">
      <Navbar />

      <div className="bg-primary text-primary-foreground pt-20">
        <div className="container mx-auto px-6 max-w-[1400px] py-4">
          <h1 className="text-lg font-semibold">Emergency Demo</h1>
          <p className="text-sm text-primary-foreground/70 mt-1">
            Dedicated emergency audio workflow with emergency-only STT and routing recommendations.
          </p>
        </div>
      </div>

      <div className="container mx-auto px-6 max-w-[1440px] py-8">
        <div className="grid grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)] gap-6 items-start">
          <aside className="lg:sticky lg:top-24">
            <div className="rounded-lg border border-border bg-card shadow-card overflow-hidden">
              <div className="border-b border-border px-4 py-4">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Emergency Inputs</p>
                <h2 className="mt-2 text-lg font-semibold text-foreground">Sample Library</h2>
                <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                  Pick emergency scenarios, then run with <span className="font-medium text-foreground">Whisper Tiny LoRA (Emergency)</span>.
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button type="button" variant="default" className="rounded-pill" disabled={isProcessing} onClick={() => void runSelectedSample()}>
                    Run Selected Sample
                  </Button>
                  <Button type="button" variant="outline" className="rounded-pill" disabled={isProcessing} onClick={handleUploadClick}>
                    <Upload className="h-4 w-4 mr-2" />
                    Upload Audio
                  </Button>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  className="mt-3 rounded-pill w-full"
                  disabled={isProcessing || !fileRef.current}
                  onClick={() => void rerunCurrentAudio()}
                >
                  Re-Run Current Audio
                </Button>
                <input
                  ref={uploadInputRef}
                  type="file"
                  accept=".mp3,.wav,audio/mpeg,audio/wav"
                  className="hidden"
                  onChange={(event) => void handleFileSelected(event)}
                />
              </div>

              <div className="p-3 space-y-2">
                {EMERGENCY_SAMPLES.map((sample) => {
                  const selected = sample.id === selectedSampleId;
                  return (
                    <button
                      key={sample.id}
                      type="button"
                      disabled={isProcessing}
                      onClick={() => setSelectedSampleId(sample.id)}
                      className={`w-full rounded-lg border px-3 py-3 text-left transition-all disabled:opacity-60 disabled:cursor-not-allowed ${
                        selected ? "border-accent bg-accent/10 shadow-card" : "border-border bg-card hover:border-accent/40"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-foreground">{sample.label}</span>
                        <Badge
                          className={`text-[10px] border-0 ${
                            sample.severity === "Critical"
                              ? "bg-signal-red/10 text-signal-red"
                              : "bg-warning/15 text-warning"
                          }`}
                        >
                          {sample.severity}
                        </Badge>
                      </div>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{sample.description}</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <span className="rounded-full bg-secondary px-2 py-1 text-[10px] font-medium text-muted-foreground">
                          {sample.challenge}
                        </span>
                        <span className="rounded-full bg-secondary px-2 py-1 text-[10px] font-medium text-muted-foreground">
                          {formatClipLength(sample.durationSec)}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </aside>

          <div className="space-y-6 min-w-0">
            {errorMessage && (
              <div className="rounded-lg border border-signal-red/40 bg-signal-red/10 px-4 py-3 text-sm text-signal-red">
                {errorMessage}
              </div>
            )}

            <div className="rounded-lg border border-border bg-card shadow-card p-5">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Emergency Routing</p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Badge
                  className={`rounded-pill border-0 ${
                    routingDecision.priority === "RED"
                      ? "bg-signal-red/15 text-signal-red"
                      : routingDecision.priority === "ORANGE"
                        ? "bg-warning/20 text-warning"
                        : "bg-success/20 text-success"
                  }`}
                >
                  Priority {routingDecision.priority}
                </Badge>
                <span className="text-sm text-foreground font-medium">{routingDecision.disposition}</span>
              </div>
              <div className="mt-3 space-y-1">
                {routingDecision.rationale.map((reason) => (
                  <p key={reason} className="text-xs text-muted-foreground">
                    - {reason}
                  </p>
                ))}
              </div>
            </div>

            {selection && (
              <div className="rounded-lg border border-border bg-primary text-primary-foreground shadow-card overflow-hidden">
                <div className="flex flex-col gap-5 p-5">
                  <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary-foreground/60">Loaded Audio</p>
                      <h3 className="mt-2 text-xl font-semibold">{selection.label}</h3>
                      <p className="mt-1 text-sm text-primary-foreground/70">{selection.description}</p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <span className="rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-medium text-primary-foreground/85">
                          Whisper Tiny LoRA demo
                        </span>
                        <span className="rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-medium text-primary-foreground/85">
                          {formatClipLength(loadedSample?.durationSec ?? audioDuration)}
                        </span>
                        {loadedSample && (
                          <span className="rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-medium text-primary-foreground/85">
                            {loadedSample.challenge}
                          </span>
                        )}
                      </div>
                    </div>
                    <Button type="button" variant="secondary" className="rounded-pill gap-2" onClick={() => void togglePlayback()}>
                      {isAudioPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                      {isAudioPlaying ? "Pause Audio" : "Play Audio"}
                    </Button>
                  </div>

                  <div className="rounded-lg bg-black/20 px-4 py-5">
                    <div className="flex h-28 items-end gap-1 overflow-hidden">
                      {waveformPeaks.map((peak, index) => {
                        const ratio = audioDuration > 0 ? Math.min(audioCurrentTime / audioDuration, 1) : 0;
                        const isPlayed = index / waveformPeaks.length <= ratio;
                        return (
                          <div
                            key={`${selection.id}-${index}`}
                            className={`flex-1 rounded-full transition-colors ${isPlayed ? "bg-[#67B0FF]" : "bg-white/20"}`}
                            style={{ height: `${Math.max(18, peak * 100)}%` }}
                          />
                        );
                      })}
                    </div>

                    <div className="mt-4 flex items-center gap-3">
                      <span className="w-12 text-xs tabular-nums text-primary-foreground/70">{formatTime(audioCurrentTime)}</span>
                      <input
                        type="range"
                        min={0}
                        max={audioDuration || 1}
                        step={0.01}
                        value={Math.min(audioCurrentTime, audioDuration || 1)}
                        onChange={(event) => {
                          const nextTime = Number(event.target.value);
                          setAudioCurrentTime(nextTime);
                          if (audioRef.current) audioRef.current.currentTime = nextTime;
                        }}
                        className="h-2 flex-1 cursor-pointer accent-accent"
                      />
                      <span className="w-12 text-right text-xs tabular-nums text-primary-foreground/70">{formatTime(audioDuration)}</span>
                    </div>
                  </div>

                  <audio
                    ref={audioRef}
                    src={selection.src}
                    preload="metadata"
                    onLoadedMetadata={(event) => setAudioDuration(event.currentTarget.duration || 0)}
                    onTimeUpdate={(event) => setAudioCurrentTime(event.currentTarget.currentTime)}
                    onPlay={() => setIsAudioPlaying(true)}
                    onPause={() => setIsAudioPlaying(false)}
                    onEnded={() => {
                      setIsAudioPlaying(false);
                      setAudioCurrentTime(0);
                    }}
                    className="hidden"
                  />
                </div>
              </div>
            )}

            {isProcessing && (
              <div className="bg-card rounded-lg shadow-card p-4 flex items-center gap-3">
                <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin shrink-0" />
                <p className="text-sm text-foreground">Running emergency transcription and routing...</p>
              </div>
            )}

            {result && (
              <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.78fr)] gap-6 items-start">
                <div className="space-y-6">
                  <div className="rounded-lg border border-border bg-card shadow-card overflow-hidden">
                    <div className="bg-primary px-4 py-3 flex items-center justify-between">
                      <h3 className="text-base font-bold text-primary-foreground">Corrected Transcript</h3>
                      <div className="flex items-center gap-2">
                        {isTranscriptAnimating && (
                          <Badge variant="outline" className="border-primary-foreground/25 text-xs text-primary-foreground">
                            Live reveal
                          </Badge>
                        )}
                        <Badge variant="secondary" className="text-xs">{transcriptWordLabel}</Badge>
                      </div>
                    </div>
                    <div className="p-4 max-h-[520px] overflow-auto">
                      <div className="space-y-3">
                        {isTranscriptAnimating && (
                          <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
                            Revealing transcript word by word
                          </p>
                        )}
                        <p className="text-sm leading-relaxed text-foreground">
                          {correctedText || "No corrected transcript text generated."}
                          {isTranscriptAnimating && (
                            <span className="ml-1 inline-block h-4 w-0.5 animate-pulse bg-accent align-[-2px]" />
                          )}
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-lg border border-border bg-card shadow-card overflow-hidden">
                    <div className="bg-primary px-4 py-3">
                      <h3 className="text-base font-bold text-primary-foreground">Routing Signals</h3>
                    </div>
                    <div className="p-4 space-y-2 text-sm">
                      <p className="text-muted-foreground">
                        <span className="font-medium text-foreground">Low/Medium confidence words:</span> {lowConfidenceCount}
                      </p>
                      <p className="text-muted-foreground">
                        <span className="font-medium text-foreground">Source clip:</span> {loadedSample?.sourceClipId ?? "Uploaded audio"}
                      </p>
                      <p className="text-muted-foreground">
                        <span className="font-medium text-foreground">Stress profile:</span> {loadedSample?.challenge ?? "User upload"}
                      </p>
                    </div>
                  </div>

                  <div className="rounded-lg border border-border bg-card shadow-card overflow-hidden">
                    <div className="bg-primary px-4 py-3">
                      <h3 className="text-base font-bold text-primary-foreground">Clinical Summary</h3>
                    </div>
                    <div className="p-4 space-y-4 text-sm">
                      {summaryHasContent(result.clinical_summary) ? (
                        <>
                          {result.clinical_summary.symptoms.length > 0 && (
                            <div>
                              <p className="font-medium text-foreground mb-1">Symptoms</p>
                              {result.clinical_summary.symptoms.map((symptom) => (
                                <p key={symptom} className="text-muted-foreground">- {symptom}</p>
                              ))}
                            </div>
                          )}
                          {result.clinical_summary.allergies.length > 0 && (
                            <div>
                              <p className="font-medium text-foreground mb-1">Allergies</p>
                              {result.clinical_summary.allergies.map((allergy) => (
                                <p key={allergy} className="text-muted-foreground">- {allergy}</p>
                              ))}
                            </div>
                          )}
                          {result.clinical_summary.follow_up_actions.length > 0 && (
                            <div>
                              <p className="font-medium text-foreground mb-1">Follow-up Actions</p>
                              {result.clinical_summary.follow_up_actions.map((action) => (
                                <p key={action} className="text-muted-foreground">- {action}</p>
                              ))}
                            </div>
                          )}
                        </>
                      ) : (
                        <p className="text-muted-foreground">No structured emergency summary data yet.</p>
                      )}
                    </div>
                  </div>
                </div>

                <div className="space-y-6 xl:sticky xl:top-24">
                  <div className="rounded-lg border border-border bg-card shadow-card overflow-hidden">
                    <div className="bg-primary px-4 py-3">
                      <h3 className="text-base font-bold text-primary-foreground">Latency Breakdown</h3>
                    </div>
                    <div className="p-4 space-y-4">
                      <div className="grid grid-cols-2 gap-3">
                        <div className="rounded-lg border border-border bg-secondary/60 px-3 py-3">
                          <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">Tiny LoRA STT</p>
                          <p className="mt-2 text-lg font-semibold text-foreground">{formatLatency(modelLatencyMs)}</p>
                        </div>
                        <div className="rounded-lg border border-border bg-secondary/60 px-3 py-3">
                          <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">Post-STT Routing</p>
                          <p className="mt-2 text-lg font-semibold text-foreground">{formatLatency(postProcessingLatencyMs)}</p>
                        </div>
                        <div className="rounded-lg border border-border bg-secondary/60 px-3 py-3">
                          <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">End to End</p>
                          <p className="mt-2 text-lg font-semibold text-foreground">
                            {formatLatency(result.pipeline_latency_ms.total)}
                          </p>
                        </div>
                        <div className="rounded-lg border border-border bg-secondary/60 px-3 py-3">
                          <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">Speed vs Audio</p>
                          <p className="mt-2 text-lg font-semibold text-foreground">{speedLabel ?? "Waiting for audio"}</p>
                        </div>
                      </div>

                      <div className="space-y-2">
                        {LATENCY_STAGES.map((item) => (
                          <div key={item.key} className="flex items-center justify-between gap-3 text-sm">
                            <div className="flex items-center gap-2">
                              <span className="h-2 w-2 rounded-full bg-accent" />
                              <span className="text-muted-foreground">{item.label}</span>
                            </div>
                            <span className="font-medium text-foreground">
                              {formatLatency(result.pipeline_latency_ms[item.key])}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {stage === "idle" && (
              <div className="rounded-lg border border-dashed border-border bg-card/70 px-6 py-16 text-center text-muted-foreground shadow-card">
                <AlertTriangle className="h-10 w-10 mx-auto mb-3 opacity-50" />
                <p className="text-sm">Select an emergency sample or upload audio to run emergency routing.</p>
              </div>
            )}
          </div>
        </div>
      </div>

      <Footer />
    </div>
  );
};

export default EmergencyPage;
