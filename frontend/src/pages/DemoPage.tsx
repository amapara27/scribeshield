import { useState, useCallback, useEffect, useRef } from "react";
import { Stethoscope, Pill, Syringe, AlertTriangle, Activity, CheckCircle, HelpCircle, Download, Play, Pause, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { transcribeAudio } from "@/services/api";
import type { TranscribeResponse, ProcessingStage, RawWord, CorrectedWord } from "@/types/api";

type DemoVariant = {
  id: string;
  variantId: "clear_call" | "ambient_noise" | "heavy_accent" | "clinical_handoff" | "medical_term_slip";
  label: string;
  description: string;
  wav: string;
};

type DemoSituation = {
  id: string;
  baseScriptId: string;
  label: string;
  description: string;
  icon: typeof Pill;
  category: "Standard" | "Adversarial";
  variants: DemoVariant[];
};

const makeVariants = (slug: string, situationId: string): DemoVariant[] => ([
  {
    id: `${situationId}_clear_call`,
    variantId: "clear_call",
    label: "Clear Call",
    description: "Low-noise baseline take with the same script.",
    wav: `/demo-audio/${slug}/clear-call.wav`,
  },
  {
    id: `${situationId}_ambient_noise`,
    variantId: "ambient_noise",
    label: "Ambient Crowd + TV",
    description: "Conversation, room tone, and TV or music in the background.",
    wav: `/demo-audio/${slug}/ambient-crowd-tv.wav`,
  },
  {
    id: `${situationId}_heavy_accent`,
    variantId: "heavy_accent",
    label: "Heavy Accent",
    description: "Same situation with a much stronger accent challenge.",
    wav: `/demo-audio/${slug}/heavy-accent.wav`,
  },
  {
    id: `${situationId}_clinical_handoff`,
    variantId: "clinical_handoff",
    label: "Clinical Handoff",
    description: "More compressed clinical delivery with ambient room sound.",
    wav: `/demo-audio/${slug}/clinical-handoff.wav`,
  },
  {
    id: `${situationId}_medical_term_slip`,
    variantId: "medical_term_slip",
    label: "Medical Term Challenge",
    description: "Extra medical-term stress take with stronger accent, ambiguity, or ambient pressure.",
    wav: `/demo-audio/${slug}/medical-term-slip.wav`,
  },
]);

/** Canonical situations are generated from backend/audio_gen/input/demo_cards_20260412.csv plus local demo extensions. */
const SITUATIONS: DemoSituation[] = [
  {
    id: "demo_20260412_medication_refill",
    baseScriptId: "medication_refill",
    label: "Medication Refill",
    description: "Patient calling to refill metformin and lisinopril prescriptions.",
    icon: Pill,
    category: "Standard",
    variants: makeVariants("medication-refill", "demo_20260412_medication_refill"),
  },
  {
    id: "demo_20260412_postop_followup",
    baseScriptId: "postop_followup",
    label: "Post-Op Follow-up",
    description: "Recovery check-in after knee replacement with timing confusion.",
    icon: Syringe,
    category: "Standard",
    variants: makeVariants("post-op-followup", "demo_20260412_postop_followup"),
  },
  {
    id: "demo_20260412_new_symptom_report",
    baseScriptId: "new_symptom_report",
    label: "New Symptom Report",
    description: "Patient describing new headaches and dizziness after a dose change.",
    icon: Stethoscope,
    category: "Standard",
    variants: makeVariants("new-symptom-report", "demo_20260412_new_symptom_report"),
  },
  {
    id: "demo_20260412_allergy_review",
    baseScriptId: "allergy_review",
    label: "Allergy Review",
    description: "Antibiotic allergy history review before a new prescription.",
    icon: AlertTriangle,
    category: "Standard",
    variants: makeVariants("allergy-review", "demo_20260412_allergy_review"),
  },
  {
    id: "demo_20260412_dose_timing_check",
    baseScriptId: "dose_timing_check",
    label: "Dose Timing Check",
    description: "Parent checking whether fever medicine doses were spaced safely.",
    icon: Stethoscope,
    category: "Standard",
    variants: makeVariants("dose-timing-check", "demo_20260412_dose_timing_check"),
  },
  {
    id: "demo_20260419_glp1_dose_escalation",
    baseScriptId: "glp1_dose_escalation",
    label: "GLP-1 Dose Escalation",
    description: "Dose increase call about semaglutide with side effects, brand-name confusion, and injection timing questions.",
    icon: Syringe,
    category: "Adversarial",
    variants: makeVariants("glp1-dose-escalation", "demo_20260419_glp1_dose_escalation"),
  },
  {
    id: "demo_20260412_rapid_med_list",
    baseScriptId: "rapid_med_list",
    label: "Rapid Med List",
    description: "Fast medication handoff with multiple names and dose details.",
    icon: Activity,
    category: "Adversarial",
    variants: makeVariants("rapid-med-list", "demo_20260412_rapid_med_list"),
  },
];

const ALL_DEMO_VARIANTS = SITUATIONS.flatMap((situation) =>
  situation.variants.map((variant) => ({
    ...variant,
    situationId: situation.id,
    situationLabel: situation.label,
    situationDescription: situation.description,
    category: situation.category,
  })),
);

const DEFAULT_WAVEFORM = [0.28, 0.42, 0.64, 0.84, 0.58, 0.34, 0.48, 0.7, 0.88, 0.56, 0.4, 0.62, 0.78, 0.52, 0.36, 0.66, 0.86, 0.6, 0.38, 0.5, 0.74, 0.9, 0.54, 0.3, 0.46, 0.68, 0.82, 0.57, 0.35, 0.49, 0.72, 0.87, 0.63, 0.41, 0.53, 0.76, 0.85, 0.59, 0.37, 0.44, 0.69, 0.81, 0.61, 0.33, 0.47, 0.71];

const formatTime = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) return "0:00";
  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

