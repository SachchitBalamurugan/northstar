import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, Loader2 } from "lucide-react";
import type { SidekickStep } from "@contracts/types";
import { runSidekick } from "@/api";
import { useUI } from "@/store";

const SUGGESTIONS = ["Fill my Stripe application", "Unsubscribe from promo emails", "Find the CS 201 syllabus"];

export default function CommandBar() {
  const { commandOpen, commandPrefill, closeCommand } = useUI();
  const [text, setText] = useState("");
  const [steps, setSteps] = useState<SidekickStep[]>([]);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const runId = useRef(0);

  const reset = () => { runId.current++; setText(""); setSteps([]); setRunning(false); setDone(false); };
  const close = () => { reset(); closeCommand(); };

  useEffect(() => {
    if (!commandOpen) return;
    reset(); setText(commandPrefill);
    const t = setTimeout(() => input.current?.focus(), 30);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); close(); } };
    window.addEventListener("keydown", onKey);
    return () => { clearTimeout(t); window.removeEventListener("keydown", onKey); };
  }, [commandOpen, commandPrefill]);

  const run = async (instruction: string) => {
    const t = instruction.trim(); if (!t || running) return;
    const id = ++runId.current;
    setText(t); setSteps([]); setRunning(true); setDone(false);
    await runSidekick(t, s => { if (runId.current === id) setSteps(prev => [...prev, s]); });
    if (runId.current === id) { setRunning(false); setDone(true); }
  };

  return (
    <AnimatePresence>
      {commandOpen && (
        <motion.div key="cmd" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}
          className="no-drag fixed inset-0 z-[60] bg-black/20 backdrop-blur-sm" onMouseDown={close}>
          <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.2, ease: "easeOut" }}
            onMouseDown={e => e.stopPropagation()}
            className="mx-auto mt-[18vh] w-[640px] max-w-[calc(100vw-32px)] overflow-hidden rounded-[var(--radius)] border border-line bg-surface shadow-xl">
            <input ref={input} value={text} onChange={e => setText(e.target.value)} autoFocus
              onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); run(text); } }}
              placeholder="Hand off a task… e.g. fill this internship application"
              className="h-16 w-full bg-transparent px-6 text-[20px] text-ink outline-none placeholder:text-muted" />

            {!text && steps.length === 0 && (
              <div className="flex flex-wrap gap-2 border-t border-line px-6 py-4">
                {SUGGESTIONS.map(s => (
                  <button key={s} onClick={() => run(s)}
                    className="h-8 rounded-full bg-soft px-3.5 text-[13px] text-muted transition-colors duration-150 hover:text-ink">{s}</button>
                ))}
              </div>
            )}

            {steps.length > 0 && (
              <ul className="space-y-2.5 border-t border-line px-6 py-5">
                {steps.slice(-5).map((s, i, arr) => {
                  const last = i === arr.length - 1;
                  const current = last && running;
                  const final = last && done;
                  return (
                    <motion.li key={`${s.step}-${i}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }}
                      className={`flex items-center gap-3 text-[15px] ${final || current ? "text-ink" : "text-muted"}`}>
                      {current ? <Loader2 size={16} className="shrink-0 animate-spin" /> : <Check size={16} className="shrink-0" />}
                      <span>{s.detail}</span>
                    </motion.li>
                  );
                })}
              </ul>
            )}

            <p className="border-t border-line px-6 py-3 text-[12px] text-muted">Enter to run · Esc to close · Northstar pauses before anything final</p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
