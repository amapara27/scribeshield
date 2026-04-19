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
  label: string;
  description: string;
  severity: "Critical" | "Urgent";
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

const EMERGENCY_SAMPLES: EmergencySample[] = [
  {
    id: "chest_pain_call",
    label: "Chest Pain Escalation",
    description: "Caller reports chest pressure, dizziness, and worsening shortness of breath.",
    severity: "Critical",
    wav: "/emergency-audio/chest-pain-escalation.wav",
  },
  {
    id: "anaphylaxis_reaction",
    label: "Possible Anaphylaxis",
    description: "Rash progression with lip swelling and trouble breathing after a medication dose.",
    severity: "Critical",
    wav: "/emergency-audio/anaphylaxis-reaction.wav",
  },
  {
    id: "severe_fever_child",
    label: "Pediatric Fever Concern",
    description: "High fever in child with lethargy and reduced intake; parent requests triage guidance.",
    severity: "Urgent",
    wav: "/emergency-audio/pediatric-fever-concern.wav",
  },
];

const DEFAULT_WAVEFORM = [0.34, 0.48, 0.67, 0.83, 0.56, 0.42, 0.51, 0.72, 0.91, 0.61, 0.4, 0.63, 0.79, 0.58, 0.36, 0.66, 0.84, 0.59, 0.41, 0.54, 0.76, 0.89, 0.57, 0.38, 0.49, 0.71, 0.82, 0.6, 0.35, 0.53, 0.75, 0.88, 0.62, 0.43, 0.5, 0.73, 0.86, 0.61, 0.39, 0.52, 0.7, 0.8, 0.6, 0.42, 0.47, 0.69];

const formatTime = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) return "0:00";
  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

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

  const fileRef = useRef<File | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const waveformLoadIdRef = useRef(0);

  const isProcessing = stage === "uploading";
  const routingDecision = useMemo(() => buildRoutingDecision(result), [result]);
  const lowConfidenceCount = result?.raw_transcript.filter((word) => word.confidence !== "HIGH").length ?? 0;
  const correctedText = result?.corrected_transcript.map((word) => word.word).join(" ").trim() ?? "";

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

  const runEmergencyTranscription = useCallback(async (file: File, nextSelection: AudioSelection) => {
    setStage("uploading");
    setErrorMessage(null);
    setSelection(nextSelection);
    fileRef.current = file;

    const loadId = ++waveformLoadIdRef.current;
    void extractWaveformPeaks(file, nextSelection.id).then((peaks) => {
      if (waveformLoadIdRef.current === loadId) setWaveformPeaks(peaks);
    });

    try {
      const payload = await transcribeAudio(file, "emergency_lora");
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
              <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)] gap-6 items-start">
                <div className="rounded-lg border border-border bg-card shadow-card overflow-hidden">
                  <div className="bg-primary px-4 py-3 flex items-center justify-between">
                    <h3 className="text-base font-bold text-primary-foreground">Corrected Transcript</h3>
                    <Badge variant="secondary" className="text-xs">{result.corrected_transcript.length} tokens</Badge>
                  </div>
                  <div className="p-4 max-h-[520px] overflow-auto">
                    <p className="text-sm leading-relaxed text-foreground">
                      {correctedText || "No corrected transcript text generated."}
                    </p>
                  </div>
                </div>

                <div className="space-y-6">
                  <div className="rounded-lg border border-border bg-card shadow-card overflow-hidden">
                    <div className="bg-primary px-4 py-3">
                      <h3 className="text-base font-bold text-primary-foreground">Routing Signals</h3>
                    </div>
                    <div className="p-4 space-y-2 text-sm">
                      <p className="text-muted-foreground">
                        <span className="font-medium text-foreground">Low/Medium confidence words:</span> {lowConfidenceCount}
                      </p>
                      <p className="text-muted-foreground">
                        <span className="font-medium text-foreground">Pipeline total latency:</span> {result.pipeline_latency_ms.total} ms
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
