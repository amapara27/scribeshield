import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import HomeCta from "@/components/home/HomeCta";
import HomeHero from "@/components/home/HomeHero";
import HomeMetricRail from "@/components/home/HomeMetricRail";
import HomeProofSection from "@/components/home/HomeProofSection";
import HomeScenarioSection from "@/components/home/HomeScenarioSection";
import { useHomeBenchmarkData } from "@/hooks/use-home-benchmark";

const Landing = () => {
  const {
    headlineMetrics,
    proofBadges,
    ablationStages,
    scenarios,
    dataSource,
    isRefreshing,
    totalClipCount,
  } = useHomeBenchmarkData();

  return (
    <div className="home-page min-h-screen">
      <Navbar />
      <HomeHero
        proofBadges={proofBadges}
        dataSource={dataSource}
        isRefreshing={isRefreshing}
        totalClipCount={totalClipCount}
      />
      <HomeMetricRail metrics={headlineMetrics} />
      <HomeProofSection stages={ablationStages} />
      <HomeScenarioSection
        scenarios={scenarios}
        proofBadges={proofBadges}
        dataSource={dataSource}
      />
      <HomeCta />
      <Footer variant="editorial" />
    </div>
  );
};

export default Landing;
