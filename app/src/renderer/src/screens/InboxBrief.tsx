import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Sparkles, RefreshCw } from "lucide-react";
import { Window, PrimaryButton, SecondaryButton, TextLink, relTime } from "@/components/ui";
import { getBrief, refreshBrief, replyToEmail, emailMeBrief, type Brief, type BriefItem } from "@/briefApi";
import { useUI } from "@/store";

const DOT: Record<BriefItem["importance"], string> = { high: "bg-accent", medium: "bg-warn", low: "bg-faint" };
const goApprove = () => useUI.getState().setScreen("approve");

function ItemCard({ item, onDismiss }: { item: BriefItem; onDismiss: () => void }) {
  const [body, setBody] = useState(item.suggestedReply ?? "");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [err, setErr] = useState("");

  const send = async () => {
    if (!body.trim()) return;
    setState("sending"); setErr("");
    try { await replyToEmail(item.emailId, body); setState("sent"); }
    catch (e) { setState("error"); setErr(e instanceof Error ? e.message : "Couldn't reach the inbox service."); }
  };

  return (
    <motion.div layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.22, ease: "easeOut" }} className="overflow-hidden px-6 py-5">
      <div className="flex items-start gap-3">
        <span className={`mt-[7px] h-2 w-2 shrink-0 rounded-full ${DOT[item.importance] ?? DOT.low}`} title={`${item.importance} importance`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-[15px] font-medium text-ink">{item.from}</span>
            <span className="shrink-0 text-[12px] text-faint">{relTime(item.receivedAt)}</span>
          </div>
          <p className="truncate text-[15px] text-warm">{item.subject}</p>
          <p className="mt-1 text-[14px] leading-relaxed text-muted">{item.oneLine}</p>
          {item.why && (
            <p className="mt-2 flex items-start gap-1.5 text-[12.5px] leading-relaxed text-blue">
              <Sparkles size={13} strokeWidth={1.75} className="mt-[3px] shrink-0" />{item.why}
            </p>
          )}

          {item.suggestedReply !== null ? (
            <div className="mt-4 rounded-[12px] bg-raised p-4">
              <p className="mb-2 text-[12px] font-medium uppercase tracking-[0.14em] text-faint">Suggested reply</p>
              <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} disabled={state === "sending" || state === "sent"}
                className="no-drag w-full resize-y bg-transparent text-[15px] leading-relaxed text-warm outline-none placeholder:text-faint disabled:opacity-70" />
              <div className="mt-3 flex items-center gap-5">
                {state === "sent" ? (
                  <>
                    <span className="text-[14px] text-ink">In Approve ✓</span>
                    <TextLink onClick={goApprove}>Review in Approve</TextLink>
                  </>
                ) : (
                  <>
                    <PrimaryButton glow={false} className="h-9 px-5 text-[14px]" onClick={send} disabled={state === "sending" || !body.trim()}>
                      {state === "sending" ? "Sending…" : "Send reply"}
                    </PrimaryButton>
                    <TextLink onClick={onDismiss}>Dismiss</TextLink>
                    {state === "error" && <span className="text-[13px] text-accent">{err}</span>}
                  </>
                )}
              </div>
            </div>
          ) : (
            <div className="mt-3 flex items-center gap-5">
              <span className="text-[12.5px] text-faint">No reply needed</span>
              <TextLink className="text-[13px]" onClick={onDismiss}>Dismiss</TextLink>
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}

function Skeleton() {
  return (
    <div className="animate-pulse space-y-3 px-6 py-6">
      <div className="h-3.5 w-11/12 rounded bg-white/[0.06]" />
      <div className="h-3.5 w-9/12 rounded bg-white/[0.06]" />
      <div className="h-3.5 w-10/12 rounded bg-white/[0.06]" />
      <div className="mt-6 h-16 rounded-[12px] bg-white/[0.04]" />
      <div className="h-16 rounded-[12px] bg-white/[0.04]" />
    </div>
  );
}

export default function InboxBrief() {
  const [brief, setBrief] = useState<Brief | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [dismissed, setDismissed] = useState<Record<string, boolean>>({});
  const [mail, setMail] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [, tick] = useState(0);
  const alive = useRef(true);

  const load = () => getBrief().then((b) => {
    if (!alive.current) return;
    // Don't wipe a brief we already have just because one poll failed.
    setBrief((prev) => (b.generatedAt === null && !b.summary && prev?.generatedAt ? prev : b));
  });

  useEffect(() => { alive.current = true; load(); return () => { alive.current = false; }; }, []);

  const stale = !!brief?.stale;
  useEffect(() => {
    const id = setInterval(load, stale ? 5000 : 60000);
    return () => clearInterval(id);
  }, [stale]);

  // Re-render every 30s so relative times stay fresh.
  useEffect(() => { const id = setInterval(() => tick((n) => n + 1), 30000); return () => clearInterval(id); }, []);

  const onRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try { const b = await refreshBrief(); if (alive.current) setBrief(b); }
    catch { /* keep the current brief */ }
    finally { if (alive.current) setRefreshing(false); }
  };

  const onEmailMe = async () => {
    setMail("sending");
    try { await emailMeBrief(); setMail("done"); } catch { setMail("error"); }
  };

  const loading = !brief || (brief.generatedAt === null && !brief.summary);
  const items = (brief?.items ?? []).filter((i) => !dismissed[i.emailId]);
  const meta = loading || refreshing || stale ? "Reading your Gmail…" : `Updated ${relTime(brief!.generatedAt!)}`;

  return (
    <div className="mb-10">
      <Window title="Inbox briefing" icon={<Sparkles size={16} strokeWidth={1.75} />} tag="AUTO" meta={meta}>
        <div className="flex flex-wrap items-center gap-3 border-b-[0.8px] border-line px-6 py-3">
          <button onClick={onRefresh} disabled={refreshing} aria-label="Refresh" title="Refresh"
            className="no-drag inline-flex h-9 w-9 items-center justify-center rounded-full border-[0.8px] border-line text-muted transition-colors duration-150 hover:bg-white/[0.06] hover:text-ink disabled:opacity-60">
            <RefreshCw size={15} strokeWidth={1.75} className={refreshing ? "animate-spin" : ""} />
          </button>
          {mail === "done" ? (
            <span className="flex items-center gap-4">
              <span className="text-[14px] text-ink">Draft ready in Approve</span>
              <TextLink onClick={goApprove}>Review in Approve</TextLink>
            </span>
          ) : (
            <SecondaryButton className="h-9 text-[14px]" onClick={onEmailMe} disabled={mail === "sending" || loading}>
              {mail === "sending" ? "Drafting…" : "Email me this summary"}
            </SecondaryButton>
          )}
          {mail === "error" && <span className="text-[13px] text-accent">Couldn't reach the inbox service.</span>}
        </div>

        {loading ? <Skeleton /> : (
          <>
            {brief!.summary && <p className="px-6 pt-5 pb-2 text-[15px] leading-[1.7] text-warm">{brief!.summary}</p>}
            {items.length === 0 ? (
              <div className="px-6 py-10 text-center">
                <p className="display text-[24px] text-ink">Inbox zero. Nothing needs you.</p>
              </div>
            ) : (
              <div className="divide-y divide-line">
                <AnimatePresence initial={false}>
                  {items.map((it) => (
                    <ItemCard key={it.emailId} item={it} onDismiss={() => setDismissed((d) => ({ ...d, [it.emailId]: true }))} />
                  ))}
                </AnimatePresence>
              </div>
            )}
          </>
        )}
      </Window>
    </div>
  );
}
