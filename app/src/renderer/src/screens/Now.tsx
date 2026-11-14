import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CalendarDays } from "lucide-react";
import type { CalEvent, Insights } from "@contracts/types";
import { getInsights, getToday } from "@/api";
import { useUI } from "@/store";
import { useProfile, firstName } from "@/profile";
import Network from "@/three/Network";
import {
  Heading, Lead, Eyebrow, PrimaryButton, SecondaryButton, TextLink, Window, GlowCard, Chip, Stripes, relTime, clock,
} from "@/components/ui";

type Item = { title: string; why: string; minutes: number; dueAt?: string };


function greeting(d: Date) {
  const h = d.getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

function useNow(ms = 60000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.08 } } };
const rise = { hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0, transition: { duration: 0.45, ease: "easeOut" as const } } };

const DAY_START = 8;
const DAY_END = 23;
const HOUR_LABELS: [number, string][] = [[8, "8a"], [12, "12p"], [16, "4p"], [20, "8p"]];

export default function Now() {
  const startFocus = useUI(s => s.startFocus);
  // The profile name wins; without one, the name typed in onboarding or the dashboard greeting.
  const typedName = useUI(s => s.userName).trim().split(/\s+/)[0] ?? "";
  const profileName = useProfile(s => firstName(s.profile));
  const name = profileName !== "there" ? profileName : typedName;
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
  const start = new Date(now); start.setHours(DAY_START, 0, 0, 0);
  const end = new Date(now); end.setHours(DAY_END, 0, 0, 0);
  const span = end.getTime() - start.getTime();
  const pct = Math.min(1, Math.max(0, (now.getTime() - start.getTime()) / span));
  const hoursLeft = Math.max(0, Math.round((end.getTime() - now.getTime()) / 36e5));

  const todays = (events ?? [])
    .slice()
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

  const dateLabel = now.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
  const onDeck = queue.length;
  const dueSoon = (iso?: string) => !!iso && new Date(iso).getTime() - now.getTime() < 2 * 864e5;

  return (
    <div>
      {/* ---------- hero ---------- */}
      <section className="grid min-h-[460px] grid-cols-[1.1fr_0.9fr] items-center gap-10">
        <motion.div variants={stagger} initial="hidden" animate="show" className="min-w-0">
          <motion.div variants={rise} className="mb-6 flex items-center gap-2.5">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
            <Eyebrow>{dateLabel}{insights ? ` · ${onDeck} ${onDeck === 1 ? "thing" : "things"} on deck` : ""}</Eyebrow>
          </motion.div>

          <motion.div variants={rise}>
            <Heading size="xl" className="mb-6">
              {greeting(now)}{name ? `, ${name}` : ""}.<br />Here's your <span className="text-glow">one thing.</span>
            </Heading>
          </motion.div>

          <motion.div variants={rise}>
            <Lead className="mb-8 max-w-[520px]">
              {insights ? insights.nextThing.why : "Reading your calendar and deadlines…"}
            </Lead>
          </motion.div>

          <motion.div variants={rise}>
            {!insights ? (
              <div className="animate-pulse rounded-[18px] border-[0.8px] border-line bg-surface p-6">
                <div className="mb-4 h-3 w-20 rounded bg-white/[0.06]" />
                <div className="mb-5 h-7 w-2/3 rounded-lg bg-white/[0.06]" />
                <div className="h-6 w-40 rounded-full bg-white/[0.06]" />
              </div>
            ) : (
              <AnimatePresence mode="wait">
                <motion.div key={idx} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.2 }}>
                  {item ? (
                    <>
                      <GlowCard className="p-6">
                        <Eyebrow className="mb-3">Next up</Eyebrow>
                        <h2 className="display mb-4 text-[28px] leading-[1.15] text-ink">{item.title}</h2>
                        <div className="flex flex-wrap gap-2">
                          <Chip>{item.minutes} min</Chip>
                          {item.dueAt && <Chip tone={dueSoon(item.dueAt) ? "accent" : "default"}>Due {relTime(item.dueAt)}</Chip>}
                        </div>
                      </GlowCard>
                      <div className="mt-7 flex items-center gap-3">
                        <PrimaryButton onClick={() => startFocus({ title: item.title, minutes: item.minutes })}>Start focus</PrimaryButton>
                        <SecondaryButton onClick={() => setIdx(i => i + 1)}>Not now</SecondaryButton>
                      </div>
                    </>
                  ) : (
                    <GlowCard className="p-6">
                      <Eyebrow className="mb-3">All clear</Eyebrow>
                      <h2 className="display mb-2 text-[28px] leading-[1.15] text-ink">Nothing else urgent.</h2>
                      <p className="mb-5 text-[15px] text-muted">Enjoy the break.</p>
                      <TextLink onClick={() => setIdx(0)}>Back to the first thing</TextLink>
                    </GlowCard>
                  )}
                </motion.div>
              </AnimatePresence>
            )}
          </motion.div>
        </motion.div>

        <motion.div initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.9, ease: "easeOut" }}
          className="relative flex items-center justify-center">
          <span aria-hidden className="pointer-events-none absolute left-1/2 top-1/2 h-[520px] w-[520px] -translate-x-1/2 -translate-y-1/2 rounded-full border-[0.8px] border-white/10" />
          <Network size={440} />
        </motion.div>
      </section>

      <Stripes className="my-16" />

      {/* ---------- today ---------- */}
      <section>
        <Heading size="md">Your day,<br />already planned.</Heading>

        <Window title="Today" icon={<CalendarDays size={16} />} tag="AUTO-PLANNED" meta={`${hoursLeft}h left today`}>
          <div className="px-6 pt-6 pb-5">
            <div className="relative h-1 w-full rounded-full bg-white/[0.06]" aria-label={`${Math.round(pct * 100)}% of the day gone`}>
              <div className="h-full rounded-full bg-accent transition-[width] duration-200" style={{ width: `${pct * 100}%` }} />
              <span className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent"
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

          <ul className="border-t-[0.8px] border-line">
            {events === null
              ? [0, 1, 2].map(i => (
                <li key={i} className="flex items-center gap-6 border-b-[0.8px] border-line px-6 py-4 last:border-b-0">
                  <span className="h-4 w-16 animate-pulse rounded bg-white/[0.06]" />
                  <span className="h-4 w-1/2 animate-pulse rounded bg-white/[0.06]" />
                </li>
              ))
              : todays.length === 0
                ? <li className="px-6 py-5 text-[15px] text-muted">Nothing on the calendar today.</li>
                : todays.map(e => {
                  const past = new Date(e.end).getTime() <= now.getTime();
                  return (
                    <li key={e.id} className={`flex items-center gap-6 border-b-[0.8px] border-line px-6 py-4 last:border-b-0 ${past ? "opacity-45" : ""}`}>
                      <span className="w-20 shrink-0 text-[13px] tabular-nums text-muted">{clock(e.start)}</span>
                      <span className="flex min-w-0 flex-1 items-center gap-3">
                        {e.northstar && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" title="Planned by Northstar" />}
                        <span className="truncate text-[15px] text-warm">{e.title}</span>
                      </span>
                      {e.northstar && <Chip tone="accent">◎ planned</Chip>}
                    </li>
                  );
                })}
          </ul>
        </Window>
      </section>
    </div>
  );
}
