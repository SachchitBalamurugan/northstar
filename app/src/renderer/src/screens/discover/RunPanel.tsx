// Discover live research run: query + intent, agent cards with streaming steps, overall progress.
import { AnimatePresence, motion } from "framer-motion";
import { Brain, Briefcase, CalendarDays, Check, Globe, Loader2, Map, Sparkles, Users } from "lucide-react";
import { Chip, Window } from "@/components/ui";
import type { ResearchAgent } from "@/discover";
import type { AgentState, RunState } from "./Discover";

const ICONS: Record<ResearchAgent["icon"], typeof Globe> = { globe: Globe, calendar: CalendarDays, users: Users, brain: Brain, map: Map, briefcase: Briefcase };

function AgentCard({ a }: { a: AgentState }) {
  const Icon = ICONS[a.agent.icon] ?? Globe;
  const step = a.steps[a.steps.length - 1];
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-[14px] border-[0.8px] border-line bg-white/[0.02] p-4">
      <div className="flex items-start gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-white/[0.06] text-warm"><Icon size={15} /></span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-medium text-ink">{a.agent.name}</p>
          <p className="truncate text-[12px] text-faint">{a.agent.task}</p>
        </div>
        {a.done
          ? <span className="flex shrink-0 items-center gap-1 text-[12px] text-muted"><Check size={13} className="text-accent" />{a.found} found</span>
          : <Loader2 size={14} className="shrink-0 animate-spin text-accent" />}
      </div>
      <div className="relative h-5 overflow-hidden">
        <AnimatePresence mode="wait" initial={false}>
          <motion.p key={step ?? "idle"} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.2 }}
            className="truncate text-[13px] text-muted">
            {step ?? "Starting…"}
          </motion.p>
        </AnimatePresence>
      </div>
      {a.sources.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {a.sources.slice(-3).map((s, i) => (
            <motion.span key={`${s}-${i}`} initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }}
              className="rounded-[5px] bg-white/[0.05] px-1.5 py-0.5 text-[10px] text-faint">{s}</motion.span>
          ))}
        </div>
      )}
    </div>
  );
}

export default function RunPanel({ run }: { run: RunState }) {
  const total = run.agents.length;
  const doneCount = run.agents.filter(a => a.done).length;
  const pct = run.status === "done" ? 100 : total ? (doneCount / total) * 100 : 4;
  return (
    <Window title="Research run" icon={<Sparkles size={15} />} tag={run.status === "done" ? "DONE" : "LIVE"}
      meta={`${run.results.length} found${run.ms ? ` · ${(run.ms / 1000).toFixed(1)}s` : ""}`} bodyClassName="p-5">
      <div className="mb-4 flex flex-col gap-2">
        <p className="text-[15px] text-warm"><span className="text-faint">You asked: </span><span className="text-ink">{run.query}</span></p>
        {run.intent && <p className="text-[13px] text-muted">{run.intent}</p>}
        {run.filters.length > 0 && <div className="flex flex-wrap gap-1.5">{run.filters.map(f => <Chip key={f}>{f}</Chip>)}</div>}
      </div>
      <div className="mb-5 h-[3px] overflow-hidden rounded-full bg-white/[0.06]">
        <motion.div className="h-full rounded-full bg-gradient-to-r from-[#E26D45] to-[#F3A27F]" initial={{ width: 0 }} animate={{ width: `${pct}%` }} transition={{ duration: 0.5, ease: "easeOut" }} />
      </div>
      {total === 0 ? (
        <div className="flex items-center gap-3 rounded-[14px] border-[0.8px] border-line bg-white/[0.02] p-4">
          <Loader2 size={14} className="animate-spin text-accent" />
          <span className="relative overflow-hidden text-[14px] text-muted">
            Planning the search…
            <motion.span className="absolute inset-0 bg-gradient-to-r from-transparent via-white/25 to-transparent" initial={{ x: "-100%" }} animate={{ x: "100%" }} transition={{ duration: 1.4, repeat: Infinity, ease: "linear" }} />
          </span>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">{run.agents.map(a => <AgentCard key={a.agent.id} a={a} />)}</div>
      )}
    </Window>
  );
}
