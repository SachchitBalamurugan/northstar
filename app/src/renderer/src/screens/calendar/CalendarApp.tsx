// Full calendar: Day / Week / Month views, mini-month navigator, calendar toggles, search,
// click-to-create, event details, edit, delete, overlap layout, current-time line, keyboard shortcuts.
// Real Google Calendar through the inbox service; an in-memory demo calendar when it's offline.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronLeft, ChevronRight, Plus, Search, X, MapPin, Clock, Trash2, Pencil, CalendarDays, AlignLeft, Sparkles, Flag } from "lucide-react";
import { getEventsBetween, createEvent, updateEvent, deleteEvent, getTriage, isOnline, type CalEventFull } from "@/api";
import { CalendarAgentBox } from "../Dashboard";
import {
  type View, HOUR_PX, range, step, title, sameDay, startOfDay, addDays, startOfMonth, startOfWeek, addMonths,
  timeLabel, hourLabel, minutesOfDay, layoutDay, toLocalInput, fromLocalInput,
} from "./cal";

/* ---------- calendars (color-coded, toggleable) ---------- */
type CalId = "google" | "northstar" | "deadlines";
const CALS: Record<CalId, { label: string; color: string; bg: string; border: string }> = {
  google: { label: "My calendar", color: "#9DB8FF", bg: "rgba(91,140,255,.16)", border: "#5B8CFF" },
  northstar: { label: "Northstar focus blocks", color: "#3DDC97", bg: "rgba(61,220,151,.14)", border: "#3DDC97" },
  deadlines: { label: "Deadlines from email", color: "#F2B84B", bg: "rgba(242,184,75,.12)", border: "#F2B84B" },
};

interface Ev extends CalEventFull { cal: CalId }
const calOf = (e: CalEventFull): CalId => (e.northstar ? "northstar" : "google");

interface Draft { id?: string; title: string; start: string; end: string; location: string; details: string }

