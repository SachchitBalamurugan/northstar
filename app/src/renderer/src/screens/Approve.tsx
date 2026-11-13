import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Send, CalendarPlus, FileText, FileCheck, MailX, Sparkles, RefreshCw, type LucideIcon } from "lucide-react";
import type { Proposal } from "@contracts/types";
import { getPendingProposals, approve, reject } from "@/api";
import { useUI } from "@/store";
import { Heading, Lead, Eyebrow, Window, PrimaryButton, SecondaryButton, TextLink, Why, Chip, relTime, clock } from "@/components/ui";
import { approveEdited } from "@/assistApi";
import RefineControls from "@/components/RefineControls";

const ICONS: Record<Proposal["type"], LucideIcon> = {
  send_reply: Send, create_event: CalendarPlus, fill_form: FileText,
  submit_form: FileCheck, unsubscribe: MailX, task: Sparkles,
};

const LABELS: Record<Proposal["type"], string> = {
  send_reply: "Reply", create_event: "Calendar", fill_form: "Application",
  submit_form: "Application", unsubscribe: "Unsubscribe", task: "Suggestion",
};

type Field = { label: string; value: string; confidence?: number; selector?: string; ask?: boolean };
type Answers = Record<string, string>;

function Preview({ p, answers, onAnswer, body, onBody }: {
  p: Proposal; answers: Answers; onAnswer: (selector: string, value: string) => void;
  /** The reply text after the user refined it (send_reply only). */ body?: string; onBody?: (text: string) => void;
}) {
  const pl = p.payload ?? {};
  if (p.type === "send_reply") {
    return (
      <div className="mt-6 rounded-[12px] bg-raised p-5">
        <div className="mb-4 space-y-1.5 border-b-[0.8px] border-line pb-4 text-[12px] text-faint">
          <p><span className="inline-block w-16">To</span><span className="text-muted">{pl.to}</span></p>
          <p><span className="inline-block w-16">Subject</span><span className="text-muted">{pl.subject}</span></p>
        </div>
        <div className="relative max-h-[10rem] overflow-hidden">
          <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-warm">{body ?? pl.body}</p>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-raised to-transparent" />
        </div>
        {onBody && typeof pl.body === "string" && (
          <RefineControls className="mt-4 border-t-[0.8px] border-line pt-4" text={body ?? pl.body}
            context={pl.subject ? `Reply email. Subject: ${pl.subject}` : undefined} onChange={onBody} />
        )}
      </div>
    );
  }
  if (p.type === "create_event" && pl.start && pl.end) {
    const d = new Date(pl.start);
    return (
      <div className="mt-6 flex gap-5 rounded-[12px] bg-raised p-5">
        <div className="flex w-16 shrink-0 flex-col items-center justify-center rounded-[10px] border-[0.8px] border-line py-2">
          <span className="text-[11px] uppercase tracking-[0.12em] text-faint">{d.toLocaleDateString([], { weekday: "short" })}</span>
          <span className="display text-[26px] text-ink">{d.getDate()}</span>
        </div>
        <div className="min-w-0 flex-1 border-l-2 border-accent pl-4">
          <p className="text-[12px] text-faint">{clock(pl.start)} – {clock(pl.end)}</p>
          <p className="mt-1 truncate text-[15px] text-warm"><span className="mr-1.5 text-accent">◎</span>{pl.title ?? p.title}</p>
        </div>
      </div>
    );
  }
  if ((p.type === "fill_form" || p.type === "submit_form") && Array.isArray(pl.fields)) {
    // Required fields the filler would not guess come back in `unknown`; the user answers them here.
    const asks: Field[] = (Array.isArray(pl.unknown) ? pl.unknown : []).map((u: Field) => ({ label: u.label, value: "", selector: u.selector, ask: true }));
    const rows = [...asks, ...(pl.fields as Field[])];
    return (
      <ul className="mt-6 max-h-[19rem] divide-y divide-line overflow-y-auto rounded-[12px] bg-raised px-5">
        {rows.map((f, i) => (
          <li key={f.selector ?? `${f.label}-${i}`} className="flex items-center justify-between gap-4 py-3">
            <span className="shrink-0 text-[12px] uppercase tracking-[0.1em] text-faint">{f.label}</span>
            <span className="flex min-w-0 items-center gap-2">
              {f.value ? <span className="truncate text-[15px] text-warm">{f.value}</span>
                : f.ask && f.selector ? (
                  <input value={answers[f.selector] ?? ""} onChange={(e) => onAnswer(f.selector!, e.target.value)}
                    placeholder="Needs you" aria-label={f.label}
                    className="h-9 w-[16rem] max-w-full rounded-[8px] border-[0.8px] border-accent/60 bg-transparent px-3 text-[15px] text-warm outline-none placeholder:text-accent focus:border-accent" />
                ) : <Chip tone="accent">Needs you</Chip>}
              {f.value && (f.confidence ?? 1) < 0.7 && <Chip tone="accent">check this</Chip>}
            </span>
          </li>
        ))}
      </ul>
    );
  }
  return null;
}


