import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useUI } from "@/store";
import { Eyebrow, PrimaryButton, SecondaryButton, TextLink } from "@/components/ui";
import Orb from "@/three/Orb";
import Wormhole from "@/three/Wormhole";

const BOX = 380;
const R = 170;
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
  const intensity = paused ? 0.35 : 0.4 + 0.6 * (1 - frac);

  const takeFive = () => { setTotal(300); setLeft(300); setPaused(false); };

  return (
    <AnimatePresence onExitComplete={endFocus}>
      {visible && (
        <motion.div key="focus" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.35 }}
          className="no-drag fixed inset-0 z-50 flex flex-col items-center justify-center overflow-hidden bg-black px-8">
          <div aria-hidden className="pointer-events-none absolute inset-0" style={{ opacity: 0.35 }}><Wormhole /></div>
          <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_0%,rgba(0,0,0,0.6)_60%,#000_100%)]" />

          <div className="relative z-10 flex flex-col items-center">
            <Eyebrow className="mb-4">{done ? "Time's up" : paused ? `Paused · ${focusTask.minutes} min` : `Focus · ${focusTask.minutes} min`}</Eyebrow>
            <h1 className="display mb-8 max-w-[720px] text-center text-[44px] text-ink">{done ? "Nice work." : title}</h1>

            <div className="relative flex items-center justify-center" style={{ width: BOX, height: BOX }}>
              <div className="absolute inset-0 flex items-center justify-center">
                <Orb size={300} intensity={intensity} speed={paused ? 0.3 : 1} />
              </div>
              <svg width={BOX} height={BOX} className="absolute inset-0 -rotate-90 overflow-visible">
                <circle cx={BOX / 2} cy={BOX / 2} r={R} fill="none" strokeWidth={2} stroke="rgba(255,255,255,0.12)" />
                <circle cx={BOX / 2} cy={BOX / 2} r={R} fill="none" strokeWidth={2} strokeLinecap="round"
                  className="stroke-accent transition-[stroke-dashoffset] duration-1000 ease-linear"
                  style={{ filter: "drop-shadow(0 0 6px var(--accent)) drop-shadow(0 0 14px var(--accent))" }}
                  strokeDasharray={C} strokeDashoffset={C * (1 - frac)} />
              </svg>
              <span className="display relative text-[64px] tabular-nums text-ink [text-shadow:0_2px_24px_rgba(0,0,0,0.6)]">{mm}:{ss}</span>
            </div>

            <div className="mt-10 flex items-center gap-4">
              {done ? (
                <>
                  <PrimaryButton onClick={close}>Done</PrimaryButton>
                  <SecondaryButton onClick={takeFive}>Take 5</SecondaryButton>
                </>
              ) : (
                <>
                  <PrimaryButton onClick={() => setPaused(p => !p)} className="min-w-[124px]">{paused ? "Resume" : "Pause"}</PrimaryButton>
                  <SecondaryButton onClick={() => openCommand(`Help me get started on: ${title}`)}>I'm stuck</SecondaryButton>
                  <TextLink className="ml-3" onClick={close}>Done</TextLink>
                </>
              )}
            </div>
          </div>
          <p className="absolute bottom-8 z-10 text-[12px] text-faint">Esc to leave</p>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
