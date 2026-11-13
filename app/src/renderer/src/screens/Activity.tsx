// Activity: what Northstar is automating right now (left) and what your calendar looks like (right).
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CalendarDays, Check, Loader2, Zap } from "lucide-react";
import type { CalEvent } from "@contracts/types";
import type { Run } from "@/local-types";
import { cancelRun, getRuns, getToday, getWeek } from "@/api";
import { useUI } from "@/store";
import { Heading, Eyebrow, Window, Chip, SecondaryButton, TextLink, clock } from "@/components/ui";
import TabOrganizer from "@/components/TabOrganizer";

const MAX_ROWS = 5;
const DAY_START = 8;
const DAY_END = 23;
const HOUR_LABELS: [number, string][] = [[8, "8a"], [12, "12p"], [16, "4p"], [20, "8p"]];

function ago(iso: string, now: Date) {
  const m = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

function dayLabel(iso: string, now: Date) {
  const d = new Date(iso);
  const a = new Date(now); a.setHours(0, 0, 0, 0);
  const b = new Date(d); b.setHours(0, 0, 0, 0);
  const diff = Math.round((b.getTime() - a.getTime()) / 864e5);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function StatusChip({ status }: { status: Run["status"] }) {
  if (status === "running") return <Chip tone="accent"><Loader2 size={12} className="mr-1.5 animate-spin" />Running</Chip>;
  if (status === "stopped") return <Chip tone="accent">Needs your OK</Chip>;
  if (status === "done") return <Chip><Check size={12} className="mr-1.5" />Done</Chip>;
  return <Chip>Didn't finish</Chip>;
}

export default function Activity() {
  const { setScreen, openCommand, pendingCount } = useUI();
  const [now, setNow] = useState(() => new Date());
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [today, setToday] = useState<CalEvent[] | null>(null);
  const [week, setWeek] = useState<CalEvent[] | null>(null);

  // Automations: poll every 2 s while the screen is visible.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (document.visibilityState === "hidden") return;
      const r = await getRuns();
      if (alive) { setRuns(Array.isArray(r) ? r : []); setNow(new Date()); }
    };
    tick(); const t = setInterval(tick, 2000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  useEffect(() => {
    let alive = true;
    getToday().then(e => alive && setToday(e));
    getWeek().then(e => alive && setWeek(Array.isArray(e) ? e : []));
    return () => { alive = false; };
  }, []);

  const stop = async (id: string) => { await cancelRun(id); setRuns(await getRuns()); };

  const shownRuns = (runs ?? []).slice(0, MAX_ROWS);
  const runningCount = shownRuns.filter(r => r.status === "running").length;

  // Time left today: 8am to 11pm (same bar as the Now screen).
  const start = new Date(now); start.setHours(DAY_START, 0, 0, 0);
  const end = new Date(now); end.setHours(DAY_END, 0, 0, 0);
  const pct = Math.min(1, Math.max(0, (now.getTime() - start.getTime()) / (end.getTime() - start.getTime())));
  const hoursLeft = Math.max(0, Math.round((end.getTime() - now.getTime()) / 36e5));

  const byStart = (a: CalEvent, b: CalEvent) => new Date(a.start).getTime() - new Date(b.start).getTime();
  const todays = (today ?? []).slice().sort(byStart).slice(0, MAX_ROWS);
  // The "now" marker sits before the first event that has not ended yet.
  const nowAt = todays.findIndex(e => new Date(e.end).getTime() > now.getTime());

  const endOfToday = new Date(now); endOfToday.setHours(23, 59, 59, 999);
  const ahead = (week ?? []).filter(e => new Date(e.start).getTime() > endOfToday.getTime()).sort(byStart);
  const aheadShown = ahead.slice(0, MAX_ROWS);

  const nowMarker = (
    <li key="now" className="flex items-center gap-3 px-6 py-2" aria-label="Now">
      <span className="w-20 shrink-0 text-[11px] font-medium uppercase tracking-[0.14em] text-accent">Now</span>
      <span className="-ml-[3px] h-2 w-2 shrink-0 rounded-full bg-accent shadow-[0_0_12px_rgba(226,109,69,0.9)]" />
      <span className="h-px flex-1 bg-accent/40" />
      <span className="shrink-0 text-[12px] tabular-nums text-accent">{clock(now.toISOString())}</span>
    </li>
  );

  return (
    <div>
      <Heading eyebrow="Activity" size="md">What I'm handling,<br />and what's ahead.</Heading>

      <div className="grid grid-cols-2 items-start gap-8">
        {/* ---------- automations ---------- */}
        <Window title="Automations" icon={<Zap size={16} />} meta={runs === null ? "" : runningCount > 0 ? `${runningCount} running now` : "Nothing running"}>
          {runs === null ? (
            <ul>
              {[0, 1, 2].map(i => (
                <li key={i} className="border-b-[0.8px] border-line px-6 py-5 last:border-b-0">
                  <span className="mb-3 block h-4 w-2/3 animate-pulse rounded bg-white/[0.06]" />
                  <span className="block h-3 w-1/2 animate-pulse rounded bg-white/[0.06]" />
                </li>
              ))}
            </ul>
          ) : shownRuns.length === 0 ? (
            <div className="px-6 py-8">
              <p className="mb-5 text-[15px] leading-relaxed text-muted">Nothing is running. Hand me a task and you'll see every step here.</p>
              <SecondaryButton onClick={() => openCommand()} className="h-11 text-[14px]">Hand off a task</SecondaryButton>
            </div>
          ) : (
            <ul>
              {shownRuns.map(r => {
                const open = r.status === "running" || selected === r.id;
                const steps = (r.steps ?? []).slice(-5);
                return (
                  <li key={r.id} className="border-b-[0.8px] border-line last:border-b-0">
                    <div role="button" tabIndex={0} aria-expanded={open}
                      onClick={() => setSelected(s => (s === r.id ? null : r.id))}
                      onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected(s => (s === r.id ? null : r.id)); } }}
                      className="cursor-pointer px-6 py-4 transition-colors duration-150 hover:bg-white/[0.02]">
                      <div className="flex items-center gap-3">
                        <span className="min-w-0 flex-1 truncate text-[15px] text-ink">{r.instruction}</span>
                        <StatusChip status={r.status} />
                      </div>
                      <div className="mt-1.5 flex items-baseline gap-2 text-[13px]">
                        <span className="shrink-0 tabular-nums text-faint">{ago(r.endedAt ?? r.startedAt, now)}</span>
                        <span className="text-faint">·</span>
                        <span className="min-w-0 flex-1 truncate text-muted">{r.lastDetail}</span>
                        {r.status === "stopped" && (
                          <TextLink onClick={e => { e.stopPropagation(); setScreen("approve"); }} className="shrink-0 text-[13px] !text-accent hover:!text-ink">Review in Approve →</TextLink>
                        )}
                        {r.status === "running" && (
                          <TextLink onClick={e => { e.stopPropagation(); stop(r.id); }} className="shrink-0 text-[13px]">Stop</TextLink>
                        )}
                      </div>
                    </div>
                    <AnimatePresence initial={false}>
                      {open && steps.length > 0 && (
                        <motion.ul initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
                          transition={{ duration: 0.2, ease: "easeOut" }} className="overflow-hidden">
                          <div className="space-y-2 px-6 pb-4">
                            {steps.map((s, i) => {
                              const current = i === steps.length - 1 && r.status === "running";
                              return (
                                <li key={`${s.step}-${i}`} className={`flex items-center gap-2.5 text-[13px] ${i === steps.length - 1 ? "text-warm" : "text-muted"}`}>
                                  {current
                                    ? <Loader2 size={13} className="shrink-0 animate-spin text-accent" />
                                    : <Check size={13} className="shrink-0 text-accent" />}
                                  <span className="truncate">{s.detail}</span>
                                </li>
                              );
                            })}
                          </div>
                        </motion.ul>
                      )}
                    </AnimatePresence>
                  </li>
                );
              })}
            </ul>
          )}
        </Window>

        {/* ---------- calendar ---------- */}
        <div>
          <Window title="Your calendar" icon={<CalendarDays size={16} />} meta={`${hoursLeft}h left today`}>
            <div className="px-6 pt-6 pb-5">
              <div className="relative h-1 w-full rounded-full bg-white/[0.06]" aria-label={`${Math.round(pct * 100)}% of the day gone`}>
                <div className="h-full rounded-full bg-[linear-gradient(90deg,#FF8A3D,#E26D45)] transition-[width] duration-200" style={{ width: `${pct * 100}%` }} />
                <span className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent shadow-[0_0_12px_rgba(226,109,69,0.9)]"
                  style={{ left: `${pct * 100}%` }} />
              </div>
              <div className="relative mt-2.5 h-4">
                {HOUR_LABELS.map(([h, label]) => (
                  <span key={label} className="absolute text-[11px] tabular-nums text-faint"
                    style={{ left: `${((h - DAY_START) / (DAY_END - DAY_START)) * 100}%` }}>
                    {label}
                  </span>
                ))}
              </div>
            </div>

            <ul className="border-t-[0.8px] border-line py-1.5">
              {today === null
                ? [0, 1, 2].map(i => (
                  <li key={i} className="flex items-center gap-6 px-6 py-3">
                    <span className="h-4 w-16 animate-pulse rounded bg-white/[0.06]" />
                    <span className="h-4 w-1/2 animate-pulse rounded bg-white/[0.06]" />
                  </li>
                ))
                : todays.length === 0
                  ? <li className="px-6 py-4 text-[15px] text-muted">Nothing on the calendar today.</li>
                  : <>
                    {todays.map((e, i) => {
                      const past = new Date(e.end).getTime() <= now.getTime();
                      return [
                        i === nowAt ? nowMarker : null,
                        <li key={e.id} className={`flex items-center gap-3 px-6 py-3 ${past ? "opacity-45" : ""}`}>
                          <span className="w-20 shrink-0 text-[13px] tabular-nums text-muted">{clock(e.start)}</span>
                          <span className={`h-8 w-[2px] shrink-0 rounded-full ${e.northstar ? "bg-accent" : "bg-white/15"}`} title={e.northstar ? "Planned by Northstar" : undefined} />
                          <span className="min-w-0 flex-1">
                            <span className={`block truncate text-[15px] ${e.northstar ? "text-ink" : "text-warm"}`}>{e.title}</span>
                            <span className="block text-[12px] tabular-nums text-faint">until {clock(e.end)}</span>
                          </span>
                          {e.northstar && <Chip tone="accent">◎ planned</Chip>}
                        </li>,
                      ];
                    })}
                    {nowAt === -1 && nowMarker}
                  </>}
            </ul>

            <div className="border-t-[0.8px] border-line px-6 pt-5 pb-5">
              <Eyebrow className="mb-3">Next 7 days</Eyebrow>
              {week === null ? (
                <span className="block h-4 w-1/2 animate-pulse rounded bg-white/[0.06]" />
              ) : aheadShown.length === 0 ? (
                <p className="text-[14px] text-muted">Nothing else on the calendar this week.</p>
              ) : (
                <ul className="space-y-2.5">
                  {aheadShown.map((e, i) => {
                    const label = dayLabel(e.start, now);
                    const first = i === 0 || dayLabel(aheadShown[i - 1].start, now) !== label;
                    return (
                      <li key={e.id} className="flex items-center gap-3 text-[14px]">
                        <span className="w-[92px] shrink-0 truncate text-[13px] text-muted">{first ? label : ""}</span>
                        <span className="w-[68px] shrink-0 text-[13px] tabular-nums text-faint">{clock(e.start)}</span>
                        <span className={`min-w-0 flex-1 truncate ${e.northstar ? "text-[#F3A27F]" : "text-warm"}`}>{e.title}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
              {ahead.length > aheadShown.length && <p className="mt-3 text-[13px] text-faint">+{ahead.length - aheadShown.length} more</p>}
            </div>
          </Window>

          {pendingCount > 0 && (
            <TextLink onClick={() => setScreen("approve")} className="mt-5 flex items-center gap-2.5 text-[14px]">
              <span className="h-1.5 w-1.5 rounded-full bg-accent shadow-[0_0_10px_rgba(226,109,69,0.8)]" />
              {pendingCount} {pendingCount === 1 ? "thing" : "things"} waiting for your OK →
            </TextLink>
          )}
        </div>
      </div>

      {/* ---------- tabs ---------- */}
      <TabOrganizer />
    </div>
  );
}
