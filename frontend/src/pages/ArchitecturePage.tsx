import {
  Activity,
  ArrowRight,
  BrainCircuit,
  CheckCircle2,
  Cpu,
  Database,
  FileSearch,
  LineChart,
  ShieldCheck,
  Sparkles,
  Stethoscope,
  Waves,
} from "lucide-react";
import { Link } from "react-router-dom";
import FadeInSection from "@/components/FadeInSection";
import Footer from "@/components/Footer";
import Navbar from "@/components/Navbar";
import { Button } from "@/components/ui/button";
import { useHomeBenchmarkData } from "@/hooks/use-home-benchmark";

const pipelineStages = [
  {
    title: "1. Preprocess audio",
    copy: "Telephony clips run through the ffmpeg cleanup chain before batch STT so the models see a more consistent waveform.",
  },
  {
    title: "2. Run an STT provider",
    copy: "The backend can call ElevenLabs Scribe v2 or a local Whisper-family model, depending on the route and runtime availability.",
  },
  {
    title: "3. Score uncertainty",
    copy: "Rule-based confidence signals run first, and XGBoost can optionally raise risk on words that look deceptively plausible.",
  },
  {
    title: "4. Verify risky medical terms",
    copy: "Only medical-shaped words that need review are sent to Tavily, with caps, caching, and deduplication.",
  },
  {
    title: "5. Correct conservatively",
    copy: "Claude gets verification evidence and is expected to correct only what is supported instead of polishing blindly.",
  },
  {
    title: "6. Extract structured output",
    copy: "The final summary is produced after correction so meds, symptoms, and actions stay grounded in the reviewed transcript.",
  },
];

const modelCards = [
  {
    icon: <Waves className="h-5 w-5" />,
    title: "ScribeV2",
    subtitle: "External ElevenLabs STT",
    copy: "This is the API-backed path. It gives the app a strong baseline plus word timestamps and speaker IDs, and it is also the fallback when local Whisper models are unavailable.",
    detail:
      "Good for turnkey transcription and comparison baselines. It is not the uncertainty model or the medical safety layer by itself.",
  },
  {
    icon: <Cpu className="h-5 w-5" />,
    title: "Whisper Fine-Tuned",
    subtitle: "Full local checkpoint",
    copy: "This is the local full fine-tuned telephony Whisper path, exposed in the UI as `fine_tuned_telephony` and normalized in the backend to `full_ft`.",
    detail:
      "It is a true local model runtime, not an API alias. It can be selected directly for demo runs and benchmark generation.",
  },
  {
    icon: <Sparkles className="h-5 w-5" />,
    title: "Whisper LoRA",
    subtitle: "Adapter-based local model",
    copy: "The LoRA path loads adapter weights on top of a base Whisper model through PEFT, then merges them for inference when supported.",
    detail:
      "This is useful when you want smaller fine-tuning artifacts or faster experimentation without shipping a whole new checkpoint.",
  },
  {
    icon: <Stethoscope className="h-5 w-5" />,
    title: "Emergency LoRA",
    subtitle: "Specialized emergency variant",
    copy: "This is a separate local adapter path intended for the emergency flow. It is benchmarked as its own model instead of being treated as just another UI mode.",
    detail:
      "It is useful as a separate benchmark row because its behavior can diverge from the clinic-oriented fine-tuned and LoRA variants.",
  },
];

const safetyCards = [
  {
    icon: <Activity className="h-5 w-5" />,
    title: "Rule-based uncertainty",
    copy: "Timing irregularity, phonetic distance, keyterm mismatch, and correction history combine into HIGH / MEDIUM / LOW review buckets.",
  },
  {
    icon: <BrainCircuit className="h-5 w-5" />,
    title: "XGBoost risk model",
    copy: "XGB is not the transcriber. It is a word-risk scorer that can raise suspicion on tokens that need human or verification attention.",
  },
  {
    icon: <FileSearch className="h-5 w-5" />,
    title: "Tavily verification",
    copy: "Tavily is used for validation, not text generation. It tries to confirm canonical medical terms before Claude is allowed to commit a risky correction.",
  },
  {
    icon: <ShieldCheck className="h-5 w-5" />,
    title: "Claude guardrail pass",
    copy: "Claude sits behind the verification layer and should be thought of as a constrained correction and extraction stage, not a free-form transcript rewriter.",
  },
];

