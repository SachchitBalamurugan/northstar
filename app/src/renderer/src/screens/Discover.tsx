// Discover: what Northstar researched for you, based on what it knows. Never more than five things.
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowUpRight, Bookmark, BookmarkCheck, Clock, Compass, RefreshCw, Search, Sparkles } from "lucide-react";
import { useUI } from "@/store";
import { Heading, Lead, Eyebrow, Chip, GlowCard, PrimaryButton, SecondaryButton, TextLink, Why, relTime } from "@/components/ui";
import { getDiscover, runDiscover, saveDiscover, dismissDiscover, type DiscoverFeed, type DiscoverItem } from "@/discoverApi";

const openUrl = (url: string) => (window.northstar ? window.northstar.openExternal(url) : window.open(url, "_blank", "noopener"));

const CATEGORY: Record<DiscoverItem["category"], string> = {
  opportunity: "Opportunity", resource: "Resource", event: "Event", reading: "Reading", idea: "Idea",
};

const STAGES = ["Reading what I know about you", "Searching for things that fit", "Checking dates and sources", "Choosing the few worth your time"];

function Meta({ item }: { item: DiscoverItem }) {
  const soon = !!item.deadline && new Date(item.deadline).getTime() - Date.now() < 3 * 864e5;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Chip tone="accent">{CATEGORY[item.category] ?? "Idea"}</Chip>
      {item.deadline && (
        <span className={`inline-flex items-center gap-1.5 text-[12.5px] ${soon ? "text-accent" : "text-faint"}`}>
          <Clock size={12} /> {new Date(item.deadline).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} · {relTime(item.deadline)}
        </span>
      )}
      {item.sourceLabel && <span className="text-[12.5px] text-faint">{item.sourceLabel}</span>}
    </div>
  );
}

function NextStep({ children }: { children: string }) {
  return (
    <div className="rounded-[12px] bg-raised px-4 py-3">
      <p className="mb-0.5 text-[11px] font-medium uppercase tracking-[0.12em] text-faint">Next step</p>
      <p className="text-[14.5px] leading-relaxed text-warm">{children}</p>
    </div>
  );
}

function SaveButton({ item, onSave }: { item: DiscoverItem; onSave: () => void }) {
  return (
    <button onClick={onSave} disabled={item.saved}
      className={`no-drag inline-flex items-center gap-1.5 text-[14px] transition-colors duration-150 ${item.saved ? "text-[#F3A27F]" : "text-muted hover:text-ink"}`}>
      {item.saved ? <BookmarkCheck size={15} /> : <Bookmark size={15} />} {item.saved ? "Saved" : "Save"}
    </button>
  );
}

