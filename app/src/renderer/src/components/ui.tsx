// Shared primitives, design system v2 ("Star chart"). See app/DESIGN.md. Every screen uses these.
import { motion } from "framer-motion";
import type { ReactNode, ButtonHTMLAttributes } from "react";

/* ---------- type ---------- */
export function Eyebrow({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <p className={`font-mono text-[11.5px] font-medium uppercase tracking-[0.08em] text-faint ${className}`}>{children}</p>;
}

/** Big two-line Manrope headline. Lines fade/rise in one after another. */
export function Heading({ eyebrow, children, size = "lg", className = "" }: { eyebrow?: string; children: ReactNode; size?: "xl" | "lg" | "md"; className?: string }) {
  const sz = size === "xl" ? "text-[60px]" : size === "lg" ? "text-[48px]" : "text-[34px]";
  return (
    <header className={`mb-10 ${className}`}>
      {eyebrow && <Eyebrow className="mb-4">{eyebrow}</Eyebrow>}
      <motion.h1 initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45, ease: "easeOut" }}
        className={`display ${sz} text-ink`}>
        {children}
      </motion.h1>
    </header>
  );
}

export function Lead({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <p className={`text-[18px] leading-[1.6] tracking-[-0.012em] text-muted ${className}`}>{children}</p>;
}

export function Why({ children }: { children: ReactNode }) {
  return <p className="text-[15px] leading-relaxed text-muted">{children}</p>;
}

/* ---------- buttons ---------- */
/** Solid mint button, 10px radius, no glow. One per screen. (`glow` kept for API compatibility; ignored.) */
export function PrimaryButton({ children, className = "", glow: _glow = true, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { glow?: boolean }) {
  return (
    <span className="no-drag relative inline-flex">
      <button {...rest}
        className={`relative inline-flex h-[46px] items-center justify-center gap-2 rounded-[10px] bg-accent px-5 text-[15px] font-semibold text-accent-ink transition-[transform,opacity,filter] duration-150 ease-out hover:-translate-y-px hover:brightness-105 active:translate-y-0 active:scale-[0.98] disabled:opacity-40 ${className}`}>
        {children}
      </button>
    </span>
  );
}

/** Outline button: transparent with a strong hairline. */
export function SecondaryButton({ children, className = "", ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...rest}
      className={`no-drag inline-flex h-[46px] items-center justify-center gap-2 rounded-[10px] border border-line-strong bg-transparent px-5 text-[15px] font-medium text-ink transition-colors duration-150 hover:bg-white/[0.04] active:scale-[0.98] ${className}`}>
      {children}
    </button>
  );
}

export function TextLink({ children, className = "", ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...rest} className={`no-drag text-[14px] text-muted transition-colors duration-150 hover:text-ink ${className}`}>
      {children}
    </button>
  );
}

/* ---------- surfaces ---------- */
export function GlassPill({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`no-drag inline-flex items-center gap-1 rounded-[10px] border border-line bg-surface/80 p-1.5 backdrop-blur-[8px] ${className}`}>
      {children}
    </div>
  );
}

/** Instrument-panel window: mono label + hairline header. */
export function Window({ title, icon, tag, meta, children, className = "", bodyClassName = "" }: {
  title?: string; icon?: ReactNode; tag?: string; meta?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string;
}) {
  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: "easeOut" }}
      className={`overflow-hidden rounded-[14px] border border-line bg-surface text-warm shadow-[inset_0_1px_0_rgba(255,255,255,0.03),0_12px_32px_rgba(0,0,0,0.35)] ${className}`}>
      {title !== undefined && (
        <div className="flex h-[46px] items-center gap-3 border-b border-line px-5">
          <span aria-hidden className="h-1.5 w-1.5 rounded-[1px] bg-accent/70" />
          {icon && <span className="text-muted">{icon}</span>}
          <span className="font-mono text-[11.5px] font-medium uppercase tracking-[0.08em] text-warm">{title}</span>
          {tag && <span className="rounded-[6px] border border-line px-1.5 py-0.5 font-mono text-[10px] font-medium tracking-[0.08em] text-muted uppercase">{tag}</span>}
          {meta && <span className="ml-auto font-mono text-[11px] text-faint">{meta}</span>}
        </div>
      )}
      <div className={bodyClassName}>{children}</div>
    </motion.div>
  );
}

/** Plain dark card (alias kept for older screens). */
export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease: "easeOut" }}
      className={`rounded-[14px] border border-line bg-surface shadow-[inset_0_1px_0_rgba(255,255,255,0.03),0_12px_32px_rgba(0,0,0,0.35)] ${className}`}>
      {children}
    </motion.div>
  );
}

