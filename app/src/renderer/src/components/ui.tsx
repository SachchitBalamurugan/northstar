// Shared primitives matched to sentient-os.ai. See app/DESIGN.md. Every screen uses these.
import { motion } from "framer-motion";
import type { ReactNode, ButtonHTMLAttributes } from "react";

/* ---------- type ---------- */
export function Eyebrow({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <p className={`text-[12px] font-medium uppercase tracking-[0.14em] text-faint ${className}`}>{children}</p>;
}

/** Big two-line Cabinet headline. Lines fade/rise in one after another. */
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
/** White pill with a breathing rainbow glow behind it. One per screen. */
export function PrimaryButton({ children, className = "", glow = true, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { glow?: boolean }) {
  return (
    <span className="no-drag relative isolate inline-flex">
      {glow && <span aria-hidden className="cta-glow" />}
      <button {...rest}
        className={`relative inline-flex h-[50px] items-center justify-center gap-2 rounded-full bg-white px-6 text-[15px] font-medium text-black transition-[transform,opacity] duration-150 hover:opacity-95 active:scale-[0.98] disabled:opacity-40 ${className}`}>
        {children}
      </button>
    </span>
  );
}

/** Glass pill: rgba(255,255,255,.06) with a 38% white hairline. */
export function SecondaryButton({ children, className = "", ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...rest}
      className={`no-drag inline-flex h-[50px] items-center justify-center gap-2 rounded-full border-[0.8px] border-white/38 bg-white/[0.06] px-5 text-[15px] text-ink transition-colors duration-150 hover:bg-white/[0.1] active:scale-[0.98] ${className}`}>
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
    <div className={`no-drag inline-flex items-center gap-1 rounded-full border-[0.8px] border-glass-line bg-glass p-[9.5px] backdrop-blur-[12px] ${className}`}>
      {children}
    </div>
  );
}

/** Sentient's macOS-style app window. */
/** Window traffic-light dots, in Antigravity's Google neon colors. */
const DOTS = ["#FF5C5C", "#FFC93C", "#3DDC84"];

/** Sentient's app window with an Antigravity neon edge. `glow` adds the full multi-color halo. */
export function Window({ title, icon, tag, meta, children, className = "", bodyClassName = "", glow = false }: {
  title?: string; icon?: ReactNode; tag?: string; meta?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string; glow?: boolean;
}) {
  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: "easeOut" }}
      className={`rounded-[18px] ${glow ? "neon-frame" : "neon-line relative"} ${className}`}>
      <div className="h-full overflow-hidden rounded-[18px] bg-surface text-warm shadow-[0_24px_80px_rgba(0,0,0,0.38),inset_0_1px_0_rgba(255,255,255,0.03)]">
        {title !== undefined && (
          <div className="flex h-[52px] items-center gap-3 border-b-[0.8px] border-line bg-[linear-gradient(180deg,rgba(76,141,255,0.06),transparent)] px-5">
            <span className="flex gap-1.5">{DOTS.map(c => <span key={c} className="h-2.5 w-2.5 rounded-full opacity-80" style={{ background: c, boxShadow: `0 0 6px ${c}88` }} />)}</span>
            {icon && <span className="ml-2 neon-text-blue">{icon}</span>}
            <span className="text-[15px] font-medium text-ink">{title}</span>
            {tag && <span className="rounded-[5px] border-[0.8px] border-[#4C8DFF]/40 bg-[#4C8DFF]/10 px-1.5 py-0.5 text-[10px] font-medium tracking-[0.08em] text-[#8AB4FF] uppercase">{tag}</span>}
            {meta && <span className="ml-auto text-[12px] text-faint">{meta}</span>}
          </div>
        )}
        <div className={bodyClassName}>{children}</div>
      </div>
    </motion.div>
  );
}

/** Plain dark card (alias kept for older screens). */
export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease: "easeOut" }}
      className={`rounded-[18px] border-[0.8px] border-line bg-surface shadow-[0_24px_80px_rgba(0,0,0,0.33),inset_0_1px_0_rgba(255,255,255,0.02)] ${className}`}>
      {children}
    </motion.div>
  );
}

/** "Proactive intelligence" card: soft orange glowing edge. For the single most important item. */
export function GlowCard({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45, ease: "easeOut" }}
      className="neon-frame rounded-[18px]">
      {/* stronger halo for the hero card: blue top, pink/violet sides, warm bottom */}
      <span aria-hidden className="pointer-events-none absolute -inset-6 -z-10 rounded-[30px] opacity-80 blur-[28px]"
        style={{ background: "radial-gradient(55% 45% at 50% 0%, rgba(76,141,255,.45), transparent 70%), radial-gradient(45% 60% at 0% 60%, rgba(255,79,216,.25), transparent 70%), radial-gradient(45% 60% at 100% 60%, rgba(167,139,250,.3), transparent 70%), radial-gradient(60% 45% at 50% 100%, rgba(255,180,92,.25), transparent 70%)" }} />
      <div className={`relative rounded-[18px] bg-[linear-gradient(180deg,#10121A,#0B0B0D_55%)] ${className}`}>{children}</div>
    </motion.div>
  );
}

