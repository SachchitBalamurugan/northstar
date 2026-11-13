// Discover: AI research tool (frontend only; research is simulated in @/discover).
// Layout: search hero → live run (agents) + streaming results (left) | Picks board (right).
// Props contracts for the child components are defined here; each child lives in its own file.
import { useEffect, useRef, useState } from "react";
import { startResearch, type DiscoverResult, type ResearchAgent, type ResearchOptions } from "@/discover";
import SearchHero from "./SearchHero";
import RunPanel from "./RunPanel";
import Results from "./Results";
import Picks from "./Picks";
import JobsForYou from "./JobsForYou";

export interface AgentState { agent: ResearchAgent; steps: string[]; sources: string[]; found: number; done: boolean }
export interface RunState {
  query: string; intent: string; filters: string[];
  agents: AgentState[]; results: DiscoverResult[];
  status: "planning" | "running" | "done"; ms?: number;
}

const HISTORY_KEY = "ns.discover.history";
const PICKS_KEY = "ns.discover.picks";
const read = <T,>(k: string, d: T): T => { try { return JSON.parse(localStorage.getItem(k) || "null") ?? d; } catch { return d; } };
const write = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };

export default function Discover() {
  const [run, setRun] = useState<RunState | null>(null);
  const [picks, setPicks] = useState<DiscoverResult[]>(() => read(PICKS_KEY, []));
  const [history, setHistory] = useState<string[]>(() => read(HISTORY_KEY, []));
  const cancel = useRef<(() => void) | null>(null);

  useEffect(() => write(PICKS_KEY, picks), [picks]);
  useEffect(() => () => cancel.current?.(), []);

  const search = (query: string, opts: ResearchOptions) => {
    const q = query.trim(); if (!q) return;
    cancel.current?.();
    setHistory(h => { const next = [q, ...h.filter(x => x !== q)].slice(0, 6); write(HISTORY_KEY, next); return next; });
    setRun({ query: q, intent: "", filters: [], agents: [], results: [], status: "planning" });
    cancel.current = startResearch(q, opts, e => setRun(r => {
      if (!r) return r;
      switch (e.type) {
        case "plan": return { ...r, intent: e.intent, filters: e.filters, status: "running",
          agents: e.agents.map(a => ({ agent: a, steps: [], sources: [], found: 0, done: false })) };
        case "step": return { ...r, agents: r.agents.map(a => a.agent.id === e.agentId ? { ...a, steps: [...a.steps, e.text] } : a) };
        case "source": return { ...r, agents: r.agents.map(a => a.agent.id === e.agentId ? { ...a, sources: [...a.sources, e.domain] } : a) };
        case "result": return { ...r, results: [...r.results, e.result].sort((x, y) => y.score - x.score) };
        case "agent_done": return { ...r, agents: r.agents.map(a => a.agent.id === e.agentId ? { ...a, done: true, found: e.found } : a) };
        case "done": return { ...r, status: "done", ms: e.ms };
      }
    }));
  };
  const stop = () => { cancel.current?.(); setRun(r => (r ? { ...r, status: "done" } : r)); };

  const isPicked = (id: string) => picks.some(p => p.id === id);
  const togglePick = (r: DiscoverResult) => setPicks(p => (p.some(x => x.id === r.id) ? p.filter(x => x.id !== r.id) : [r, ...p]));
  const removePick = (id: string) => setPicks(p => p.filter(x => x.id !== id));
  const clearPicks = () => setPicks([]);

  return (
    <div className="pb-24">
      <JobsForYou />
      <SearchHero onSearch={search} running={run?.status === "running" || run?.status === "planning"} onStop={stop} history={history} compact={!!run} />
      {run && (
        <div className="mt-8 grid grid-cols-[minmax(0,1fr)_340px] items-start gap-6">
          <div className="flex min-w-0 flex-col gap-5">
            <RunPanel run={run} />
            <Results run={run} isPicked={isPicked} onToggle={togglePick} />
          </div>
          <div className="sticky top-3 self-start"><Picks picks={picks} onRemove={removePick} onClear={clearPicks} /></div>
        </div>
      )}
      {!run && picks.length > 0 && (
        <div className="mt-10 max-w-[420px]"><Picks picks={picks} onRemove={removePick} onClear={clearPicks} /></div>
      )}
    </div>
  );
}
