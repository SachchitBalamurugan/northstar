import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Send, CalendarPlus, FileText, FileCheck, MailX, Sparkles, type LucideIcon } from "lucide-react";
import type { Proposal } from "@contracts/types";
import { getPendingProposals, approve, reject } from "@/api";
import { useUI } from "@/store";
import { Heading, Lead, Eyebrow, Window, NumberedList, PrimaryButton, SecondaryButton, TextLink, Why, Chip, relTime, clock } from "@/components/ui";

const ICONS: Record<Proposal["type"], LucideIcon> = {
  send_reply: Send, create_event: CalendarPlus, fill_form: FileText,
  submit_form: FileCheck, unsubscribe: MailX, task: Sparkles,
};

const LABELS: Record<Proposal["type"], string> = {
  send_reply: "Reply", create_event: "Calendar", fill_form: "Application",
  submit_form: "Application", unsubscribe: "Unsubscribe", task: "Suggestion",
};

type Field = { label: string; value: string; confidence?: number };

function Preview({ p }: { p: Proposal }) {
  const pl = p.payload ?? {};
  if (p.type === "send_reply") {
    return (
      <div className="mt-6 rounded-[12px] bg-raised p-5">
        <div className="mb-4 space-y-1.5 border-b-[0.8px] border-line pb-4 text-[12px] text-faint">
          <p><span className="inline-block w-16">To</span><span className="text-muted">{pl.to}</span></p>
          <p><span className="inline-block w-16">Subject</span><span className="text-muted">{pl.subject}</span></p>
        </div>
        <div className="relative max-h-[10rem] overflow-hidden">
          <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-warm">{pl.body}</p>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-raised to-transparent" />
        </div>
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
    return (
      <ul className="mt-6 divide-y divide-line rounded-[12px] bg-raised px-5">
        {(pl.fields as Field[]).map((f) => (
          <li key={f.label} className="flex items-center justify-between gap-4 py-3">
            <span className="text-[12px] uppercase tracking-[0.1em] text-faint">{f.label}</span>
            <span className="flex min-w-0 items-center gap-2">
              {f.value ? <span className="truncate text-[15px] text-warm">{f.value}</span> : <Chip tone="accent">Needs you</Chip>}
              {f.value && (f.confidence ?? 1) < 0.7 && <Chip tone="accent">check this</Chip>}
            </span>
          </li>
        ))}
      </ul>
    );
  }
  return null;
}

export default function Approve() {
  const setPendingCount = useUI((s) => s.setPendingCount);
  const [items, setItems] = useState<Proposal[] | null>(null);
  const [idx, setIdx] = useState(0);
  const [dir, setDir] = useState(1);

  useEffect(() => {
    getPendingProposals().then((ps) => { setItems(ps); setPendingCount(ps.length); });
  }, [setPendingCount]);

  const remove = useCallback((ids: string[]) => {
    setItems((prev) => {
      if (!prev) return prev;
      const next = prev.filter((p) => !ids.includes(p.id));
      setPendingCount(next.length);
      setIdx((i) => Math.min(i, Math.max(0, next.length - 1)));
      return next;
    });
  }, [setPendingCount]);

  const current = items?.[idx];

  const act = useCallback((kind: "approve" | "skip") => {
    if (!current) return;
    setDir(kind === "approve" ? 1 : -1);
    (kind === "approve" ? approve(current) : reject(current));
    remove([current.id]);
  }, [current, remove]);

  const approveLowRisk = () => {
    if (!items) return;
    const low = items.filter((p) => p.urgency === 1 || p.type === "create_event");
    low.forEach((p) => approve(p));
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
      else if (k === "j") { setDir(1); setIdx((i) => Math.min(i + 1, items.length - 1)); }
      else if (k === "k") { setDir(-1); setIdx((i) => Math.max(i - 1, 0)); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [act, items]);

  if (items === null) return null;

  if (!current) {
    return (
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }}
        className="flex min-h-[60vh] flex-col items-center justify-center text-center">
        <Heading size="lg" className="mb-4">All clear.</Heading>
        <Lead>New suggestions show up here.</Lead>
      </motion.div>
    );
  }

  const hasLowRisk = items.some((p) => p.urgency === 1 || p.type === "create_event");
  // Show a 5-item window of titles around the current index.
  const start = Math.max(0, Math.min(idx - 2, items.length - 5));
  const visible = items.slice(start, start + 5);
  const Icon = ICONS[current.type] ?? Sparkles;

  return (
    <div className="mx-auto grid max-w-[1180px] grid-cols-[0.8fr_1.2fr] items-start gap-12">
      <div className="pt-4">
        <Eyebrow className="mb-4">Approve · {items.length} waiting</Eyebrow>
        <Heading size="lg" className="mb-6">Nothing happens<br />without your <span className="text-glow">OK.</span></Heading>
        <Lead className="mb-8">Northstar drafts, plans and fills. You decide.</Lead>
        <NumberedList
          items={visible.map((p) => p.title)}
          active={idx - start}
          onSelect={(i) => { const n = start + i; setDir(n >= idx ? 1 : -1); setIdx(n); }}
        />
        <div className="mt-8 flex flex-col items-start gap-3">
          {hasLowRisk && <TextLink onClick={approveLowRisk}>Approve all low-risk</TextLink>}
          <span className="text-[12px] text-faint">A approve · S skip · J/K move</span>
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
            <Preview p={current} />
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