const GROUPS: { key: string; label: string; types: Proposal["type"][] }[] = [
  { key: "emails", label: "Emails", types: ["send_reply"] },
  { key: "apps", label: "Applications", types: ["fill_form", "submit_form"] },
  { key: "calendar", label: "Calendar", types: ["create_event"] },
  { key: "unsub", label: "Unsubscribe", types: ["unsubscribe"] },
  { key: "suggest", label: "Suggestions", types: ["task"] },
];
const GROUP_ORDER = GROUPS.map((g) => g.key);
const groupOf = (p: Proposal) => GROUPS.find((g) => g.types.includes(p.type))?.key ?? "suggest";
const AGENT: Record<string, string> = { inbox: "Inbox", memory: "Memory", actions: "Actions", ui: "Memory" };
const dot = (u: number) => (u >= 3 ? "bg-accent" : u === 2 ? "bg-[#F3C27A]" : "bg-faint/50");

function ago(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

export default function Approve() {
  const setPendingCount = useUI((s) => s.setPendingCount);
  const [raw, setRaw] = useState<Proposal[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dir, setDir] = useState(1);
  const [answers, setAnswers] = useState<Record<string, Answers>>({});
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [loading, setLoading] = useState(false);
  // Reply bodies the user refined (by proposal id). When set, this is the text that gets sent on approve.
  const [bodies, setBodies] = useState<Record<string, string>>({});
  // Ids acted on in this screen; hidden even if a poll that started earlier still returns them.
  const gone = useRef(new Set<string>());
  const listRef = useRef<HTMLDivElement>(null);
  const send = useCallback((p: Proposal, typed?: Answers) => {
    const body = bodies[p.id];
    return p.type === "send_reply" && body !== undefined && body.trim() && body !== p.payload?.body ? approveEdited(p, body) : approve(p, typed);
  }, [bodies]);

  // Grouped order is both the list order and the J/K order.
  const items = useMemo(() => raw && [...raw].sort((a, b) => GROUP_ORDER.indexOf(groupOf(a)) - GROUP_ORDER.indexOf(groupOf(b))), [raw]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const ps = (await getPendingProposals()).filter((p) => !gone.current.has(p.id));
      setRaw(ps);
      setPendingCount(ps.length);
      setUpdatedAt(Date.now());
    } finally { setLoading(false); }
  }, [setPendingCount]);

  useEffect(() => {
    load();
    const t = setInterval(load, 8000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const onFocus = () => { load(); };
    const onVis = () => { if (document.visibilityState === "visible") load(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(t); clearInterval(tick);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [load]);

  const current = items?.find((p) => p.id === selectedId) ?? items?.[0];
  const curIdx = items && current ? items.indexOf(current) : -1;

  const select = useCallback((id: string) => {
    if (!items) return;
    setDir(items.findIndex((p) => p.id === id) >= curIdx ? 1 : -1);
    setSelectedId(id);
  }, [items, curIdx]);

  const remove = useCallback((ids: string[]) => {
    ids.forEach((id) => gone.current.add(id));
    if (items && current && ids.includes(current.id)) {
      // Next in the same group, else next overall, else the last one left.
      const rest = items.filter((p) => !ids.includes(p.id));
      const after = items.slice(curIdx + 1).filter((p) => !ids.includes(p.id));
      const next = after.find((p) => groupOf(p) === groupOf(current)) ?? after[0] ?? rest[rest.length - 1];
      setSelectedId(next?.id ?? null);
    }
    setRaw((prev) => {
      if (!prev) return prev;
      const next = prev.filter((p) => !ids.includes(p.id));
      setPendingCount(next.length);
      return next;
    });
  }, [items, current, curIdx, setPendingCount]);

  const act = useCallback((kind: "approve" | "skip") => {
    if (!current) return;
    setDir(kind === "approve" ? 1 : -1);
    if (kind === "approve") {
      const title = current.title;
      const typed = Object.fromEntries(Object.entries(answers[current.id] ?? {}).filter(([, v]) => v.trim()));
      // The service answers with the finished proposal; say so if the action did not go through.
      send(current, Object.keys(typed).length ? typed : undefined).then((res) => {
        if (res.status === "failed") setNotice({ ok: false, text: `Couldn't finish "${title}". ${res.payload?.error ?? ""}`.trim() });
        else if (res.payload?.confirmation) setNotice({ ok: true, text: `Done: ${title}` });
        // A submitted form also settles its "answer these questions" card.
        if (res.status === "done" && res.payload?.taskProposalId) remove([res.payload.taskProposalId]);
      });
    } else reject(current);
    remove([current.id]);
  }, [current, remove, answers, send]);

  const approveLowRisk = () => {
    if (!items) return;
    const low = items.filter((p) => p.urgency === 1 || p.type === "create_event");
    low.forEach((p) => send(p));
    setDir(1);
    remove(low.map((p) => p.id));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey || !items?.length) return;
      const k = e.key.toLowerCase();
      if (k === "a") act("approve");
      else if (k === "s") act("skip");
      else if (k === "j") { const n = items[Math.min(curIdx + 1, items.length - 1)]; if (n) { setDir(1); setSelectedId(n.id); } }
      else if (k === "k") { const n = items[Math.max(curIdx - 1, 0)]; if (n) { setDir(-1); setSelectedId(n.id); } }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [act, items, curIdx]);

  // Keep the selected row in view when moving with J/K.
  const currentId = current?.id;
  useEffect(() => {
    if (!currentId) return;
    listRef.current?.querySelector(`[data-pid="${CSS.escape(currentId)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [currentId]);

  if (items === null) return null;

  const refreshBtn = (
    <span className="flex items-center gap-2 text-[11px] text-faint">
      <button type="button" onClick={() => { load(); }} aria-label="Refresh" title="Refresh"
        className="grid h-6 w-6 place-items-center rounded-[6px] text-faint transition-colors hover:bg-raised hover:text-ink">
        <RefreshCw size={12} strokeWidth={1.75} className={loading ? "animate-spin" : ""} />
      </button>
      {updatedAt && <span>Last updated {ago(now - updatedAt)}</span>}
    </span>
  );

  if (!current) {
    return (
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }}
        className="flex min-h-[60vh] flex-col items-center justify-center text-center">
        <Heading size="lg" className="mb-4">All clear.</Heading>
        <Lead>New suggestions show up here.</Lead>
        <div className="mt-4">{refreshBtn}</div>
        {notice && <p role="status" className={`mt-6 max-w-[32rem] text-[13px] ${notice.ok ? "text-muted" : "text-accent"}`}>{notice.text}</p>}
      </motion.div>
    );
  }

  const hasLowRisk = items.some((p) => p.urgency === 1 || p.type === "create_event");
  const Icon = ICONS[current.type] ?? Sparkles;
  const groups = GROUPS.map((g) => ({ ...g, list: items.filter((p) => groupOf(p) === g.key) })).filter((g) => g.list.length);

  return (
    <div className="mx-auto grid max-w-[1180px] grid-cols-[0.8fr_1.2fr] items-start gap-12">
      <div className="pt-4">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <Eyebrow>Approve · {items.length} waiting</Eyebrow>
          {refreshBtn}
        </div>
        <Heading size="lg" className="mb-6">Nothing happens<br />without your <span className="text-glow">OK.</span></Heading>
        <Lead className="mb-6">Northstar drafts, plans and fills. You decide.</Lead>
        <div ref={listRef} className="max-h-[60vh] overflow-y-auto pr-1">
          {groups.map((g) => (
            <section key={g.key} className="mb-4 last:mb-0">
              <p className="mb-1.5 flex items-center gap-2 px-2 text-[11px] uppercase tracking-[0.12em] text-faint">
                {g.label}<span className="text-muted">{g.list.length}</span>
              </p>
              <ul>
                {g.list.map((p) => {
                  const RowIcon = ICONS[p.type] ?? Sparkles;
                  const active = p.id === current.id;
                  return (
                    <li key={p.id}>
                      <button type="button" data-pid={p.id} onClick={() => select(p.id)} aria-current={active || undefined}
                        className={`flex w-full items-center gap-3 rounded-[8px] px-2 py-2 text-left transition-colors ${active ? "bg-raised text-ink" : "text-muted hover:bg-raised/60 hover:text-warm"}`}>
                        <RowIcon size={14} strokeWidth={1.75} className={`shrink-0 ${active ? "text-accent" : "text-faint"}`} />
                        <span className="min-w-0 flex-1 truncate text-[14px]">{p.title}</span>
                        <span className="shrink-0 text-[10px] uppercase tracking-[0.1em] text-faint">{AGENT[p.agent] ?? p.agent}</span>
                        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot(p.urgency)}`} aria-label={`urgency ${p.urgency}`} />
                        <span className="w-14 shrink-0 text-right text-[11px] text-faint">{p.createdAt ? relTime(p.createdAt) : ""}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
        <div className="mt-6 flex flex-col items-start gap-3">
          {hasLowRisk && <TextLink onClick={approveLowRisk}>Approve all low-risk</TextLink>}
          <span className="text-[12px] text-faint">A approve · S skip · J/K move</span>
          {notice && <p role="status" className={`max-w-[22rem] text-[13px] ${notice.ok ? "text-muted" : "text-accent"}`}>{notice.text}</p>}
        </div>
      </div>

      <Window
        title={LABELS[current.type] ?? "Suggestion"}
        icon={<Icon size={16} strokeWidth={1.75} />}
        tag="NEEDS YOUR OK"
        meta={current.dueAt ? `due ${relTime(current.dueAt)}` : undefined}
        bodyClassName="p-7"
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={current.id}
            initial={{ opacity: 0, x: 8 * dir }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -8 * dir }}
            transition={{ duration: 0.22, ease: "easeOut" }}>
            <h2 className="display mb-3 text-[26px] leading-[1.15] text-ink">{current.title}</h2>
            <Why>{current.why}</Why>
            <Preview p={current} answers={answers[current.id] ?? {}}
              body={bodies[current.id]} onBody={(t) => setBodies((b) => ({ ...b, [current.id]: t }))}
              onAnswer={(sel, v) => setAnswers((a) => ({ ...a, [current.id]: { ...(a[current.id] ?? {}), [sel]: v } }))} />
            <div className="mt-8 flex items-center justify-end gap-3">
              <SecondaryButton onClick={() => act("skip")}>Skip</SecondaryButton>
              <PrimaryButton onClick={() => act("approve")}>Approve</PrimaryButton>
            </div>
          </motion.div>
        </AnimatePresence>
      </Window>
    </div>
  );
}
