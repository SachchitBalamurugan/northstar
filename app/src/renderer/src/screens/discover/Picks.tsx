// Picks board: liked Discover results collect here. Add events/deadlines to the calendar, or save/copy as markdown.
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Bookmark, Calendar, Briefcase, MapPin, FileText, X, Loader2, Check, Copy, Download, CalendarPlus } from "lucide-react";
import { Window, PrimaryButton, TextLink } from "../../components/ui";
import { createEvent } from "../../api";
import { toMarkdown, type DiscoverResult, type ResultKind } from "../../discover";

type Status = "pending" | "added" | { error: string };

const KIND_ICON: Record<ResultKind, typeof Calendar> = { event: Calendar, opportunity: Briefcase, place: MapPin, article: FileText };

const HOUR = 3600_000;
function fmtWhen(iso?: string) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function fmtDay(iso: string) {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function whenWhere(r: DiscoverResult) {
  const parts: string[] = [];
  if (r.kind === "event" && r.start) parts.push(fmtWhen(r.start));
  if (r.kind === "opportunity" && r.deadline) parts.push(`Due ${fmtDay(r.deadline)}`);
  if (r.location) parts.push(r.location);
  if (!parts.length) parts.push(r.source);
  return parts.filter(Boolean).join(" · ");
}
const details = (r: DiscoverResult) => `${r.summary}\n\nWhy: ${r.why}\nSource: ${r.url}`;

function calendarPayload(r: DiscoverResult) {
  if (r.kind === "event" && r.start) {
    const end = r.end ?? new Date(new Date(r.start).getTime() + HOUR).toISOString();
    return { title: r.title, start: r.start, end, location: r.location, details: details(r) };
  }
  if (r.kind === "opportunity" && r.deadline) {
    const d = new Date(r.deadline);
    d.setHours(9, 0, 0, 0);
    return { title: `Deadline: ${r.title}`, start: d.toISOString(), end: new Date(d.getTime() + HOUR / 2).toISOString(), details: details(r) };
  }
  return null;
}

function today() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export default function Picks({ picks, onRemove, onClear }: { picks: DiscoverResult[]; onRemove: (id: string) => void; onClear: () => void }) {
  const [status, setStatus] = useState<Record<string, Status>>({});
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);

  const add = async (r: DiscoverResult) => {
    const payload = calendarPayload(r);
    if (!payload) return;
    const s = status[r.id];
    if (s === "pending" || s === "added") return;
    setStatus(m => ({ ...m, [r.id]: "pending" }));
    try {
      const res = await createEvent(payload);
      if (res && !res.error && res.ok !== false) setStatus(m => ({ ...m, [r.id]: "added" }));
      else setStatus(m => ({ ...m, [r.id]: { error: String(res?.error ?? "Couldn't add") } }));
    } catch (e) {
      setStatus(m => ({ ...m, [r.id]: { error: e instanceof Error ? e.message : "Couldn't add" } }));
    }
  };

  const pendingEvents = picks.filter(r => r.kind === "event" && r.start && status[r.id] !== "added" && status[r.id] !== "pending");
  const addAll = async () => { for (const r of pendingEvents) await add(r); };

  const markdown = () => toMarkdown("Discover picks", picks);
  const saveFile = () => {
    const blob = new Blob([markdown()], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `northstar-picks-${today()}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(markdown());
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable; ignore */ }
  };

  return (
    <Window title="Your picks" icon={<Bookmark size={15} />} meta={`${picks.length}`} className="sticky top-4" bodyClassName="p-4">
      {picks.length === 0 ? (
        <div className="rounded-[12px] border-[0.8px] border-dashed border-line px-5 py-8 text-center text-[13px] leading-relaxed text-muted">
          Pick results you like. They collect here so you can add events to your calendar or save them as a file.
        </div>
      ) : (
        <>
          <ul className="flex max-h-[52vh] flex-col gap-2 overflow-y-auto pr-1">
            <AnimatePresence initial={false}>
              {picks.map(r => {
                const Icon = KIND_ICON[r.kind] ?? FileText;
                const s = status[r.id];
                const canCal = (r.kind === "event" && !!r.start) || (r.kind === "opportunity" && !!r.deadline);
                return (
                  <motion.li key={r.id} layout
                    initial={{ opacity: 0, x: -24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -24, height: 0, marginTop: 0 }}
                    transition={{ duration: 0.25, ease: "easeOut" }}
                    className="rounded-[12px] border-[0.8px] border-line bg-raised px-3 py-2.5">
                    <div className="flex items-start gap-2.5">
                      <span className="mt-0.5 text-muted"><Icon size={15} /></span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[14px] font-medium text-ink" title={r.title}>{r.title}</div>
                        <div className="truncate text-[12px] text-faint">{whenWhere(r)}</div>
                      </div>
                      <button aria-label={`Remove ${r.title}`} onClick={() => onRemove(r.id)}
                        className="no-drag -mr-1 rounded-full p-1 text-faint transition-colors hover:bg-white/[0.06] hover:text-ink">
                        <X size={14} />
                      </button>
                    </div>
                    {canCal && (
                      <div className="mt-2 pl-[25px] text-[12px]">
                        {s === "added" ? (
                          <span className="inline-flex items-center gap-1 text-emerald-300"><Check size={13} /> Added</span>
                        ) : s === "pending" ? (
                          <span className="inline-flex items-center gap-1.5 text-muted"><Loader2 size={13} className="animate-spin" /> Adding…</span>
                        ) : (
                          <span className="inline-flex flex-wrap items-center gap-2">
                            <button onClick={() => add(r)}
                              className="no-drag inline-flex items-center gap-1 rounded-full border-[0.8px] border-line px-2.5 py-1 text-warm transition-colors hover:border-accent hover:text-ink">
                              <CalendarPlus size={12} /> {r.kind === "event" ? "Add to calendar" : "Add deadline"}
                            </button>
                            {typeof s === "object" && <span className="text-accent">{s.error}</span>}
                          </span>
                        )}
                      </div>
                    )}
                  </motion.li>
                );
              })}
            </AnimatePresence>
          </ul>

          <div className="mt-4 flex flex-col gap-3 border-t-[0.8px] border-line pt-4">
            <PrimaryButton glow={false} className="h-10 w-full text-[14px]" disabled={pendingEvents.length === 0} onClick={addAll}>
              <CalendarPlus size={15} /> Add all events to calendar{pendingEvents.length > 0 ? ` (${pendingEvents.length})` : ""}
            </PrimaryButton>
            <div className="flex items-center gap-2">
              <button onClick={saveFile}
                className="no-drag inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-full border-[0.8px] border-white/38 bg-white/[0.06] text-[14px] text-ink transition-colors hover:bg-white/[0.1]">
                <Download size={14} /> Save as file
              </button>
              <button onClick={copy} aria-label="Copy as markdown" title="Copy as markdown"
                className="no-drag inline-flex h-10 min-w-10 items-center justify-center gap-1.5 rounded-full border-[0.8px] border-white/38 bg-white/[0.06] px-3 text-[13px] text-ink transition-colors hover:bg-white/[0.1]">
                {copied ? <><Check size={14} className="text-emerald-300" /> Copied</> : <Copy size={14} />}
              </button>
            </div>
            <div className="flex items-center justify-between gap-3">
              <p className="text-[11px] leading-snug text-faint">Events go to Google Calendar when connected, otherwise the demo calendar.</p>
              <TextLink className="shrink-0 text-[13px]" onClick={onClear}>Clear all</TextLink>
            </div>
          </div>
        </>
      )}
    </Window>
  );
}
