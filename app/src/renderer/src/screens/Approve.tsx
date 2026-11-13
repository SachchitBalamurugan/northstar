import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Send, CalendarPlus, FileText, FileCheck, MailX, Sparkles, type LucideIcon } from "lucide-react";
import type { Proposal } from "@contracts/types";
import { getPendingProposals, approve, reject } from "@/api";
import { useUI } from "@/store";
import { Heading, Card, PrimaryButton, TextLink, Why, Chip, relTime, clock } from "@/components/ui";

const ICONS: Record<Proposal["type"], LucideIcon> = {
  send_reply: Send, create_event: CalendarPlus, fill_form: FileText,
  submit_form: FileCheck, unsubscribe: MailX, task: Sparkles,
};

type Field = { label: string; value: string; confidence?: number };

function Preview({ p }: { p: Proposal }) {
  const pl = p.payload ?? {};
  if (p.type === "send_reply") {
    return (
      <div className="mt-5">
        <p className="mb-2 text-[13px] text-muted">To {pl.to} · {pl.subject}</p>
        <div className="relative max-h-[9.5rem] overflow-hidden rounded-xl bg-soft p-4">
          <p className="whitespace-pre-wrap text-[14px] leading-relaxed text-ink">{pl.body}</p>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-soft to-transparent" />
        </div>
      </div>
    );
  }
  if (p.type === "create_event" && pl.start && pl.end) {
    return <p className="mt-5 text-[15px] text-ink">{clock(pl.start)} – {clock(pl.end)}</p>;
  }
  if ((p.type === "fill_form" || p.type === "submit_form") && Array.isArray(pl.fields)) {
    return (
      <ul className="mt-5 divide-y divide-line rounded-xl bg-soft px-4">
        {(pl.fields as Field[]).map((f) => (
          <li key={f.label} className="flex items-center justify-between gap-4 py-2.5 text-[14px]">
            <span className="text-muted">{f.label}</span>
            <span className="flex min-w-0 items-center gap-2">
              {f.value ? <span className="truncate text-ink">{f.value}</span> : <span className="text-muted italic">Needs you</span>}
              {f.value && (f.confidence ?? 1) < 0.7 && <Chip>check this</Chip>}
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

  const hasLowRisk = items?.some((p) => p.urgency === 1 || p.type === "create_event");
  const upcoming = items ? items.slice(idx + 1, idx + 3) : [];

  return (
    <div className="mx-auto max-w-[640px]">
      <Heading eyebrow="Approve">Nothing happens<br />without your OK.</Heading>

      {items === null ? null : !current ? (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }}>
          <p className="mb-2 font-serif text-[32px] text-ink">All clear.</p>
          <Why>New suggestions show up here.</Why>
        </motion.div>
      ) : (
        <>
          <div className="mb-3 flex items-center justify-between">
            <span className="text-[13px] text-muted">{idx + 1} of {items.length}</span>
            {hasLowRisk && <TextLink onClick={approveLowRisk} className="text-[13px]">Approve all low-risk</TextLink>}
          </div>

          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={current.id}
              initial={{ opacity: 0, x: 24 * dir }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -24 * dir }}
              transition={{ duration: 0.2, ease: "easeOut" }}>
              <Card className="p-8">
                <Current p={current} />
                <div className="mt-8 flex items-center gap-6">
                  <PrimaryButton onClick={() => act("approve")}>Approve</PrimaryButton>
                  <TextLink onClick={() => act("skip")}>Skip</TextLink>
                  <span className="ml-auto text-[12px] text-muted">A approve · S skip · J/K move</span>
                </div>
              </Card>
            </motion.div>
          </AnimatePresence>

          {upcoming.length > 0 && (
            <ul className="mt-4 space-y-2 px-2">
              {upcoming.map((p, i) => (
                <li key={p.id} className="truncate font-serif text-[17px] text-muted" style={{ opacity: i === 0 ? 0.6 : 0.35 }}>
                  {p.title}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function Current({ p }: { p: Proposal }) {
  const Icon = ICONS[p.type] ?? Sparkles;
  return (
    <>
      <div className="mb-4 flex items-center gap-3">
        <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-soft text-ink">
          <Icon size={17} strokeWidth={1.75} />
        </span>
        {p.dueAt && <Chip>due {relTime(p.dueAt)}</Chip>}
      </div>
      <h2 className="mb-2 font-serif text-[28px] leading-[1.15] text-ink">{p.title}</h2>
      <Why>{p.why}</Why>
      <Preview p={p} />
    </>
  );
}
