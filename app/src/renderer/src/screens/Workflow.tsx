// Workflow: one place for the day-to-day streams. Sub-tabs: Inbox · Calendar · Discover.
import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Inbox as InboxIcon, CalendarDays, Compass, CalendarPlus, Clock } from "lucide-react";
import type { CalEvent } from "@contracts/types";
import { useUI, type WorkflowTab } from "@/store";
import { getRange, getPendingProposals } from "@/api";
import { Heading, Lead, Window, Chip, clock } from "@/components/ui";
import Inbox from "./Inbox";
import { CalendarAgentBox } from "./Dashboard";

const TABS: { id: WorkflowTab; label: string; Icon: typeof InboxIcon }[] = [
  { id: "inbox", label: "Inbox", Icon: InboxIcon },
  { id: "calendar", label: "Calendar", Icon: CalendarDays },
  { id: "discover", label: "Discover", Icon: Compass },
];

export default function Workflow() {
  const { workflowTab, openWorkflow } = useUI();

  return (
    <div>
      {/* Sub-tab switcher */}
      <div className="mb-10 flex items-center gap-1 rounded-full border-[0.8px] border-line bg-white/[0.03] p-1 w-fit">
        {TABS.map(({ id, label, Icon }) => (
          <button key={id} onClick={() => openWorkflow(id)}
            className={`no-drag relative flex h-9 items-center gap-2 rounded-full px-4 text-[14px] font-medium transition-colors duration-200 ${workflowTab === id ? "text-ink" : "text-muted hover:text-ink"}`}>
            {workflowTab === id && <motion.span layoutId="workflow-tab" transition={{ duration: 0.28, ease: "easeOut" }} className="absolute inset-0 rounded-full bg-white/10" />}
            <Icon size={15} className="relative" />
            <span className="relative">{label}</span>
          </button>
        ))}
      </div>

      <AnimatePresence mode="wait">
        <motion.div key={workflowTab} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.2, ease: "easeOut" }}>
          {workflowTab === "inbox" && <Inbox />}
          {workflowTab === "calendar" && <CalendarTab />}
          {workflowTab === "discover" && <DiscoverTab />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

/* ---------------- Calendar ---------------- */

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

function CalendarTab() {
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [sel, setSel] = useState(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; });

  useEffect(() => {
    // Today's calendar + Northstar's suggested blocks (pending create_event proposals) across the week.
    Promise.all([getRange(7), getPendingProposals()]).then(([today, props]) => {
      const planned: CalEvent[] = props
        .filter(p => p.type === "create_event" && p.payload?.start && p.payload?.end)
        .map(p => ({ id: `p-${p.id}`, title: p.title, start: p.payload.start, end: p.payload.end, northstar: true }));
      const seen = new Set<string>();
      setEvents([...today, ...planned].filter(e => { const k = e.title + e.start; if (seen.has(k)) return false; seen.add(k); return true; }));
    });
  }, []);

  const week = useMemo(() => {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    return Array.from({ length: 7 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
  }, []);

  const byDay = useMemo(() => {
    const m = new Map<string, CalEvent[]>();
    for (const e of events) { const k = dayKey(new Date(e.start)); m.set(k, [...(m.get(k) ?? []), e]); }
    for (const list of m.values()) list.sort((a, b) => +new Date(a.start) - +new Date(b.start));
    return m;
  }, [events]);

  const dayEvents = byDay.get(dayKey(sel)) ?? [];
  const isToday = dayKey(sel) === dayKey(new Date());
  const hours = dayEvents.reduce((s, e) => s + (+new Date(e.end) - +new Date(e.start)) / 36e5, 0);

  return (
    <div>
      <Heading eyebrow="Calendar">Your week,<br />already planned.</Heading>

      {/* Week strip */}
      <div className="mb-8 grid grid-cols-7 gap-2">
        {week.map(d => {
          const k = dayKey(d), active = k === dayKey(sel), count = byDay.get(k)?.length ?? 0;
          return (
            <button key={k} onClick={() => setSel(d)}
              className={`no-drag flex flex-col items-center gap-1 rounded-[14px] border-[0.8px] py-3 transition-colors duration-200 ${active ? "border-white/25 bg-white/[0.08]" : "border-line bg-surface hover:bg-white/[0.04]"}`}>
              <span className="text-[11px] tracking-[0.12em] text-faint uppercase">{d.toLocaleDateString([], { weekday: "short" })}</span>
              <span className={`display text-[22px] ${active ? "text-ink" : "text-warm"}`}>{d.getDate()}</span>
              <span className="flex h-1.5 gap-1">{Array.from({ length: Math.min(count, 3) }, (_, i) => <span key={i} className="h-1.5 w-1.5 rounded-full bg-accent/80" />)}</span>
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] gap-6">
        <Window title={isToday ? "Today" : sel.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" })}
          icon={<CalendarDays size={15} />} meta={`${dayEvents.length} events · ${hours.toFixed(1)}h`}>
          <ul className="px-5 py-2">
            {dayEvents.map(ev => {
              const past = new Date(ev.end).getTime() < Date.now();
              return (
                <li key={ev.id} className={`flex items-center gap-4 border-b-[0.8px] border-line py-4 last:border-b-0 ${past ? "opacity-40" : ""}`}>
                  <span className="w-20 shrink-0 text-[13px] text-muted tabular-nums">{clock(ev.start)}</span>
                  <span className={`h-9 w-[3px] shrink-0 rounded-full ${ev.northstar ? "bg-accent" : "bg-white/20"}`} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px] text-ink">{ev.title.replace(/^◎\s*/, "")}</p>
                    <p className="flex items-center gap-1.5 text-[12.5px] text-faint"><Clock size={12} /> {clock(ev.start)}–{clock(ev.end)}</p>
                  </div>
                  {ev.northstar && <Chip tone="accent">◎ planned</Chip>}
                </li>
              );
            })}
            {dayEvents.length === 0 && <li className="py-10 text-center text-[14px] text-faint">Nothing scheduled. A clear day.</li>}
          </ul>
        </Window>

        <Window title="Add to calendar" icon={<CalendarPlus size={15} />} tag="AGENT">
          <p className="px-5 pt-4 text-[13.5px] leading-relaxed text-muted">
            Tell Northstar about an event. It checks your mail, files and calendar for details, then asks before adding anything.
          </p>
          <CalendarAgentBox />
        </Window>
      </div>
    </div>
  );
}

/* ---------------- Discover (placeholder: function to be specified) ---------------- */

function DiscoverTab() {
  return (
    <div>
      <Heading eyebrow="Discover">Something new<br />is coming here.</Heading>
      <Lead className="max-w-[46ch]">Discover is being set up. Check back soon.</Lead>
      <div className="mt-10 flex h-[260px] items-center justify-center rounded-[18px] border-[0.8px] border-dashed border-line">
        <Compass size={28} className="text-faint" />
      </div>
    </div>
  );
}
