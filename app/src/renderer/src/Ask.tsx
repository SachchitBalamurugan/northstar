// The small "Ask" window that opens under the floating bubble: one text box to hand a task to Northstar,
// live steps underneath, and a maximize button that opens the full app on the Activity screen.
// In Electron it is its own frameless window (#ask). In a plain browser it renders centered on a dark page.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { motion } from "framer-motion";
import { Check, Loader2, Maximize2 } from "lucide-react";
import { runSidekick } from "@/api";
import { useUI, type Screen } from "@/store";
import { LogoMark, PrimaryButton, TextLink } from "@/components/ui";
import type { AskStep } from "@/local-types";

const SUGGESTIONS = ["Fill my Stripe application", "Unsubscribe from promo emails", "Find the CS 101 syllabus"];
const EDGE = "linear-gradient(90deg,#FF8A3D,#FF3DA5,#8B5CF6,#3B82F6)";

/** Browser fallback: when the hash leaves #ask (maximize), swap this tab over to the full app. */
export function AskRoot({ app }: { app: ReactNode }) {
  const [isAsk, setIsAsk] = useState(true);
  useEffect(() => {
    const onHash = () => setIsAsk(window.location.hash === "#ask");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return isAsk ? <Ask /> : <>{app}</>;
}

function openMain(screen: Screen) {
  if (window.northstar) { window.northstar.openMain(screen); return; }
  useUI.getState().setScreen(screen);
  window.location.hash = "";
}

export default function Ask() {
  const inElectron = !!window.northstar;
  const [text, setText] = useState("");
  const [steps, setSteps] = useState<AskStep[]>([]);
  const [running, setRunning] = useState(false);
  const [ended, setEnded] = useState<"done" | "stopped" | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const runId = useRef(0);
  const busy = useRef(false);
  busy.current = running;

  const reset = () => { runId.current++; setText(""); setSteps([]); setRunning(false); setEnded(null); input.current?.focus(); };

  const run = async (instruction: string) => {
    const t = instruction.trim(); if (!t || running) return;
    const id = ++runId.current;
    let last: AskStep | undefined;
    setText(t); setSteps([]); setRunning(true); setEnded(null);
    await runSidekick(t, s => { if (runId.current === id) { last = s; setSteps(prev => [...prev, s]); } });
    if (runId.current === id) { setRunning(false); setEnded(last?.action === "stopped" ? "stopped" : "done"); }
  };

  // Typing over a finished run starts a fresh ask.
  const onType = (v: string) => {
    if (running) return;
    if (ended) { runId.current++; setSteps([]); setEnded(null); }
    setText(v);
  };

  // Electron: transparent page, the window is exactly the card. Report the card height so the window fits it.
  useEffect(() => {
    if (!inElectron) return;
    for (const el of [document.documentElement, document.body, document.getElementById("root")!]) {
      el.style.background = "transparent"; el.style.overflow = "hidden"; el.style.margin = "0";
    }
    const el = card.current; if (!el) return;
    const report = () => window.northstar!.askResize(Math.ceil(el.getBoundingClientRect().height));
    const ro = new ResizeObserver(report); ro.observe(el); report();
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const focus = () => input.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); window.northstar?.askHide(); } };
    window.addEventListener("focus", focus);
    window.addEventListener("keydown", onKey);
    const offShown = window.northstar?.onAskShown(focus);
    // Clicking away hides the window, but never in the middle of a run.
    const offBlur = window.northstar?.onAskBlur(() => { if (!busy.current) window.northstar?.askHide(); });
    return () => { window.removeEventListener("focus", focus); window.removeEventListener("keydown", onKey); offShown?.(); offBlur?.(); };
  }, []);

  const shown = steps.slice(-5);
  const idleEmpty = !text && steps.length === 0 && !running;

  const panel = (
    <motion.div ref={card} initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, ease: "easeOut" }}
      className={`no-drag flex max-h-[340px] w-full flex-col overflow-hidden rounded-[18px] border-[0.8px] border-line bg-surface ${inElectron ? "" : "shadow-[0_24px_80px_rgba(0,0,0,0.5)]"}`}>
      <div className="relative shrink-0">
        <div className="flex h-[74px] items-center gap-3 pl-5 pr-3">
          <LogoMark size={22} />
          <input ref={input} value={text} onChange={e => onType(e.target.value)} autoFocus readOnly={running}
            onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); run(text); } }}
            placeholder="What can I take over for you?" aria-label="Ask Northstar"
            className="h-full min-w-0 flex-1 bg-transparent text-[20px] tracking-[-0.015em] text-ink outline-none placeholder:text-faint placeholder:italic" />
          <button aria-label="Open Northstar" title="See everything: automations and your calendar" onClick={() => openMain("activity")}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted transition-colors duration-150 hover:bg-white/10 hover:text-ink">
            <Maximize2 size={15} strokeWidth={1.75} />
          </button>
        </div>
        <span aria-hidden className="absolute inset-x-0 bottom-0 h-[2px]" style={{ background: EDGE }} />
        <span aria-hidden className="absolute inset-x-6 -bottom-1 h-[6px] opacity-70 blur-[8px]" style={{ background: EDGE }} />
      </div>

      {idleEmpty && (
        <ol className="flex shrink-0 flex-col px-2.5 py-2">
          {SUGGESTIONS.map((s, i) => (
            <li key={s}>
              <button onClick={() => run(s)}
                className="group flex w-full items-center gap-3 rounded-[10px] border-l border-transparent py-[7px] pl-3.5 text-left text-[14px] text-muted transition-colors duration-150 hover:border-accent hover:bg-white/[0.03] hover:text-ink">
                <span className="w-5 text-[12px] tabular-nums text-faint group-hover:text-accent">{String(i + 1).padStart(2, "0")}</span>
                <span className="truncate">{s}</span>
              </button>
            </li>
          ))}
        </ol>
      )}

      {shown.length > 0 && (
        <ul className="min-h-0 space-y-2.5 overflow-y-auto px-5 pt-4 pb-3.5">
          {shown.map((s, i) => {
            const last = i === shown.length - 1;
            return (
              <motion.li key={`${s.step}-${steps.length - shown.length + i}`} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}
                className={`flex items-center gap-3 text-[14px] leading-5 ${last ? "text-ink" : "text-muted"}`}>
                {last && running
                  ? <Loader2 size={15} className="shrink-0 animate-spin text-accent" />
                  : <Check size={15} className="shrink-0 text-accent" />}
                <span className="truncate">{s.detail}</span>
              </motion.li>
            );
          })}
        </ul>
      )}
      {running && steps.length === 0 && (
        <p className="flex items-center gap-3 px-5 py-4 text-[14px] text-muted"><Loader2 size={15} className="animate-spin text-accent" />Starting…</p>
      )}

      {ended === "stopped" && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }}
          className="flex shrink-0 items-center justify-between gap-4 border-t-[0.8px] border-line py-3.5 pl-5 pr-6">
          <p className="min-w-0 text-[13px] leading-snug text-muted">Ready, and waiting for your OK. Nothing is sent until you approve.</p>
          <PrimaryButton onClick={() => openMain("approve")} className="h-10 shrink-0 whitespace-nowrap px-4 text-[14px]">Review &amp; approve</PrimaryButton>
        </motion.div>
      )}
      {ended === "done" && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }}
          className="flex shrink-0 items-center justify-between gap-4 border-t-[0.8px] border-line px-5 py-2.5">
          <p className="text-[12px] text-faint">Done. It's saved in Activity.</p>
          <TextLink onClick={reset} className="text-[13px]">Ask another</TextLink>
        </motion.div>
      )}
    </motion.div>
  );

  if (inElectron) return <div className="fixed inset-x-0 top-0">{panel}</div>;
  return (
    <div className="flex min-h-full justify-center bg-bg px-4 pt-[16vh]">
      <div className="w-[520px] max-w-full">{panel}</div>
    </div>
  );
}
