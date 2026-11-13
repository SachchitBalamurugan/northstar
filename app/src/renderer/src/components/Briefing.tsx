// "Today's briefing": one summary sentence, then at most five ordered next actions, each with its why.
// Time estimates are optional (estimating durations is tiring), so they sit behind a small remembered toggle.
import { useEffect, useState } from "react";
import { Sunrise } from "lucide-react";
import { getBriefing, type Briefing as BriefingData, type BriefingItem, type BriefingKind } from "@/assistApi";
import { useUI } from "@/store";
import { Window, relTime, clock } from "@/components/ui";

const KEY = "ns.briefing.estimates";
const readPref = () => { try { return localStorage.getItem(KEY) === "1"; } catch { return false; } };
const KIND: Record<BriefingKind, string> = { event: "Event", deadline: "Deadline", unfinished: "Unfinished", approval: "Needs your OK" };
const soon = (iso?: string) => !!iso && new Date(iso).getTime() - Date.now() < 48 * 36e5;

export default function Briefing() {
  const { setScreen, startFocus } = useUI();
  const [estimates, setEstimates] = useState(readPref);
  const [data, setData] = useState<BriefingData | null>(null);

  useEffect(() => {
    let alive = true;
    getBriefing(estimates).then(b => alive && setData(b));
    return () => { alive = false; };
  }, [estimates]);

  const toggle = () => setEstimates(v => { try { localStorage.setItem(KEY, v ? "0" : "1"); } catch {} return !v; });
  const open = (i: BriefingItem) => (i.proposalId ? setScreen("approve") : startFocus({ title: i.title, minutes: i.minutes ?? 25 }));
  const when = (i: BriefingItem) => (i.start ? clock(i.start) : i.dueAt ? `due ${relTime(i.dueAt)}` : "");

  if (!data) return null;
  const items = data.items.slice(0, 5);

  return (
    <Window title="Today's briefing" icon={<Sunrise size={15} />} meta={items.length ? `${items.length} next ${items.length === 1 ? "step" : "steps"}` : undefined}>
      <p className="px-5 pt-4 pb-3 text-[15px] leading-relaxed text-warm">{data.summary}</p>
      {items.length === 0 ? (
        <p className="px-5 pb-4 text-[14px] text-faint">Nothing is waiting on you right now.</p>
      ) : (
        <ol className="border-t-[0.8px] border-line">
          {items.map((i, n) => (
            <li key={i.id} className="border-b-[0.8px] border-line last:border-b-0">
              <button onClick={() => open(i)} title={i.proposalId ? "Review in Approve" : "Start a focus session"}
                className="no-drag group flex w-full items-start gap-4 px-5 py-3.5 text-left transition-colors duration-150 hover:bg-white/[0.025]">
                <span className="w-5 pt-0.5 text-[12px] tabular-nums text-faint">{String(n + 1).padStart(2, "0")}</span>
                <span className="min-w-0 flex-1">
                  <span className="mb-1 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.08em]">
                    <span className="text-[#F3A27F]">{KIND[i.kind] ?? "Next"}</span>
                    {when(i) && <><span className="text-faint">·</span><span className={`normal-case tracking-normal tabular-nums ${soon(i.dueAt) ? "text-accent" : "text-faint"}`}>{when(i)}</span></>}
                    {estimates && typeof i.minutes === "number" && <><span className="text-faint">·</span><span className="normal-case tracking-normal tabular-nums text-faint">about {i.minutes} min</span></>}
                  </span>
                  <span className="block truncate text-[15px] text-ink">{i.title}</span>
                  <span className="block text-[13px] leading-relaxed text-faint">{i.why}</span>
                </span>
                <span className="mt-1 shrink-0 rounded-full border-[0.8px] border-white/15 px-3 py-1.5 text-[12.5px] text-warm opacity-70 transition-opacity duration-150 group-hover:opacity-100">
                  {i.proposalId ? "Review" : "Start"}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
      <div className="flex items-center justify-end border-t-[0.8px] border-line px-5 py-2.5">
        <button role="switch" aria-checked={estimates} onClick={toggle}
          className="no-drag flex items-center gap-2 text-[12px] text-faint transition-colors duration-150 hover:text-warm">
          <span className={`relative h-[14px] w-[24px] rounded-full transition-colors duration-150 ${estimates ? "bg-accent/70" : "bg-white/15"}`}>
            <span className={`absolute top-[2px] h-[10px] w-[10px] rounded-full bg-white transition-[left] duration-150 ${estimates ? "left-[12px]" : "left-[2px]"}`} />
          </span>
          Show time estimates
        </button>
      </div>
    </Window>
  );
}
