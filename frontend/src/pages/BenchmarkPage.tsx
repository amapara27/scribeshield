import { useEffect, useMemo, useState } from "react";
import { ArrowUpDown, Download } from "lucide-react";
import {
  Bar,
  BarChart,
  Cell,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import FadeInSection from "@/components/FadeInSection";
import Footer from "@/components/Footer";
import Navbar from "@/components/Navbar";
import { fetchBenchmark, fetchLearningLoop } from "@/services/api";
import type {
  BenchmarkClipResult,
  BenchmarkResponse,
  LearningLoopResponse,
} from "@/types/api";

type SortKey = keyof BenchmarkClipResult;
type Filter = "all" | "Standard" | "Adversarial";

const PERCENT_NUMERIC_FIELDS = new Set<SortKey>([
  "raw_wer",
  "corrected_wer",
  "raw_cer",
  "corrected_cer",
  "raw_digit_accuracy",
  "corrected_digit_accuracy",
  "raw_medical_keyword_accuracy",
  "corrected_medical_keyword_accuracy",
  "improvement_pct",
]);

const toPercent = (value: number | null | undefined): number | null => {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  return Math.abs(value) <= 1 ? value * 100 : value;
};

const fmtPercent = (value: number | null | undefined, decimals = 1): string => {
  const pct = toPercent(value);
  if (pct === null) return "n/a";
  return `${pct.toFixed(decimals)}%`;
};

const toRatio = (value: number | null | undefined): number | null => {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  return Math.abs(value) <= 1 ? value : value / 100;
};

const BenchmarkPage = () => {
  const [data, setData] = useState<BenchmarkResponse | null>(null);
  const [dataSource, setDataSource] = useState<"api" | "unavailable">("unavailable");
  const [benchmarkNote, setBenchmarkNote] = useState<string | null>(null);
  const [learningLoop, setLearningLoop] = useState<LearningLoopResponse | null>(null);
  const [learningLoopNote, setLearningLoopNote] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("clip_id");
  const [sortAsc, setSortAsc] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const clips =
      filter === "all"
        ? ("all" as const)
        : filter === "Adversarial"
          ? ("adversarial" as const)
          : ("standard" as const);

    setLoading(true);

    fetchBenchmark(clips)
      .then((payload) => {
        if (cancelled) return;
        setData(payload);
        setDataSource("api");
        setBenchmarkNote(null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setData(null);
        setDataSource("unavailable");
        setBenchmarkNote(
          error instanceof Error
            ? `Live benchmark data unavailable: ${error.message}`
            : "Live benchmark data unavailable. Run backend/scripts/run_benchmark.py --run-pipeline to generate real benchmark data.",
        );
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [filter]);

  useEffect(() => {
    let cancelled = false;

    fetchLearningLoop()
      .then((payload) => {
        if (cancelled) return;
        setLearningLoop(payload);
        setLearningLoopNote(null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLearningLoop(null);
        setLearningLoopNote(
          error instanceof Error
            ? `Training-loop visuals unavailable: ${error.message}`
            : "Training-loop visuals unavailable.",
        );
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const normalizedResults = useMemo(
    () =>
      (data?.results ?? []).map((row) => ({
        ...row,
        raw_wer_pct: toPercent(row.raw_wer) ?? 0,
        corrected_wer_pct: toPercent(row.corrected_wer) ?? 0,
        improvement_pct_norm: toPercent(row.improvement_pct) ?? 0,
      })),
    [data],
  );

  const ablationRows = useMemo(
    () =>
      (data?.ablation ?? []).map((row, idx, all) => {
        const werPct = toPercent(row.wer) ?? 0;
        const prevWerPct = idx > 0 ? toPercent(all[idx - 1].wer) ?? 0 : null;
        const deltaPct = prevWerPct === null ? null : werPct - prevWerPct;
        return {
          ...row,
          wer_pct: werPct,
          delta_pct: deltaPct,
        };
      }),
    [data],
  );

  const maxAblationWer = useMemo(
    () => Math.max(1, ...ablationRows.map((row) => row.wer_pct)),
    [ablationRows],
  );

  const filtered = useMemo(() => {
    let rows =
      filter === "all"
        ? normalizedResults
        : normalizedResults.filter((r) => r.difficulty === filter);
    rows = [...rows].sort((a, b) => {
      if (PERCENT_NUMERIC_FIELDS.has(sortKey)) {
        const av =
          toPercent(
            (a as Record<string, unknown>)[sortKey] as number | null | undefined,
          ) ?? Number.NEGATIVE_INFINITY;
        const bv =
          toPercent(
            (b as Record<string, unknown>)[sortKey] as number | null | undefined,
          ) ?? Number.NEGATIVE_INFINITY;
        return sortAsc ? av - bv : bv - av;
      }
      const av = String((a as Record<string, unknown>)[sortKey] ?? "");
      const bv = String((b as Record<string, unknown>)[sortKey] ?? "");
      return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
    });
    return rows;
  }, [normalizedResults, filter, sortKey, sortAsc]);

  const chartData = useMemo(() => {
    const buckets: Record<string, number[]> = {};
    normalizedResults.forEach((row) => {
      if (!buckets[row.category]) buckets[row.category] = [];
      buckets[row.category].push(row.improvement_pct_norm);
    });
    return Object.entries(buckets).map(([category, values]) => ({
      category,
      improvement: values.reduce((sum, value) => sum + value, 0) / values.length,
    }));
  }, [normalizedResults]);

  const learningLoopData = useMemo(
    () =>
      ablationRows.map((row, idx) => ({
        step: idx + 1,
        stage: row.stage,
        wer: row.wer_pct,
      })),
    [ablationRows],
  );

  const xgbTrainingHistory = useMemo(
    () =>
      (learningLoop?.training_history ?? []).map((row) => ({
        round: row.round,
        train: row.train_value,
        validation: row.validation_value ?? null,
      })),
    [learningLoop],
  );

  const xgbSnapshotTrend = useMemo(
    () =>
      (learningLoop?.retraining_snapshots ?? []).map((row) => ({
        calls: row.clip_count,
        rows: row.row_count,
        accuracy: row.accuracy * 100,
        f1: row.f1 * 100,
        auc: row.auc === null || row.auc === undefined ? null : row.auc * 100,
      })),
    [learningLoop],
  );

  const xgbFeatureImportance = useMemo(
    () =>
      (learningLoop?.feature_importance ?? [])
        .slice(0, 10)
        .map((row) => ({
          feature: row.feature.replace(/^cat__|^remainder__/, ""),
          importance: row.importance,
        }))
        .reverse(),
    [learningLoop],
  );

  const metricCards = useMemo(() => {
    const metrics = data?.metrics;
    if (!metrics) return [];

    const cards = [
      {
        label: "Verification Rate",
        value: fmtPercent(metrics.verification_rate),
        tip: "Corrections backed by Tavily confirmation.",
      },
      {
        label: "Unsafe Guess Rate",
        value: fmtPercent(metrics.unsafe_guess_rate),
        tip: "Corrections made without verification.",
      },
      {
        label: "Uncertainty Coverage",
        value: fmtPercent(metrics.uncertainty_coverage),
        tip: "Raw transcript errors surfaced as LOW/MEDIUM confidence tokens.",
      },
      {
        label: "Phonetic Hit Rate",
        value: fmtPercent(metrics.phonetic_hit_rate),
        tip: "Verified corrections whose source token tripped a phonetic-distance signal.",
      },
    ];

    if (
      metrics.digit_accuracy_coverage !== null &&
      metrics.digit_accuracy_coverage !== undefined
    ) {
      cards.push({
        label: "Digit Coverage",
        value: fmtPercent(metrics.digit_accuracy_coverage),
        tip: "Share of clips containing evaluable numeric references.",
      });
    }

    if (
      metrics.medical_keyword_accuracy_coverage !== null &&
      metrics.medical_keyword_accuracy_coverage !== undefined
    ) {
      cards.push({
        label: "Medical Keyword Coverage",
        value: fmtPercent(metrics.medical_keyword_accuracy_coverage),
        tip: "Share of clips containing evaluable medical-term references.",
      });
    }

    return cards;
  }, [data]);

  const modelBenchmarks = useMemo(
    () =>
      (data?.model_benchmarks ?? [])
        .map((row) => {
          const werRatio = toRatio(row.avg_wer) ?? 1.0;
          const digitRatio = toRatio(row.avg_digit_accuracy) ?? 0.0;
          const medicalRatio = toRatio(row.avg_medical_keyword_accuracy) ?? 0.0;
          const qualityScore = (0.7 * medicalRatio + 0.2 * digitRatio + 0.1 * (1 - werRatio)) * 100;
          return {
            ...row,
            qualityScore,
          };
        })
        .sort((a, b) => b.qualityScore - a.qualityScore),
    [data],
  );

  const bestModel = modelBenchmarks[0] ?? null;
  const lowestWerModel = useMemo(
    () =>
      [...modelBenchmarks].sort(
        (a, b) =>
          (toPercent(a.avg_wer) ?? Number.POSITIVE_INFINITY) -
          (toPercent(b.avg_wer) ?? Number.POSITIVE_INFINITY),
      )[0] ?? null,
    [modelBenchmarks],
  );

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortAsc((value) => !value);
      return;
    }
    setSortKey(key);
    setSortAsc(true);
  };

  return (
    <div className="home-page min-h-screen">
      <Navbar />

      <section className="px-6 pt-28 pb-8 sm:px-8 lg:px-10">
        <div className="mx-auto max-w-[900px] space-y-4">
          {benchmarkNote && (
            <div className="rounded-[24px] border border-[rgba(210,141,73,0.35)] bg-[rgba(255,241,227,0.92)] px-4 py-3 text-sm text-[hsl(var(--home-ink))]">
              {benchmarkNote}
            </div>
          )}
          {dataSource === "api" && data && !benchmarkNote && (
            <div className="rounded-[24px] border border-[rgba(77,150,108,0.28)] bg-[rgba(207,232,223,0.92)] px-4 py-3 text-xs text-[hsl(var(--home-ink))]">
              Showing benchmark results from API (
              {import.meta.env.VITE_API_URL || "VITE_API_URL"})
            </div>
          )}
          <p className="home-eyebrow text-[11px] font-semibold text-[hsl(var(--home-muted))]">
            Benchmark
          </p>
          <h1 className="font-display text-4xl tracking-[-0.04em] text-[hsl(var(--home-ink))] sm:text-5xl">
            Benchmark Results
          </h1>
          {data ? (
            <p className="text-sm leading-7 text-[hsl(var(--home-muted))] sm:text-base">
              {fmtPercent(data.aggregate.avg_improvement_pct)} average lift from untouched Scribe v2 baseline to corrected pipeline output.
              Verification rate {fmtPercent(data.metrics.verification_rate)}, unsafe
              guess rate {fmtPercent(data.metrics.unsafe_guess_rate)}.
              {bestModel
                ? ` Top overall model: ${bestModel.label} (${bestModel.qualityScore.toFixed(1)} quality score).`
                : ""}
              {lowestWerModel
                ? ` Lowest WER on this set: ${lowestWerModel.label} at ${fmtPercent(lowestWerModel.avg_wer)}.`
                : ""}
            </p>
          ) : (
            <p className="text-sm leading-7 text-[hsl(var(--home-muted))] sm:text-base">
              This page only shows API-backed benchmark results. Generate real data
              with `backend/scripts/run_benchmark.py --run-pipeline` and reload.
            </p>
          )}
        </div>
      </section>

      <div className="mx-auto max-w-[900px] px-6 pb-20 sm:px-8 lg:px-10">
        {loading && (
          <FadeInSection>
            <div className="home-panel rounded-[28px] p-6 text-sm text-[hsl(var(--home-muted))]">
              Loading benchmark results from the backend...
            </div>
          </FadeInSection>
        )}

        {!data && !loading && (
          <FadeInSection>
            <div className="home-panel rounded-[28px] p-6 text-sm text-[hsl(var(--home-muted))]">
              The backend did not return benchmark results. Start the API, then run
              `python backend/scripts/run_benchmark.py --run-pipeline` so `/benchmark`
              serves real data instead of sample numbers.
            </div>
          </FadeInSection>
        )}

        {data && (
          <>
        <FadeInSection>
          <div className="home-panel-strong mb-12 rounded-[32px] p-6 sm:p-8">
            <div className="flex items-end justify-between gap-4 mb-4">
              <div>
                <h2 className="font-display text-3xl tracking-[-0.04em] text-[hsl(var(--home-ink))]">
                  Model Benchmarks
                </h2>
                <p className="mt-2 text-sm text-[hsl(var(--home-muted))]">
                  Ranked by healthcare-weighted quality score (medical keyword accuracy,
                  digit accuracy, then WER), including untouched baselines and emergency fallback.
                </p>
              </div>
              {bestModel && (
                <div className="rounded-[24px] border border-[rgba(77,150,108,0.28)] bg-[rgba(207,232,223,0.92)] px-4 py-3 text-right">
                  <div className="home-eyebrow text-xs font-semibold text-[hsl(var(--home-muted))]">Best Overall</div>
                  <div className="text-lg font-semibold text-[hsl(var(--home-ink))]">
                    {bestModel.label}: {bestModel.qualityScore.toFixed(1)}
                  </div>
                </div>
              )}
            </div>

            {modelBenchmarks.length > 0 ? (
              <div className="editorial-table overflow-x-auto rounded-[28px]">
                <table className="w-full text-sm">
                  <thead className="editorial-table-head">
                    <tr>
                      <th className="px-4 py-3 text-left">Model</th>
                      <th className="px-4 py-3 text-left">Quality Score</th>
                      <th className="px-4 py-3 text-left">Clips</th>
                      <th className="px-4 py-3 text-left">WER</th>
                      <th className="px-4 py-3 text-left">CER</th>
                      <th className="px-4 py-3 text-left">Digit Accuracy</th>
                      <th className="px-4 py-3 text-left">Medical Keyword Accuracy</th>
                    </tr>
                  </thead>
                  <tbody>
                    {modelBenchmarks.map((row, index) => (
                      <tr
                        key={row.id}
                        className={`border-t border-[hsl(var(--home-line))/0.7] ${index % 2 === 0 ? "" : "bg-[rgba(255,250,243,0.72)]"}`}
                      >
                        <td className="px-4 py-3 font-medium text-[hsl(var(--home-ink))]">{row.label}</td>
                        <td className="px-4 py-3 text-[hsl(var(--home-ink))]">{row.qualityScore.toFixed(1)}</td>
                        <td className="px-4 py-3 text-[hsl(var(--home-muted))]">{row.clip_count}</td>
                        <td className="px-4 py-3 text-[hsl(var(--home-muted))]">{fmtPercent(row.avg_wer)}</td>
                        <td className="px-4 py-3 text-[hsl(var(--home-muted))]">{fmtPercent(row.avg_cer)}</td>
                        <td className="px-4 py-3 text-[hsl(var(--home-muted))]">{fmtPercent(row.avg_digit_accuracy)}</td>
                        <td className="px-4 py-3 text-[hsl(var(--home-muted))]">{fmtPercent(row.avg_medical_keyword_accuracy)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="rounded-[24px] border border-[rgba(210,141,73,0.35)] bg-[rgba(255,241,227,0.92)] px-4 py-3 text-sm text-[hsl(var(--home-ink))]">
                Model benchmark rows have not been generated yet. Re-run
                `backend/scripts/run_benchmark.py --run-pipeline` after the
                `openai/whisper-small`, `fine_tuned_telephony`, `lora`, `scribe_v2`, and `emergency_lora`
                providers are available.
              </div>
            )}
          </div>
        </FadeInSection>

        <FadeInSection>
          <div className="home-panel mb-12 rounded-[32px] p-6 sm:p-8">
            <h2 className="mb-6 font-display text-3xl tracking-[-0.04em] text-[hsl(var(--home-ink))]">
              Ablation Study
            </h2>
            <div className="editorial-table overflow-x-auto rounded-[28px]">
            <table className="w-full text-sm">
              <thead className="editorial-table-head">
                <tr>
                  <th className="px-4 py-3 text-left">Pipeline Stage</th>
                  <th className="px-4 py-3 text-left w-32">WER</th>
                  <th className="px-4 py-3 text-left w-24">Delta</th>
                  <th className="px-4 py-3 text-left">What This Proves</th>
                </tr>
              </thead>
              <tbody>
                {ablationRows.map((row, i) => (
                  <tr
                    key={i}
                    className={`border-t border-[hsl(var(--home-line))/0.7] ${i % 2 === 0 ? "" : "bg-[rgba(255,250,243,0.72)]"}`}
                  >
                    <td className="px-4 py-3 font-medium text-[hsl(var(--home-ink))]">
                      {row.stage}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-[hsl(var(--home-ink))]">
                          {fmtPercent(row.wer_pct)}
                        </span>
                        <div className="h-2 max-w-[90px] flex-1 rounded-full bg-[hsl(var(--home-sand))]">
                          <div
                            className="h-2 rounded-full bg-[hsl(var(--home-coral))] transition-all"
                            style={{ width: `${(row.wer_pct / maxAblationWer) * 100}%` }}
                          />
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {row.delta_pct === null ? (
                        <span className="text-muted-foreground">-</span>
                      ) : (
                        <span
                          className={
                            row.delta_pct <= 0
                              ? "text-success font-semibold"
                              : "text-signal-red font-semibold"
                          }
                        >
                          {row.delta_pct > 0 ? "+" : ""}
                          {row.delta_pct.toFixed(1)}%
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-[hsl(var(--home-muted))]">
                      {row.description}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </div>
        </FadeInSection>

        <div className="mb-12">
          <h2 className="mb-4 font-display text-3xl tracking-[-0.04em] text-[hsl(var(--home-ink))]">Key Metrics</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {metricCards.map((metric) => (
              <Tooltip key={metric.label}>
                <TooltipTrigger asChild>
                  <div className="home-panel rounded-[24px] p-4 text-center cursor-default">
                    <p className="font-display text-3xl tracking-[-0.04em] text-[hsl(var(--home-ink))]">
                      {metric.value}
                    </p>
                    <p className="mt-1 text-xs text-[hsl(var(--home-muted))]">
                      {metric.label}
                    </p>
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  <p className="text-xs max-w-[220px]">{metric.tip}</p>
                </TooltipContent>
              </Tooltip>
            ))}
          </div>
        </div>

        <FadeInSection>
          <div className="mb-12 home-panel rounded-[32px] p-6 sm:p-8">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-display text-3xl tracking-[-0.04em] text-[hsl(var(--home-ink))]">Per-Clip Results</h2>
            <div className="flex gap-2">
              {(["all", "Standard", "Adversarial"] as Filter[]).map((value) => (
                <Button
                  key={value}
                  variant={filter === value ? "default" : "outline"}
                  size="sm"
                  className={
                    filter === value
                      ? "rounded-full bg-primary text-primary-foreground"
                      : "rounded-full border-[hsl(var(--home-line))] bg-white/80 text-[hsl(var(--home-ink))] hover:bg-white"
                  }
                  onClick={() => setFilter(value)}
                >
                  {value === "all" ? "All" : value}
                </Button>
              ))}
            </div>
          </div>

          <div className="editorial-table overflow-x-auto rounded-[28px]">
            <table className="w-full text-sm">
              <thead className="editorial-table-head">
                <tr>
                    {[
                      { key: "clip_id" as SortKey, label: "Clip" },
                      { key: "category" as SortKey, label: "Category" },
                      { key: "difficulty" as SortKey, label: "Difficulty" },
                      { key: "raw_wer" as SortKey, label: "Baseline ScribeV2 WER" },
                      { key: "corrected_wer" as SortKey, label: "ScribeShield WER" },
                      { key: "improvement_pct" as SortKey, label: "Lift vs baseline" },
                    ].map((col) => (
                    <th
                      key={col.key}
                      className="cursor-pointer whitespace-nowrap px-4 py-3 text-left hover:bg-white/10"
                      onClick={() => toggleSort(col.key)}
                    >
                      <span className="flex items-center gap-1">
                        {col.label}
                        <ArrowUpDown className="h-3 w-3" />
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((row, i) => (
                  <tr
                    key={row.clip_id}
                    className={`border-t border-[hsl(var(--home-line))/0.7] transition-colors hover:bg-[rgba(214,231,244,0.18)] ${i % 2 === 0 ? "" : "bg-[rgba(255,250,243,0.72)]"}`}
                  >
                    <td className="px-4 py-3 font-medium text-[hsl(var(--home-ink))]">{row.clip_id}</td>
                    <td className="px-4 py-3 text-[hsl(var(--home-muted))]">{row.category}</td>
                    <td className="px-4 py-3">
                      <Badge
                        className={
                          row.difficulty === "Adversarial"
                            ? "border-0 bg-[rgba(211,98,78,0.12)] text-[hsl(var(--home-ink))]"
                            : "border-0 bg-[hsl(var(--home-sand))] text-[hsl(var(--home-ink))]"
                        }
                      >
                        {row.difficulty}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-[hsl(var(--home-muted))]">{fmtPercent(row.raw_wer)}</td>
                    <td className="px-4 py-3 text-[hsl(var(--home-muted))]">{fmtPercent(row.corrected_wer)}</td>
                    <td className="px-4 py-3">
                      <span
                        className={
                          row.improvement_pct_norm > 0
                            ? "text-success font-semibold"
                            : "text-signal-red font-semibold"
                        }
                      >
                        {row.improvement_pct_norm > 0 ? "+" : ""}
                        {row.improvement_pct_norm.toFixed(1)}%
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </div>
        </FadeInSection>

        <FadeInSection>
          <div className="home-panel mb-12 rounded-[32px] p-6">
          <h3 className="mb-4 text-xl font-semibold text-[hsl(var(--home-ink))]">
            Average Improvement by Category
          </h3>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} layout="vertical">
                <XAxis
                  type="number"
                  domain={[0, Math.max(10, ...chartData.map((d) => d.improvement))]}
                  tickFormatter={(v) => `${Number(v).toFixed(0)}%`}
                />
                <YAxis
                  type="category"
                  dataKey="category"
                  width={150}
                  tick={{ fontSize: 12 }}
                />
                <RechartsTooltip formatter={(v: number) => `${v.toFixed(1)}%`} />
                <Bar dataKey="improvement" radius={[0, 4, 4, 0]}>
                  {chartData.map((_, i) => (
                    <Cell key={i} fill="hsl(var(--home-coral))" />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          </div>
        </FadeInSection>

        <FadeInSection>
          <div className="home-panel mb-12 rounded-[32px] p-6">
          <h3 className="mb-2 text-xl font-semibold text-[hsl(var(--home-ink))]">Ablation Trend</h3>
          <p className="mb-4 text-sm text-[hsl(var(--home-muted))]">
            Trend derived from real benchmark ablation rows, not synthetic mock
            calls.
          </p>
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={learningLoopData}>
                <XAxis
                  dataKey="step"
                  label={{
                    value: "Stage #",
                    position: "insideBottom",
                    offset: -5,
                    fontSize: 12,
                  }}
                />
                <YAxis tickFormatter={(v) => `${v}%`} />
                <RechartsTooltip
                  formatter={(v: number) => `${v.toFixed(1)}%`}
                  labelFormatter={(label, rows) =>
                    `Stage ${label}: ${String(rows?.[0]?.payload?.stage ?? "")}`
                  }
                />
                <Line
                  type="monotone"
                  dataKey="wer"
                  stroke="hsl(var(--home-coral))"
                  strokeWidth={2}
                  dot={{ r: 3 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
          </div>
        </FadeInSection>

        <FadeInSection>
          <div className="home-panel-strong mb-12 rounded-[32px] p-6 sm:p-8">
            <div className="flex items-center justify-between gap-4 mb-3">
              <div>
                <h2 className="font-display text-3xl tracking-[-0.04em] text-[hsl(var(--home-ink))]">XGBoost Learning Loop</h2>
                <p className="mt-2 text-sm text-[hsl(var(--home-muted))]">
                  Scribe v2 feeds the transcript; the post-processor learns which words should be verified.
                </p>
              </div>
              {learningLoop?.summary && (
                <div className="grid grid-cols-3 gap-2 min-w-[280px]">
                  <div className="rounded-[20px] border border-[hsl(var(--home-line))/0.8] bg-white/[0.72] p-3 text-center">
                    <div className="text-lg font-semibold text-[hsl(var(--home-ink))]">
                      {learningLoop.summary.latest_clip_count ?? "n/a"}
                    </div>
                    <div className="text-xs text-[hsl(var(--home-muted))]">Calls Learned</div>
                  </div>
                  <div className="rounded-[20px] border border-[hsl(var(--home-line))/0.8] bg-white/[0.72] p-3 text-center">
                    <div className="text-lg font-semibold text-[hsl(var(--home-ink))]">
                      {learningLoop.summary.latest_f1 !== null &&
                      learningLoop.summary.latest_f1 !== undefined
                        ? `${(learningLoop.summary.latest_f1 * 100).toFixed(1)}%`
                        : "n/a"}
                    </div>
                    <div className="text-xs text-[hsl(var(--home-muted))]">Latest F1</div>
                  </div>
                  <div className="rounded-[20px] border border-[hsl(var(--home-line))/0.8] bg-white/[0.72] p-3 text-center">
                    <div className="text-lg font-semibold text-[hsl(var(--home-ink))]">
                      {learningLoop.summary.latest_auc !== null &&
                      learningLoop.summary.latest_auc !== undefined
                        ? `${(learningLoop.summary.latest_auc * 100).toFixed(1)}%`
                        : "n/a"}
                    </div>
                    <div className="text-xs text-[hsl(var(--home-muted))]">Latest AUC</div>
                  </div>
                </div>
              )}
            </div>

            {learningLoopNote && (
              <div className="mb-4 rounded-[24px] border border-[rgba(210,141,73,0.35)] bg-[rgba(255,241,227,0.92)] px-4 py-3 text-sm text-[hsl(var(--home-ink))]">
                {learningLoopNote}
              </div>
            )}

            {learningLoop && (
              <div className="grid gap-6 lg:grid-cols-2">
                <div className="home-panel rounded-[28px] p-4">
                  <h3 className="mb-1 text-lg font-semibold text-[hsl(var(--home-ink))]">Boosting Rounds</h3>
                  <p className="mb-4 text-xs text-[hsl(var(--home-muted))]">
                    Training vs validation {learningLoop.metric_name ?? "metric"} over boosting rounds.
                  </p>
                  <div className="h-64">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={xgbTrainingHistory}>
                        <XAxis dataKey="round" />
                        <YAxis />
                        <RechartsTooltip />
                        <Line type="monotone" dataKey="train" stroke="hsl(var(--home-coral))" strokeWidth={2} dot={false} />
                        <Line type="monotone" dataKey="validation" stroke="hsl(var(--home-ink))" strokeWidth={2} dot={false} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                <div className="home-panel rounded-[28px] p-4">
                  <h3 className="mb-1 text-lg font-semibold text-[hsl(var(--home-ink))]">Improvement Over More Calls</h3>
                  <p className="mb-4 text-xs text-[hsl(var(--home-muted))]">
                    Retraining snapshots as corrected Scribe v2 calls are added back into the loop.
                  </p>
                  <div className="h-64">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={xgbSnapshotTrend}>
                        <XAxis dataKey="calls" />
                        <YAxis tickFormatter={(value) => `${Number(value).toFixed(0)}%`} />
                        <RechartsTooltip formatter={(value: number) => `${value.toFixed(1)}%`} />
                        <Line type="monotone" dataKey="accuracy" stroke="hsl(198 65% 56%)" strokeWidth={2} dot={{ r: 2 }} />
                        <Line type="monotone" dataKey="f1" stroke="hsl(var(--home-coral))" strokeWidth={2} dot={{ r: 2 }} />
                        <Line type="monotone" dataKey="auc" stroke="hsl(145 50% 38%)" strokeWidth={2} dot={{ r: 2 }} connectNulls />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                <div className="home-panel rounded-[28px] p-4 lg:col-span-2">
                  <h3 className="mb-1 text-lg font-semibold text-[hsl(var(--home-ink))]">Top Risk Features</h3>
                  <p className="mb-4 text-xs text-[hsl(var(--home-muted))]">
                    What the post-processor is leaning on most when deciding which words should be verified.
                  </p>
                  <div className="h-80">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={xgbFeatureImportance} layout="vertical" margin={{ left: 40 }}>
                        <XAxis type="number" />
                        <YAxis type="category" dataKey="feature" width={230} tick={{ fontSize: 11 }} />
                        <RechartsTooltip formatter={(value: number) => value.toFixed(4)} />
                        <Bar dataKey="importance" radius={[0, 4, 4, 0]}>
                          {xgbFeatureImportance.map((_, index) => (
                            <Cell key={index} fill="hsl(198 65% 56%)" />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </div>
            )}
          </div>
        </FadeInSection>

        <FadeInSection>
          <div className="home-panel mb-12 rounded-[32px] p-6 sm:p-8">
            <h2 className="mb-6 font-display text-3xl tracking-[-0.04em] text-[hsl(var(--home-ink))]">Methodology</h2>
            <ol className="space-y-3 text-sm text-[hsl(var(--home-ink))]">
              {[
                "ElevenLabs TTS renders healthcare call scripts with diverse voices and accents.",
                "ffmpeg degrades audio to simulated 8kHz telephony conditions.",
                "Base Whisper Small and fine_tuned_telephony run side by side on the same benchmark clips.",
                "Scribe v2 transcribes each clip with dynamic keyterm prompting.",
                "WER/CER are computed against benchmark ground truth.",
                "Multi-signal uncertainty detection scores each token.",
                "Tavily verification runs on low-confidence medical candidates.",
                "Claude correction only applies verified terms and flags unresolved terms.",
                "Corrected WER is compared against raw WER per clip and stage.",
              ].map((step, i) => (
                <li key={i} className="flex items-start gap-3">
                  <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-[hsl(var(--home-coral))] text-xs font-bold text-white">
                    {i + 1}
                  </span>
                  {step}
                </li>
              ))}
            </ol>
          </div>
        </FadeInSection>

        <Button
          variant="outline"
          className="gap-2 rounded-full border-[hsl(var(--home-line))] bg-white/80 text-[hsl(var(--home-ink))] hover:bg-white"
          onClick={() => {
            const blob = new Blob([JSON.stringify(data, null, 2)], {
              type: "application/json",
            });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = "benchmark_results.json";
            a.click();
            URL.revokeObjectURL(url);
          }}
        >
          <Download className="h-4 w-4" /> Download Full Results JSON
        </Button>
          </>
        )}
      </div>

      <Footer variant="editorial" />
    </div>
  );
};

export default BenchmarkPage;
