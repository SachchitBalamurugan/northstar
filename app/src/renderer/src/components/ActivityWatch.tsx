// "Notice what I work on": the opt-in switch for computer activity, and what was noticed today.
// Only app, site and document names are noted. Never contents, keystrokes or screenshots.
import { useEffect, useState } from "react";
import { MonitorSmartphone } from "lucide-react";
import { Window } from "@/components/ui";
import { getActivity, setActivityEnabled, type ActivityStatus } from "@/profile";

export default function ActivityWatch() {
  const [s, setS] = useState<ActivityStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () => getActivity().then(v => alive && setS(v));
    load(); const t = setInterval(load, 30000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (!s) return null; // actions service offline
  const toggle = async () => { setBusy(true); const v = await setActivityEnabled(!s.enabled); if (v) setS(v); setBusy(false); };

  return (
    <div className="mt-10">
      <Window title="What you worked on" icon={<MonitorSmartphone size={15} />} tag={s.enabled ? "ON" : "OFF"}
        meta={s.enabled && s.todayMinutes > 0 ? `${s.todayMinutes} min noticed today` : undefined}>
        <div className="px-5 py-4">
          <div className="flex items-start gap-4">
            <p className="min-w-0 flex-1 text-[13.5px] leading-relaxed text-muted">
              {s.enabled
                ? "Northstar is noticing which app, site and document you have in front, so your dashboard and Discover match what you actually do."
                : "Let Northstar notice which app, site and document you have in front. It uses that to plan your day, remind you of half-finished work and find relevant things."}
              {" "}It never reads the contents, your typing or your screen, and it skips private windows and sign-in, banking and health pages.
            </p>
            {s.supported && (
              <button onClick={toggle} disabled={busy} role="switch" aria-checked={s.enabled} aria-label="Notice what I work on"
                className={`no-drag relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors duration-200 ${s.enabled ? "bg-accent" : "bg-white/15"} ${busy ? "opacity-60" : ""}`}>
                <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all duration-200 ${s.enabled ? "left-[22px]" : "left-0.5"}`} />
              </button>
            )}
          </div>
          {s.note && <p className="mt-3 text-[12.5px] leading-relaxed text-faint">{s.note}</p>}

          {s.enabled && (
            <ul className="mt-4 border-t-[0.8px] border-line">
              {s.today.map(i => (
                <li key={i.kind + i.label} className="flex items-center gap-3 border-b-[0.8px] border-line py-3 last:border-b-0">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[14px] text-warm">{i.detail ?? i.label}</p>
                    {i.detail && <p className="truncate text-[12px] text-faint">{i.label}</p>}
                  </div>
                  <span className="shrink-0 text-[12.5px] text-muted tabular-nums">{i.minutes} min</span>
                </li>
              ))}
              {s.today.length === 0 && <li className="py-4 text-[13.5px] text-faint">Nothing noticed yet. This fills in after a few minutes of work.</li>}
            </ul>
          )}
          {s.enabled && s.lastSeen && <p className="mt-3 truncate text-[12px] text-faint">Right now: {s.lastSeen.label}</p>}
        </div>
      </Window>
    </div>
  );
}
