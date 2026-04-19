import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ArrowRight, Upload, Shield, Search } from "lucide-react";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";

const Landing = () => {
  return (
    <div className="min-h-screen">
      <Navbar />

      {/* Hero */}
      <section className="bg-primary text-primary-foreground pt-32 pb-16">
        <div className="container mx-auto px-6 max-w-[800px]">
          <p className="text-accent text-sm font-medium tracking-wide uppercase mb-3">ScribeShield — Verification-Augmented STT</p>
          <h1 className="text-3xl md:text-4xl font-bold leading-snug text-primary-foreground">
            Speech-to-text that knows when it might be wrong.
          </h1>
          <p className="text-base text-primary-foreground/70 mt-4 max-w-xl">
            A confidence-gated reliability layer for STT in noisy, high-stakes clinical environments. Tavily-verified corrections, zero hallucinated guesses.
          </p>
          <div className="flex gap-3 mt-6">
            <Button asChild size="sm" className="bg-accent text-accent-foreground hover:bg-accent/90 rounded-md px-5 text-sm">
              <Link to="/clinic">Try Clinic <ArrowRight className="ml-1.5 h-3.5 w-3.5" /></Link>
            </Button>
            <Button asChild size="sm" className="border border-primary-foreground/20 bg-transparent text-primary-foreground hover:bg-primary-foreground/10 rounded-md px-5 text-sm">
              <Link to="/emergency">Emergency Demo</Link>
            </Button>
          </div>
        </div>
      </section>

      {/* Key numbers — compact, understated */}
      <section className="py-8 bg-background border-b">
        <div className="container mx-auto px-6 max-w-[800px]">
          <div className="flex flex-wrap justify-center gap-x-12 gap-y-4 text-center text-sm">
            <div>
              <span className="text-lg font-semibold text-foreground">21.4%</span>
              <p className="text-muted-foreground text-xs mt-0.5">Raw WER (telephony)</p>
            </div>
            <div>
              <span className="text-lg font-semibold text-foreground">37%</span>
              <p className="text-muted-foreground text-xs mt-0.5">Fewer medical term errors</p>
            </div>
            <div>
              <span className="text-lg font-semibold text-foreground">0%</span>
              <p className="text-muted-foreground text-xs mt-0.5">Hallucinated corrections</p>
            </div>
          </div>
        </div>
      </section>

      {/* Problem */}
      <section className="py-16 bg-background">
        <div className="container mx-auto px-6 max-w-[800px]">
          <h2 className="text-xl font-bold mb-2">The Problem</h2>
          <p className="text-sm text-muted-foreground mb-8 max-w-lg">
            Standard STT produces confident-looking transcripts even when audio is degraded. The issue isn't that it's wrong — it's that it doesn't signal uncertainty.
          </p>
          <div className="space-y-4">
            {[
              { title: "Telephony audio", desc: "8kHz bandwidth strips phonemes. methotrexate vs metformin becomes a coin flip." },
              { title: "Medical terminology", desc: "Drug names and dosages don't appear in standard training data. Models pattern-match to common words." },
              { title: "Silent failure", desc: "No confidence flag, no uncertainty marker. The transcript looks correct and gets acted on." },
            ].map((item) => (
              <div key={item.title} className="border rounded-md p-4">
                <h3 className="text-sm font-semibold text-foreground">{item.title}</h3>
                <p className="text-sm text-muted-foreground mt-1">{item.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="py-16 bg-secondary">
        <div className="container mx-auto px-6 max-w-[800px]">
          <h2 className="text-xl font-bold mb-8">How It Works</h2>
          <div className="space-y-6">
            {[
              { step: "1", icon: <Upload className="h-5 w-5 text-accent" />, title: "Scribe v2 Transcribes", desc: "ElevenLabs Scribe v2 with dynamic keyterm prompting. Word-level timestamps and speaker diarization." },
              { step: "2", icon: <Shield className="h-5 w-5 text-accent" />, title: "Uncertainty Detection", desc: "Composite confidence score from timing gaps, phonetic distance, keyterm mismatch, and correction history." },
              { step: "3", icon: <Search className="h-5 w-5 text-accent" />, title: "Tavily Verification", desc: "Low-confidence words verified against Tavily. Confirmed → corrected. Unconfirmed → flagged [UNVERIFIED]." },
            ].map((s) => (
              <div key={s.step} className="flex gap-4 items-start">
                <div className="flex items-center justify-center w-9 h-9 rounded-full bg-accent/10 shrink-0 mt-0.5">
                  {s.icon}
                </div>
                <div>
                  <p className="text-xs text-muted-foreground font-medium mb-0.5">Step {s.step}</p>
                  <h3 className="text-sm font-semibold text-foreground">{s.title}</h3>
                  <p className="text-sm text-muted-foreground mt-0.5">{s.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Built with */}
      <section className="py-8 bg-background border-t">
        <div className="container mx-auto px-6 max-w-[800px]">
          <p className="text-xs text-muted-foreground text-center">
            Built with ElevenLabs · Tavily · Claude
          </p>
        </div>
      </section>

      <Footer />
    </div>
  );
};

export default Landing;
