import { useMemo, useState, type MouseEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { BookOpen, Briefcase, CalendarDays, Check, Clock, ExternalLink, MapPin, Plus, SearchX, Sparkles, Ticket } from "lucide-react";
import type { DiscoverResult, ResultKind } from "@/discover";
import { Chip } from "@/components/ui";
import type { RunState } from "./Discover";

type Filter = "all" | ResultKind;
type Sort = "best" | "soonest";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "event", label: "Events" },
  { id: "opportunity", label: "Opportunities" },
  { id: "place", label: "Places" },
  { id: "article", label: "Reading" },
];

const KIND_ICON: Record<ResultKind, typeof CalendarDays> = {
  event: CalendarDays,
  opportunity: Briefcase,
  place: MapPin,
  article: BookOpen,
};

const openUrl = (url: string) => (window.northstar ? window.northstar.openExternal(url) : window.open(url, "_blank", "noopener"));

function fmtWhen(iso: string) {
  const d = new Date(iso);
  const day = d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `${day} · ${time}`;
}

const timeOf = (r: DiscoverResult) => {
  const iso = r.start ?? r.deadline;
  return iso ? new Date(iso).getTime() : Number.POSITIVE_INFINITY;
};

export default function Results({ run, isPicked, onToggle }: { run: RunState; isPicked: (id: string) => boolean; onToggle: (r: DiscoverResult) => void }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("best");

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: run.results.length, event: 0, opportunity: 0, place: 0, article: 0 };
    for (const r of run.results) c[r.kind]++;
    return c;
  }, [run.results]);

  const list = useMemo(() => {
    const l = filter === "all" ? [...run.results] : run.results.filter(r => r.kind === filter);
    return sort === "best" ? l.sort((a, b) => b.score - a.score) : l.sort((a, b) => timeOf(a) - timeOf(b) || b.score - a.score);
  }, [run.results, filter, sort]);

  const loading = run.status !== "done" && run.results.length === 0;
  const empty = run.status === "done" && run.results.length === 0;

  return (
    <section className="mt-8">
      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="flex items-baseline gap-2">
          <h2 className="display text-[22px] text-ink">Results</h2>
          <span className="text-[13px] text-faint">{run.results.length}</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {FILTERS.map(f => {
            const active = filter === f.id;
            const n = counts[f.id];
            if (f.id !== "all" && n === 0) return null;
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => setFilter(f.id)}
                className={`rounded-full border px-3 py-1 text-[12.5px] transition-colors ${active ? "border-white/25 bg-raised text-ink" : "border-line text-muted hover:border-white/20 hover:text-warm"}`}
              >
                {f.label} <span className={active ? "text-muted" : "text-faint"}>{n}</span>
              </button>
            );
          })}
        </div>
        <div className="ml-auto flex items-center rounded-full border border-line p-0.5 text-[12.5px]">
          {(["best", "soonest"] as Sort[]).map(s => (
            <button
              key={s}
              type="button"
              onClick={() => setSort(s)}
              className={`rounded-full px-3 py-1 transition-colors ${sort === s ? "bg-raised text-ink" : "text-muted hover:text-warm"}`}
            >
              {s === "best" ? "Best match" : "Soonest"}
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <div className="flex flex-col gap-3">
          {[0, 1, 2].map(i => (
            <div key={i} className="flex animate-pulse gap-4 rounded-[16px] border border-line bg-surface p-5">
              <div className="h-10 w-10 shrink-0 rounded-[10px] bg-raised" />
              <div className="flex-1 space-y-2.5">
                <div className="h-4 w-2/3 rounded bg-raised" />
                <div className="h-3 w-full rounded bg-raised" />
                <div className="h-3 w-4/5 rounded bg-raised" />
                <div className="h-3 w-1/3 rounded bg-raised" />
              </div>
            </div>
          ))}
        </div>
      )}

      {empty && (
        <div className="flex flex-col items-center rounded-[16px] border border-line bg-surface px-6 py-12 text-center">
          <SearchX size={22} className="text-faint" />
          <p className="mt-3 text-[15px] text-ink">Nothing turned up this time</p>
          <p className="mt-1 max-w-sm text-[13.5px] text-muted">Try a broader search, or widen the time and place filters.</p>
        </div>
      )}

      <motion.div layout className="flex flex-col gap-3">
        <AnimatePresence initial={false}>
          {list.map(r => (
            <ResultCard key={r.id} r={r} picked={isPicked(r.id)} onToggle={() => onToggle(r)} />
          ))}
        </AnimatePresence>
      </motion.div>
    </section>
  );
}

