// Response controls for any AI-written text the user reviews: Simplify, Challenge my reasoning, Try another approach.
// Simplify and Try another approach replace the text (with Undo). Challenge is feedback, so it is shown under the
// text and never replaces it. If the service asks a clarifying question, that is shown and the text is left alone.
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { refine, type RefineMode } from "@/assistApi";

const MODES: { mode: RefineMode; label: string; busy: string }[] = [
  { mode: "simplify", label: "Simplify", busy: "Simplifying…" },
  { mode: "challenge", label: "Challenge my reasoning", busy: "Looking for weak spots…" },
  { mode: "another", label: "Try another approach", busy: "Trying another approach…" },
];

export default function RefineControls({ text, context, onChange, className = "" }: {
  /** The text as it stands now. */ text: string;
  /** Optional context for the model, e.g. the email subject. */ context?: string;
  /** Called with the replacement text (also used by Undo). */ onChange: (text: string) => void;
  className?: string;
}) {
  const [busy, setBusy] = useState<RefineMode | null>(null);
  const [prev, setPrev] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "clarify" | "challenge" | "note"; text: string } | null>(null);

  const run = async (mode: RefineMode) => {
    if (busy || !text?.trim()) return;
    setBusy(mode); setMsg(null);
    const r = await refine(text, mode, context);
    setBusy(null);
    if (r.clarify) { setMsg({ kind: "clarify", text: r.clarify }); return; }
    if (mode === "challenge") { setMsg({ kind: "challenge", text: r.text || r.note || "Nothing stands out. This reads clearly." }); return; }
    if (r.text && r.text.trim() && r.text !== text) { setPrev(text); onChange(r.text); setMsg(r.note ? { kind: "note", text: r.note } : null); }
    else setMsg({ kind: "note", text: r.note ?? "No change. This already reads clearly." });
  };
  const undo = () => { if (prev !== null) { onChange(prev); setPrev(null); setMsg(null); } };

  return (
    <div className={className}>
      <div className="flex flex-wrap items-center gap-2">
        {MODES.map(m => (
          <button key={m.mode} type="button" onClick={() => run(m.mode)} disabled={!!busy}
            className="no-drag inline-flex h-7 items-center gap-1.5 rounded-full border-[0.8px] border-white/15 px-3 text-[12.5px] text-muted transition-colors duration-150 hover:bg-white/10 hover:text-ink disabled:opacity-50">
            {busy === m.mode && <Loader2 size={12} className="animate-spin text-accent" />}
            {busy === m.mode ? m.busy : m.label}
          </button>
        ))}
        {prev !== null && !busy && (
          <button type="button" onClick={undo} className="no-drag ml-1 text-[12.5px] text-faint transition-colors duration-150 hover:text-ink">Undo</button>
        )}
      </div>
      {msg && (
        <div role="status" className={`mt-3 text-[13px] leading-relaxed ${msg.kind === "note" ? "text-faint" : "border-l border-accent pl-3 text-warm"}`}>
          {msg.kind !== "note" && (
            <p className="mb-0.5 text-[11px] font-medium uppercase tracking-[0.12em] text-faint">
              {msg.kind === "clarify" ? "One question first" : "Worth a second look"}
            </p>
          )}
          <p className="whitespace-pre-wrap">{msg.text}</p>
        </div>
      )}
    </div>
  );
}
