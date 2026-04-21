import type { HomeHeadlineMetric } from "@/features/benchmark/presentation";

interface HomeMetricRailProps {
  metrics: HomeHeadlineMetric[];
}

const HomeMetricRail = ({ metrics }: HomeMetricRailProps) => (
  <section className="px-6 py-4 sm:px-8 lg:px-10">
    <div className="mx-auto grid w-full max-w-7xl gap-4 md:grid-cols-2 xl:grid-cols-4">
      {metrics.map((metric) => (
        <div
          key={metric.label}
          className="home-panel rounded-[28px] p-5 transition-transform duration-300 hover:-translate-y-1"
        >
          <p className="text-sm font-semibold text-[hsl(var(--home-ink))]">
            {metric.label}
          </p>
          <p className="mt-4 font-display text-4xl tracking-[-0.05em] text-[hsl(var(--home-ink))]">
            {metric.value}
          </p>
          <p className="mt-3 text-sm leading-6 text-[hsl(var(--home-muted))]">
            {metric.detail}
          </p>
        </div>
      ))}
    </div>
  </section>
);

export default HomeMetricRail;
