import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Bell, Clock, CornerDownLeft, RefreshCw } from "lucide-react";
import { useUI } from "../store";
import { relTime } from "./ui";

const INBOX = "http://127.0.0.1:7702";

interface Notice {
  id: string;
  kind: "followup_in" | "followup_needed";
  title: string;
  body: string;
  emailId?: string; threadId?: string;
  proposalId?: string;
  createdAt: string;
  read: boolean;
}

async function call<T>(path: string, method = "GET"): Promise<T | null> {
  try {
    const res = await fetch(INBOX + path, { method, signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch { return null; }
}

const KIND = {
  followup_in: { icon: CornerDownLeft, label: "Followed up" },
  followup_needed: { icon: Clock, label: "Needs your follow-up" },
} as const;

export function NotificationBell() {
  const setScreen = useUI(s => s.setScreen);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [open, setOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const list = await call<Notice[]>("/notifications");
    if (Array.isArray(list)) setNotices([...list].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "")));
  }, []);

  useEffect(() => { load(); const t = setInterval(load, 20000); return () => clearInterval(t); }, [load]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (root.current && !root.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onKey); };
  }, [open]);

  const unread = notices.filter(n => !n.read).length;

  const markRead = (id: string) => {
    setNotices(ns => ns.map(n => n.id === id ? { ...n, read: true } : n));
    call(`/notifications/${encodeURIComponent(id)}/read`, "POST");
  };
  const markAll = () => {
    setNotices(ns => ns.map(n => ({ ...n, read: true })));
    call("/notifications/read-all", "POST");
  };
  const scan = async () => {
    setScanning(true);
    await call("/followups/scan", "POST");
    await load();
    setScanning(false);
  };
  const review = (n: Notice) => { markRead(n.id); setScreen("approve"); setOpen(false); };

  return (
    <div ref={root} className="no-drag relative">
      <button onClick={() => setOpen(o => !o)} aria-label={`Follow-ups${unread ? `, ${unread} unread` : ""}`} aria-expanded={open}
        className="relative flex h-9 w-9 items-center justify-center rounded-full text-muted transition-colors duration-150 hover:bg-white/10 hover:text-ink">
        <Bell size={17} strokeWidth={1.8} />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-accent-ink">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div initial={{ opacity: 0, y: -6, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.16, ease: "easeOut" }} style={{ transformOrigin: "top right" }}
            className="absolute right-0 top-[46px] z-50 w-[380px] overflow-hidden rounded-[16px] border border-line bg-surface shadow-[0_24px_60px_-12px_rgba(0,0,0,0.7)]">
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <span className="text-[14px] font-semibold text-ink">Follow-ups</span>
              <div className="flex items-center gap-1">
                <button onClick={markAll} disabled={!unread} className="rounded-full px-2.5 py-1 text-[12px] text-muted transition-colors hover:bg-white/10 hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent">
                  Mark all read
                </button>
                <button onClick={scan} aria-label="Check for follow-ups now" title="Check for follow-ups now"
                  className="flex h-7 w-7 items-center justify-center rounded-full text-muted transition-colors hover:bg-white/10 hover:text-ink">
                  <RefreshCw size={14} className={scanning ? "animate-spin" : ""} />
                </button>
              </div>
            </div>

            {notices.length === 0 ? (
              <div className="px-4 py-10 text-center text-[13px] text-muted">You're all caught up.</div>
            ) : (
              <ul className="max-h-[420px] overflow-y-auto">
                {notices.slice(0, 10).map(n => {
                  const k = KIND[n.kind] ?? KIND.followup_in;
                  const Icon = k.icon;
                  return (
                    <li key={n.id} className="flex gap-3 border-b border-line/60 px-4 py-3 last:border-b-0">
                      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-accent">
                        <Icon size={14} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 text-[11px] text-faint">
                          <span>{k.label}</span><span>·</span><span>{relTime(n.createdAt)}</span>
                          {!n.read && <span aria-label="Unread" className="ml-auto h-1.5 w-1.5 rounded-full bg-accent" />}
                        </div>
                        <div className="mt-0.5 truncate text-[13.5px] font-medium text-ink">{n.title}</div>
                        <div className="mt-0.5 line-clamp-2 text-[12.5px] leading-snug text-muted">{n.body}</div>
                        <div className="mt-2 flex items-center gap-2">
                          {n.proposalId && (
                            <button onClick={() => review(n)} className="rounded-full bg-accent px-3 py-1 text-[12px] font-semibold text-accent-ink transition-opacity hover:opacity-90">
                              Review draft
                            </button>
                          )}
                          {!n.read && (
                            <button onClick={() => markRead(n.id)} className="rounded-full px-3 py-1 text-[12px] text-muted transition-colors hover:bg-white/10 hover:text-ink">
                              Dismiss
                            </button>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
