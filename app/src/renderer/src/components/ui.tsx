// Shared primitives. Every screen uses these so the look stays consistent.
import { motion } from "framer-motion";
import type { ReactNode, ButtonHTMLAttributes } from "react";

export function Heading({ eyebrow, children }: { eyebrow?: string; children: ReactNode }) {
  return (
    <header className="mb-10">
      {eyebrow && <p className="mb-3 text-[13px] font-medium tracking-wide text-muted uppercase">{eyebrow}</p>}
      <h1 className="font-serif text-[52px] leading-[1.02] tracking-[-0.01em] text-ink">{children}</h1>
    </header>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, ease: "easeOut" }}
      className={`rounded-[var(--radius)] border border-line bg-surface ${className}`}>
      {children}
    </motion.div>
  );
}

export function PrimaryButton({ children, className = "", ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...rest} className={`no-drag inline-flex h-11 items-center justify-center gap-2 rounded-full bg-accent px-6 text-[15px] font-medium text-accent-ink transition-[transform,opacity] duration-150 hover:opacity-90 active:scale-[0.98] disabled:opacity-40 ${className}`}>
      {children}
    </button>
  );
}

export function TextLink({ children, className = "", ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...rest} className={`no-drag text-[15px] text-muted underline-offset-4 transition-colors duration-150 hover:text-ink hover:underline ${className}`}>
      {children}
    </button>
  );
}

export function Why({ children }: { children: ReactNode }) {
  return <p className="text-[15px] leading-relaxed text-muted">{children}</p>;
}

export function Chip({ children }: { children: ReactNode }) {
  return <span className="inline-flex h-6 items-center rounded-full bg-soft px-2.5 text-[12px] font-medium text-muted">{children}</span>;
}

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