const formatLatencyCompact = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) return null;
  if (value < 1000) return `${Math.round(value)}ms total`;
  return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}s total`;
};

const generateFallbackWaveform = (seedText: string, bars = 46) => {
  let seed = 0;
  for (const char of seedText) seed = (seed * 31 + char.charCodeAt(0)) >>> 0;

  return Array.from({ length: bars }, (_, index) => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const base = 0.28 + ((seed % 1000) / 1000) * 0.55;
    const sway = Math.sin(index / 2.75) * 0.08;
    return Math.max(0.18, Math.min(0.96, base + sway));
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
      return Math.max(0.18, Math.min(0.96, average * 4.2 + 0.14));
    });

    const hasRealSignal = peaks.some((peak) => peak > 0.24);
    return hasRealSignal ? peaks : generateFallbackWaveform(seedText, bars);
  } catch {
    return generateFallbackWaveform(seedText, bars);
  } finally {
    await audioContext.close();
  }
};

type WorkspaceAudioSelection = {
  id: string;
  label: string;
  description: string;
  category: "Standard" | "Adversarial" | "Custom";
  src: string;
  sourceKind: "demo" | "upload";
};

type ClinicModelOption = "fine_tuned_telephony" | "lora" | "scribe_v2";

const STT_MODEL_LABELS: Record<ClinicModelOption, string> = {
  fine_tuned_telephony: "Whisper Fine-Tuned",
  lora: "Whisper LoRA",
  scribe_v2: "ScribeV2",
};

const CORE_MODEL_COMPARE_ORDER: ClinicModelOption[] = [
  "fine_tuned_telephony",
  "lora",
  "scribe_v2",
];

type ModelRunState = {
  status: "idle" | "pending" | "running" | "done" | "error";
  result?: TranscribeResponse;
  error?: string;
};

type CachedComparisonState = {
  comparisonRuns: Record<ClinicModelOption, ModelRunState>;
  activeComparisonTab: ClinicModelOption;
  errorMessage: string | null;
  stage: ProcessingStage;
};

type ComparisonRunSummary = CachedComparisonState & {
  hadSuccess: boolean;
};

const createEmptyModelRuns = (): Record<ClinicModelOption, ModelRunState> => ({
  fine_tuned_telephony: { status: "idle" },
  lora: { status: "idle" },
  scribe_v2: { status: "idle" },
});

const cloneModelRuns = (runs: Record<ClinicModelOption, ModelRunState>): Record<ClinicModelOption, ModelRunState> => ({
  fine_tuned_telephony: { ...runs.fine_tuned_telephony },
  lora: { ...runs.lora },
  scribe_v2: { ...runs.scribe_v2 },
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isTransientLoadError = (message: string) =>
  /load failed|failed to fetch|networkerror|network request failed/i.test(message);

const transcriptRevealDelayMs = (word: string) => {
  if (/[.!?]$/.test(word)) return 150;
  if (/[,;:]$/.test(word)) return 90;
  return 36;
};

const useTranscriptReveal = <T extends { word: string }>(
  words: T[] | undefined,
  loading: boolean,
  cacheKey?: string,
) => {
  const [revealedWordCount, setRevealedWordCount] = useState(0);
  const loadedKeysRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (loading || !words?.length) {
      setRevealedWordCount(0);
      return;
    }

    if (cacheKey && loadedKeysRef.current.has(cacheKey)) {
      setRevealedWordCount(words.length);
      return;
    }

    let cancelled = false;
    let timeoutId: number | null = null;

    const step = (nextCount: number) => {
      if (cancelled) return;
      setRevealedWordCount(nextCount);
      if (nextCount >= words.length) {
        if (cacheKey) loadedKeysRef.current.add(cacheKey);
        return;
      }

      const previousWord = words[nextCount - 1]?.word ?? "";
      timeoutId = window.setTimeout(() => step(nextCount + 1), transcriptRevealDelayMs(previousWord));
    };

    step(1);

    return () => {
      cancelled = true;
      if (timeoutId !== null) window.clearTimeout(timeoutId);
    };
  }, [cacheKey, loading, words]);

  return {
    revealedWordCount,
    visibleWords: words?.slice(0, revealedWordCount),
    isAnimating: !!words?.length && revealedWordCount < words.length,
  };
};

const DemoPage = () => {
  const [stage, setStage] = useState<ProcessingStage>("idle");
  const [comparisonRuns, setComparisonRuns] = useState<Record<ClinicModelOption, ModelRunState>>(() => createEmptyModelRuns());
  const [activeComparisonTab, setActiveComparisonTab] = useState<ClinicModelOption>("fine_tuned_telephony");
  const [selectedSituationId, setSelectedSituationId] = useState<string>(SITUATIONS[0].id);
  const [activeScenario, setActiveScenario] = useState<string | null>(null);
  const [uploadedSelection, setUploadedSelection] = useState<WorkspaceAudioSelection | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [audioCurrentTime, setAudioCurrentTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [isAudioPlaying, setIsAudioPlaying] = useState(false);
  const [waveformPeaks, setWaveformPeaks] = useState<number[]>(DEFAULT_WAVEFORM);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const waveformLoadIdRef = useRef(0);
  const cachedScenarioRunsRef = useRef<Record<string, CachedComparisonState>>({});
  const cachedWaveformPeaksRef = useRef<Record<string, number[]>>({});

  const resetWorkspaceState = useCallback(() => {
    setErrorMessage(null);
    setComparisonRuns(createEmptyModelRuns());
    setActiveComparisonTab("fine_tuned_telephony");
    setStage("uploading");
    setAudioCurrentTime(0);
    setAudioDuration(0);
    setIsAudioPlaying(false);
  }, []);

  const runComparison = useCallback(async (file: File): Promise<ComparisonRunSummary> => {
    const nextRuns: Record<ClinicModelOption, ModelRunState> = {
      fine_tuned_telephony: { status: "pending" },
      lora: { status: "pending" },
      scribe_v2: { status: "pending" },
    };
    setComparisonRuns(cloneModelRuns(nextRuns));

    const runSingleModel = async (model: ClinicModelOption) => {
      nextRuns[model] = { status: "running" };
      setComparisonRuns((prev) => ({
        ...prev,
        [model]: { status: "running" },
      }));

      try {
        const data = await transcribeAudio(file, model);
        nextRuns[model] = { status: "done", result: data };
        setComparisonRuns((prev) => ({
          ...prev,
          [model]: { status: "done", result: data },
        }));
        return { model, success: true as const };
      } catch (e) {
        let message = e instanceof Error ? e.message : "Transcription failed";
        // Retry once for transient browser/network fetch failures.
        if (isTransientLoadError(message)) {
          await sleep(500);
          try {
            const data = await transcribeAudio(file, model);
            nextRuns[model] = { status: "done", result: data };
            setComparisonRuns((prev) => ({
              ...prev,
              [model]: { status: "done", result: data },
            }));
            return { model, success: true as const };
          } catch (retryError) {
            message = retryError instanceof Error ? retryError.message : message;
          }
        }

        nextRuns[model] = { status: "error", error: message };
        setComparisonRuns((prev) => ({
          ...prev,
          [model]: { status: "error", error: message },
        }));
        return { model, success: false as const, message };
      }
    };

    const outcomes: Array<
      | { model: ClinicModelOption; success: true }
      | { model: ClinicModelOption; success: false; message: string }
    > = [];
    // Start all Clinic models together so Fine-Tuned Whisper and LoRA
    // can warm up side-by-side again now that the backend crash path is removed.
    outcomes.push(
      ...(await Promise.all([
        runSingleModel("fine_tuned_telephony"),
        runSingleModel("lora"),
        runSingleModel("scribe_v2"),
      ])),
    );

    const firstSuccessfulModel = CORE_MODEL_COMPARE_ORDER.find((model) =>
      outcomes.some((outcome) => outcome.model === model && outcome.success),
    );
    const failures = outcomes
      .filter((outcome) => !outcome.success)
      .map((outcome) => `${STT_MODEL_LABELS[outcome.model]}: ${outcome.message}`);
    const finalRuns = cloneModelRuns(nextRuns);

    if (firstSuccessfulModel) {
      const nextErrorMessage = failures.length > 0 ? failures.join(" | ") : null;
      setActiveComparisonTab(firstSuccessfulModel);
      setStage("done");
      setErrorMessage(nextErrorMessage);
      return {
        comparisonRuns: finalRuns,
        activeComparisonTab: firstSuccessfulModel,
        errorMessage: nextErrorMessage,
        stage: "done",
        hadSuccess: true,
      };
    }

    const nextErrorMessage = failures.join(" | ") || "Transcription failed";
    setStage("error");
    setErrorMessage(nextErrorMessage);
    return {
      comparisonRuns: finalRuns,
      activeComparisonTab: "fine_tuned_telephony",
      errorMessage: nextErrorMessage,
      stage: "error",
      hadSuccess: false,
    };
  }, []);

  const runUploadedFile = useCallback(async (
    file: File,
    selection: WorkspaceAudioSelection,
  ) => {
    resetWorkspaceState();
    setActiveScenario(null);
    setUploadedSelection(selection);
    setWaveformPeaks(generateFallbackWaveform(selection.id));

    try {
      const loadId = ++waveformLoadIdRef.current;
      void extractWaveformPeaks(file, selection.id).then((peaks) => {
        if (waveformLoadIdRef.current === loadId) setWaveformPeaks(peaks);
      });

      await runComparison(file);
    } catch (e) {
      setStage("error");
      setErrorMessage(e instanceof Error ? e.message : "Transcription failed");
    }
  }, [resetWorkspaceState, runComparison]);

  const runScenario = useCallback(async (
    situation: DemoSituation,
    variant: DemoVariant,
  ) => {
    const cached = cachedScenarioRunsRef.current[variant.id];
    if (cached) {
      setUploadedSelection(null);
      setSelectedSituationId(situation.id);
      setActiveScenario(variant.id);
      setComparisonRuns(cloneModelRuns(cached.comparisonRuns));
      setActiveComparisonTab(cached.activeComparisonTab);
      setStage(cached.stage);
      setErrorMessage(cached.errorMessage);
      setWaveformPeaks(cachedWaveformPeaksRef.current[variant.id] ?? generateFallbackWaveform(variant.id));
      return;
    }

    resetWorkspaceState();
    setUploadedSelection(null);
    setSelectedSituationId(situation.id);
    setActiveScenario(variant.id);
    setWaveformPeaks(generateFallbackWaveform(variant.id));

    try {
      const res = await fetch(variant.wav);
      if (!res.ok) {
        throw new Error(`Missing demo clip at ${variant.wav} - add this file under frontend/public/demo-audio/`);
      }
      const blob = await res.blob();
      const loadId = ++waveformLoadIdRef.current;
      void extractWaveformPeaks(blob, variant.id).then((peaks) => {
        cachedWaveformPeaksRef.current[variant.id] = peaks;
        if (waveformLoadIdRef.current === loadId) setWaveformPeaks(peaks);
      });
      const file = new File([blob], `${variant.id}.wav`, { type: blob.type || "audio/wav" });
      const summary = await runComparison(file);
      if (summary.hadSuccess) {
        cachedScenarioRunsRef.current[variant.id] = {
          comparisonRuns: cloneModelRuns(summary.comparisonRuns),
          activeComparisonTab: summary.activeComparisonTab,
          errorMessage: summary.errorMessage,
          stage: summary.stage,
        };
      }
    } catch (e) {
      setStage("error");
      setErrorMessage(e instanceof Error ? e.message : "Transcription failed");
    }
  }, [resetWorkspaceState, runComparison]);

  const isProcessing = stage === "uploading";
  const anyComparisonResult = CORE_MODEL_COMPARE_ORDER.some((model) => comparisonRuns[model].status !== "idle");
  const activeRun = comparisonRuns[activeComparisonTab];
  const activeResult = activeRun.result;
  const activeRunLoading = activeRun.status === "running" || (activeRun.status === "idle" && isProcessing);
  const selectedSituation =
    SITUATIONS.find((situation) => situation.id === selectedSituationId) ?? SITUATIONS[0];
  const activeScenarioDetails =
    ALL_DEMO_VARIANTS.find((scenario) => scenario.id === activeScenario) ?? null;
  const activeSelection: WorkspaceAudioSelection | null = uploadedSelection ?? (
    activeScenarioDetails
      ? {
          id: activeScenarioDetails.id,
          label: `${activeScenarioDetails.situationLabel} — ${activeScenarioDetails.label}`,
          description: activeScenarioDetails.description,
          category: activeScenarioDetails.category,
          src: activeScenarioDetails.wav,
          sourceKind: "demo",
        }
      : null
  );
  const progressRatio = audioDuration > 0 ? Math.min(audioCurrentTime / audioDuration, 1) : 0;

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    audio.pause();
    audio.currentTime = 0;
    setAudioCurrentTime(0);
    setAudioDuration(0);
    setIsAudioPlaying(false);
  }, [activeSelection?.src]);

  useEffect(() => {
    return () => {
      if (uploadedSelection?.sourceKind === "upload") {
        URL.revokeObjectURL(uploadedSelection.src);
      }
    };
  }, [uploadedSelection]);

  useEffect(() => {
    if (!activeScenario) return;
    const cached = cachedScenarioRunsRef.current[activeScenario];
    if (!cached) return;
    cached.activeComparisonTab = activeComparisonTab;
  }, [activeComparisonTab, activeScenario]);

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

    if (uploadedSelection?.sourceKind === "upload") {
      URL.revokeObjectURL(uploadedSelection.src);
    }

    const objectUrl = URL.createObjectURL(file);
    const selection: WorkspaceAudioSelection = {
      id: `upload_${Date.now()}`,
      label: file.name.replace(/\.[^.]+$/, ""),
      description: "User-uploaded audio clip for live transcript and clinical summary review.",
      category: "Custom",
      src: objectUrl,
      sourceKind: "upload",
    };

    await runUploadedFile(file, selection);
  }, [runUploadedFile, uploadedSelection]);

  return (
    <div className="min-h-screen bg-secondary">
      <Navbar />

      <div className="bg-primary text-primary-foreground pt-20">
        <div className="container mx-auto px-6 max-w-[1400px] py-4">
          <h1 className="text-lg font-semibold text-primary-foreground">Clinic Demo</h1>
          <p className="text-sm text-primary-foreground/60 mt-1">
            Seven situations each load five generated takes from <code className="text-xs opacity-90">public/demo-audio/</code>, and you can also upload
            your own <code className="text-xs opacity-90 ml-1">mp3</code> or <code className="text-xs opacity-90">wav</code> for{" "}
            <code className="text-xs opacity-90">POST /transcribe</code>
          </p>
        </div>
      </div>

      <div className="container mx-auto px-6 max-w-[1440px] py-8">
        <div className="grid grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)] xl:grid-cols-[320px_minmax(0,1fr)] gap-6 items-start">
          <aside className="lg:sticky lg:top-24">
            <div className="rounded-lg border border-border bg-card shadow-card overflow-hidden">
              <div className="border-b border-border px-4 py-4">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Clinic Options</p>
                <h2 className="mt-2 text-lg font-semibold text-foreground">Situation Library</h2>
                <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                  Keep the situations handy here, then pick the accent or noise take you want to run.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  className="mt-4 w-full justify-center gap-2 rounded-pill"
                  onClick={handleUploadClick}
                  disabled={isProcessing}
                >
                  <Upload className="h-4 w-4" />
                  Upload Audio
                </Button>
                <p className="mt-2 text-xs text-muted-foreground">Supports `.mp3` and `.wav` files.</p>
                <div className="mt-4 rounded-lg border border-border bg-secondary/60 px-3 py-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Model Comparison</p>
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                    Each run executes <span className="font-medium text-foreground">Whisper Fine-Tuned</span>,{" "}
                    <span className="font-medium text-foreground">Whisper LoRA</span>,{" "}
                    and <span className="font-medium text-foreground">ScribeV2</span> for clinic scenarios.
                  </p>
                </div>
                <input
                  ref={uploadInputRef}
                  type="file"
                  accept=".mp3,.wav,audio/mpeg,audio/wav"
                  className="hidden"
                  onChange={(event) => void handleFileSelected(event)}
                />
              </div>

              <div className="p-3 space-y-4">
                <div className="space-y-2">
                  <label htmlFor="situation-select" className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    Situation
                  </label>
                  <select
                    id="situation-select"
                    value={selectedSituationId}
                    onChange={(event) => setSelectedSituationId(event.target.value)}
                    disabled={isProcessing}
                    className="w-full rounded-lg border border-border bg-background px-3 py-3 text-sm text-foreground shadow-sm outline-none transition focus:border-accent disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {SITUATIONS.map((situation) => (
                      <option key={situation.id} value={situation.id}>
                        {situation.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="rounded-lg border border-border bg-secondary/50 p-4">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-semibold text-foreground">{selectedSituation.label}</p>
                    {selectedSituation.category === "Adversarial" && (
                      <Badge className="text-[10px] bg-signal-red/10 text-signal-red border-0">Adversarial</Badge>
                    )}
                    <Badge variant="secondary" className="text-[10px]">{selectedSituation.variants.length} takes</Badge>
                  </div>
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{selectedSituation.description}</p>
                </div>

                <div className="space-y-2">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Available Takes</p>
                  <div className="grid grid-cols-1 gap-2">
                    {selectedSituation.variants.map((variant) => {
                      const isActive = activeScenario === variant.id;
                      return (
                        <button
                          key={variant.id}
                          type="button"
                          onClick={() => !isProcessing && void runScenario(selectedSituation, variant)}
                          disabled={isProcessing}
                          className={`rounded-lg border px-3 py-3 text-left transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
                            isActive
                              ? "border-accent bg-accent/10 shadow-card"
                              : "border-border bg-card hover:border-accent/40"
                          }`}
                          >
                          <div className="flex items-center justify-between gap-3">
                            <span className="text-sm font-medium text-foreground">{variant.label}</span>
                            <Badge variant="secondary" className="text-[10px]">{variant.variantId.replace(/_/g, " ")}</Badge>
                          </div>
                          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{variant.description}</p>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          </aside>

          <div className="min-w-0 space-y-6">
            {errorMessage && (
              <div className="rounded-lg border border-signal-red/40 bg-signal-red/10 px-4 py-3 text-sm text-signal-red">
                {errorMessage}
              </div>
            )}

            <div className="rounded-lg border border-border bg-card shadow-card p-5">
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Transcript Workspace</p>
                  <h2 className="mt-2 text-2xl font-semibold text-foreground">
                    {activeSelection ? activeSelection.label : "Run a demo or upload audio to review the transcript"}
                  </h2>
                  <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">
                    {activeSelection
                      ? activeSelection.description
                      : "Select a situation and take from the left rail or upload your own audio to inspect the raw transcript, corrected transcript, and clinical summary output."}
                  </p>
                </div>
                {activeSelection && (
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary" className="rounded-pill">
                      {activeSelection.category}
                    </Badge>
                    <Badge variant="outline" className="rounded-pill">
                      {CORE_MODEL_COMPARE_ORDER.length}-model comparison
                    </Badge>
                    <Badge variant="outline" className="rounded-pill">
                      {stage === "done" ? "Loaded" : isProcessing ? "Running" : "Ready"}
                    </Badge>
                  </div>
                )}
              </div>
            </div>

            {activeSelection && (
              <div className="rounded-lg border border-border bg-primary text-primary-foreground shadow-card overflow-hidden">
                <div className="flex flex-col gap-5 p-5">
                  <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary-foreground/60">Loaded Audio</p>
                      <h3 className="mt-2 text-xl font-semibold">{activeSelection.label}</h3>
                      <p className="mt-1 text-sm text-primary-foreground/70">
                        Listen to the selected demo clip while reviewing the transcript and clinical summary.
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="secondary"
                      className="rounded-pill gap-2 self-start md:self-auto"
                      onClick={() => void togglePlayback()}
                    >
                      {isAudioPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                      {isAudioPlaying ? "Pause Audio" : "Play Audio"}
                    </Button>
                  </div>

                  <div className="rounded-lg bg-black/20 px-4 py-5">
                    <div className="flex h-28 items-end gap-1 overflow-hidden">
                      {waveformPeaks.map((peak, index) => {
                        const isPlayed = index / waveformPeaks.length <= progressRatio;
                        return (
                          <div
                            key={`${activeSelection.id}-${index}`}
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
                    src={activeSelection.src}
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

            {anyComparisonResult && (
              <div className="rounded-lg border border-border bg-card shadow-card p-3">
                <div className="flex flex-wrap gap-2">
                  {CORE_MODEL_COMPARE_ORDER.map((model) => {
                    const run = comparisonRuns[model];
                    const isActive = activeComparisonTab === model;
                    const latencyLabel = run.result
                      ? formatLatencyCompact(run.result.pipeline_latency_ms.total)
                      : null;
                    const statusLabel =
                      run.status === "done"
                        ? "Loaded"
                        : run.status === "running"
                          ? "Running"
                          : run.status === "error"
                            ? "Error"
                            : "Pending";

                    return (
                      <button
                        key={model}
                        type="button"
                        onClick={() => setActiveComparisonTab(model)}
                        disabled={run.status === "idle"}
                        className={`rounded-lg border px-3 py-2 text-left transition disabled:cursor-not-allowed disabled:opacity-50 ${
                          isActive
                            ? "border-accent bg-accent/10 shadow-card"
                            : "border-border bg-background hover:border-accent/40"
                        }`}
                      >
                        <p className="text-sm font-medium text-foreground">{STT_MODEL_LABELS[model]}</p>
                        <p className="text-[11px] text-muted-foreground">{statusLabel}</p>
                        {latencyLabel && <p className="text-[11px] text-foreground/80">{latencyLabel}</p>}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {stage === "uploading" && (
              <div className="bg-card rounded-lg shadow-card p-4 flex items-center gap-3">
                <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin shrink-0" />
                <p className="text-sm text-foreground">
                  Running all models on the server...
                </p>
              </div>
            )}

            {activeRun.status === "error" && activeRun.error && (
              <div className="rounded-lg border border-signal-red/40 bg-signal-red/10 px-4 py-3 text-sm text-signal-red">
                {STT_MODEL_LABELS[activeComparisonTab]} failed: {activeRun.error}
              </div>
            )}

            {(isProcessing || anyComparisonResult) && (
              <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(340px,0.95fr)] gap-6 items-start">
                <TranscriptPanel
                  title="Raw Transcript"
                  loading={activeRunLoading}
                  words={activeResult?.raw_transcript}
                  cacheKey={activeSelection ? `${activeSelection.id}:${activeComparisonTab}:raw` : undefined}
                />
                <CorrectedPanel
                  title="Corrected Transcript"
                  loading={activeRunLoading}
                  words={activeResult?.corrected_transcript}
                  latency={activeResult?.pipeline_latency_ms}
                  sttLabel={STT_MODEL_LABELS[activeComparisonTab]}
                  cacheKey={activeSelection ? `${activeSelection.id}:${activeComparisonTab}:corrected` : undefined}
                />
                <SummaryPanel
                  className="xl:sticky xl:top-24"
                  loading={activeRunLoading}
                  summary={activeResult?.clinical_summary}
                />
              </div>
            )}

            {stage === "idle" && (
              <div className="rounded-lg border border-dashed border-border bg-card/70 px-6 py-16 text-center text-muted-foreground shadow-card">
                <Stethoscope className="h-10 w-10 mx-auto mb-3 opacity-40" />
                <p className="text-sm">Pick a situation, choose one of its takes, or upload your own clip to populate the transcript workspace.</p>
              </div>
            )}
          </div>
        </div>
      </div>

      <Footer />
    </div>
  );
};

/* Sub-components */

const TranscriptPanel = ({ title, loading, words, cacheKey }: {
  title: string;
  loading: boolean;
  words?: RawWord[];
  cacheKey?: string;
}) => {
  const { visibleWords, isAnimating, revealedWordCount } = useTranscriptReveal(words, loading, cacheKey);
  const wordLabel = words
    ? isAnimating
      ? `${revealedWordCount}/${words.length} words`
      : `${words.length} words`
    : "0 words";

  return (
    <div className="bg-card rounded-lg shadow-card overflow-hidden min-h-[440px]">
      <div className="bg-primary px-4 py-3 flex items-center justify-between">
        <h3 className="text-base font-bold text-primary-foreground">{title}</h3>
        {words && (
          <div className="flex items-center gap-2">
            {isAnimating && (
              <Badge variant="outline" className="border-primary-foreground/25 text-xs text-primary-foreground">
                Live reveal
              </Badge>
            )}
            <Badge variant="secondary" className="text-xs">{wordLabel}</Badge>
          </div>
        )}
      </div>
      <div className="p-4 max-h-[520px] overflow-auto">
        {loading ? (
          <div className="space-y-3">
            {[...Array(6)].map((_, i) => <div key={i} className="skeleton h-4 w-full" />)}
          </div>
        ) : words ? (
          <div className="space-y-3">
            {isAnimating && (
              <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
                Revealing transcript word by word
              </p>
            )}
            <div className="leading-relaxed">
              {visibleWords?.map((w, i) => {
                const isSpeakerLabel = w.word === "Doctor:" || w.word === "Patient:";
                if (isSpeakerLabel) {
                  return (
                    <span key={i}>
                      {i > 0 && <br />}
                      <Badge className={`mr-2 mt-2 text-xs ${w.speaker === "Doctor" ? "bg-primary/20 text-primary" : "bg-success/20 text-success"}`}>
                        {w.speaker === "Doctor" ? "Dr." : "Patient"}
                      </Badge>
                    </span>
                  );
                }

                let wordCls = "text-sm text-foreground";
                if (w.confidence === "LOW") wordCls = "text-sm bg-signal-red/20 text-signal-red rounded px-0.5 font-medium";
                else if (w.confidence === "MEDIUM") wordCls = "text-sm bg-warning/20 text-warning rounded px-0.5";

                return (
                  <Tooltip key={i}>
                    <TooltipTrigger asChild>
                      <span className={`${wordCls} cursor-default`}>
                        {w.word}{" "}
                      </span>
                    </TooltipTrigger>
                    {w.confidence !== "HIGH" && w.uncertainty_signals && (
                      <TooltipContent>
                        <p className="text-xs font-semibold mb-1">{w.confidence} confidence</p>
                        {w.uncertainty_signals.map((s, si) => (
                          <p key={si} className="text-xs text-muted-foreground">• {s}</p>
                        ))}
                      </TooltipContent>
                    )}
                  </Tooltip>
                );
              })}
              {isAnimating && (
                <span className="ml-1 inline-block h-4 w-0.5 animate-pulse bg-accent align-[-2px]" />
              )}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
};

const CorrectedPanel = ({ title, loading, words, latency, sttLabel = "STT", cacheKey }: {
  title: string; loading: boolean; words?: CorrectedWord[];
  latency?: TranscribeResponse["pipeline_latency_ms"];
  sttLabel?: string;
  cacheKey?: string;
}) => {
  const { visibleWords, isAnimating, revealedWordCount } = useTranscriptReveal(words, loading, cacheKey);
  const changedCount = words?.filter((word) => word.changed).length ?? 0;
  const unresolvedCount = words?.filter((word) => word.unverified).length ?? 0;
  const tavilyVerifiedCount = words?.filter((word) => word.tavily_verified).length ?? 0;
  const tavilyRan = (latency?.tavily ?? 0) > 0;
  const fmtMs = (value: number) => (value <= 0 ? "<1" : String(value));
  const wordLabel = words
    ? isAnimating
      ? `${revealedWordCount}/${words.length} words`
      : `${words.length} words`
    : "0 words";

  return (
    <div className="bg-card rounded-lg shadow-card overflow-hidden min-h-[440px]">
      <div className="bg-primary px-4 py-3 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-bold text-primary-foreground">{title}</h3>
          {latency && (
            <p className="text-xs text-primary-foreground/60 mt-1">
              {sttLabel} {fmtMs(latency.scribe)}ms + Tavily {fmtMs(latency.tavily)}ms + Claude {fmtMs(latency.claude)}ms = {fmtMs(latency.total)}ms
            </p>
          )}
        </div>
        {words && (
          <div className="flex shrink-0 items-center gap-2">
            {isAnimating && (
              <Badge variant="outline" className="border-primary-foreground/25 text-xs text-primary-foreground">
                Live reveal
              </Badge>
            )}
            <Badge variant="secondary" className="text-xs">{wordLabel}</Badge>
            <Badge variant="secondary" className="text-xs">{changedCount} changes</Badge>
            {unresolvedCount > 0 && <Badge variant="outline" className="border-primary-foreground/30 text-xs text-primary-foreground">{unresolvedCount} unresolved</Badge>}
          </div>
        )}
      </div>
      <div className="p-4 max-h-[520px] overflow-auto">
        {loading ? (
          <div className="space-y-3">
            {[...Array(6)].map((_, i) => <div key={i} className="skeleton h-4 w-full" />)}
          </div>
        ) : words ? (
          <div className="space-y-3">
            {changedCount === 0 && (
              <div className="rounded-lg border border-border bg-secondary/60 px-3 py-2 text-xs text-muted-foreground">
                {tavilyVerifiedCount > 0
                  ? "Tavily verified terms, but no word-level correction was needed for this clip."
                  : tavilyRan
                    ? "Tavily ran, but no safe word-level correction was needed for this clip."
                    : "No eligible medical terms were sent to Tavily for this clip."}
              </div>
            )}
            {isAnimating && (
              <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
                Revealing transcript word by word
              </p>
            )}
            <div className="leading-relaxed">
              {visibleWords?.map((w, i) => {
                const isSpeakerLabel = w.word === "Doctor:" || w.word === "Patient:";
                if (isSpeakerLabel) {
                  return (
                    <span key={i}>
                      {i > 0 && <br />}
                      <Badge className={`mr-2 mt-2 text-xs ${w.speaker === "Doctor" ? "bg-primary/20 text-primary" : "bg-success/20 text-success"}`}>
                        {w.speaker === "Doctor" ? "Dr." : "Patient"}
                      </Badge>
                    </span>
                  );
                }
                let cls = "text-sm text-foreground";
                if (w.changed && w.tavily_verified) cls = "text-sm bg-accent/15 text-accent underline decoration-accent rounded px-0.5 font-medium";
                else if (w.changed) cls = "text-sm bg-warning/15 text-warning rounded px-0.5";
                else if (w.unverified) cls = "text-sm text-muted-foreground border-b border-dashed border-muted-foreground";

                return (
                  <span key={i} className={cls}>
                    {w.word}
                    {w.unverified && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="inline-flex align-middle">
                            <HelpCircle className="inline h-3 w-3 ml-0.5 text-muted-foreground" />
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p className="text-xs">Kept unchanged because the backend could not verify a safe correction.</p>
                        </TooltipContent>
                      </Tooltip>
                    )}
                    {" "}
                  </span>
                );
              })}
              {isAnimating && (
                <span className="ml-1 inline-block h-4 w-0.5 animate-pulse bg-accent align-[-2px]" />
              )}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
};

const SummaryPanel = ({ loading, summary, className = "" }: {
  loading: boolean;
  summary?: TranscribeResponse["clinical_summary"];
  className?: string;
}) => (
  <div className={`bg-card rounded-lg shadow-card overflow-hidden min-h-[440px] ${className}`}>
    <div className="bg-primary px-4 py-3 flex items-center justify-between">
      <h3 className="text-base font-bold text-primary-foreground">Clinical Summary</h3>
      {summary && <Badge className="bg-success text-success-foreground text-xs rounded-pill">EHR-Ready</Badge>}
    </div>
    <div className="p-4 max-h-[520px] overflow-auto">
      {loading ? (
        <div className="space-y-3">
          {[...Array(5)].map((_, i) => <div key={i} className="skeleton h-4 w-full" />)}
        </div>
      ) : summary ? (
        <div className="space-y-4">
          {summary.appointment_needed && (
            <div className="bg-warning/10 border border-warning/30 rounded-lg p-3 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-warning shrink-0" />
              <p className="text-sm font-medium text-warning">Follow-up appointment recommended</p>
            </div>
          )}

          <div>
            <h4 className="text-xs font-bold uppercase text-muted-foreground mb-2">Medications</h4>
            <div className="space-y-2">
              {summary.medications.map((med, i) => {
                const metadata = [med.dosage, med.frequency, med.route].filter((value) => {
                  const normalized = value.trim().toLowerCase();
                  return normalized.length > 0 && normalized !== "unknown";
                });

                return (
                  <div key={i} className="bg-secondary rounded-lg p-3">
                    <div className="flex items-center justify-between">
                      <p className="font-semibold text-sm text-foreground">{med.name}</p>
                      {med.tavily_verified
                        ? <CheckCircle className="h-4 w-4 text-success" />
                        : <HelpCircle className="h-4 w-4 text-muted-foreground" />}
                    </div>
                    {metadata.length > 0 && (
                      <p className="text-xs text-muted-foreground mt-1">
                        {metadata.join(" · ")}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {summary.symptoms.length > 0 && (
            <div>
              <h4 className="text-xs font-bold uppercase text-muted-foreground mb-2">Symptoms</h4>
              <div className="flex flex-wrap gap-2">
                {summary.symptoms.map((s, i) => (
                  <Badge key={i} variant="secondary" className="rounded-pill">{s}</Badge>
                ))}
              </div>
            </div>
          )}

          {summary.follow_up_actions.length > 0 && (
            <div>
              <h4 className="text-xs font-bold uppercase text-muted-foreground mb-2">Follow-up Actions</h4>
              <ul className="space-y-1">
                {summary.follow_up_actions.map((a, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-foreground">
                    <input type="checkbox" className="mt-1 rounded border-border" readOnly />
                    {a}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <Button variant="outline" className="w-full rounded-pill text-sm gap-2"
            onClick={() => {
              const blob = new Blob([JSON.stringify(summary, null, 2)], { type: "application/json" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url; a.download = "clinical_summary.json"; a.click();
              URL.revokeObjectURL(url);
            }}>
            <Download className="h-4 w-4" /> Export JSON
          </Button>
        </div>
      ) : null}
    </div>
  </div>
);

export default DemoPage;
