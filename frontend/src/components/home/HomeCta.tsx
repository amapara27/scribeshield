import { ArrowRight, Siren } from "lucide-react";
import { Link } from "react-router-dom";
import FadeInSection from "@/components/FadeInSection";
import { Button } from "@/components/ui/button";

const HomeCta = () => (
  <section className="px-6 pt-6 pb-16 sm:px-8 lg:px-10">
    <FadeInSection className="mx-auto w-full max-w-7xl">
      <div className="rounded-[36px] bg-[hsl(var(--home-ink))] px-6 py-10 text-white shadow-[0_30px_80px_rgba(18,32,51,0.22)] sm:px-8 lg:px-10">
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
          <div className="max-w-3xl">
            <p className="home-eyebrow text-[11px] font-semibold text-white/65">
              Next step
            </p>
            <h2 className="mt-4 font-display text-4xl tracking-[-0.04em] text-white sm:text-5xl">
              Explore the clinic demo, read the architecture, then pressure-test the benchmark.
            </h2>
            <p className="mt-4 max-w-2xl text-base leading-7 text-white/70">
              The Home page should make the promise legible. The architecture
              page explains the model stack and safety layers, and the clinic
              plus benchmark pages show how that stack behaves in practice.
            </p>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row lg:flex-col">
            <Button
              asChild
              size="lg"
              className="h-12 rounded-full bg-white px-6 text-[hsl(var(--home-ink))] hover:bg-white/90"
            >
              <Link to="/clinic">
                Try clinic workflow
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
            <Button
              asChild
              size="lg"
              variant="outline"
              className="h-12 rounded-full border-white/20 bg-transparent px-6 text-white hover:bg-white/10 hover:text-white"
            >
              <Link to="/architecture">
                Read architecture
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
            <Button
              asChild
              size="lg"
              variant="outline"
              className="h-12 rounded-full border-white/20 bg-transparent px-6 text-white hover:bg-white/10 hover:text-white"
            >
              <Link to="/emergency">
                <Siren className="h-4 w-4" />
                Open emergency demo
              </Link>
            </Button>
          </div>
        </div>
      </div>
    </FadeInSection>
  </section>
);

export default HomeCta;