function ResultCard({ r, picked, onToggle }: { r: DiscoverResult; picked: boolean; onToggle: () => void }) {
  const Icon = KIND_ICON[r.kind];
  const deadlineSoon = r.deadline ? new Date(r.deadline).getTime() - Date.now() < 7 * 864e5 : false;
  const pct = Math.round(r.score * 100);

  const onCardClick = (e: MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("a,button")) return;
    onToggle();
  };
  const open = (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); openUrl(r.url); };

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
      onClick={onCardClick}
      className={`group flex cursor-pointer gap-4 rounded-[16px] border bg-surface p-5 transition-colors ${picked ? "border-accent/50 ring-1 ring-accent/30" : "border-line hover:border-white/20"}`}
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] border border-line bg-raised text-warm">
        <Icon size={18} />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-3">
          <h3 className="min-w-0 flex-1 text-[16px] font-medium leading-snug text-ink">{r.title}</h3>
          <div className="flex shrink-0 items-center gap-2 pt-0.5" title={`${pct}% match`}>
            <div className="h-1 w-10 overflow-hidden rounded-full bg-raised">
              <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
            </div>
            <span className="text-[11.5px] tabular-nums text-faint">{pct}%</span>
          </div>
        </div>

        <p className="mt-1 line-clamp-2 text-[14px] leading-relaxed text-muted">{r.summary}</p>

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12.5px] text-muted">
          {r.start && <span className="inline-flex items-center gap-1.5"><Clock size={13} className="text-faint" />{fmtWhen(r.start)}</span>}
          {r.location && <span className="inline-flex items-center gap-1.5"><MapPin size={13} className="text-faint" />{r.location}</span>}
          {r.price && <span className="inline-flex items-center gap-1.5"><Ticket size={13} className="text-faint" />{r.price}</span>}
          {r.deadline && (
            <span className={`inline-flex items-center gap-1.5 ${deadlineSoon ? "text-accent" : ""}`}>
              <CalendarDays size={13} className={deadlineSoon ? "text-accent" : "text-faint"} />
              Apply by {new Date(r.deadline).toLocaleDateString([], { month: "short", day: "numeric" })}
            </span>
          )}
          <a href={r.url} onClick={open} className="inline-flex items-center gap-1 text-faint underline-offset-2 hover:text-warm hover:underline">
            {r.source}<ExternalLink size={11} />
          </a>
        </div>

        <p className="mt-2.5 flex items-start gap-1.5 text-[12.5px] leading-snug text-[#F3C27A]">
          <Sparkles size={13} className="mt-px shrink-0" />
          <span>{r.why}</span>
        </p>

        {r.tags.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {r.tags.map(t => <Chip key={t}>{t}</Chip>)}
          </div>
        )}
      </div>

      <div className="flex shrink-0 flex-col items-end justify-between gap-3">
        <button
          type="button"
          onClick={e => { e.stopPropagation(); onToggle(); }}
          aria-pressed={picked}
          className={`inline-flex items-center gap-1 rounded-full px-3.5 py-1.5 text-[12.5px] font-medium transition-colors ${picked ? "bg-white text-black hover:bg-white/90" : "border border-line text-warm hover:border-white/30 hover:text-ink"}`}
        >
          {picked ? <><Check size={13} strokeWidth={2.5} />Picked</> : <><Plus size={13} />Pick</>}
        </button>
        <a href={r.url} onClick={open} className="text-[12px] text-faint opacity-0 transition-opacity hover:text-warm group-hover:opacity-100">
          Open source
        </a>
      </div>
    </motion.div>
  );
}
