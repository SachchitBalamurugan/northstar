// "Jobs for you": matches from the user's profile + LinkedIn (memory /jobs), with batch auto-fill (actions /apply/batch).
import { useEffect, useState } from "react";
import { Briefcase, Sparkles, Loader2, ExternalLink, RefreshCw, Search, Check, AlertCircle } from "lucide-react";
import { Window, PrimaryButton, TextLink, relTime } from "@/components/ui";
import { useProfile } from "@/profile";
import { useUI } from "@/store";
import { getJobs, searchJobs, getLinkedIn, applyBatch, type Job, type JobsResponse, type ApplyResult } from "@/jobsApi";

const openUrl = (url: string) => (window.northstar ? window.northstar.openExternal(url) : window.open(url, "_blank", "noopener"));
const MAX_BATCH = 5;

export default function JobsForYou() {
  const [data, setData] = useState<JobsResponse | null>(null);
  const [hasLinkedIn, setHasLinkedIn] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [applying, setApplying] = useState<number | null>(null);
  const [results, setResults] = useState<ApplyResult[] | null>(null);
  const profileOpen = useProfile(s => s.open);

  useEffect(() => {
    if (profileOpen) return; // refresh after the profile panel closes (LinkedIn may have been imported)
    void getJobs().then(r => setData(r));
    void getLinkedIn().then(p => setHasLinkedIn(!!p));
  }, [profileOpen]);

  const jobs = data?.jobs ?? [];
  const empty = !hasLinkedIn && jobs.length === 0;

  const find = async () => {
    if (searching) return;
    setSearching(true); setError(null);
    const r = await searchJobs();
    setSearching(false);
    if (r.error) setError(r.error); else { setData(r); setSelected([]); }
  };

  const toggle = (id: string) =>
    setSelected(s => (s.includes(id) ? s.filter(x => x !== id) : s.length >= MAX_BATCH ? s : [...s, id]));

  const apply = async (list: Job[]) => {
    if (!list.length || applying !== null) return;
    setApplying(list.length); setResults(null); setError(null);
    const r = await applyBatch(list);
    setApplying(null);
    if (r.error) setError(r.error);
    setResults(r.results);
    if (r.results.length) setSelected([]);
  };

  const meta = data?.basedOn?.length ? (
    <span className="block max-w-[320px] truncate" title={data.basedOn.join(", ")}>Based on: {data.basedOn.join(", ")}</span>
  ) : data?.generatedAt ? `Updated ${relTime(data.generatedAt)}` : undefined;

  return (
    <Window title="Jobs for you" icon={<Briefcase size={15} />} tag="FROM YOUR PROFILE" meta={meta} className="mb-10" bodyClassName="p-5">
      {empty && !searching ? (
        <div className="flex flex-col items-start gap-4 py-4">
          <h3 className="display text-[24px] text-ink">Roles picked from your skills.</h3>
          <p className="max-w-[520px] text-[14px] leading-relaxed text-muted">
            Import your LinkedIn and Northstar finds current postings that match what you've done, then fills the applications for you to review.
          </p>
          <div className="flex items-center gap-4">
            <PrimaryButton type="button" glow={false} className="h-10 px-5 text-[14px]" onClick={() => useProfile.getState().setOpen(true)}>
              Add your LinkedIn
            </PrimaryButton>
            <TextLink type="button" onClick={() => void find()}>Search with my profile instead</TextLink>
          </div>
        </div>
      ) : (
        <>
          <div className="mb-4 flex items-center gap-3">
            <button type="button" onClick={() => void find()} disabled={searching}
              className="no-drag inline-flex h-9 items-center gap-2 rounded-full border-[0.8px] border-white/38 bg-white/[0.06] px-4 text-[13.5px] text-ink transition-colors hover:bg-white/[0.1] disabled:opacity-50">
              {searching ? <Loader2 size={14} className="animate-spin" /> : jobs.length ? <RefreshCw size={14} /> : <Search size={14} />}
              {jobs.length ? "Refresh" : "Find jobs"}
            </button>
            {searching && <span className="text-[13px] text-muted">Searching current postings that match your skills… (about a minute)</span>}
            {!searching && data?.generatedAt && <span className="text-[12.5px] text-faint">Last search {relTime(data.generatedAt)}</span>}
          </div>

          {error && (
            <p className="mb-4 flex items-center gap-2 text-[13px] text-amber-300/90"><AlertCircle size={14} />{error}</p>
          )}

          {jobs.length === 0 && !searching && (
            <p className="py-6 text-[14px] text-muted">No matches yet. Click Find jobs to search current postings.</p>
          )}

          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            {jobs.map(j => {
              const on = selected.includes(j.id);
              const pct = Math.round(Math.max(0, Math.min(1, j.matchScore || 0)) * 100);
              return (
                <div key={j.id}
                  className={`flex flex-col gap-3 rounded-[14px] border-[0.8px] bg-raised p-4 transition-colors ${on ? "border-accent/70" : "border-line"}`}>
                  <div className="flex items-start gap-3">
                    <button type="button" role="checkbox" aria-checked={on} aria-label={`Select ${j.title}`} onClick={() => toggle(j.id)}
                      disabled={!on && selected.length >= MAX_BATCH}
                      className={`no-drag mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border-[0.8px] transition-colors disabled:opacity-30 ${on ? "border-accent bg-accent text-black" : "border-white/30 hover:border-white/60"}`}>
                      {on && <Check size={12} strokeWidth={3} />}
                    </button>
                    <div className="min-w-0 flex-1">
                      <p className="text-[15px] font-medium leading-snug text-ink">{j.title}</p>
                      <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[12.5px] text-muted">
                        <span>{j.company}</span>
                        {j.location && <><span className="text-faint">·</span><span>{j.location}</span></>}
                        {j.remote && <span className="ml-1 rounded-full bg-emerald-400/10 px-2 py-0.5 text-[11px] text-emerald-300">Remote</span>}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2.5">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
                      <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="text-[12px] tabular-nums text-warm">{pct}% match</span>
                  </div>

                  {j.summary && <p className="line-clamp-2 text-[13px] leading-relaxed text-muted">{j.summary}</p>}
                  {j.why && (
                    <p className="flex items-start gap-2 text-[13px] leading-relaxed text-[#F3C27A]">
                      <Sparkles size={13} className="mt-[3px] shrink-0" /><span>{j.why}</span>
                    </p>
                  )}
                  {j.skills?.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {j.skills.slice(0, 5).map(s => (
                        <span key={s} className="inline-flex h-6 items-center rounded-full bg-white/[0.06] px-2.5 text-[11.5px] text-muted">{s}</span>
                      ))}
                    </div>
                  )}

                  <div className="mt-auto flex items-center gap-4 pt-1">
                    <TextLink type="button" className="inline-flex items-center gap-1.5 text-[13px]" onClick={() => openUrl(j.url)}>
                      <ExternalLink size={13} /> View posting
                    </TextLink>
                    <button type="button" disabled={applying !== null} onClick={() => void apply([j])}
                      className="no-drag ml-auto inline-flex h-8 items-center rounded-full border-[0.8px] border-line bg-white/[0.04] px-3 text-[12.5px] text-ink transition-colors hover:bg-white/[0.09] disabled:opacity-40">
                      Auto-fill application
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {jobs.length > 0 && (
            <div className="mt-5 border-t-[0.8px] border-line pt-4">
              <div className="flex flex-wrap items-center gap-4">
                <PrimaryButton type="button" glow={false} className="h-10 px-5 text-[14px]"
                  disabled={!selected.length || applying !== null}
                  onClick={() => void apply(jobs.filter(j => selected.includes(j.id)))}>
                  {applying !== null && <Loader2 size={14} className="animate-spin" />}
                  Auto-fill selected ({selected.length})
                </PrimaryButton>
                {applying !== null && (
                  <span className="text-[13px] text-muted">Filling {applying} application{applying === 1 ? "" : "s"} in Chrome… sign in if a site asks</span>
                )}
                {applying === null && selected.length >= MAX_BATCH && <span className="text-[12.5px] text-faint">Up to {MAX_BATCH} at a time</span>}
              </div>

              {results && results.length > 0 && (
                <div className="mt-4 flex flex-col gap-2">
                  {results.map(r => (
                    <div key={r.url} className="flex items-start gap-2 text-[13px]">
                      {r.ok ? <Check size={14} className="mt-[3px] shrink-0 text-emerald-400" /> : <AlertCircle size={14} className="mt-[3px] shrink-0 text-amber-300" />}
                      <span className="min-w-0">
                        <span className="text-ink">{r.title}</span><span className="text-faint"> · {r.company}</span>
                        <span className={r.ok ? "text-muted" : "text-amber-300/90"}>
                          {" "}{r.ok ? `filled ${r.filled ?? 0} fields${r.needsYou ? `, ${r.needsYou} need you` : ""}` : r.error ?? "couldn't fill"}
                        </span>
                      </span>
                    </div>
                  ))}
                  {results.some(r => r.ok) && (
                    <TextLink type="button" className="self-start text-[13px] text-accent hover:text-accent" onClick={() => useUI.getState().setScreen("approve")}>
                      Review in Approve →
                    </TextLink>
                  )}
                </div>
              )}
              <p className="mt-3 text-[12px] text-faint">Nothing is submitted until you approve each application.</p>
            </div>
          )}
        </>
      )}
    </Window>
  );
}
