import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowUpRight, Check, Loader2 } from "lucide-react";
import type { SidekickStep } from "@contracts/types";
import { runSidekick } from "@/api";
import { useUI } from "@/store";
import { LogoMark } from "@/components/ui";

const SUGGESTIONS = ["Fill my Stripe application", "Unsubscribe from promo emails", "Find the CS 201 syllabus"];
const EDGE = "var(--accent)";

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
        <motion.div key="cmd" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}
          className="no-drag fixed inset-0 z-[60] bg-black/60 backdrop-blur-md" onMouseDown={close}>
          <motion.div initial={{ opacity: 0, y: -8, scale: 0.985 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -8, scale: 0.985 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
            onMouseDown={e => e.stopPropagation()}
            className="mx-auto mt-[16vh] w-[680px] max-w-[calc(100vw-32px)] overflow-hidden rounded-[18px] border-[0.8px] border-line bg-surface shadow-[0_24px_80px_rgba(0,0,0,0.5)]">
            <div className="flex h-12 items-center gap-2.5 px-5">
              <LogoMark size={22} />
              <span className="text-[13px] text-muted">Sidekick</span>
              <ArrowUpRight size={15} strokeWidth={1.75} className="ml-auto text-faint" />
            </div>

            <div className="relative">
              <input ref={input} value={text} onChange={e => setText(e.target.value)} autoFocus
                onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); run(text); } }}
                placeholder="What can I take over for you?"
                className="h-16 w-full bg-transparent px-5 text-[22px] tracking-[-0.015em] text-ink outline-none placeholder:text-faint placeholder:italic" />
              <span aria-hidden className="absolute inset-x-0 bottom-0 h-px" style={{ background: EDGE }} />
            </div>

            {!text && steps.length === 0 && (
              <ol className="flex flex-col px-3 py-3">
                {SUGGESTIONS.map((s, i) => (
                  <li key={s}>
                    <button onClick={() => run(s)}
                      className="group flex w-full items-center gap-4 rounded-[10px] border-l border-transparent py-2.5 pl-4 text-left text-[15px] text-muted transition-colors duration-150 hover:border-accent hover:bg-white/[0.03] hover:text-ink">
                      <span className="w-6 text-[13px] tabular-nums text-faint group-hover:text-accent">{String(i + 1).padStart(2, "0")}</span>
                      <span className="truncate">{s}</span>
                    </button>
                  </li>
                ))}
              </ol>
            )}

            {steps.length > 0 && (
              <ul className="space-y-3 px-6 py-5">
                {steps.slice(-5).map((s, i, arr) => {
                  const last = i === arr.length - 1;
                  const current = last && running;
                  return (
                    <motion.li key={`${s.step}-${i}`} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}
                      className={`flex items-center gap-3 text-[15px] ${last ? "text-ink" : "text-muted"}`}>
                      {current
                        ? <Loader2 size={16} className="shrink-0 animate-spin text-accent" />
                        : <Check size={16} className="shrink-0 text-accent" />}
                      <span>{s.detail}</span>
                    </motion.li>
                  );
                })}
              </ul>
            )}

            <p className="border-t-[0.8px] border-line px-5 py-3 text-[12px] text-faint">Enter to run · Esc to close · Pauses before anything final</p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