export default function Discover() {
  const { setScreen } = useUI();
  const [feed, setFeed] = useState<DiscoverFeed | null>(null);
  const [focus, setFocus] = useState("");
  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState(0);
  const [error, setError] = useState(false);

  useEffect(() => { getDiscover().then(setFeed); }, []);

  // Calm progress copy while research runs (it can take up to a minute).
  useEffect(() => {
    if (!running) { setStage(0); return; }
    const t = setInterval(() => setStage(s => Math.min(s + 1, STAGES.length - 1)), 9000);
    return () => clearInterval(t);
  }, [running]);

  const run = async () => {
    if (running) return;
    setRunning(true); setError(false);
    try { setFeed(await runDiscover(focus)); setFocus(""); }
    catch { setError(true); }
    finally { setRunning(false); }
  };

  const patch = (fn: (items: DiscoverItem[]) => DiscoverItem[]) => setFeed(f => (f ? { ...f, items: fn(f.items) } : f));
  const save = (id: string) => { patch(items => items.map(i => (i.id === id ? { ...i, saved: true } : i))); void saveDiscover(id); };
  const dismiss = (id: string) => { patch(items => items.filter(i => i.id !== id)); void dismissDiscover(id); };

  const items = feed?.items.slice(0, 5) ?? [];
  const [hero, ...rest] = items;
  const never = !!feed && feed.generatedAt === null;

  const progress = (
    <div className="flex items-center gap-3 rounded-[14px] border-[0.8px] border-line bg-surface px-5 py-4" role="status" aria-live="polite">
      <motion.span animate={{ opacity: [0.35, 1, 0.35] }} transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }} className="h-2 w-2 shrink-0 rounded-full bg-accent" />
      <div>
        <p className="text-[15px] text-ink">{STAGES[stage]}…</p>
        <p className="text-[13px] text-faint">This can take up to a minute. You can keep working; nothing is saved or sent without you.</p>
      </div>
    </div>
  );

  return (
    <div className="max-w-[960px]">
      <Eyebrow className="mb-4">Discover</Eyebrow>
      <Heading size="lg" className="mb-6">Found for you,<br />while you <span className="text-glow">worked.</span></Heading>
      <Lead className="mb-8 max-w-[52ch]">
        Northstar looks things up based on what it knows about you, then keeps only the few worth your time.
      </Lead>

      {!feed ? (
        <p className="text-[14px] text-faint">Looking…</p>
      ) : never ? (
        <div className="flex flex-col items-center rounded-[18px] border-[0.8px] border-dashed border-line px-6 py-16 text-center">
          <Compass size={26} className="mb-5 text-faint" />
          <p className="display text-[26px] text-ink">Nothing researched yet.</p>
          <p className="mt-2 mb-8 max-w-[44ch] text-[14.5px] leading-relaxed text-muted">
            I will read your goals, classes and deadlines, then bring back up to five things that fit. Nothing is saved or sent without you.
          </p>
          {running ? <div className="w-full max-w-[520px] text-left">{progress}</div> : (
            <PrimaryButton onClick={run}><Sparkles size={16} /> Start researching</PrimaryButton>
          )}
          {error && <p className="mt-5 text-[13.5px] text-muted">That did not finish this time. Nothing was lost. Try again when you are ready.</p>}
        </div>
      ) : (
        <>
          {feed.basedOn.length > 0 && (
            <div className="mb-6">
              <p className="mb-2.5 text-[13px] text-faint">Based on what I know about you</p>
              <div className="flex flex-wrap gap-2">
                {feed.basedOn.slice(0, 5).map(b => (
                  <button key={b} onClick={() => setScreen("knowledge")} title="Open Knowledge"
                    className="no-drag inline-flex h-7 items-center rounded-full border-[0.8px] border-line bg-white/[0.04] px-3 text-[12.5px] text-muted transition-colors duration-150 hover:bg-white/[0.08] hover:text-ink">
                    {b}
                  </button>
                ))}
              </div>
            </div>
          )}

          <form onSubmit={e => { e.preventDefault(); void run(); }} className="mb-3 flex items-center gap-3">
            <label className="flex h-[50px] flex-1 items-center gap-3 rounded-full border-[0.8px] border-line bg-white/[0.03] px-5 transition-colors duration-150 focus-within:border-white/25">
              <Search size={15} className="shrink-0 text-faint" />
              <input value={focus} onChange={e => setFocus(e.target.value)} disabled={running} placeholder="Research something specific…"
                aria-label="Research something specific"
                className="no-drag w-full bg-transparent text-[15px] text-ink placeholder:text-faint focus:outline-none disabled:opacity-50" />
            </label>
            <SecondaryButton type="submit" disabled={running} className="shrink-0 disabled:opacity-50">
              <RefreshCw size={15} className={running ? "animate-spin [animation-duration:2.4s]" : ""} /> {running ? "Researching" : "Research again"}
            </SecondaryButton>
          </form>
          <p className="mb-8 pl-5 text-[12.5px] text-faint">
            {error ? "That did not finish this time. Your earlier finds are still here." : feed.generatedAt ? `Last researched ${relTime(feed.generatedAt)}` : ""}
          </p>

          {running && <div className="mb-8">{progress}</div>}

          <div className={`transition-opacity duration-300 ${running ? "opacity-40" : ""}`}>
            {items.length === 0 ? (
              <div className="rounded-[18px] border-[0.8px] border-line bg-surface px-6 py-14 text-center">
                <p className="display text-[26px] text-ink">All caught up.</p>
                <p className="mt-2 text-[14px] text-faint">Nothing left to look at. Research again whenever you like.</p>
              </div>
            ) : (
              <>
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.div key={hero.id} layout exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.22, ease: "easeOut" }}>
                    <GlowCard className="p-7">
                      <div className="mb-4 flex items-center justify-between gap-4">
                        <Meta item={hero} />
                        <span className="shrink-0 text-[11px] font-medium uppercase tracking-[0.12em] text-faint">Top find</span>
                      </div>
                      <h2 className="display mb-3 text-[28px] text-ink">{hero.title}</h2>
                      <p className="mb-4 max-w-[68ch] text-[15.5px] leading-relaxed text-warm">{hero.summary}</p>
                      <div className="mb-5 border-l border-accent pl-4"><Why>Why this: {hero.why}</Why></div>
                      <NextStep>{hero.nextStep}</NextStep>
                      <div className="mt-6 flex items-center gap-6">
                        {hero.url && <PrimaryButton onClick={() => openUrl(hero.url!)}>Open <ArrowUpRight size={16} /></PrimaryButton>}
                        <SaveButton item={hero} onSave={() => save(hero.id)} />
                        <TextLink onClick={() => dismiss(hero.id)}>Not for me</TextLink>
                      </div>
                    </GlowCard>
                  </motion.div>
                </AnimatePresence>

                {rest.length > 0 && (
                  <div className="mt-6 grid grid-cols-2 gap-6">
                    <AnimatePresence mode="popLayout" initial={false}>
                      {rest.map(it => (
                        <motion.article key={it.id} layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.98 }}
                          transition={{ duration: 0.22, ease: "easeOut" }}
                          className="flex flex-col rounded-[18px] border-[0.8px] border-line bg-surface p-6 shadow-[0_24px_80px_rgba(0,0,0,0.33),inset_0_1px_0_rgba(255,255,255,0.02)]">
                          <div className="mb-3"><Meta item={it} /></div>
                          <h3 className="display mb-2 text-[21px] text-ink">{it.title}</h3>
                          <p className="mb-3 text-[14.5px] leading-relaxed text-warm">{it.summary}</p>
                          <p className="mb-4 text-[14px] leading-relaxed text-muted">Why this: {it.why}</p>
                          <div className="mt-auto">
                            <NextStep>{it.nextStep}</NextStep>
                            <div className="mt-4 flex items-center gap-5">
                              {it.url && (
                                <button onClick={() => openUrl(it.url!)} className="no-drag inline-flex items-center gap-1 text-[14px] font-medium text-ink transition-opacity duration-150 hover:opacity-80">
                                  Open <ArrowUpRight size={15} />
                                </button>
                              )}
                              <SaveButton item={it} onSave={() => save(it.id)} />
                              <TextLink onClick={() => dismiss(it.id)}>Not for me</TextLink>
                            </div>
                          </div>
                        </motion.article>
                      ))}
                    </AnimatePresence>
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
