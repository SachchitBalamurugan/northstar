// Dashboard: the home page. Northstar ranks everything (emails, approvals, calendar, tasks) and shows only what matters.
// One hero item, a short ranked list, today at a glance, calendar suggestions, and a floating "ask" input.
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Mail, CalendarPlus, FileText, Sparkles, Target, ArrowUp, ArrowUpRight, Check, CalendarDays, Loader2, Plus, BookOpen, PenLine } from "lucide-react";
import type { EventCandidate } from "@contracts/types";
import { suggestEvents, addEvent } from "@/calendarAgent";
import { Heading, Eyebrow, GlowCard, PrimaryButton, SecondaryButton, Window, Chip, relTime, clock } from "@/components/ui";
import { useUI } from "@/store";
import NameInline from "@/components/NameInline";
import { useProfile, firstName } from "@/profile";
import { approve, draftReply } from "@/api";
import { loadDashboard, type DashboardData, type Priority, type PriorityKind } from "@/priorities";
import Briefing from "@/components/Briefing";
import ResumeWork from "@/components/ResumeWork";

const ICON: Record<PriorityKind, typeof Mail> = { focus: Target, email: Mail, calendar: CalendarPlus, application: FileText, task: Sparkles };
const LABEL: Record<PriorityKind, string> = { focus: "Focus", email: "Email", calendar: "Calendar", application: "Application", task: "Suggestion" };

