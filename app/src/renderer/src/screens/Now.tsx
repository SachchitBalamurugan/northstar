import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { CalEvent, Insights } from "@contracts/types";
import { getInsights, getToday } from "@/api";
import { useUI } from "@/store";
import { Heading, Card, PrimaryButton, TextLink, Why, Chip, relTime, clock } from "@/components/ui";

type Item = { title: string; why: string; minutes: number; dueAt?: string };

function greeting(d: Date) {
  const h = d.getHours();
  if (h < 12) return "Good morning.";
  if (h < 18) return "Good afternoon.";
  return "Good evening.";
}

function useNow(ms = 60000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

export default function Now() {
  const startFocus = useUI(s => s.startFocus);
  const now = useNow();
  const [insights, setInsights] = useState<Insights | null>(null);
  const [events, setEvents] = useState<CalEvent[] | null>(null);
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    let alive = true;
    getInsights().then(i => alive && setInsights(i));
    getToday().then(e => alive && setEvents(e));
    return () => { alive = false; };
  }, []);

  const queue: Item[] = insights
    ? [insights.nextThing, ...insights.cards.map(c => ({ title: c.title, why: c.why, minutes: 25, dueAt: c.dueAt }))]
    : [];
  const item = queue[idx];

  // Day progress: 8am to 11pm
  const start = new Date(now); start.setHours(8, 0, 0, 0);
  const end = new Date(now); end.setHours(23, 0, 0, 0);
  const span = end.getTime() - start.getTime();
  const pct = Math.min(1, Math.max(0, (now.getTime() - start.getTime()) / span));
  const hoursLeft = Math.max(0, Math.round((end.getTime() - now.getTime()) / 36e5));

  const upcoming = (events ?? [])
    .filter(e => new Date(e.end).getTime() > now.getTime())
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
    .slice(0, 3);

  const dateLabel = now.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });

  return (
    <div>
      <Heading eyebrow={dateLabel}>
        {greeting(now)}<br />Here's your one thing.
      </Heading>

      {!insights ? (
        <div className="animate-pulse rounded-[var(--radius)] border border-line bg-surface p-8">
          <div className="mb-4 h-8 w-2/3 rounded-lg bg-soft" />
          <div className="mb-6 h-4 w-1/2 rounded bg-soft" />
          <div className="h-11 w-28 rounded-full bg-soft" />
        </div>
      ) : (
        <AnimatePresence mode="wait">
          <motion.div key={idx} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
            {item ? (
              <Card className="p-8">
                <h2 className="mb-3 font-serif text-[34px] leading-[1.1] text-ink">{item.title}</h2>
                <Why>{item.why}</Why>
                <div className="mt-4 flex gap-2">
                  <Chip>{item.minutes} min</Chip>
                  {item.dueAt && <Chip>Due {relTime(item.dueAt)}</Chip>}
                </div>
                <div className="mt-8 flex items-center gap-6">
                  <PrimaryButton onClick={() => startFocus({ title: item.title, minutes: item.minutes })}>Start</PrimaryButton>
                  <TextLink onClick={() => setIdx(i => i + 1)}>Not now</TextLink>
                </div>
              </Card>
            ) : (
              <Card className="p-8">
                <h2 className="mb-3 font-serif text-[34px] leading-[1.1] text-ink">Nothing else urgent.</h2>
                <Why>Enjoy the break.</Why>
                <div className="mt-6"><TextLink onClick={() => setIdx(0)}>Back to the first thing</TextLink></div>
              </Card>
            )}
          </motion.div>
        </AnimatePresence>
      )}

      <section className="mt-14">
        <div className="mb-3 flex items-baseline justify-between">
          <h3 className="text-[13px] font-medium tracking-wide text-muted uppercase">Today</h3>
          <span className="text-[13px] tabular-nums text-muted">{hoursLeft}h left today</span>
        </div>
        <div className="h-1 w-full overflow-hidden rounded-full bg-soft" aria-label={`${Math.round(pct * 100)}% of the day gone`}>
          <div className="h-full rounded-full bg-accent opacity-40 transition-[width] duration-200" style={{ width: `${pct * 100}%` }} />
        </div>

        <ul className="mt-6 space-y-3">
          {events === null
            ? [0, 1, 2].map(i => <li key={i} className="h-5 w-1/2 animate-pulse rounded bg-soft" />)
            : upcoming.length === 0
              ? <li className="text-[15px] text-muted">Nothing else on the calendar.</li>
              : upcoming.map(e => (
                <li key={e.id} className="flex items-center gap-4 text-[15px]">
                  <span className="w-20 shrink-0 tabular-nums text-muted">{clock(e.start)}</span>
                  {e.northstar && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" title="Planned by Northstar" />}
                  <span className="text-ink">{e.title}</span>
                </li>
              ))}
        </ul>
      </section>
    </div>
  );
}
