// Discover search hero: headline, big research input, When/Where filters, suggestions and recent queries.
import { useState, type FormEvent } from "react";
import { motion } from "framer-motion";
import { ArrowUp, Search, Square, Clock } from "lucide-react";
import { Heading, Lead } from "@/components/ui";
import type { ResearchOptions } from "@/discover";

const SUGGESTIONS = ["Career events this month", "Fun side quests this weekend", "Study groups for CS 61B", "Internships with deadlines soon"];
const WHEN: { v: ResearchOptions["when"]; l: string }[] = [{ v: "any", l: "Any time" }, { v: "week", l: "This week" }, { v: "month", l: "This month" }];
const WHERE: { v: ResearchOptions["where"]; l: string }[] = [{ v: "any", l: "Anywhere" }, { v: "campus", l: "Near campus" }, { v: "online", l: "Online" }];

function Segmented<T extends string>({ label, options, value, onChange }: { label: string; options: { v: T; l: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[12px] text-faint">{label}</span>
      <div className="flex rounded-full border-[0.8px] border-line bg-white/[0.03] p-0.5">
        {options.map(o => (
          <button key={o.v} type="button" onClick={() => onChange(o.v)}
            className={`relative h-7 rounded-full px-3 text-[12px] font-medium transition-colors ${value === o.v ? "text-ink" : "text-muted hover:text-warm"}`}>
            {value === o.v && <motion.span layoutId={`seg-${label}`} className="absolute inset-0 rounded-full bg-white/[0.09]" transition={{ duration: 0.25 }} />}
            <span className="relative">{o.l}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export default function SearchHero({ onSearch, running, onStop, history, compact }: {
  onSearch: (q: string, opts: ResearchOptions) => void; running: boolean; onStop: () => void; history: string[]; compact: boolean;
}) {
  const [q, setQ] = useState("");
  const [when, setWhen] = useState<ResearchOptions["when"]>("any");
  const [where, setWhere] = useState<ResearchOptions["where"]>("any");
  const run = (text: string) => { if (!text.trim()) return; setQ(text); onSearch(text, { when, where }); };
  const submit = (e: FormEvent) => { e.preventDefault(); if (running) onStop(); else run(q); };

  const input = (
    <form onSubmit={submit}
      className={`flex w-full items-center gap-3 rounded-full border-[0.8px] border-white/[0.12] bg-white/[0.04] pl-5 pr-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] backdrop-blur-xl transition-colors focus-within:border-white/25 ${compact ? "h-12" : "h-[60px]"}`}>
      <Search size={compact ? 16 : 18} className="shrink-0 text-faint" />
      <input value={q} onChange={e => setQ(e.target.value)} placeholder="e.g. career events this month, fun side quests this weekend"
        className={`min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-faint ${compact ? "text-[14px]" : "text-[16px]"}`} />
      <button type="submit"
        className={`flex shrink-0 items-center gap-1.5 rounded-full bg-white font-medium text-accent-ink transition-opacity hover:opacity-90 ${compact ? "h-9 px-4 text-[13px]" : "h-12 px-5 text-[14px]"}`}>
        {running ? <><Square size={12} fill="currentColor" /> Stop</> : <>Research <ArrowUp size={15} /></>}
      </button>
    </form>
  );
  const filters = (
    <div className="flex flex-wrap items-center gap-4">
      <Segmented label="When" options={WHEN} value={when} onChange={setWhen} />
      <Segmented label="Where" options={WHERE} value={where} onChange={setWhere} />
    </div>
  );

  if (compact) return <div className="flex flex-col gap-3 xl:flex-row xl:items-center"><div className="flex-1">{input}</div>{filters}</div>;

  return (
    <section className="max-w-[760px]">
      <Heading eyebrow="Discover" className="mb-4">What should Northstar<br />go find for you?</Heading>
      <Lead className="mb-8 max-w-[560px]">Describe it in plain words. Research agents search the web, campus boards and your memory, then show you what fits.</Lead>
      {input}
      <div className="mt-4">{filters}</div>
      <div className="mt-8 flex flex-wrap gap-2">
        {SUGGESTIONS.map((s, i) => (
          <motion.button key={s} type="button" onClick={() => run(s)} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 + i * 0.05 }}
            className="h-9 rounded-full border-[0.8px] border-line bg-white/[0.03] px-4 text-[13px] text-warm transition-colors hover:border-white/20 hover:text-ink">
            {s}
          </motion.button>
        ))}
      </div>
      {history.length > 0 && (
        <div className="mt-6">
          <p className="mb-2 text-[12px] font-medium uppercase tracking-[0.14em] text-faint">Recent</p>
          <div className="flex flex-wrap gap-2">
            {history.map(h => (
              <button key={h} type="button" onClick={() => run(h)}
                className="inline-flex h-8 items-center gap-1.5 rounded-full bg-white/[0.05] px-3 text-[12px] text-muted transition-colors hover:text-ink">
                <Clock size={12} /> {h}
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