export default function CalendarApp() {
  const [view, setView] = useState<View>("week");
  const [cursor, setCursor] = useState(() => startOfDay(new Date()));
  const [events, setEvents] = useState<Ev[]>([]);
  const [loading, setLoading] = useState(true);
  const [shown, setShown] = useState<Record<CalId, boolean>>({ google: true, northstar: true, deadlines: true });
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const win = useMemo(() => range(view, cursor), [view, cursor]);

  const load = useCallback(async () => {
    setLoading(true);
    const [list, triage] = await Promise.all([getEventsBetween(win.from, win.to), getTriage()]);
    // Deadlines from triaged email become all-day markers on their due date.
    const dl: Ev[] = [...triage.needsYou, ...triage.fyi].filter(e => e.dueAt).map(e => {
      const d = startOfDay(new Date(e.dueAt!));
      return { id: `dl-${e.id}`, title: e.subject.replace(/^(re|fwd?):\s*/i, ""), start: d.toISOString(), end: addDays(d, 1).toISOString(),
        allDay: true, description: `From ${e.from}: ${e.snippet}`, cal: "deadlines" as CalId };
    });
    setEvents([...list.map(e => ({ ...e, cal: calOf(e) })), ...dl]);
    setLoading(false);
  }, [win.from.getTime(), win.to.getTime()]);

  useEffect(() => { load(); }, [load]);

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(null), 2600); };

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return events.filter(e => shown[e.cal] && (!needle || `${e.title} ${e.location ?? ""} ${e.description ?? ""}`.toLowerCase().includes(needle)));
  }, [events, shown, q]);

  const opened = events.find(e => e.id === openId) ?? null;

  /* ---------- actions ---------- */
  const newAt = (start: Date, minutes = 60) => setDraft({ title: "", start: start.toISOString(), end: new Date(+start + minutes * 60e3).toISOString(), location: "", details: "" });
  const save = async () => {
    if (!draft || !draft.title.trim()) return;
    if (+new Date(draft.end) <= +new Date(draft.start)) { flash("End time must be after the start"); return; }
    setBusy(true);
    const body = { title: draft.title.trim(), start: draft.start, end: draft.end, location: draft.location || undefined, details: draft.details || undefined };
    const r = draft.id ? await updateEvent(draft.id, body) : await createEvent(body);
    setBusy(false);
    if (r?.error) { flash(r.error); return; }
    flash(draft.id ? "Event updated" : isOnline("inbox") ? "Added to Google Calendar" : "Added (demo calendar)");
    setDraft(null); setOpenId(null); load();
  };
  const remove = async (e: Ev) => {
    const r = await deleteEvent(e.id);
    if (r?.error) { flash(r.error); return; }
    flash("Event deleted"); setOpenId(null); load();
  };

  /* ---------- keyboard: T today, D/W/M views, ←/→ navigate, N new, / search, Esc close ---------- */
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) { if (e.key === "Escape") (t as HTMLInputElement).blur(); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "Escape") { setOpenId(null); setDraft(null); }
      else if (draft || opened) return;
      else if (e.key === "t" || e.key === "T") setCursor(startOfDay(new Date()));
      else if (e.key === "d") setView("day"); else if (e.key === "w") setView("week"); else if (e.key === "m") setView("month");
      else if (e.key === "ArrowLeft") setCursor(c => step(view, c, -1)); else if (e.key === "ArrowRight") setCursor(c => step(view, c, 1));
      else if (e.key === "n") { const s = new Date(); s.setMinutes(s.getMinutes() < 30 ? 30 : 60, 0, 0); newAt(s); }
      else if (e.key === "/") { e.preventDefault(); searchRef.current?.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, draft, opened]);

  return (
    <div className="relative">
      {/* Toolbar */}
      <div className="mb-5 flex items-center gap-3">
        <button onClick={() => setCursor(startOfDay(new Date()))} title="Today (T)"
          className="no-drag h-9 rounded-full border-[0.8px] border-white/20 px-4 text-[13.5px] text-ink transition-colors hover:bg-white/[0.06]">Today</button>
        <div className="flex">
          <IconBtn label="Previous (←)" onClick={() => setCursor(c => step(view, c, -1))}><ChevronLeft size={18} /></IconBtn>
          <IconBtn label="Next (→)" onClick={() => setCursor(c => step(view, c, 1))}><ChevronRight size={18} /></IconBtn>
        </div>
        <h2 className="display min-w-0 truncate text-[26px] text-ink">{title(view, cursor)}</h2>
        {loading && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" title="Loading" />}

        <div className="ml-auto flex items-center gap-3">
          <label className="no-drag flex h-9 w-[220px] items-center gap-2 rounded-full border-[0.8px] border-line bg-white/[0.03] px-3 focus-within:border-white/25">
            <Search size={14} className="text-faint" />
            <input ref={searchRef} value={q} onChange={e => setQ(e.target.value)} placeholder="Search events  /"
              className="min-w-0 flex-1 bg-transparent text-[13px] text-ink placeholder:text-faint focus:outline-none" />
            {q && <button onClick={() => setQ("")} aria-label="Clear search"><X size={13} className="text-faint" /></button>}
          </label>
          <div className="no-drag flex rounded-full border-[0.8px] border-line bg-white/[0.03] p-0.5">
            {(["day", "week", "month"] as View[]).map(v => (
              <button key={v} onClick={() => setView(v)} title={`${v[0].toUpperCase()}${v.slice(1)} (${v[0].toUpperCase()})`}
                className={`relative h-8 rounded-full px-3.5 text-[13px] capitalize transition-colors ${view === v ? "text-ink" : "text-muted hover:text-ink"}`}>
                {view === v && <motion.span layoutId="cal-view" transition={{ duration: 0.25 }} className="absolute inset-0 rounded-full bg-white/10" />}
                <span className="relative">{v}</span>
              </button>
            ))}
          </div>
          <button onClick={() => { const s = new Date(cursor); const n = new Date(); s.setHours(sameDay(cursor, n) ? n.getHours() + 1 : 9, 0, 0, 0); newAt(s); }}
            className="no-drag flex h-9 items-center gap-1.5 rounded-[10px] bg-accent px-4 text-[13.5px] font-medium text-accent-ink transition-opacity hover:opacity-90" title="New event (N)">
            <Plus size={15} /> New event
          </button>
        </div>
      </div>

      <div className="grid grid-cols-[236px_minmax(0,1fr)] gap-5">
        {/* Sidebar */}
        <aside className="flex flex-col gap-5">
          <MiniMonth cursor={cursor} events={visible} onPick={d => { setCursor(d); if (view === "month") setView("day"); }} />
          <div>
            <p className="mb-2 px-1 text-[11px] font-medium tracking-[0.14em] text-faint uppercase">My calendars</p>
            {(Object.keys(CALS) as CalId[]).map(id => (
              <button key={id} onClick={() => setShown(s => ({ ...s, [id]: !s[id] }))}
                className="no-drag flex w-full items-center gap-2.5 rounded-[8px] px-2 py-1.5 text-left text-[13px] text-warm hover:bg-white/[0.04]">
                <span className="flex h-4 w-4 items-center justify-center rounded-[4px] border-[1.5px] transition-colors"
                  style={{ borderColor: CALS[id].border, background: shown[id] ? CALS[id].border : "transparent" }}>
                  {shown[id] && <svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 5.2l2 2 4-4.4" stroke="#000" strokeWidth="1.6" fill="none" strokeLinecap="round" /></svg>}
                </span>
                {CALS[id].label}
              </button>
            ))}
          </div>
          <Upcoming events={visible} onOpen={id => setOpenId(id)} />
          <div className="overflow-hidden rounded-[14px] border-[0.8px] border-line bg-surface">
            <p className="flex items-center gap-2 px-4 pt-3.5 text-[13px] text-ink"><Sparkles size={14} className="text-accent" /> Ask Northstar to add</p>
            <CalendarAgentBox />
          </div>
        </aside>

        {/* Main view */}
        <div className="min-w-0 overflow-hidden rounded-[18px] border-[0.8px] border-line bg-surface shadow-[0_24px_80px_rgba(0,0,0,0.33)]">
          <AnimatePresence mode="wait">
            <motion.div key={view + win.from.toDateString()} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
              {view === "month"
                ? <MonthGrid days={win.days} cursor={cursor} events={visible} onOpen={setOpenId} onDay={d => { setCursor(d); setView("day"); }} onCreate={d => { const s = new Date(d); s.setHours(9, 0, 0, 0); newAt(s); }} />
                : <TimeGrid days={win.days} events={visible} onOpen={setOpenId} onCreate={newAt} onDayHeader={d => { setCursor(d); setView("day"); }} />}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>

      {/* Event details */}
      <AnimatePresence>
        {opened && !draft && (
          <Overlay onClose={() => setOpenId(null)}>
            <EventDetails ev={opened} onClose={() => setOpenId(null)} onDelete={() => remove(opened)}
              onEdit={() => setDraft({ id: opened.id, title: opened.title, start: opened.start, end: opened.end, location: opened.location ?? "", details: opened.description ?? "" })} />
          </Overlay>
        )}
      </AnimatePresence>

      {/* Create / edit */}
      <AnimatePresence>
        {draft && (
          <Overlay onClose={() => setDraft(null)}>
            <EventEditor draft={draft} busy={busy} onChange={setDraft} onCancel={() => setDraft(null)} onSave={save} />
          </Overlay>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {toast && (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }}
            className="fixed bottom-24 left-1/2 z-[70] -translate-x-1/2 rounded-full border-[0.8px] border-white/15 bg-raised px-4 py-2 text-[13px] text-ink shadow-xl">
            {toast}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ============================== pieces ============================== */

function IconBtn({ children, label, onClick }: { children: React.ReactNode; label: string; onClick: () => void }) {
  return <button onClick={onClick} title={label} aria-label={label} className="no-drag flex h-9 w-9 items-center justify-center rounded-full text-muted transition-colors hover:bg-white/[0.06] hover:text-ink">{children}</button>;
}

function MiniMonth({ cursor, events, onPick }: { cursor: Date; events: Ev[]; onPick: (d: Date) => void }) {
  const [month, setMonth] = useState(() => startOfMonth(cursor));
  useEffect(() => { setMonth(startOfMonth(cursor)); }, [cursor.getFullYear(), cursor.getMonth()]);
  const first = startOfWeek(month), today = new Date();
  const has = new Set(events.map(e => startOfDay(new Date(e.start)).toDateString()));
  return (
    <div className="rounded-[14px] border-[0.8px] border-line bg-surface p-3">
      <div className="mb-2 flex items-center justify-between px-1">
        <span className="text-[13.5px] font-medium text-ink">{month.toLocaleDateString([], { month: "long", year: "numeric" })}</span>
        <span className="flex">
          <button onClick={() => setMonth(m => addMonths(m, -1))} aria-label="Previous month" className="no-drag rounded-full p-1 text-faint hover:text-ink"><ChevronLeft size={15} /></button>
          <button onClick={() => setMonth(m => addMonths(m, 1))} aria-label="Next month" className="no-drag rounded-full p-1 text-faint hover:text-ink"><ChevronRight size={15} /></button>
        </span>
      </div>
      <div className="grid grid-cols-7 text-center text-[10.5px] text-faint">{["S", "M", "T", "W", "T", "F", "S"].map((d, i) => <span key={i} className="py-1">{d}</span>)}</div>
      <div className="grid grid-cols-7 gap-y-0.5">
        {Array.from({ length: 42 }, (_, i) => addDays(first, i)).map(d => {
          const inMonth = d.getMonth() === month.getMonth(), isToday = sameDay(d, today), sel = sameDay(d, cursor);
          return (
            <button key={d.toISOString()} onClick={() => onPick(d)}
              className={`no-drag relative mx-auto flex h-7 w-7 items-center justify-center rounded-full text-[12px] tabular-nums transition-colors
                ${sel ? "bg-white text-accent-ink" : isToday ? "text-accent" : inMonth ? "text-warm hover:bg-white/[0.07]" : "text-faint/60 hover:bg-white/[0.05]"}`}>
              {d.getDate()}
              {has.has(d.toDateString()) && !sel && <span className="absolute bottom-0.5 h-1 w-1 rounded-full bg-white/40" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Upcoming({ events, onOpen }: { events: Ev[]; onOpen: (id: string) => void }) {
  const now = Date.now();
  const next = events.filter(e => !e.allDay && +new Date(e.end) > now).sort((a, b) => +new Date(a.start) - +new Date(b.start)).slice(0, 4);
  if (!next.length) return null;
  return (
    <div>
      <p className="mb-2 px-1 text-[11px] font-medium tracking-[0.14em] text-faint uppercase">Up next</p>
      {next.map(e => (
        <button key={e.id} onClick={() => onOpen(e.id)} className="no-drag flex w-full gap-2.5 rounded-[8px] px-2 py-1.5 text-left hover:bg-white/[0.04]">
          <span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ background: CALS[e.cal].border }} />
          <span className="min-w-0">
            <span className="block truncate text-[13px] text-warm">{e.title.replace(/^◎\s*/, "")}</span>
            <span className="block text-[11.5px] text-faint">{new Date(e.start).toLocaleDateString([], { weekday: "short" })} · {timeLabel(new Date(e.start))}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

/* ---------- Day & Week time grid ---------- */
function TimeGrid({ days, events, onOpen, onCreate, onDayHeader }: {
  days: Date[]; events: Ev[]; onOpen: (id: string) => void; onCreate: (start: Date, minutes?: number) => void; onDayHeader: (d: Date) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 60e3); return () => clearInterval(t); }, []);
  useEffect(() => { // open scrolled to ~1h before now (or 7am)
    const h = days.some(d => sameDay(d, new Date())) ? Math.max(0, new Date().getHours() - 1) : 7;
    scroller.current?.scrollTo({ top: h * HOUR_PX });
  }, [days[0].toDateString(), days.length]);

  const single = days.length === 1;
  const cols = `56px repeat(${days.length}, minmax(0, 1fr))`;
  const allDay = (d: Date) => events.filter(e => (e.allDay || +new Date(e.end) - +new Date(e.start) >= 864e5) && new Date(e.start) < addDays(d, 1) && new Date(e.end) > d);
  const timed = (d: Date) => events.filter(e => !(e.allDay || +new Date(e.end) - +new Date(e.start) >= 864e5) && sameDay(new Date(e.start), d));
  const anyAllDay = days.some(d => allDay(d).length > 0);

  const clickSlot = (d: Date, e: React.MouseEvent<HTMLDivElement>) => {
    const y = e.clientY - e.currentTarget.getBoundingClientRect().top;
    const mins = Math.floor((y / HOUR_PX) * 60 / 30) * 30;
    const s = new Date(d); s.setHours(0, mins, 0, 0); onCreate(s);
  };

  return (
    <div>
      {/* Header */}
      <div className="grid border-b-[0.8px] border-line" style={{ gridTemplateColumns: cols }}>
        <div className="py-3 text-center text-[10.5px] text-faint">{Intl.DateTimeFormat().resolvedOptions().timeZone.split("/").pop()?.replace("_", " ")}</div>
        {days.map(d => {
          const isToday = sameDay(d, now);
          return (
            <button key={d.toISOString()} onClick={() => onDayHeader(d)} className={`no-drag flex ${single ? "items-center gap-3 px-4" : "flex-col items-center"} py-2.5 hover:bg-white/[0.02]`}>
              <span className={`text-[11px] tracking-[0.12em] uppercase ${isToday ? "text-accent" : "text-faint"}`}>{d.toLocaleDateString([], { weekday: "short" })}</span>
              <span className={`display mt-0.5 flex h-9 w-9 items-center justify-center rounded-full text-[20px] ${isToday ? "bg-accent text-accent-ink" : "text-ink"}`}>{d.getDate()}</span>
            </button>
          );
        })}
      </div>

      {/* All-day row */}
      {anyAllDay && (
        <div className="grid border-b-[0.8px] border-line" style={{ gridTemplateColumns: cols }}>
          <div className="py-1.5 pr-2 text-right text-[10px] text-faint">all-day</div>
          {days.map(d => (
            <div key={d.toISOString()} className="flex flex-col gap-1 border-l-[0.8px] border-line p-1">
              {allDay(d).map(e => <Chip key={e.id} e={e} onOpen={onOpen} />)}
            </div>
          ))}
        </div>
      )}

      {/* Hours */}
      <div ref={scroller} className="relative max-h-[600px] overflow-y-auto">
        <div className="grid" style={{ gridTemplateColumns: cols, height: 24 * HOUR_PX }}>
          <div className="relative">
            {Array.from({ length: 24 }, (_, h) => (
              <span key={h} className="absolute right-2 -translate-y-1/2 text-[10.5px] text-faint tabular-nums" style={{ top: h * HOUR_PX }}>{h ? hourLabel(h) : ""}</span>
            ))}
          </div>
          {days.map(d => {
            const isToday = sameDay(d, now);
            return (
              <div key={d.toISOString()} onClick={e => clickSlot(d, e)} title="Click to add an event"
                className="relative cursor-crosshair border-l-[0.8px] border-line"
                style={{ backgroundImage: `repeating-linear-gradient(to bottom, rgba(255,255,255,.06) 0 1px, transparent 1px ${HOUR_PX / 2}px, rgba(255,255,255,.025) ${HOUR_PX / 2}px ${HOUR_PX / 2 + 1}px, transparent ${HOUR_PX / 2 + 1}px ${HOUR_PX}px)` }}>
                {isToday && <div className="pointer-events-none absolute inset-0 bg-white/[0.015]" />}
                {layoutDay(timed(d)).map(({ ev, col, cols: n }) => {
                  const s = new Date(ev.start), en = new Date(ev.end);
                  const top = (minutesOfDay(s) / 60) * HOUR_PX;
                  const h = Math.max(20, ((+en - +s) / 36e5) * HOUR_PX - 2);
                  const c = CALS[ev.cal], past = +en < +now;
                  return (
                    <button key={ev.id} onClick={e => { e.stopPropagation(); onOpen(ev.id); }}
                      className={`no-drag absolute overflow-hidden rounded-[7px] border-l-[3px] px-2 py-1 text-left transition-[filter] hover:brightness-125 ${past ? "opacity-55" : ""}`}
                      style={{ top, height: h, left: `calc(${(col / n) * 100}% + 2px)`, width: `calc(${100 / n}% - 4px)`, background: c.bg, borderColor: c.border }}>
                      <p className="truncate text-[12px] font-medium leading-tight" style={{ color: c.color }}>{ev.title.replace(/^◎\s*/, "")}</p>
                      {h > 34 && <p className="truncate text-[11px] text-muted">{timeLabel(s)} – {timeLabel(en)}</p>}
                      {h > 52 && ev.location && <p className="truncate text-[11px] text-faint">{ev.location}</p>}
                    </button>
                  );
                })}
                {isToday && (
                  <div className="pointer-events-none absolute right-0 left-0 z-10" style={{ top: (minutesOfDay(now) / 60) * HOUR_PX }}>
                    <div className="relative h-[2px] bg-accent"><span className="absolute -top-[4px] -left-[5px] h-2.5 w-2.5 rounded-full bg-accent" /></div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ---------- Month grid ---------- */
function MonthGrid({ days, cursor, events, onOpen, onDay, onCreate }: {
  days: Date[]; cursor: Date; events: Ev[]; onOpen: (id: string) => void; onDay: (d: Date) => void; onCreate: (d: Date) => void;
}) {
  const today = new Date();
  const on = (d: Date) => events.filter(e => new Date(e.start) < addDays(d, 1) && new Date(e.end) > d)
    .sort((a, b) => Number(!!b.allDay) - Number(!!a.allDay) || +new Date(a.start) - +new Date(b.start));
  return (
    <div>
      <div className="grid grid-cols-7 border-b-[0.8px] border-line">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(d => <span key={d} className="py-2.5 text-center text-[11px] tracking-[0.12em] text-faint uppercase">{d}</span>)}
      </div>
      <div className="grid grid-cols-7 grid-rows-6">
        {days.map((d, i) => {
          const list = on(d), inMonth = d.getMonth() === cursor.getMonth(), isToday = sameDay(d, today);
          return (
            <div key={d.toISOString()} onDoubleClick={() => onCreate(d)} title="Double-click to add an event"
              className={`group relative h-[112px] border-line p-1.5 ${i % 7 ? "border-l-[0.8px]" : ""} ${i >= 7 ? "border-t-[0.8px]" : ""} ${inMonth ? "" : "bg-white/[0.012]"}`}>
              <button onClick={() => onDay(d)}
                className={`no-drag mb-1 flex h-6 w-6 items-center justify-center rounded-full text-[12px] tabular-nums transition-colors
                  ${isToday ? "bg-accent text-accent-ink" : inMonth ? "text-warm hover:bg-white/10" : "text-faint/60 hover:bg-white/[0.06]"}`}>{d.getDate()}</button>
              <div className="flex flex-col gap-0.5">
                {list.slice(0, 3).map(e => <Chip key={e.id} e={e} onOpen={onOpen} compact />)}
                {list.length > 3 && <button onClick={() => onDay(d)} className="no-drag px-1.5 text-left text-[11px] text-muted hover:text-ink">+{list.length - 3} more</button>}
              </div>
              <button onClick={() => onCreate(d)} aria-label="Add event this day"
                className="no-drag absolute top-1.5 right-1.5 hidden h-6 w-6 items-center justify-center rounded-full text-faint hover:bg-white/10 hover:text-ink group-hover:flex"><Plus size={13} /></button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Chip({ e, onOpen, compact = false }: { e: Ev; onOpen: (id: string) => void; compact?: boolean }) {
  const c = CALS[e.cal];
  const timedEvent = !e.allDay;
  return (
    <button onClick={ev => { ev.stopPropagation(); onOpen(e.id); }}
      className="no-drag flex w-full items-center gap-1.5 truncate rounded-[5px] px-1.5 py-[2px] text-left text-[11.5px] hover:brightness-125"
      style={{ background: e.allDay ? c.bg : "transparent", color: c.color }}>
      {timedEvent && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: c.border }} />}
      {e.cal === "deadlines" && <Flag size={10} className="shrink-0" />}
      {compact && timedEvent && <span className="shrink-0 text-faint tabular-nums">{new Date(e.start).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).replace(":00", "").replace(" ", "").toLowerCase()}</span>}
      <span className="truncate">{e.title.replace(/^◎\s*/, "")}</span>
    </button>
  );
}

/* ---------- overlays ---------- */
function Overlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}
      onMouseDown={onClose} className="fixed inset-0 z-[65] flex items-center justify-center bg-black/55 backdrop-blur-sm">
      <motion.div initial={{ scale: 0.96, y: 8 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.97, y: 4 }} transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
        onMouseDown={e => e.stopPropagation()}
        className="w-[440px] overflow-hidden rounded-[18px] border-[0.8px] border-white/12 bg-surface shadow-[0_30px_100px_rgba(0,0,0,.7)]">
        {children}
      </motion.div>
    </motion.div>
  );
}

function EventDetails({ ev, onClose, onEdit, onDelete }: { ev: Ev; onClose: () => void; onEdit: () => void; onDelete: () => void }) {
  const s = new Date(ev.start), e = new Date(ev.end), c = CALS[ev.cal];
  const editable = ev.cal !== "deadlines";
  const [confirming, setConfirming] = useState(false);
  return (
    <div>
      <div className="flex items-center justify-end gap-1 px-3 pt-3">
        {confirming ? (
          <span className="mr-auto flex items-center gap-2 pl-3 text-[13px] text-warm">
            Delete this event?
            <button onClick={onDelete} className="no-drag rounded-full bg-accent px-3 py-1 text-[12.5px] font-medium text-accent-ink">Delete</button>
            <button onClick={() => setConfirming(false)} className="no-drag px-2 py-1 text-[12.5px] text-muted hover:text-ink">Keep</button>
          </span>
        ) : null}
        {editable && !confirming && <IconBtn label="Edit" onClick={onEdit}><Pencil size={15} /></IconBtn>}
        {editable && !confirming && <IconBtn label="Delete" onClick={() => setConfirming(true)}><Trash2 size={15} /></IconBtn>}
        <IconBtn label="Close (Esc)" onClick={onClose}><X size={16} /></IconBtn>
      </div>
      <div className="px-6 pb-6">
        <div className="flex items-start gap-3">
          <span className="mt-2 h-3 w-3 shrink-0 rounded-[4px]" style={{ background: c.border }} />
          <h3 className="display text-[24px] text-ink">{ev.title.replace(/^◎\s*/, "")}</h3>
        </div>
        <div className="mt-4 flex flex-col gap-3 pl-6 text-[13.5px] text-warm">
          <p className="flex items-center gap-2.5"><Clock size={14} className="text-faint" />
            {ev.allDay ? `${s.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })} · all day`
              : `${s.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })} · ${timeLabel(s)} – ${timeLabel(e)}`}</p>
          {ev.location && <p className="flex items-center gap-2.5"><MapPin size={14} className="text-faint" />{ev.location}</p>}
          {ev.description && <p className="flex items-start gap-2.5 whitespace-pre-wrap text-muted"><AlignLeft size={14} className="mt-0.5 shrink-0 text-faint" />{ev.description}</p>}
          <p className="flex items-center gap-2.5 text-faint"><CalendarDays size={14} />{c.label}</p>
        </div>
      </div>
    </div>
  );
}

function EventEditor({ draft, busy, onChange, onCancel, onSave }: { draft: Draft; busy: boolean; onChange: (d: Draft) => void; onCancel: () => void; onSave: () => void }) {
  const field = "no-drag w-full rounded-[10px] border-[0.8px] border-line bg-white/[0.03] px-3 py-2.5 text-[14px] text-ink placeholder:text-faint focus:border-white/25 focus:outline-none [color-scheme:dark]";
  return (
    <form onSubmit={e => { e.preventDefault(); onSave(); }} className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="display text-[22px] text-ink">{draft.id ? "Edit event" : "New event"}</h3>
        <IconBtn label="Cancel (Esc)" onClick={onCancel}><X size={16} /></IconBtn>
      </div>
      <input autoFocus value={draft.title} onChange={e => onChange({ ...draft, title: e.target.value })} placeholder="Add a title"
        className="no-drag mb-4 w-full border-b-[0.8px] border-line bg-transparent pb-2 text-[20px] text-ink placeholder:text-faint focus:border-white/30 focus:outline-none" />
      <div className="mb-3 grid grid-cols-2 gap-3">
        <label className="text-[11.5px] text-faint">Starts
          <input type="datetime-local" value={toLocalInput(draft.start)} onChange={e => {
            const ns = fromLocalInput(e.target.value), dur = +new Date(draft.end) - +new Date(draft.start);
            onChange({ ...draft, start: ns, end: new Date(+new Date(ns) + Math.max(dur, 15 * 60e3)).toISOString() });
          }} className={`${field} mt-1`} />
        </label>
        <label className="text-[11.5px] text-faint">Ends
          <input type="datetime-local" value={toLocalInput(draft.end)} onChange={e => onChange({ ...draft, end: fromLocalInput(e.target.value) })} className={`${field} mt-1`} />
        </label>
      </div>
      <div className="mb-3 flex gap-1.5">
        {[30, 60, 90, 120].map(m => (
          <button type="button" key={m} onClick={() => onChange({ ...draft, end: new Date(+new Date(draft.start) + m * 60e3).toISOString() })}
            className="no-drag rounded-full border-[0.8px] border-line px-2.5 py-1 text-[11.5px] text-muted hover:text-ink">{m < 60 ? `${m}m` : `${m / 60}h`}</button>
        ))}
      </div>
      <input value={draft.location} onChange={e => onChange({ ...draft, location: e.target.value })} placeholder="Location" className={`${field} mb-3`} />
      <textarea value={draft.details} onChange={e => onChange({ ...draft, details: e.target.value })} placeholder="Notes" rows={3} className={`${field} mb-5 resize-none`} />
      <div className="flex items-center justify-end gap-3">
        <button type="button" onClick={onCancel} className="no-drag text-[14px] text-muted hover:text-ink">Cancel</button>
        <button type="submit" disabled={!draft.title.trim() || busy}
          className="no-drag h-10 rounded-[10px] bg-accent px-5 text-[14px] font-medium text-accent-ink transition-opacity disabled:opacity-40">{busy ? "Saving…" : draft.id ? "Save changes" : "Add to calendar"}</button>
      </div>
    </form>
  );
}