export function AppChip({ icon, label, active = false, onClick }: { icon: ReactNode; label: string; active?: boolean; onClick?: () => void }) {
  return (
    <button onClick={onClick}
      className={`no-drag inline-flex h-[52px] items-center gap-3 rounded-[14px] border-[0.8px] px-3.5 pr-4 text-[15px] transition-colors duration-150 ${active ? "border-white/20 bg-white/[0.08] text-ink" : "border-line bg-surface/80 text-warm hover:bg-white/[0.05]"}`}>
      <span className="flex h-8 w-8 items-center justify-center rounded-[9px] bg-white/[0.08]">{icon}</span>
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
            className={`no-drag relative flex w-full items-center gap-4 py-2.5 pl-4 text-left text-[16px] transition-colors duration-200 ${i === active ? "text-ink" : "text-muted hover:text-warm"}`}>
            <span aria-hidden className={`absolute inset-y-1 left-0 w-[2px] rounded-full transition-opacity duration-200 ${i === active ? "opacity-100" : "opacity-0"}`}
              style={{ background: "linear-gradient(180deg,#4C8DFF,#A78BFA,#FF4FD8)", boxShadow: "0 0 10px rgba(167,139,250,.8)" }} />
            <span className={`w-6 text-[13px] tabular-nums ${i === active ? "neon-text-violet" : "text-faint"}`}>{String(i + 1).padStart(2, "0")}</span>
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

/** Soft colored blooms in the corners, like Sentient's hero. Place once, behind everything. */
export function AmbientGlow() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      {/* Antigravity dot field */}
      <div className="dot-field absolute inset-0 opacity-70" />
      {/* Neon blooms: Google blue, violet, pink, warm, green */}
      <div className="absolute -top-40 -left-40 h-[540px] w-[540px] rounded-full bg-[#4C8DFF] opacity-[0.22] blur-[140px]" />
      <div className="absolute -top-56 left-[32%] h-[440px] w-[560px] rounded-full bg-[#A78BFA] opacity-[0.16] blur-[150px]" />
      <div className="absolute -top-40 -right-32 h-[460px] w-[460px] rounded-full bg-[#FF4FD8] opacity-[0.14] blur-[140px]" />
      <div className="absolute -bottom-56 -left-24 h-[420px] w-[520px] rounded-full bg-[#3DDC84] opacity-[0.07] blur-[150px]" />
      <div className="absolute -right-24 -bottom-56 h-[420px] w-[520px] rounded-full bg-[#FFC93C] opacity-[0.07] blur-[150px]" />
    </div>
  );
}

export type Tone = "default" | "accent" | "blue" | "green" | "yellow" | "pink" | "violet";
const TONES: Record<Tone, string> = {
  default: "bg-white/[0.06] text-muted",
  accent: "bg-[#FF8A5C]/15 text-[#FFB08F] shadow-[0_0_12px_rgba(255,138,92,.25)]",
  blue: "bg-[#4C8DFF]/15 text-[#8AB4FF] shadow-[0_0_12px_rgba(76,141,255,.25)]",
  green: "bg-[#3DDC84]/12 text-[#7CF0B0] shadow-[0_0_12px_rgba(61,220,132,.22)]",
  yellow: "bg-[#FFC93C]/12 text-[#FFD975] shadow-[0_0_12px_rgba(255,201,60,.2)]",
  pink: "bg-[#FF4FD8]/12 text-[#FF8AE2] shadow-[0_0_12px_rgba(255,79,216,.22)]",
  violet: "bg-[#A78BFA]/15 text-[#C4B5FD] shadow-[0_0_12px_rgba(167,139,250,.25)]",
};
export function Chip({ children, tone = "default" }: { children: ReactNode; tone?: Tone }) {
  return <span className={`inline-flex h-6 items-center rounded-full px-2.5 text-[12px] font-medium ${TONES[tone]}`}>{children}</span>;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded-[5px] border-[0.8px] border-black/15 bg-black/[0.06] px-1.5 py-0.5 font-sans text-[11px] text-black/60">{children}</kbd>;
}

/** Glowing ring logo mark (our own, not Sentient's). */
export function LogoMark({ size = 30 }: { size?: number }) {
  return (
    <span className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <span className="absolute inset-0 rounded-full bg-[conic-gradient(from_200deg,#4C8DFF,#A78BFA,#FF4FD8,#FFC93C,#3DDC84,#4C8DFF)] opacity-60 blur-[8px]" />
      <svg viewBox="0 0 32 32" width={size} height={size} className="relative">
        <circle cx="16" cy="16" r="13" fill="none" stroke="white" strokeWidth="2" />
        <path d="M16 9 L17.6 14.4 L23 16 L17.6 17.6 L16 23 L14.4 17.6 L9 16 L14.4 14.4 Z" fill="white" />
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
