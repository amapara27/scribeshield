import { ArrowRight, CheckCircle2, FileText, Mic, Play } from "lucide-react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { MOCK_TRANSCRIBE } from "@/services/mockData";
import type { HomeProofBadge } from "@/features/benchmark/presentation";

interface HomeHeroProps {
  proofBadges: HomeProofBadge[];
  dataSource: "live" | "snapshot";
  isRefreshing: boolean;
  totalClipCount: number;
}

const rawDoctorLine = MOCK_TRANSCRIBE.raw_transcript
  .slice(4, 16)
  .map((token) => token.word.replace(/^Doctor:\s*/, ""))
  .join(" ");
const rawPatientLine = MOCK_TRANSCRIBE.raw_transcript
  .slice(21, 29)
  .map((token) => token.word)
  .join(" ");
const correctedDoctorLine = MOCK_TRANSCRIBE.corrected_transcript
  .slice(4, 16)
  .map((token) => token.word.replace(/^Doctor:\s*/, ""))
  .join(" ");
const correctedPatientLine = MOCK_TRANSCRIBE.corrected_transcript
  .slice(21, 29)
  .map((token) => token.word)
  .join(" ");

const badgeToneClasses: Record<HomeProofBadge["tone"], string> = {
  mint: "border-emerald-200 bg-emerald-50 text-emerald-900",
  sand: "border-amber-200 bg-amber-50 text-amber-900",
  coral: "border-rose-200 bg-rose-50 text-rose-900",
};