const soon = (iso?: string) => !!iso && new Date(iso).getTime() - Date.now() < 48 * 36e5;
const openUrl = (url: string) => (window.northstar ? window.northstar.openExternal(url) : window.open(url, "_blank", "noopener"));

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Still up" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export default function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());
  const { setScreen, startFocus, openWorkflow } = useUI();
  const name = useProfile(s => firstName(s.profile));

  useEffect(() => {
    let alive = true;
    const load = () => loadDashboard().then(d => alive && setData(d));
    load(); const t = setInterval(load, 30000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const markDone = (id: string) => setDone(s => new Set(s).add(id));

  // Every item gets exactly one obvious action.
  const act = async (p: Priority) => {
    if (p.kind === "focus") return startFocus({ title: p.title, minutes: p.minutes ?? 25 });
    if (p.proposal && p.kind !== "calendar") { setScreen("approve"); return; }
    if (p.kind === "calendar" && p.proposal) { markDone(p.id); await approve(p.proposal); return; }
    if (p.email) { await draftReply(p.email.id); setScreen("approve"); return; }
    setScreen("approve");
  };
  const actLabel = (p: Priority) =>
    p.kind === "focus" ? "Start" : p.kind === "calendar" ? "Add block" : p.kind === "application" ? "Review" : p.email ? "Draft reply" : p.kind === "email" ? "Review reply" : "Open";

  const list = data?.priorities.filter(p => !done.has(p.id)) ?? [];
  const [top, ...rest] = list;

  return (
    <div className="pb-40">
      {/* Header */}
      <Heading eyebrow={new Date().toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" })}>
        {/* The profile name wins; without one, the inline editable name. */}
        {greeting()}, {name !== "there" ? name : <NameInline />}.<br />
        {data ? <>{list.length === 0 ? "You're all " : `${Math.min(list.length, 3)} things matter `}<span className="text-glow">{list.length === 0 ? "caught up." : "today."}</span></> : <span className="text-faint">Reading your day…</span>}
      </Heading>

      {!data ? <Skeleton /> : (
        <div className="grid grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] gap-6">
          {/* Left: ranked priorities */}
          <div className="flex flex-col gap-5">
            <AnimatePresence mode="popLayout">
              {top && (
                <motion.div key={top.id} layout exit={{ opacity: 0, scale: 0.98 }} transition={{ duration: 0.25 }}>
                  <GlowCard className="p-7">
                    <div className="mb-4 flex items-center gap-2">
                      <Eyebrow>Most important</Eyebrow>
                      <span className="text-faint">·</span>
                      <KindTag kind={top.kind} />
                    </div>
                    <h2 className="display text-[30px] text-ink">{top.title}</h2>
                    <p className="mt-2 max-w-[52ch] text-[15px] leading-relaxed text-muted">{top.why}</p>
                    <div className="mt-6 flex flex-wrap items-center gap-3">
                      <PrimaryButton onClick={() => act(top)}>{actLabel(top)}</PrimaryButton>
                      {top.calendarUrl && top.kind !== "calendar" && (
                        <SecondaryButton onClick={() => openUrl(top.calendarUrl!)}><CalendarPlus size={16} /> Add to Google Calendar</SecondaryButton>
                      )}
                      <span className="ml-auto flex gap-2">
                        {top.minutes && <Chip>{top.minutes} min</Chip>}
                        {top.dueAt && <Chip tone={soon(top.dueAt) ? "accent" : "default"}>Due {relTime(top.dueAt)}</Chip>}
                      </span>
                    </div>
                  </GlowCard>
                </motion.div>
              )}
            </AnimatePresence>

            <ResumeWork />

            {rest.length > 0 && (
              <Window title="Up next" icon={<Sparkles size={15} />} tag="RANKED BY NORTHSTAR" meta={`${rest.length} more`}>
                <ul>
                  <AnimatePresence initial={false}>
                    {rest.map((p, i) => {
                      const Icon = ICON[p.kind];
                      return (
                        <motion.li key={p.id} layout initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.22 }}
                          className="group flex items-center gap-4 border-b-[0.8px] border-line px-5 py-4 last:border-b-0 hover:bg-white/[0.025]">
                          <span className="w-5 text-[12px] text-faint tabular-nums">{String(i + 2).padStart(2, "0")}</span>
                          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-white/[0.06] text-warm"><Icon size={16} /></span>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[15px] text-ink">{p.title}</p>
                            <p className="truncate text-[13px] text-faint">{p.why}</p>
                          </div>
                          {p.dueAt && <span className={`shrink-0 text-[12px] tabular-nums ${soon(p.dueAt) ? "text-accent" : "text-faint"}`}>{relTime(p.dueAt)}</span>}
                          <button onClick={() => act(p)}
                            className="no-drag shrink-0 rounded-full border-[0.8px] border-white/15 px-3 py-1.5 text-[12.5px] text-warm opacity-70 transition-all duration-150 group-hover:opacity-100 hover:bg-white/10">
                            {actLabel(p)}
                          </button>
                        </motion.li>
                      );
                    })}
                  </AnimatePresence>
                </ul>
              </Window>
            )}

            <Briefing />
          </div>

          {/* Right: today + calendar suggestions + quiet counts */}
          <div className="flex flex-col gap-5">
            <Window title="Today" icon={<CalendarDays size={15} />} meta={`${data.today.length} events`}>
              <DayBar />
              <ul className="px-5 pb-3">
                {data.today.slice(0, 4).map(ev => {
                  const past = new Date(ev.end).getTime() < Date.now();
                  return (
                    <li key={ev.id} className={`flex items-center gap-3 border-b-[0.8px] border-line py-3 last:border-b-0 ${past ? "opacity-40" : ""}`}>
                      <span className="w-16 shrink-0 text-[12.5px] text-muted tabular-nums">{clock(ev.start)}</span>
                      {ev.northstar && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />}
                      <span className="truncate text-[14px] text-warm">{ev.title.replace(/^◎\s*/, "")}</span>
                    </li>
                  );
                })}
                {data.today.length === 0 && <li className="py-4 text-[14px] text-faint">Nothing scheduled. A clear day.</li>}
              </ul>
            </Window>

            {(
              <Window title="Add to calendar" icon={<CalendarPlus size={15} />} tag="SUGGESTED">
                <ul className="px-5 py-2">
                  {data.calendarAdds.map(c => (
                    <li key={c.id} className="flex items-center gap-3 border-b-[0.8px] border-line py-3 last:border-b-0">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[14px] text-warm">{c.title.replace(/^◎\s*/, "")}</p>
                        {c.dueAt && <p className="text-[12px] text-faint">Due {relTime(c.dueAt)}</p>}
                      </div>
                      <button onClick={() => openUrl(c.calendarUrl!)} title="Opens Google Calendar with this event filled in"
                        className="no-drag flex shrink-0 items-center gap-1 rounded-[10px] bg-accent px-3 py-1.5 text-[12.5px] font-medium text-accent-ink transition-opacity hover:opacity-90">
                        Add <ArrowUpRight size={13} />
                      </button>
                    </li>
                  ))}
                </ul>
                <CalendarAgentBox />
              </Window>
            )}

            <div className="flex gap-3 px-1 text-[13px] text-faint">
              <button onClick={() => openWorkflow("inbox")} className="no-drag hover:text-warm">{data.counts.emails} emails need you</button>
              <span>·</span>
              <button onClick={() => setScreen("approve")} className="no-drag hover:text-warm">{data.counts.approvals} to approve</button>
              <span>·</span>
              <span>{data.counts.ignored} handled quietly</span>
            </div>
          </div>
        </div>
      )}


    </div>
  );
}

/**
 * Chat box at the end of "Add to calendar". The user describes an event; the agent searches mail, Knowledge files,
 * approvals and calendar for related details and proposes events. Each one waits for the user's Add (approve) or Skip.
 */
export function CalendarAgentBox() {
  const [q, setQ] = useState("");
  const [asked, setAsked] = useState("");
  const [busy, setBusy] = useState(false);
  const [cands, setCands] = useState<EventCandidate[]>([]);
  const [status, setStatus] = useState<Record<string, "adding" | "added" | "link" | "skipped">>({});

  const search = async () => {
    const text = q.trim(); if (!text || busy) return;
    setBusy(true); setAsked(text); setCands([]); setStatus({});
    const found = await suggestEvents(text);
    setCands(found); setBusy(false); setQ("");
  };
  const add = async (c: EventCandidate) => {
    setStatus(s => ({ ...s, [c.id]: "adding" }));
    const r = await addEvent(c);
    setStatus(s => ({ ...s, [c.id]: r.via === "service" ? "added" : "link" }));
  };
  const when = (c: EventCandidate) => {
    const s = new Date(c.start), e = new Date(c.end);
    return `${s.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} · ${clock(c.start)}–${clock(c.end)}`
      + (e.getDate() !== s.getDate() ? " (+1d)" : "");
  };
  const visible = cands.filter(c => status[c.id] !== "skipped");

  return (
    <div className="border-t-[0.8px] border-line">
      <AnimatePresence initial={false}>
        {(busy || asked) && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }} className="overflow-hidden">
            <div className="px-5 pt-4">
              {asked && <p className="mb-3 ml-auto w-fit max-w-[85%] rounded-[14px] rounded-br-[4px] bg-white/[0.08] px-3.5 py-2 text-[13.5px] text-ink">{asked}</p>}
              {busy ? (
                <p className="flex items-center gap-2 pb-4 text-[13px] text-muted">
                  <Loader2 size={14} className="animate-spin text-accent" /> Searching your email, files and calendar…
                </p>
              ) : visible.length > 0 ? (
                <div className="pb-4">
                  <p className="mb-2.5 text-[12.5px] text-faint">
                    Found {visible.length} {visible.length === 1 ? "event" : "events"}. Nothing is added until you say so.
                  </p>
                  <ul className="flex flex-col gap-2">
                    <AnimatePresence initial={false}>
                      {visible.map((c, i) => {
                        const st = status[c.id];
                        const SrcIcon = c.source === "email" ? Mail : c.source === "knowledge" ? BookOpen : c.source === "approval" ? Sparkles : c.source === "calendar" ? CalendarDays : PenLine;
                        return (
                          <motion.li key={c.id} layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0, transition: { delay: i * 0.06 } }} exit={{ opacity: 0, height: 0 }}
                            className={`rounded-[12px] border-[0.8px] p-3.5 transition-colors ${st === "added" || st === "link" ? "border-emerald-400/30 bg-accent/[0.04]" : "border-line bg-raised"}`}>
                            <div className="flex items-start gap-3">
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-[14.5px] text-ink">{c.title}</p>
                                <p className="mt-0.5 text-[12.5px] text-warm tabular-nums">{when(c)}</p>
                                <p className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-faint"><SrcIcon size={12} /> {c.sourceLabel}</p>
                                {c.conflict && <p className="mt-1 text-[11.5px] text-accent">⚠ {c.conflict}</p>}
                              </div>
                              {st === "added" ? (
                                <span className="flex shrink-0 items-center gap-1 text-[12.5px] text-emerald-300"><Check size={14} /> Added</span>
                              ) : st === "link" ? (
                                <span className="flex shrink-0 items-center gap-1 text-[12px] text-emerald-300" title="Google Calendar opened with this event filled in. Press Save there.">
                                  <ArrowUpRight size={13} /> Save it in Google
                                </span>
                              ) : (
                                <div className="flex shrink-0 items-center gap-1.5">
                                  <button onClick={() => setStatus(s => ({ ...s, [c.id]: "skipped" }))}
                                    className="no-drag rounded-full px-2.5 py-1.5 text-[12.5px] text-faint hover:text-warm">Skip</button>
                                  <button onClick={() => add(c)} disabled={st === "adding"}
                                    className="no-drag flex items-center gap-1 rounded-[10px] bg-accent px-3 py-1.5 text-[12.5px] font-medium text-accent-ink transition-opacity hover:opacity-90 disabled:opacity-50">
                                    {st === "adding" ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Add
                                  </button>
                                </div>
                              )}
                            </div>
                          </motion.li>
                        );
                      })}
                    </AnimatePresence>
                  </ul>
                </div>
              ) : asked ? (
                <p className="pb-4 text-[13px] text-faint">All set. Nothing left to add.</p>
              ) : null}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <form onSubmit={(e) => { e.preventDefault(); search(); }} className="flex items-center gap-2 px-4 py-3">
        <input value={q} onChange={e => setQ(e.target.value)} disabled={busy}
          placeholder="Add an event… e.g. career fair next Tue 2pm"
          className="no-drag h-10 min-w-0 flex-1 rounded-full border-[0.8px] border-line bg-white/[0.03] px-4 text-[13.5px] text-ink placeholder:text-faint focus:border-white/25 focus:outline-none" />
        <button type="submit" disabled={!q.trim() || busy} aria-label="Find events"
          className="no-drag flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white text-accent-ink transition-opacity disabled:opacity-25">
          {busy ? <Loader2 size={16} className="animate-spin" /> : <ArrowUp size={16} />}
        </button>
      </form>
    </div>
  );
}

