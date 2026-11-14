// Slim banner at the top of the Inbox: says whether the mail is real or sample, and connects Google in one click.
// Hidden entirely when the inbox service is offline.
import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { disconnectGoogle, getAuthStatus, getGoogleAuthUrl, syncInbox, type AuthStatus } from "@/assistApi";
import { TextLink } from "@/components/ui";

const openUrl = (url: string) => (window.northstar ? window.northstar.openExternal(url) : window.open(url, "_blank", "noopener"));
const POLL_MS = 3000;
const MAX_POLLS = 60; // stop waiting after about 3 minutes

export default function GoogleConnect({ onSynced }: { /** Called after a sync so the screen can reload triage. */ onSynced?: () => void }) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [state, setState] = useState<"idle" | "waiting" | "syncing">("idle");
  const [hint, setHint] = useState("");
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const alive = useRef(true);

  const stopPolling = () => { if (timer.current) { clearInterval(timer.current); timer.current = null; } };
  useEffect(() => {
    alive.current = true;
    getAuthStatus().then(s => alive.current && setStatus(s));
    return () => { alive.current = false; stopPolling(); };
  }, []);

  const sync = async () => {
    setState("syncing"); setHint("");
    await syncInbox();
    const s = await getAuthStatus();
    if (!alive.current) return;
    setStatus(s); setState("idle"); onSynced?.();
  };

  const connect = async () => {
    setHint("");
    const { url } = await getGoogleAuthUrl();
    if (!alive.current) return;
    if (!url) { setStatus(s => (s ? { ...s, configured: false } : s)); return; }
    openUrl(url);
    setState("waiting");
    let polls = 0;
    stopPolling();
    timer.current = setInterval(async () => {
      polls += 1;
      const s = await getAuthStatus();
      if (!alive.current || !timer.current) return;
      if (s?.authed) { stopPolling(); setStatus(s); await sync(); }
      else if (polls >= MAX_POLLS) { stopPolling(); setState("idle"); setHint("Sign-in didn't finish. You can try again whenever you like."); }
    }, POLL_MS);
  };

  const disconnect = async () => {
    await disconnectGoogle();
    const s = await getAuthStatus();
    if (!alive.current) return;
    setStatus(s); onSynced?.();
  };

  if (!status) return null;
  const connected = status.authed && status.source === "google";

  return (
    <div role="status" className="mb-8 flex min-h-[44px] flex-wrap items-center gap-x-4 gap-y-1 rounded-[12px] border-[0.8px] border-line bg-surface px-4 py-2.5 text-[13.5px]">
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${connected ? "bg-accent" : "bg-white/25"}`} />
      {state === "waiting" ? (
        <>
          <span className="flex min-w-0 flex-1 items-center gap-2 text-muted"><Loader2 size={13} className="animate-spin text-accent" /> Waiting for you to finish signing in with Google…</span>
          <TextLink onClick={() => { stopPolling(); setState("idle"); }} className="text-[13px]">Cancel</TextLink>
        </>
      ) : state === "syncing" ? (
        <span className="flex min-w-0 flex-1 items-center gap-2 text-muted"><Loader2 size={13} className="animate-spin text-accent" /> Syncing your mail and calendar…</span>
      ) : connected ? (
        <>
          <span className="min-w-0 flex-1 truncate text-muted">{status.email ? <>Connected as <span className="text-warm">{status.email}</span></> : "Connected to Google"}</span>
          <TextLink onClick={sync} className="text-[13px]">Sync now</TextLink>
          <TextLink onClick={disconnect} className="text-[13px]">Disconnect</TextLink>
        </>
      ) : !status.configured ? (
        <span className="min-w-0 flex-1 text-muted">{status.mock ? "Showing sample mail. " : "Nothing here yet. "}The Google keys aren't set up on this computer yet, so there is nothing to connect for now.</span>
      ) : (
        <>
          <span className="min-w-0 flex-1 text-muted">{status.mock ? "Showing sample mail. Connect Gmail and Calendar to see yours." : "Your inbox is empty until you connect Gmail and Calendar."}</span>
          <button onClick={connect}
            className="no-drag shrink-0 rounded-[10px] bg-accent px-3.5 py-1.5 text-[12.5px] font-medium text-accent-ink transition-opacity duration-150 hover:opacity-90">
            Connect
          </button>
        </>
      )}
      {hint && state === "idle" && <span className="w-full pl-[22px] text-[12.5px] text-faint">{hint}</span>}
    </div>
  );
}
