// Top-bar Google connection pill, driven by the inbox service's GET /health
// ({ authed, configured, mock, source, email?, reason? }). After sign-in, the inbox service syncs automatically.
import { useEffect, useState } from "react";
import { getAuthUrl, SERVICES } from "@/api";

interface Status { authed: boolean; configured: boolean; mock: boolean; source: "fixtures" | "google"; email?: string; reason?: string }

export default function GoogleStatus() {
  const [s, setS] = useState<Status | null>(null);
  const [waiting, setWaiting] = useState(false);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const r = await fetch(`${SERVICES.inbox}/health`, { signal: AbortSignal.timeout(2500) });
        const j = await r.json();
        if (alive) setS({ authed: !!j.authed, configured: !!j.configured, mock: !!j.mock, source: j.source, email: j.email, reason: j.reason });
      } catch { if (alive) setS(null); }
    };
    poll(); const t = setInterval(poll, waiting ? 3000 : 15000);
    return () => { alive = false; clearInterval(t); };
  }, [waiting]);

  useEffect(() => { if (s?.source === "google") setWaiting(false); }, [s?.source]);

  if (!s) return null;

  const connect = async () => {
    const { url } = await getAuthUrl();
    if (!url) return;
    if (window.northstar) window.northstar.openExternal(url); else window.open(url, "_blank", "noopener");
    setWaiting(true);
  };

  if (s.source === "google") {
    return (
      <span title={`Real Gmail + Google Calendar${s.email ? ` (${s.email})` : ""}`}
        className="no-drag flex h-8 items-center gap-2 rounded-full border-[0.8px] border-emerald-400/30 bg-accent/[0.06] px-3 text-[12.5px] text-emerald-200">
        <span className="h-1.5 w-1.5 rounded-full bg-accent" />
        Google{ s.email ? ` · ${s.email}` : "" }
      </span>
    );
  }
  if (!s.mock && s.configured && !s.authed) {
    return (
      <button onClick={connect} title="Sign in with Google to use your real Gmail and Calendar"
        className="no-drag flex h-8 items-center gap-2 rounded-[10px] bg-accent px-3.5 text-[12.5px] font-medium text-accent-ink transition-opacity hover:opacity-90">
        <svg width="13" height="13" viewBox="0 0 48 48" aria-hidden><path fill="#4285F4" d="M45 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h11.8c-.5 2.7-2.1 5-4.4 6.6v5.5h7.1c4.2-3.9 6.5-9.6 6.5-16.1z"/><path fill="#34A853" d="M24 46c5.9 0 10.9-2 14.5-5.3l-7.1-5.5c-2 1.3-4.5 2.1-7.4 2.1-5.7 0-10.5-3.8-12.2-9H4.5v5.7C8.1 41.1 15.5 46 24 46z"/><path fill="#FBBC05" d="M11.8 28.3c-.4-1.3-.7-2.7-.7-4.3s.3-3 .7-4.3V14H4.5C3 17 2 20.4 2 24s1 7 2.5 10l7.3-5.7z"/><path fill="#EA4335" d="M24 10.7c3.2 0 6.1 1.1 8.4 3.3l6.3-6.3C34.9 4.1 29.9 2 24 2 15.5 2 8.1 6.9 4.5 14l7.3 5.7c1.7-5.2 6.5-9 12.2-9z"/></svg>
        {waiting ? "Waiting for Google…" : "Connect Google"}
      </button>
    );
  }
  return (
    <span title={s.reason ?? "Demo data"} className="no-drag flex h-8 cursor-help items-center gap-2 rounded-full border-[0.8px] border-line px-3 text-[12px] text-faint">
      <span className="h-1.5 w-1.5 rounded-full bg-white/25" /> Demo data
    </span>
  );
}
