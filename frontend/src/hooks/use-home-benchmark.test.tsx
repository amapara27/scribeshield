import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatPercent } from "@/features/benchmark/presentation";
import { MOCK_BENCHMARK } from "@/services/mockData";
import { useHomeBenchmarkData } from "@/hooks/use-home-benchmark";
import { fetchBenchmark } from "@/services/api";

vi.mock("@/services/api", () => ({
  fetchBenchmark: vi.fn(),
}));

const Harness = () => {
  const { headlineMetrics, dataSource, hasLiveError } = useHomeBenchmarkData();

  return (
    <div>
      {headlineMetrics.map((metric) => (
        <div key={metric.label}>
          {metric.label}:{metric.value}
        </div>
      ))}
      <div>source:{dataSource}</div>
      <div>error:{hasLiveError ? "yes" : "no"}</div>
    </div>
  );
};

const renderHarness = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <Harness />
    </QueryClientProvider>,
  );
};

describe("useHomeBenchmarkData", () => {
  beforeEach(() => {
    vi.mocked(fetchBenchmark).mockReset();
  });

  it("renders live benchmark headline values when the API succeeds", async () => {
    vi.mocked(fetchBenchmark).mockResolvedValue({
      ...MOCK_BENCHMARK,
      aggregate: {
        ...MOCK_BENCHMARK.aggregate,
        avg_raw_wer: 0.249,
        avg_corrected_wer: 15.7,
        avg_improvement_pct: 0.37,
      },
      model_benchmarks: (MOCK_BENCHMARK.model_benchmarks ?? []).map((row) =>
        row.id === "scribe_v2"
          ? { ...row, avg_wer: 0.249 }
          : row.id === "base_whisper_small"
            ? { ...row, avg_wer: 0.31 }
            : row,
      ),
    });

    renderHarness();

    await waitFor(() =>
      expect(screen.getByText("source:live")).toBeInTheDocument(),
    );

    expect(screen.getByText("Baseline ScribeV2:24.9%")).toBeInTheDocument();
    expect(screen.getByText("Baseline Whisper Small:31.0%")).toBeInTheDocument();
    expect(screen.getByText("ScribeShield corrected:15.7%")).toBeInTheDocument();
    expect(screen.getByText("Lift vs ScribeV2:37.0%")).toBeInTheDocument();
    expect(screen.getByText("error:no")).toBeInTheDocument();
  });

  it("falls back to shipped snapshot metrics when the API fails", async () => {
    vi.mocked(fetchBenchmark).mockRejectedValue(new Error("backend offline"));

    renderHarness();

    await waitFor(() =>
      expect(screen.getByText("error:yes")).toBeInTheDocument(),
    );

    expect(screen.getByText("source:snapshot")).toBeInTheDocument();
    expect(
      screen.getByText(
        `Baseline ScribeV2:${formatPercent(
          MOCK_BENCHMARK.model_benchmarks?.find((row) => row.id === "scribe_v2")?.avg_wer,
        )}`,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        `ScribeShield corrected:${formatPercent(
          MOCK_BENCHMARK.aggregate.avg_corrected_wer,
        )}`,
      ),
    ).toBeInTheDocument();
  });
});
