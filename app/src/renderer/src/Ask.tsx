// The small "Ask" window that opens under the floating bubble: one text box to hand a task to Northstar,
// live steps underneath, and a maximize button that opens the full app on the Activity screen.
// In Electron it is its own frameless window (#ask). In a plain browser it renders centered on a dark page.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { motion } from "framer-motion";
import { Check, Loader2, Maximize2, Square } from "lucide-react";
import { answerCheckpoint, cancelRun, runSidekick } from "@/api";
import { useUI, type Screen } from "@/store";
import { LogoMark, PrimaryButton, SecondaryButton, TextLink } from "@/components/ui";
import type { AskStep, TaskCheckpoint } from "@/local-types";

const SUGGESTIONS = ["Fill my Stripe application", "Unsubscribe from promo emails", "Find the CS 101 syllabus"];
const EDGE = "var(--accent)";

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
  const [cp, setCp] = useState<TaskCheckpoint | null>(null);
  const [answer, setAnswer] = useState("");
  const [sending, setSending] = useState(false);
  const liveRun = useRef<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const runId = useRef(0);
  const busy = useRef(false);
  busy.current = running;

  const reset = () => { runId.current++; setText(""); setSteps([]); setRunning(false); setEnded(null); setCp(null); input.current?.focus(); };

  const run = async (instruction: string) => {
    const t = instruction.trim(); if (!t || running) return;
    const id = ++runId.current;
    let last: AskStep | undefined;
    setText(t); setSteps([]); setRunning(true); setEnded(null); setCp(null); liveRun.current = null;
    await runSidekick(t, raw => {
      const s = raw as AskStep;
      if (runId.current !== id) return;
      if (s.runId) liveRun.current = s.runId;
      if (s.checkpoint) {
        setCp(s.checkpoint); setAnswer("");
        window.northstar?.askShow(s.checkpoint.title);
        return;
      }
      setCp(null);
      last = s; setSteps(prev => [...prev, s]);
    });
    if (runId.current === id) { setRunning(false); setCp(null); setEnded(last?.action === "stopped" ? "stopped" : "done"); }
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

  const decide = async (decision: string) => {
    if (!cp || sending) return;
    if (decision === "answer" && !answer.trim()) return;
    setSending(true);
    const ok = await answerCheckpoint(cp.id, decision, decision === "answer" ? answer.trim() : undefined);
    setSending(false);
    if (ok) setCp(null);
  };
  const stop = () => { if (liveRun.current) void cancelRun(liveRun.current); };

  const shown = steps.slice(-5);
  const idleEmpty = !text && steps.length === 0 && !running;

  const panel = (
    <motion.div ref={card} initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, ease: "easeOut" }}
      className={`no-drag flex max-h-[520px] w-full flex-col overflow-hidden rounded-[18px] border-[0.8px] border-line bg-surface ${inElectron ? "" : "shadow-[0_24px_80px_rgba(0,0,0,0.5)]"}`}>
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
        <span aria-hidden className="absolute inset-x-0 bottom-0 h-px" style={{ background: EDGE }} />
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

      {cp && <CheckpointCard cp={cp} answer={answer} setAnswer={setAnswer} sending={sending} decide={decide} />}

      {running && !cp && steps.length > 0 && (
        <div className="flex shrink-0 justify-end border-t-[0.8px] border-line px-5 py-2">
          <TextLink onClick={stop} className="inline-flex items-center gap-1.5 text-[12px]"><Square size={10} strokeWidth={2.5} />Stop</TextLink>
        </div>
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

const CP_LABEL: Record<TaskCheckpoint["kind"], string> = {
  plan: "Plan · approve once",
  submit: "Final step",
  payment: "Payment",
  signin: "Sign-in needed",
  question: "Quick question",
};

function CheckpointCard({ cp, answer, setAnswer, sending, decide }: {
  cp: TaskCheckpoint; answer: string; setAnswer: (v: string) => void; sending: boolean; decide: (d: string) => void;
}) {
  return (
    <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18 }}
      className="shrink-0 overflow-y-auto border-t-[0.8px] border-line px-5 pt-3.5 pb-4">
      <p className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-accent">{CP_LABEL[cp.kind]}</p>
      <p className="mt-1.5 text-[15px] leading-snug text-ink">{cp.title}</p>
      {cp.steps && cp.steps.length > 0 && (
        <ol className="mt-2.5 space-y-1">
          {cp.steps.map((s, i) => (
            <li key={i} className="flex gap-2.5 text-[13px] leading-5 text-muted">
              <span className="w-4 shrink-0 font-mono text-[11px] tabular-nums leading-5 text-faint">{i + 1}</span><span>{s}</span>
            </li>
          ))}
        </ol>
      )}
      {cp.detail && <p className="mt-2 text-[12.5px] leading-snug text-faint">{cp.detail}</p>}
      {cp.kind === "question" && (
        <textarea autoFocus value={answer} onChange={e => setAnswer(e.target.value)} rows={2}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); decide("answer"); } }}
          placeholder="Type your answer" className="mt-2.5 w-full resize-none rounded-[10px] border-[0.8px] border-line bg-raised px-3 py-2 text-[14px] text-ink outline-none placeholder:text-faint focus:border-accent" />
      )}
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        {cp.kind === "plan" && <>
          <TextLink onClick={() => decide("cancel")} disabled={sending} className="mr-auto text-[13px]">Cancel</TextLink>
          {cp.finalAction
            ? <>
                <SecondaryButton onClick={() => decide("run")} disabled={sending} className="h-9 px-3.5 text-[13px]">Run, ask before submit</SecondaryButton>
                <PrimaryButton onClick={() => decide("run_submit")} disabled={sending} className="h-9 px-3.5 text-[13px]">Run &amp; submit</PrimaryButton>
              </>
            : <PrimaryButton autoFocus onClick={() => decide("run")} disabled={sending} className="h-9 px-4 text-[13px]">Run</PrimaryButton>}
        </>}
        {(cp.kind === "submit" || cp.kind === "payment") && <>
          <SecondaryButton onClick={() => decide("skip")} disabled={sending} className="h-9 px-3.5 text-[13px]">Not now</SecondaryButton>
          <PrimaryButton autoFocus onClick={() => decide("approve")} disabled={sending} className="h-9 px-4 text-[13px]">Approve</PrimaryButton>
        </>}
        {cp.kind === "signin" && <>
          <SecondaryButton onClick={() => decide("skip")} disabled={sending} className="h-9 px-3.5 text-[13px]">Stop</SecondaryButton>
          <PrimaryButton onClick={() => decide("continue")} disabled={sending} className="h-9 px-4 text-[13px]">I signed in, continue</PrimaryButton>
        </>}
        {cp.kind === "question" && <>
          <SecondaryButton onClick={() => decide("skip")} disabled={sending} className="h-9 px-3.5 text-[13px]">Skip</SecondaryButton>
          <PrimaryButton onClick={() => decide("answer")} disabled={sending || !answer.trim()} className="h-9 px-4 text-[13px]">Send</PrimaryButton>
        </>}
      </div>
    </motion.div>
  );
}