function KindTag({ kind }: { kind: PriorityKind }) {
  const Icon = ICON[kind];
  return <span className="flex items-center gap-1.5 text-[12px] font-medium tracking-[0.06em] text-accent uppercase"><Icon size={13} /> {LABEL[kind]}</span>;
}

/** Thin 8am–11pm progress bar with a glowing "now" dot. */
function DayBar() {
  const start = 8, end = 23;
  const now = new Date(); const h = now.getHours() + now.getMinutes() / 60;
  const pct = Math.max(0, Math.min(1, (h - start) / (end - start))) * 100;
  const left = Math.max(0, end - h);
  return (
    <div className="px-5 pt-4 pb-2">
      <div className="mb-2 flex justify-between text-[11px] text-faint"><span>8a</span><span>{left.toFixed(0)}h left</span><span>11p</span></div>
      <div className="relative h-[3px] rounded-full bg-white/[0.08]">
        <div className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${pct}%` }} />
        <div className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white" style={{ left: `${pct}%` }} />
      </div>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="grid grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] gap-6">
      <div className="h-[220px] animate-pulse rounded-[18px] bg-white/[0.04]" />
      <div className="h-[220px] animate-pulse rounded-[18px] bg-white/[0.04]" />
    </div>
  );
}

/** Floating ask input. Chat isn't built yet, so questions are queued in the store for the chat screen to pick up. */
export function AskBar() {
  const [q, setQ] = useState("");
  const [sent, setSent] = useState(false);
  const askChat = useUI(s => s.askChat);
  const ref = useRef<HTMLInputElement>(null);

  const submit = () => {
    const text = q.trim(); if (!text) return;
    askChat(text); setQ(""); setSent(true);
    setTimeout(() => setSent(false), 2600);
  };

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-7 z-30 flex justify-center px-10">
      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1], delay: 0.15 }}
        className="pointer-events-auto relative w-full max-w-[680px]">
        <form onSubmit={(e) => { e.preventDefault(); submit(); }}
          onClick={() => ref.current?.focus()}
          className="no-drag relative flex h-[58px] items-center gap-3 rounded-full border-[0.8px] border-white/15 bg-surface/85 pr-2 pl-5 shadow-[0_20px_60px_rgba(0,0,0,.6)] backdrop-blur-xl">
          <Sparkles size={18} className="shrink-0 text-accent" />
          <input ref={ref} value={q} onChange={e => setQ(e.target.value)}
            placeholder="Ask Northstar anything about your day…"
            className="min-w-0 flex-1 bg-transparent text-[15.5px] text-ink placeholder:text-faint focus:outline-none" />
          <AnimatePresence mode="wait">
            {sent ? (
              <motion.span key="sent" initial={{ opacity: 0, x: 6 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }}
                className="flex shrink-0 items-center gap-1.5 pr-3 text-[12.5px] text-muted"><Check size={14} className="text-accent" /> Saved for chat</motion.span>
            ) : (
              <motion.button key="go" type="submit" disabled={!q.trim()} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                aria-label="Ask"
                className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-full bg-white text-accent-ink transition-opacity disabled:opacity-25">
                <ArrowUp size={18} />
              </motion.button>
            )}
          </AnimatePresence>
        </form>
      </motion.div>
    </div>
  );
}