/** Highlight card: mint hairline border + thin mint top accent. For the single most important item. */
export function GlowCard({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45, ease: "easeOut" }}
      className={`relative overflow-hidden rounded-[14px] border border-accent/30 bg-surface shadow-[0_12px_32px_rgba(0,0,0,0.35)] ${className}`}>
      <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[2px] bg-accent/80" />
      {children}
    </motion.div>
  );
}

export function AppChip({ icon, label, active = false, onClick }: { icon: ReactNode; label: string; active?: boolean; onClick?: () => void }) {
  return (
    <button onClick={onClick}
      className={`no-drag inline-flex h-[52px] items-center gap-3 rounded-[10px] border px-3.5 pr-4 text-[15px] transition-colors duration-150 ${active ? "border-accent/40 bg-accent/[0.06] text-ink" : "border-line bg-surface/80 text-warm hover:border-line-strong hover:bg-white/[0.04]"}`}>
      <span className="flex h-8 w-8 items-center justify-center rounded-[8px] bg-white/[0.05]">{icon}</span>
      {label}
    </button>
  );
}

/** "01 Finish applications" list. Active row: accent left rule + white text. */
export function NumberedList({ items, active, onSelect }: { items: string[]; active: number; onSelect?: (i: number) => void }) {
  return (
    <ol className="flex flex-col">
      {items.map((label, i) => (
        <li key={label + i}>
          <button onClick={() => onSelect?.(i)}
            className={`no-drag flex w-full items-center gap-4 border-l py-2.5 pl-4 text-left text-[16px] transition-colors duration-200 ${i === active ? "border-accent text-ink" : "border-transparent text-muted hover:text-warm"}`}>
            <span className={`w-6 font-mono text-[12px] tabular-nums ${i === active ? "text-accent" : "text-faint"}`}>{String(i + 1).padStart(2, "0")}</span>
            <span className="truncate">{label}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}

export function Stripes({ className = "" }: { className?: string }) {
  return <div aria-hidden className={`stripes h-14 w-full ${className}`} />;
}

/** Very subtle mint/blue vignette plus the faint chart grid. Place once, behind everything. */
export function AmbientGlow() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <div className="chart-grid absolute inset-0 [mask-image:radial-gradient(ellipse_at_50%_0%,black_30%,transparent_80%)]" />
      <div className="absolute -top-48 -left-40 h-[520px] w-[620px] rounded-full bg-accent opacity-[0.05] blur-[150px]" />
      <div className="absolute -top-48 -right-40 h-[480px] w-[560px] rounded-full bg-blue opacity-[0.05] blur-[150px]" />
    </div>
  );
}

type ChipTone = "default" | "neutral" | "accent" | "mint" | "blue" | "amber";
const CHIP: Record<ChipTone, string> = {
  default: "border-line bg-white/[0.03] text-muted",
  neutral: "border-line bg-white/[0.03] text-muted",
  accent: "border-accent/25 bg-accent/10 text-accent",
  mint: "border-accent/25 bg-accent/10 text-accent",
  blue: "border-blue/25 bg-blue/10 text-blue",
  amber: "border-warn/25 bg-warn/10 text-warn",
};
export function Chip({ children, tone = "default" }: { children: ReactNode; tone?: ChipTone }) {
  return (
    <span className={`inline-flex h-6 items-center rounded-[6px] border px-2 font-mono text-[11px] font-medium tracking-[0.04em] ${CHIP[tone]}`}>
      {children}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded-[5px] border border-line-strong bg-raised px-1.5 py-0.5 font-mono text-[10.5px] text-muted">{children}</kbd>;
}

/** Northstar mark: a mint 4-point north star inside a thin compass ring. */
export function LogoMark({ size = 30 }: { size?: number }) {
  return (
    <span className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden>
        <circle cx="16" cy="16" r="13.5" fill="none" stroke="var(--line-strong)" strokeWidth="1.25" />
        <path d="M16 1.5 V4.5 M16 27.5 V30.5 M1.5 16 H4.5 M27.5 16 H30.5" stroke="var(--muted)" strokeWidth="1.25" strokeLinecap="round" />
        <path d="M16 6.5 L18 14 L25.5 16 L18 18 L16 25.5 L14 18 L6.5 16 L14 14 Z" fill="var(--accent)" />
      </svg>
    </span>
  );
}

/* ---------- helpers ---------- */
export function relTime(iso?: string) {
  if (!iso) return "";
  const diff = new Date(iso).getTime() - Date.now(); const h = Math.round(diff / 36e5);
  if (Math.abs(h) < 1) return "now";
  if (h > 0 && h < 24) return `in ${h}h`;
  if (h >= 24) return `in ${Math.round(h / 24)}d`;
  if (h > -24) return `${-h}h ago`;
  return `${Math.round(-h / 24)}d ago`;
}

export function clock(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