const ArchitecturePage = () => {
  const { benchmark, dataSource, headlineMetrics, proofBadges } = useHomeBenchmarkData();

  const modelBenchmarks = [...(benchmark.model_benchmarks ?? [])].sort(
    (a, b) => a.avg_wer - b.avg_wer,
  );

  return (
    <div className="home-page min-h-screen">
      <Navbar />

      <section className="px-6 pt-32 pb-10 sm:px-8 lg:px-10">
        <div className="mx-auto grid w-full max-w-7xl gap-8 lg:grid-cols-[minmax(0,0.95fr)_minmax(320px,0.72fr)] lg:items-start">
          <FadeInSection>
            <p className="home-eyebrow text-[11px] font-semibold text-[hsl(var(--home-muted))]">
              Architecture
            </p>
            <h1 className="mt-5 max-w-4xl font-display text-5xl leading-[0.96] tracking-[-0.04em] text-[hsl(var(--home-ink))] sm:text-6xl">
              What the system is actually doing under the UI.
            </h1>
            <p className="mt-6 max-w-3xl text-base leading-7 text-[hsl(var(--home-muted))] sm:text-lg">
              This page is the technical companion to Home. It explains which
              parts are transcript models, which parts are risk scoring or
              verification layers, and where the headline metrics really come
              from.
            </p>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Button
                asChild
                size="lg"
                className="h-12 rounded-full bg-primary px-6 text-primary-foreground hover:bg-primary/90"
              >
                <Link to="/benchmark">
                  Open benchmark
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
              <Button
                asChild
                size="lg"
                variant="outline"
                className="h-12 rounded-full border-[hsl(var(--home-line))] bg-white/75 px-6 text-[hsl(var(--home-ink))] hover:bg-white"
              >
                <Link to="/clinic">See clinic demo</Link>
              </Button>
            </div>
          </FadeInSection>

          <FadeInSection className="home-panel-strong rounded-[32px] p-6" delay={80}>
            <div className="flex items-start gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[hsl(var(--home-mint))] text-[hsl(var(--home-ink))]">
                {dataSource === "live" ? (
                  <Database className="h-5 w-5" />
                ) : (
                  <LineChart className="h-5 w-5" />
                )}
              </div>
              <div>
                <p className="text-sm font-semibold text-[hsl(var(--home-ink))]">
                  Metric source status
                </p>
                <p className="mt-2 text-sm leading-6 text-[hsl(var(--home-muted))]">
                  {dataSource === "live"
                    ? "The frontend is currently reading the backend benchmark artifact."
                    : "The frontend is currently using the shipped benchmark snapshot fallback."}
                </p>
              </div>
            </div>

            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              {headlineMetrics.map((metric) => (
                <div key={metric.label} className="rounded-[24px] border border-[hsl(var(--home-line))] bg-white/80 p-4">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[hsl(var(--home-muted))]">
                    {metric.label}
                  </p>
                  <p className="mt-2 text-3xl font-semibold tracking-tight text-[hsl(var(--home-ink))]">
                    {metric.value}
                  </p>
                </div>
              ))}
            </div>

            <div className="home-rule mt-6 pt-5" />
            <p className="text-sm leading-6 text-[hsl(var(--home-muted))]">
              Important nuance: the benchmark endpoint serves a cached JSON
              artifact, not a fresh benchmark rerun on every page load. That
              makes it real repo-backed data, but only as fresh as the last
              benchmark generation pass.
            </p>
          </FadeInSection>
        </div>
      </section>

      <section className="px-6 py-8 sm:px-8 lg:px-10">
        <div className="mx-auto grid w-full max-w-7xl gap-4 md:grid-cols-3">
          {proofBadges.map((badge) => (
            <FadeInSection key={badge.label} className="home-panel rounded-[28px] p-5">
              <p className="text-sm font-semibold text-[hsl(var(--home-ink))]">
                {badge.label}
              </p>
              <p className="mt-3 font-display text-4xl tracking-[-0.05em] text-[hsl(var(--home-ink))]">
                {badge.value}
              </p>
              <p className="mt-3 text-sm leading-6 text-[hsl(var(--home-muted))]">
                {badge.detail}
              </p>
            </FadeInSection>
          ))}
        </div>
      </section>

      <section className="px-6 py-14 sm:px-8 lg:px-10">
        <div className="mx-auto w-full max-w-7xl">
          <FadeInSection className="max-w-3xl">
            <p className="home-eyebrow text-[11px] font-semibold text-[hsl(var(--home-muted))]">
              System flow
            </p>
            <h2 className="mt-4 font-display text-4xl tracking-[-0.04em] text-[hsl(var(--home-ink))] sm:text-5xl">
              One pipeline, several roles.
            </h2>
            <p className="mt-4 text-base leading-7 text-[hsl(var(--home-muted))]">
              The easiest way to misunderstand this project is to assume every
              component is “the model.” It is really a layered system.
            </p>
          </FadeInSection>

          <div className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {pipelineStages.map((stage, index) => (
              <FadeInSection
                key={stage.title}
                className="home-panel rounded-[28px] p-5"
                delay={index * 40}
              >
                <p className="text-lg font-semibold text-[hsl(var(--home-ink))]">
                  {stage.title}
                </p>
                <p className="mt-3 text-sm leading-6 text-[hsl(var(--home-muted))]">
                  {stage.copy}
                </p>
              </FadeInSection>
            ))}
          </div>
        </div>
      </section>

      <section className="px-6 py-14 sm:px-8 lg:px-10">
        <div className="mx-auto w-full max-w-7xl">
          <FadeInSection className="max-w-3xl">
            <p className="home-eyebrow text-[11px] font-semibold text-[hsl(var(--home-muted))]">
              STT models
            </p>
            <h2 className="mt-4 font-display text-4xl tracking-[-0.04em] text-[hsl(var(--home-ink))] sm:text-5xl">
              ScribeV2, full fine-tune, LoRA, and emergency LoRA are different runtime choices.
            </h2>
          </FadeInSection>

          <div className="mt-8 grid gap-4 md:grid-cols-2">
            {modelCards.map((card, index) => (
              <FadeInSection
                key={card.title}
                className="home-panel rounded-[30px] p-6"
                delay={index * 45}
              >
                <div className="flex items-center gap-3 text-[hsl(var(--home-ink))]">
                  <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[hsl(var(--home-sky))]">
                    {card.icon}
                  </div>
                  <div>
                    <p className="text-lg font-semibold">{card.title}</p>
                    <p className="text-sm text-[hsl(var(--home-muted))]">{card.subtitle}</p>
                  </div>
                </div>
                <p className="mt-5 text-sm leading-6 text-[hsl(var(--home-muted))]">
                  {card.copy}
                </p>
                <div className="mt-4 rounded-[24px] border border-[hsl(var(--home-line))] bg-white/80 p-4">
                  <p className="text-sm leading-6 text-[hsl(var(--home-muted))]">
                    {card.detail}
                  </p>
                </div>
              </FadeInSection>
            ))}
          </div>
        </div>
      </section>

      <section className="px-6 py-14 sm:px-8 lg:px-10">
        <div className="mx-auto grid w-full max-w-7xl gap-6 xl:grid-cols-[minmax(0,0.9fr)_minmax(340px,0.8fr)]">
          <FadeInSection className="home-panel rounded-[32px] p-6 sm:p-8">
            <p className="home-eyebrow text-[11px] font-semibold text-[hsl(var(--home-muted))]">
              Safety layers
            </p>
            <h2 className="mt-4 font-display text-4xl tracking-[-0.04em] text-[hsl(var(--home-ink))]">
              XGBoost and Tavily are not transcript engines.
            </h2>
            <p className="mt-4 text-base leading-7 text-[hsl(var(--home-muted))]">
              They sit around the transcript model. XGBoost predicts risk on
              words. Tavily tries to verify risky medical-shaped terms. Claude
              then works under those constraints.
            </p>

            <div className="mt-8 grid gap-4 md:grid-cols-2">
              {safetyCards.map((card, index) => (
                <FadeInSection
                  key={card.title}
                  className="rounded-[24px] border border-[hsl(var(--home-line))] bg-white/80 p-5"
                  delay={index * 35}
                >
                  <div className="flex items-center gap-3 text-[hsl(var(--home-ink))]">
                    {card.icon}
                    <p className="text-lg font-semibold">{card.title}</p>
                  </div>
                  <p className="mt-3 text-sm leading-6 text-[hsl(var(--home-muted))]">
                    {card.copy}
                  </p>
                </FadeInSection>
              ))}
            </div>
          </FadeInSection>

          <FadeInSection className="home-panel-strong rounded-[32px] p-6" delay={90}>
            <p className="text-sm font-semibold text-[hsl(var(--home-ink))]">
              Current runtime caveats
            </p>
            <div className="mt-5 space-y-4 text-sm leading-6 text-[hsl(var(--home-muted))]">
              <div className="rounded-[24px] border border-[hsl(var(--home-line))] bg-white/80 p-4">
                <p className="font-semibold text-[hsl(var(--home-ink))]">
                  XGBoost exists, but it is optional in runtime.
                </p>
                <p className="mt-2">
                  The repo includes trained XGB artifacts and reporting, but the
                  backend config keeps runtime XGBoost disabled by default.
                </p>
              </div>
              <div className="rounded-[24px] border border-[hsl(var(--home-line))] bg-white/80 p-4">
                <p className="font-semibold text-[hsl(var(--home-ink))]">
                  Tavily is conservative on purpose.
                </p>
                <p className="mt-2">
                  It only runs on deduped medical-looking terms up to a call cap,
                  caches results, and can still return unverified.
                </p>
              </div>
              <div className="rounded-[24px] border border-[hsl(var(--home-line))] bg-white/80 p-4">
                <p className="font-semibold text-[hsl(var(--home-ink))]">
                  The benchmark artifact currently tells a stricter story than the old mock snapshot.
                </p>
                <p className="mt-2">
                  That is useful. It means the architecture page can stay honest
                  about what is implemented versus what is aspirational.
                </p>
              </div>
            </div>
          </FadeInSection>
        </div>
      </section>

      <section className="px-6 py-14 sm:px-8 lg:px-10">
        <div className="mx-auto w-full max-w-7xl">
          <FadeInSection className="max-w-3xl">
            <p className="home-eyebrow text-[11px] font-semibold text-[hsl(var(--home-muted))]">
              Model rows
            </p>
            <h2 className="mt-4 font-display text-4xl tracking-[-0.04em] text-[hsl(var(--home-ink))] sm:text-5xl">
              Current benchmark artifact by model family.
            </h2>
            <p className="mt-4 text-base leading-7 text-[hsl(var(--home-muted))]">
              These rows come from the benchmark artifact the frontend reads. They
              are useful for orientation, but they should still be refreshed when
              the benchmark pipeline changes.
            </p>
          </FadeInSection>

          <div className="mt-8 grid gap-4 xl:grid-cols-4">
            {modelBenchmarks.map((row, index) => (
              <FadeInSection
                key={row.id}
                className="home-panel rounded-[28px] p-5"
                delay={index * 40}
              >
                <p className="text-lg font-semibold text-[hsl(var(--home-ink))]">
                  {row.label}
                </p>
                <p className="mt-2 text-sm text-[hsl(var(--home-muted))]">
                  {row.clip_count} clips in current artifact
                </p>
                <div className="mt-5 grid gap-3">
                  <div className="rounded-[20px] bg-white/80 p-4">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[hsl(var(--home-muted))]">
                      Avg WER
                    </p>
                    <p className="mt-2 text-3xl font-semibold tracking-tight text-[hsl(var(--home-ink))]">
                      {row.avg_wer.toFixed(2)}%
                    </p>
                  </div>
                  <div className="rounded-[20px] bg-white/80 p-4">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[hsl(var(--home-muted))]">
                      Medical keyword accuracy
                    </p>
                    <p className="mt-2 text-3xl font-semibold tracking-tight text-[hsl(var(--home-ink))]">
                      {row.avg_medical_keyword_accuracy === null ||
                      row.avg_medical_keyword_accuracy === undefined
                        ? "n/a"
                        : `${row.avg_medical_keyword_accuracy.toFixed(2)}%`}
                    </p>
                  </div>
                </div>
              </FadeInSection>
            ))}
          </div>
        </div>
      </section>

      <section className="px-6 pt-6 pb-16 sm:px-8 lg:px-10">
        <FadeInSection className="mx-auto w-full max-w-7xl">
          <div className="rounded-[36px] bg-[hsl(var(--home-ink))] px-6 py-10 text-white shadow-[0_30px_80px_rgba(18,32,51,0.22)] sm:px-8 lg:px-10">
            <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
              <div className="max-w-3xl">
                <p className="home-eyebrow text-[11px] font-semibold text-white/65">
                  Next step
                </p>
                <h2 className="mt-4 font-display text-4xl tracking-[-0.04em] text-white sm:text-5xl">
                  Use Home for the promise, Architecture for the explanation, and Benchmark for the proof.
                </h2>
                <p className="mt-4 max-w-2xl text-base leading-7 text-white/70">
                  That split keeps the landing page clear while still giving you
                  a place to talk honestly about model choice, verification, and
                  where the numbers come from.
                </p>
              </div>
              <div className="flex flex-col gap-3 sm:flex-row lg:flex-col">
                <Button
                  asChild
                  size="lg"
                  className="h-12 rounded-full bg-white px-6 text-[hsl(var(--home-ink))] hover:bg-white/90"
                >
                  <Link to="/benchmark">
                    Open benchmark
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                </Button>
                <Button
                  asChild
                  size="lg"
                  variant="outline"
                  className="h-12 rounded-full border-white/20 bg-transparent px-6 text-white hover:bg-white/10 hover:text-white"
                >
                  <Link to="/">Back to Home</Link>
                </Button>
              </div>
            </div>
          </div>
        </FadeInSection>
      </section>

      <Footer variant="editorial" />
    </div>
  );
};

export default ArchitecturePage;