const HomeHero = ({
  proofBadges,
  dataSource,
  isRefreshing,
  totalClipCount,
}: HomeHeroProps) => (
  <section className="relative overflow-hidden px-6 pt-32 pb-12 sm:px-8 lg:px-10">
    <div className="mx-auto grid w-full max-w-7xl gap-10 lg:grid-cols-[minmax(0,1.05fr)_minmax(360px,0.95fr)] lg:items-center">
      <div className="max-w-2xl">
        <p className="home-eyebrow text-[11px] font-semibold text-[hsl(var(--home-muted))]">
          Benchmark-backed clinical voice QA
        </p>
        <h1 className="mt-5 max-w-3xl font-display text-5xl leading-[0.96] tracking-[-0.04em] text-[hsl(var(--home-ink))] sm:text-6xl lg:text-7xl">
          Speech-to-text that refuses to guess when the stakes are clinical.
        </h1>
        <p className="mt-6 max-w-2xl text-base leading-7 text-[hsl(var(--home-muted))] sm:text-lg">
          ScribeShield scores uncertainty before it rewrites anything, verifies
          risky medical terms, and keeps unsafe corrections out of the final
          transcript. The goal is not prettier text. It is safer review.
        </p>

        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <Button
            asChild
            size="lg"
            className="h-12 rounded-full bg-primary px-6 text-primary-foreground shadow-[0_16px_30px_rgba(18,32,51,0.18)] hover:bg-primary/90"
          >
            <Link to="/clinic">
              Run clinic demo
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
          <Button
            asChild
            size="lg"
            variant="outline"
            className="h-12 rounded-full border-[hsl(var(--home-line))] bg-white/70 px-6 text-[hsl(var(--home-ink))] hover:bg-white"
          >
            <Link to="/benchmark">
              <Play className="h-4 w-4" />
              View benchmark
            </Link>
          </Button>
        </div>

        <div className="mt-8 grid gap-3 sm:grid-cols-3">
          {[
            {
              icon: <Mic className="h-4 w-4" />,
              title: "Telephony-first",
              copy: "Built for clipped bandwidth, noise, accents, and rushed handoffs.",
            },
            {
              icon: <CheckCircle2 className="h-4 w-4" />,
              title: "Verification-gated",
              copy: "Low-confidence medical terms need evidence before correction.",
            },
            {
              icon: <FileText className="h-4 w-4" />,
              title: "Review-ready output",
              copy: "Transcript, safety cues, and structured summary stay aligned.",
            },
          ].map((item) => (
            <div
              key={item.title}
              className="home-chip rounded-3xl p-4 text-sm shadow-[0_10px_24px_rgba(17,24,39,0.04)]"
            >
              <div className="flex items-center gap-2 text-[hsl(var(--home-ink))]">
                {item.icon}
                <p className="font-semibold">{item.title}</p>
              </div>
              <p className="mt-2 leading-6 text-[hsl(var(--home-muted))]">
                {item.copy}
              </p>
            </div>
          ))}
        </div>
      </div>

      <div className="home-panel-strong home-grid-paper rounded-[32px] p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-[hsl(var(--home-ink))]">
              Proof console
            </p>
            <p className="mt-1 text-sm text-[hsl(var(--home-muted))]">
              {totalClipCount} benchmark clips feeding the homepage narrative.
            </p>
          </div>
          <Badge
            variant="outline"
            className={cn(
              "rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]",
              dataSource === "live"
                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                : "border-amber-200 bg-amber-50 text-amber-800",
            )}
          >
            {dataSource === "live" ? "Live benchmark feed" : "Snapshot fallback"}
            {isRefreshing ? " • refreshing" : ""}
          </Badge>
        </div>

        <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_160px]">
          <div className="space-y-4">
            <div className="rounded-[28px] border border-rose-100 bg-white/90 p-4">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-semibold text-[hsl(var(--home-ink))]">
                  Raw transcript
                </p>
                <span className="rounded-full bg-rose-50 px-2.5 py-1 text-[11px] font-medium text-rose-700">
                  Uncertainty detected
                </span>
              </div>
              <div className="mt-3 space-y-3 text-sm leading-6 text-slate-700">
                <p>
                  <span className="font-semibold text-slate-900">Doctor:</span>{" "}
                  {rawDoctorLine
                    .split(" ")
                    .map((word, index) => (
                      <span
                        key={`${word}-${index}`}
                        className={cn(
                          "mr-1 inline-block rounded-md px-1.5 py-0.5",
                          ["metoformin", "lisinipril"].includes(
                            word.replace(/[.,]/g, ""),
                          )
                            ? "bg-rose-100 text-rose-800"
                            : "",
                        )}
                      >
                        {word}
                      </span>
                    ))}
                </p>
                <p>
                  <span className="font-semibold text-slate-900">Patient:</span>{" "}
                  {rawPatientLine
                    .split(" ")
                    .map((word, index) => (
                      <span
                        key={`${word}-${index}`}
                        className={cn(
                          "mr-1 inline-block rounded-md px-1.5 py-0.5",
                          word.replace(/[.,]/g, "") === "atorvostatin"
                            ? "bg-rose-100 text-rose-800"
                            : "",
                        )}
                      >
                        {word}
                      </span>
                    ))}
                </p>
              </div>
            </div>

            <div className="rounded-[28px] border border-emerald-100 bg-white/90 p-4">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-semibold text-[hsl(var(--home-ink))]">
                  Corrected transcript
                </p>
                <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-medium text-emerald-700">
                  Verified only
                </span>
              </div>
              <div className="mt-3 space-y-3 text-sm leading-6 text-slate-700">
                <p>
                  <span className="font-semibold text-slate-900">Doctor:</span>{" "}
                  {correctedDoctorLine
                    .split(" ")
                    .map((word, index) => (
                      <span
                        key={`${word}-${index}`}
                        className={cn(
                          "mr-1 inline-block rounded-md px-1.5 py-0.5",
                          ["metformin", "lisinopril"].includes(
                            word.replace(/[.,]/g, ""),
                          )
                            ? "bg-emerald-100 text-emerald-800"
                            : "",
                        )}
                      >
                        {word}
                      </span>
                    ))}
                </p>
                <p>
                  <span className="font-semibold text-slate-900">Patient:</span>{" "}
                  {correctedPatientLine
                    .split(" ")
                    .map((word, index) => (
                      <span
                        key={`${word}-${index}`}
                        className={cn(
                          "mr-1 inline-block rounded-md px-1.5 py-0.5",
                          word.replace(/[.,]/g, "") === "atorvastatin"
                            ? "bg-emerald-100 text-emerald-800"
                            : "",
                        )}
                      >
                        {word}
                      </span>
                    ))}
                </p>
              </div>
            </div>
          </div>

          <div className="space-y-3">
            {proofBadges.map((badge) => (
              <div
                key={badge.label}
                className={cn(
                  "rounded-[24px] border p-3.5",
                  badgeToneClasses[badge.tone],
                )}
              >
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em]">
                  {badge.label}
                </p>
                <p className="mt-2 text-2xl font-semibold tracking-tight">
                  {badge.value}
                </p>
                <p className="mt-2 text-xs leading-5 opacity-80">{badge.detail}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  </section>
);

export default HomeHero;
