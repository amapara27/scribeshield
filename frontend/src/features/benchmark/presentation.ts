import type { BenchmarkResponse } from "@/types/api";

export interface HomeHeadlineMetric {
  label: string;
  value: string;
  detail: string;
}

export interface HomeProofBadge {
  label: string;
  value: string;
  detail: string;
  tone: "mint" | "sand" | "coral";
}

export interface HomeAblationStage {
  stage: string;
  description: string;
  wer: string;
  delta: string;
  widthRatio: number;
}

export interface HomeScenarioCard {
  category: string;
  clipCount: number;
  rawWer: string;
  correctedWer: string;
  improvement: string;
  difficulty: string;
}

export interface HomeBenchmarkViewModel {
  headlineMetrics: HomeHeadlineMetric[];
  proofBadges: HomeProofBadge[];
  ablationStages: HomeAblationStage[];
  scenarios: HomeScenarioCard[];
  totalClipCount: number;
}

export const toPercentValue = (
  value: number | null | undefined,
): number | null => {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  return Math.abs(value) <= 1 ? value * 100 : value;
};

export const formatPercent = (
  value: number | null | undefined,
  decimals = 1,
): string => {
  const pct = toPercentValue(value);
  if (pct === null) return "n/a";
  return `${pct.toFixed(decimals)}%`;
};

const average = (values: number[]): number =>
  values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;

const findModelBenchmark = (
  benchmark: BenchmarkResponse,
  id: string,
) => benchmark.model_benchmarks?.find((row) => row.id === id) ?? null;

export const mapHomeBenchmarkData = (
  benchmark: BenchmarkResponse,
): HomeBenchmarkViewModel => {
  const baselineScribe =
    findModelBenchmark(benchmark, "scribe_v2")?.avg_wer ??
    benchmark.aggregate.avg_raw_wer;
  const baselineWhisper =
    findModelBenchmark(benchmark, "base_whisper_small")?.avg_wer ??
    benchmark.comparison?.base_model.avg_wer ??
    null;

  const maxAblationWer = Math.max(
    1,
    ...benchmark.ablation.map((row) => toPercentValue(row.wer) ?? 0),
  );

  const scenarioGroups = benchmark.results.reduce<
    Record<
      string,
      {
        clipCount: number;
        rawWer: number[];
        correctedWer: number[];
        improvement: number[];
        difficulties: Set<string>;
      }
    >
  >((acc, row) => {
    if (!acc[row.category]) {
      acc[row.category] = {
        clipCount: 0,
        rawWer: [],
        correctedWer: [],
        improvement: [],
        difficulties: new Set(),
      };
    }

    acc[row.category].clipCount += 1;
    acc[row.category].rawWer.push(toPercentValue(row.raw_wer) ?? 0);
    acc[row.category].correctedWer.push(toPercentValue(row.corrected_wer) ?? 0);
    acc[row.category].improvement.push(toPercentValue(row.improvement_pct) ?? 0);
    acc[row.category].difficulties.add(row.difficulty);
    return acc;
  }, {});

  const scenarios = Object.entries(scenarioGroups)
    .map(([category, values]) => ({
      category,
      clipCount: values.clipCount,
      rawWer: formatPercent(average(values.rawWer)),
      correctedWer: formatPercent(average(values.correctedWer)),
      improvement: formatPercent(average(values.improvement)),
      difficulty:
        values.difficulties.size > 1
          ? "Mixed difficulty"
          : `${Array.from(values.difficulties)[0]} set`,
      improvementValue: average(values.improvement),
    }))
    .sort((a, b) => b.improvementValue - a.improvementValue)
    .map(({ improvementValue, ...scenario }) => scenario);

  return {
    headlineMetrics: [
      {
        label: "Baseline ScribeV2",
        value: formatPercent(baselineScribe),
        detail: "Untouched ElevenLabs Scribe v2 on benchmark telephony audio, with no ScribeShield additions.",
      },
      {
        label: "Baseline Whisper Small",
        value: formatPercent(baselineWhisper),
        detail: "Plain `openai/whisper-small` on the same clips, without preprocessing, keyterms, or verification.",
      },
      {
        label: "ScribeShield corrected",
        value: formatPercent(benchmark.aggregate.avg_corrected_wer),
        detail: "Full pipeline output after preprocessing, dynamic keyterms, uncertainty scoring, Tavily, and Claude.",
      },
      {
        label: "Lift vs ScribeV2",
        value: formatPercent(benchmark.aggregate.avg_improvement_pct),
        detail: "Average relative WER reduction from untouched Scribe v2 baseline to final corrected output.",
      },
    ],
    proofBadges: [
      {
        label: "Verified corrections",
        value: formatPercent(benchmark.metrics.verification_rate),
        detail: "Corrections supported by external verification.",
        tone: "mint",
      },
      {
        label: "Uncertainty surfaced",
        value: formatPercent(benchmark.metrics.uncertainty_coverage),
        detail: "Problem tokens flagged before being rewritten.",
        tone: "sand",
      },
      {
        label: "Phonetic signal hit",
        value: formatPercent(benchmark.metrics.phonetic_hit_rate),
        detail: "Verified fixes that tripped the phonetic risk detector.",
        tone: "coral",
      },
    ],
    ablationStages: benchmark.ablation.map((row, index) => {
      const werValue = toPercentValue(row.wer) ?? 0;
      const deltaValue = toPercentValue(row.delta);
      return {
        stage: row.stage,
        description: row.description,
        wer: formatPercent(row.wer),
        delta:
          index === 0 || deltaValue === null
            ? "Baseline"
            : `${formatPercent(deltaValue)} better`,
        widthRatio: Math.max(werValue / maxAblationWer, 0.12),
      };
    }),
    scenarios,
    totalClipCount: benchmark.results.length,
  };
};
