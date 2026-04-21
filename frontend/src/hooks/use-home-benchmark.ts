import { useQuery } from "@tanstack/react-query";
import { mapHomeBenchmarkData } from "@/features/benchmark/presentation";
import { fetchBenchmark } from "@/services/api";
import { MOCK_BENCHMARK } from "@/services/mockData";

export const useHomeBenchmarkData = () => {
  const query = useQuery({
    queryKey: ["benchmark", "home"],
    queryFn: () => fetchBenchmark("all"),
    retry: false,
    staleTime: 60_000,
  });

  const benchmark = query.data ?? MOCK_BENCHMARK;

  return {
    ...mapHomeBenchmarkData(benchmark),
    benchmark,
    dataSource: query.data ? ("live" as const) : ("snapshot" as const),
    isRefreshing: query.isFetching,
    hasLiveError: Boolean(query.error),
  };
};
