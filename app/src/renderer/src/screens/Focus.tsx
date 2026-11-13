import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useUI } from "@/store";
import { PrimaryButton, TextLink } from "@/components/ui";

const SIZE = 320;
const STROKE = 6;
const R = (SIZE - STROKE) / 2;
const C = 2 * Math.PI * R;

export default function Focus() {
  const { focusTask, endFocus, openCommand } = useUI();
  const [total, setTotal] = useState(() => (focusTask?.minutes ?? 25) * 60);
  const [left, setLeft] = useState(total);
  const [paused, setPaused] = useState(false);
  const [visible, setVisible] = useState(true);

  // Reset when a new task starts
  useEffect(() => {
    const t = (focusTask?.minutes ?? 25) * 60;
    setTotal(t); setLeft(t); setPaused(false);
  }, [focusTask?.title, focusTask?.minutes]);

  useEffect(() => {
    if (paused || left <= 0) return;
    const t = setInterval(() => setLeft(l => Math.max(0, l - 1)), 1000);
    return () => clearInterval(t);
  }, [paused, left <= 0]);

  const close = () => setVisible(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!focusTask) return null;
  const title = focusTask.title;
  const done = left <= 0;
  const frac = total > 0 ? left / total : 0;
  const mm = String(Math.floor(left / 60)).padStart(2, "0");
  const ss = String(left % 60).padStart(2, "0");

  const takeFive = () => { setTotal(300); setLeft(300); setPaused(false); };

  return (
    <AnimatePresence onExitComplete={endFocus}>
      {visible && (
        <motion.div key="focus" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.25 }}
          className="no-drag fixed inset-0 z-50 flex flex-col items-center justify-center bg-bg px-8">
          <p className="mb-3 text-[13px] font-medium tracking-wide text-muted uppercase">{done ? "Time's up" : paused ? "Paused" : "Focusing on"}</p>
          <h1 className="mb-12 max-w-[640px] text-center font-serif text-[40px] leading-[1.1] text-ink">{done ? "Nice work." : title}</h1>

          <div className="relative" style={{ width: SIZE, height: SIZE }}>
            <svg width={SIZE} height={SIZE} className="-rotate-90">
              <circle cx={SIZE / 2} cy={SIZE / 2} r={R} fill="none" strokeWidth={STROKE} className="stroke-line" />
              <circle cx={SIZE / 2} cy={SIZE / 2} r={R} fill="none" strokeWidth={STROKE} strokeLinecap="round"
                className="stroke-accent transition-[stroke-dashoffset] duration-1000 ease-linear"
                strokeDasharray={C} strokeDashoffset={C * (1 - frac)} />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-[64px] font-light tabular-nums text-ink">{mm}:{ss}</span>
              <span className="mt-1 text-[13px] text-muted">{focusTask.minutes} min block</span>
            </div>
          </div>

          <div className="mt-12 flex items-center gap-8">
            {done ? (
              <>
                <PrimaryButton onClick={close}>Done</PrimaryButton>
                <TextLink onClick={takeFive}>Take 5</TextLink>
              </>
            ) : (
              <>
                <PrimaryButton onClick={() => setPaused(p => !p)} className="min-w-[120px]">{paused ? "Resume" : "Pause"}</PrimaryButton>
                <TextLink onClick={() => openCommand(`Help me get started on: ${title}`)}>I'm stuck</TextLink>
                <TextLink onClick={close}>Done</TextLink>
              </>
            )}
          </div>
          <p className="absolute bottom-8 text-[12px] text-muted">Esc to leave</p>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
