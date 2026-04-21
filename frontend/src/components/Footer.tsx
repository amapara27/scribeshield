import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";

interface FooterProps {
  variant?: "default" | "editorial";
}

const Footer = ({ variant = "default" }: FooterProps) => {
  const editorial = variant === "editorial";

  return (
    <footer
      className={cn(
        "py-12",
        editorial
          ? "border-t border-[hsl(var(--home-line))] bg-[rgba(255,252,247,0.9)] text-[hsl(var(--home-ink))]"
          : "bg-primary text-primary-foreground",
      )}
    >
      <div className="container mx-auto max-w-[1100px] px-6">
        <div className="flex flex-col items-start justify-between gap-6 md:flex-row md:items-center">
          <div>
            <p className="text-lg font-bold">
              Scribe
              <span className={editorial ? "text-[hsl(var(--home-coral))]" : "text-accent"}>
                Shield
              </span>
            </p>
            <p
              className={cn(
                "mt-1 text-sm",
                editorial ? "text-[hsl(var(--home-muted))]" : "text-primary-foreground/70",
              )}
            >
              Verification-Augmented Speech-to-Text
            </p>
          </div>
          <div
            className={cn(
              "flex gap-6 text-sm",
              editorial ? "text-[hsl(var(--home-muted))]" : "text-primary-foreground/70",
            )}
          >
            <Link to="/" className="transition-colors hover:text-accent">Home</Link>
            <Link to="/architecture" className="transition-colors hover:text-accent">Architecture</Link>
            <Link to="/clinic" className="transition-colors hover:text-accent">Clinic</Link>
            <Link to="/emergency" className="transition-colors hover:text-accent">Emergency</Link>
            <Link to="/benchmark" className="transition-colors hover:text-accent">Benchmark</Link>
          </div>
        </div>
        <div
          className={cn(
            "mt-8 border-t pt-6 text-center text-xs",
            editorial
              ? "border-[hsl(var(--home-line))] text-[hsl(var(--home-muted))]"
              : "border-primary-foreground/20 text-primary-foreground/50",
          )}
        >
          Built in 12 hours at Hackathon · April 2026 · Powered by ElevenLabs +
          Tavily + Claude
        </div>
      </div>
    </footer>
  );
};

export default Footer;
