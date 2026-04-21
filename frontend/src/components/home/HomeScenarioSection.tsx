import { ArrowRight, Database, Shield, Sparkles } from "lucide-react";
import { Link } from "react-router-dom";
import FadeInSection from "@/components/FadeInSection";
import { Button } from "@/components/ui/button";
import type { HomeProofBadge, HomeScenarioCard } from "@/features/benchmark/presentation";

interface HomeScenarioSectionProps {
  scenarios: HomeScenarioCard[];
  proofBadges: HomeProofBadge[];
  dataSource: "live" | "snapshot";
}

const HomeScenarioSection = ({
  scenarios,
  proofBadges,
  dataSource,
}: HomeScenarioSectionProps) => (
  <section className="px-6 py-14 sm:px-8 lg:px-10">
    <div className="mx-auto grid w-full max-w-7xl gap-6 xl:grid-cols-[minmax(280px,0.42fr)_minmax(0,1fr)]">
      <FadeInSection className="home-panel rounded-[32px] p-6 sm:p-8">
        <p className="home-eyebrow text-[11px] font-semibold text-[hsl(var(--home-muted))]">
          Benchmark by scenario
        </p>
        <h2 className="mt-4 font-display text-4xl tracking-[-0.04em] text-[hsl(var(--home-ink))]">
          Lift that still shows up when the audio gets mean.
        </h2>
        <p className="mt-4 text-base leading-7 text-[hsl(var(--home-muted))]">
          The benchmark view is not hidden behind the product story. It is the
          product story. Each scenario card below summarizes the mean raw WER,
          corrected WER, and lift for that slice of the dataset.
        </p>

        <div className="mt-6 space-y-3">
          {proofBadges.map((badge) => (
            <div
              key={badge.label}
              className="rounded-[24px] border border-[hsl(var(--home-line))] bg-white/80 p-4"
            >
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-semibold text-[hsl(var(--home-ink))]">
                  {badge.label}
                </p>
                <p className="text-xl font-semibold text-[hsl(var(--home-ink))]">
                  {badge.value}
                </p>
              </div>
              <p className="mt-2 text-sm leading-6 text-[hsl(var(--home-muted))]">
                {badge.detail}
              </p>
            </div>
          ))}
        </div>

        <div className="home-rule mt-8 pt-6" />
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[hsl(var(--home-mint))] text-[hsl(var(--home-ink))]">
            {dataSource === "live" ? (
              <Database className="h-5 w-5" />
            ) : (
              <Shield className="h-5 w-5" />
            )}
          </div>
          <div>
            <p className="text-sm font-semibold text-[hsl(var(--home-ink))]">
              {dataSource === "live"
                ? "Homepage is reading from the live benchmark endpoint."
                : "Homepage is using the shipped benchmark snapshot."}
            </p>
            <p className="mt-2 text-sm leading-6 text-[hsl(var(--home-muted))]">
              That means the narrative stays populated even if the backend is
              offline, while still upgrading itself when the live API is available.
            </p>
          </div>
        </div>

        <Button
          asChild
          variant="outline"
          className="mt-8 h-12 rounded-full border-[hsl(var(--home-line))] bg-white/80 px-6 text-[hsl(var(--home-ink))] hover:bg-white"
        >
          <Link to="/architecture">
            Read architecture
            <ArrowRight className="h-4 w-4" />
          </Link>
        </Button>

        <Button
          asChild
          variant="outline"
          className="mt-3 h-12 rounded-full border-[hsl(var(--home-line))] bg-white/80 px-6 text-[hsl(var(--home-ink))] hover:bg-white"
        >
          <Link to="/benchmark">
            Open full benchmark
            <ArrowRight className="h-4 w-4" />
          </Link>
        </Button>
      </FadeInSection>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {scenarios.map((scenario, index) => (
          <FadeInSection
            key={scenario.category}
            className="home-panel rounded-[28px] p-5"
            delay={index * 45}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-lg font-semibold text-[hsl(var(--home-ink))]">
                  {scenario.category}
                </p>
                <p className="mt-1 text-sm text-[hsl(var(--home-muted))]">
                  {scenario.clipCount} clips • {scenario.difficulty}
                </p>
              </div>
              <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[hsl(var(--home-sand))] text-[hsl(var(--home-ink))]">
                <Sparkles className="h-4 w-4" />
              </div>
            </div>

            <div className="home-rule mt-5 pt-5" />

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-[20px] bg-white/80 p-4">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[hsl(var(--home-muted))]">
                  Raw WER
                </p>
                <p className="mt-2 text-3xl font-semibold tracking-tight text-[hsl(var(--home-ink))]">
                  {scenario.rawWer}
                </p>
              </div>
              <div className="rounded-[20px] bg-white/80 p-4">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[hsl(var(--home-muted))]">
                  Corrected WER
                </p>
                <p className="mt-2 text-3xl font-semibold tracking-tight text-[hsl(var(--home-ink))]">
                  {scenario.correctedWer}
                </p>
              </div>
            </div>

            <div className="mt-4 rounded-[24px] border border-emerald-200 bg-emerald-50 p-4 text-emerald-900">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em]">
                Average lift
              </p>
              <p className="mt-2 text-3xl font-semibold tracking-tight">
                {scenario.improvement}
              </p>
            </div>
          </FadeInSection>
        ))}
      </div>
    </div>
  </section>
);

export default HomeScenarioSection;
