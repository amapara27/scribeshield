import {
  Activity,
  FileText,
  Mic,
  Phone,
  Search,
  Shield,
  TriangleAlert,
} from "lucide-react";
import FadeInSection from "@/components/FadeInSection";
import type { HomeAblationStage } from "@/features/benchmark/presentation";

interface HomeProofSectionProps {
  stages: HomeAblationStage[];
}

const problemCards = [
  {
    icon: <Phone className="h-5 w-5" />,
    title: "Telephony strips signal",
    copy: "8 kHz audio erases phonetic detail right where drug names and dosages need it most.",
  },
  {
    icon: <TriangleAlert className="h-5 w-5" />,
    title: "Medical misses look confident",
    copy: "The dangerous failure mode is not only being wrong. It is being wrong without showing uncertainty.",
  },
  {
    icon: <Mic className="h-5 w-5" />,
    title: "Real calls are messy",
    copy: "Speakerphone noise, accents, TV in the background, and rushed handoffs are part of the workload.",
  },
];

const capabilityCards = [
  {
    icon: <Activity className="h-5 w-5" />,
    title: "Score first",
    copy: "Word-level confidence blends timing irregularity, phonetic distance, history, and keyterm mismatch.",
  },
  {
    icon: <Search className="h-5 w-5" />,
    title: "Verify next",
    copy: "Risky medical-looking tokens are checked against external evidence before a correction is allowed through.",
  },
  {
    icon: <Shield className="h-5 w-5" />,
    title: "Block unsafe guesses",
    copy: "If verification does not support the change, the system preserves the uncertainty instead of inventing certainty.",
  },
  {
    icon: <FileText className="h-5 w-5" />,
    title: "Extract last",
    copy: "The structured summary is derived from the corrected transcript so medications and symptoms stay consistent.",
  },
];

const workflowSteps = [
  {
    title: "Transcribe",
    copy: "Batch STT runs on the raw clip with timestamps and speaker turns intact.",
  },
  {
    title: "Surface risk",
    copy: "Low- and medium-confidence tokens become visible before any correction step hides them.",
  },
  {
    title: "Apply verified fixes",
    copy: "Only supported corrections make it into the transcript; unresolved terms stay visibly untrusted.",
  },
  {
    title: "Deliver review-ready output",
    copy: "Final transcript, benchmark lift, and structured summary stay grounded in the same evidence chain.",
  },
];

const HomeProofSection = ({ stages }: HomeProofSectionProps) => (
  <section className="px-6 py-14 sm:px-8 lg:px-10">
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-10">
      <FadeInSection>
        <div className="max-w-3xl">
          <p className="home-eyebrow text-[11px] font-semibold text-[hsl(var(--home-muted))]">
            Why the layer exists
          </p>
          <h2 className="mt-4 font-display text-4xl tracking-[-0.04em] text-[hsl(var(--home-ink))] sm:text-5xl">
            Every token gets scored before it gets rewritten.
          </h2>
          <p className="mt-4 max-w-2xl text-base leading-7 text-[hsl(var(--home-muted))]">
            The product story is simple: standard STT keeps outputting clean-looking
            transcripts even when healthcare audio is degraded. ScribeShield turns
            that hidden uncertainty into something visible, measurable, and harder
            to misuse.
          </p>
        </div>
      </FadeInSection>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,0.9fr)_minmax(360px,1.1fr)]">
        <FadeInSection className="home-panel rounded-[32px] p-6">
          <p className="text-sm font-semibold text-[hsl(var(--home-ink))]">
            Where standard STT breaks
          </p>
          <div className="mt-5 grid gap-4">
            {problemCards.map((card) => (
              <div
                key={card.title}
                className="rounded-[24px] border border-[hsl(var(--home-line))] bg-white/80 p-4"
              >
                <div className="flex items-center gap-3 text-[hsl(var(--home-ink))]">
                  {card.icon}
                  <p className="font-semibold">{card.title}</p>
                </div>
                <p className="mt-3 text-sm leading-6 text-[hsl(var(--home-muted))]">
                  {card.copy}
                </p>
              </div>
            ))}
          </div>
        </FadeInSection>

        <FadeInSection className="home-panel rounded-[32px] p-6" delay={90}>
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-[hsl(var(--home-ink))]">
                Ablation trend
              </p>
              <p className="mt-1 text-sm text-[hsl(var(--home-muted))]">
                The benchmark proves the gain is cumulative, not decorative.
              </p>
            </div>
          </div>
          <div className="mt-5 space-y-4">
            {stages.map((stage) => (
              <div key={stage.stage} className="rounded-[24px] border border-[hsl(var(--home-line))] bg-white/75 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-[hsl(var(--home-ink))]">
                      {stage.stage}
                    </p>
                    <p className="mt-1 text-sm leading-6 text-[hsl(var(--home-muted))]">
                      {stage.description}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-lg font-semibold text-[hsl(var(--home-ink))]">
                      {stage.wer}
                    </p>
                    <p className="text-xs uppercase tracking-[0.18em] text-[hsl(var(--home-muted))]">
                      {stage.delta}
                    </p>
                  </div>
                </div>
                <div className="mt-4 h-2 rounded-full bg-[hsl(var(--home-sand))]">
                  <div
                    className="h-full rounded-full bg-[linear-gradient(90deg,#0f766e,#f59e0b)]"
                    style={{ width: `${stage.widthRatio * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </FadeInSection>
      </div>

      <FadeInSection delay={110}>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {capabilityCards.map((card) => (
            <div
              key={card.title}
              className="home-panel rounded-[28px] p-5 transition-transform duration-300 hover:-translate-y-1"
            >
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[hsl(var(--home-sky))] text-[hsl(var(--home-ink))]">
                {card.icon}
              </div>
              <p className="mt-4 text-lg font-semibold text-[hsl(var(--home-ink))]">
                {card.title}
              </p>
              <p className="mt-3 text-sm leading-6 text-[hsl(var(--home-muted))]">
                {card.copy}
              </p>
            </div>
          ))}
        </div>
      </FadeInSection>

      <FadeInSection delay={140}>
        <div className="home-panel rounded-[32px] p-6 sm:p-8">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
            <div className="max-w-xl">
              <p className="home-eyebrow text-[11px] font-semibold text-[hsl(var(--home-muted))]">
                Four stages, one rule
              </p>
              <h3 className="mt-4 font-display text-3xl tracking-[-0.04em] text-[hsl(var(--home-ink))] sm:text-4xl">
                Never convert uncertainty into confidence just to make the UI look clean.
              </h3>
            </div>
            <p className="max-w-md text-sm leading-7 text-[hsl(var(--home-muted))]">
              The workflow stays intentionally constrained. Each stage earns the
              right to hand off to the next one.
            </p>
          </div>
          <div className="home-rule mt-8 pt-8" />
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {workflowSteps.map((step, index) => (
              <div
                key={step.title}
                className="rounded-[24px] border border-[hsl(var(--home-line))] bg-white/75 p-5"
              >
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[hsl(var(--home-muted))]">
                  Stage {index + 1}
                </p>
                <p className="mt-4 text-lg font-semibold text-[hsl(var(--home-ink))]">
                  {step.title}
                </p>
                <p className="mt-3 text-sm leading-6 text-[hsl(var(--home-muted))]">
                  {step.copy}
                </p>
              </div>
            ))}
          </div>
        </div>
      </FadeInSection>
    </div>
  </section>
);

export default HomeProofSection;
