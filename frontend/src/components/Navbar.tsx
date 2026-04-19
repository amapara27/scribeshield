import { useState, useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import { Menu, X } from "lucide-react";
import { Button } from "@/components/ui/button";

const Navbar = () => {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  const isHome = location.pathname === "/";

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 80);
    window.addEventListener("scroll", onScroll);
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const navBg = isHome && !scrolled
    ? "bg-transparent"
    : "bg-background shadow-card";

  const textColor = isHome && !scrolled
    ? "text-primary-foreground"
    : "text-foreground";

  return (
    <nav className={`fixed top-0 left-0 right-0 z-50 transition-all duration-200 ${navBg}`}>
      <div className="container mx-auto flex items-center justify-between px-6 py-4 max-w-[1100px]">
        <Link to="/" className={`text-xl font-bold tracking-tight ${textColor}`}>
          Scribe<span className="text-accent">Shield</span>
        </Link>

        {/* Desktop nav */}
        <div className="hidden md:flex items-center gap-6">
          <Link to="/" className={`text-sm font-medium hover:text-accent transition-colors ${textColor}`}>Home</Link>
          <Link to="/clinic" className={`text-sm font-medium hover:text-accent transition-colors ${textColor}`}>Clinic</Link>
          <Link to="/emergency" className={`text-sm font-medium hover:text-accent transition-colors ${textColor}`}>Emergency</Link>
          <Link to="/benchmark" className={`text-sm font-medium hover:text-accent transition-colors ${textColor}`}>Benchmark</Link>
          <Button asChild variant="default" className="bg-accent text-accent-foreground hover:bg-accent/90 rounded-pill px-6">
            <Link to="/clinic">Try Clinic</Link>
          </Button>
        </div>

        {/* Mobile toggle */}
        <button className={`md:hidden ${textColor}`} onClick={() => setMenuOpen(!menuOpen)}>
          {menuOpen ? <X size={24} /> : <Menu size={24} />}
        </button>
      </div>

      {/* Mobile menu */}
      {menuOpen && (
        <div className="md:hidden bg-background border-t px-6 py-4 space-y-3 shadow-card">
          <Link to="/" className="block text-sm font-medium text-foreground" onClick={() => setMenuOpen(false)}>Home</Link>
          <Link to="/clinic" className="block text-sm font-medium text-foreground" onClick={() => setMenuOpen(false)}>Clinic</Link>
          <Link to="/emergency" className="block text-sm font-medium text-foreground" onClick={() => setMenuOpen(false)}>Emergency</Link>
          <Link to="/benchmark" className="block text-sm font-medium text-foreground" onClick={() => setMenuOpen(false)}>Benchmark</Link>
          <Button asChild variant="default" className="bg-accent text-accent-foreground w-full rounded-pill">
            <Link to="/clinic" onClick={() => setMenuOpen(false)}>Try Clinic</Link>
          </Button>
        </div>
      )}
    </nav>
  );
};

export default Navbar;
