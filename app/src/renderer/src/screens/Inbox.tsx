import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { Email, Proposal, Triage } from "@contracts/types";
import { getTriage, draftReply, approve } from "@/api";
import { Heading, Card, PrimaryButton, TextLink, Why, Chip, relTime } from "@/components/ui";

function Row({ e, muted = false, onClick }: { e: Email; muted?: boolean; onClick?: () => void }) {
  const when = e.dueAt ? `due ${relTime(e.dueAt)}` : relTime(e.receivedAt);
  return (
    <button onClick={onClick} disabled={!onClick}
      className={`no-drag flex w-full items-start gap-4 px-6 py-4 text-left transition-colors duration-150 ${onClick ? "hover:bg-soft" : ""} ${muted ? "opacity-70" : ""}`}>
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2">
          <span className="text-[15px] font-medium text-ink">{e.from}</span>
          {e.fromRole && <Chip>{e.fromRole}</Chip>}
        </div>
        <p className="truncate text-[15px] text-ink">{e.subject}</p>
        <p className="truncate text-[14px] text-muted">{e.snippet}</p>
      </div>
      <span className="shrink-0 pt-0.5 text-[13px] text-muted">{when}</span>
    </button>
  );
}

export default function Inbox() {
  const [triage, setTriage] = useState<Triage | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Proposal | "loading">>({});
  const [done, setDone] = useState<Record<string, boolean>>({});
  const [showFyi, setShowFyi] = useState(false);

  useEffect(() => { getTriage().then(setTriage); }, []);

  const open = (id: string) => {
    if (openId === id) { setOpenId(null); return; }
    setOpenId(id);
    if (!drafts[id]) {
      setDrafts((d) => ({ ...d, [id]: "loading" }));
      draftReply(id).then((p) => setDrafts((d) => ({ ...d, [id]: p })));
    }
  };

  const onApprove = (id: string) => {
    const p = drafts[id];
    if (!p || p === "loading") return;
    approve(p);
    setDone((d) => ({ ...d, [id]: true }));
    setOpenId(null);
  };

  const needs = triage ? triage.needsYou.filter((e) => !done[e.id]).slice(0, 5) : [];

  return (
    <div className="mx-auto max-w-[680px]">
      <Heading eyebrow="Inbox">Only what<br />needs you.</Heading>

      {triage && (
        needs.length === 0 ? (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }}>
            <p className="mb-2 font-serif text-[32px] text-ink">Nothing needs you.</p>
            <Why>Replies you approve go out right away.</Why>
          </motion.div>
        ) : (
          <Card className="divide-y divide-line overflow-hidden">
            {needs.map((e) => {
              const d = drafts[e.id];
              return (
                <div key={e.id}>
                  <Row e={e} onClick={() => open(e.id)} />
                  <AnimatePresence initial={false}>
                    {openId === e.id && (
                      <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2, ease: "easeOut" }} className="overflow-hidden">
                        <div className="px-6 pb-5">
                          {d === "loading" || !d ? (
                            <p className="text-[14px] text-muted">Writing a draft…</p>
                          ) : (
                            <>
                              <div className="mb-2"><Why>{d.why}</Why></div>
                              <div className="max-h-[10rem] overflow-auto rounded-xl bg-soft p-4">
                                <p className="whitespace-pre-wrap text-[14px] leading-relaxed text-ink">{d.payload?.body}</p>
                              </div>
                              <div className="mt-4 flex items-center gap-6">
                                <PrimaryButton onClick={() => onApprove(e.id)}>Approve draft</PrimaryButton>
                                <TextLink onClick={() => setOpenId(null)}>Not now</TextLink>
                              </div>
                            </>
                          )}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              );
            })}
          </Card>
        )
      )}

      {triage && (
        <div className="mt-8 space-y-4 px-1">
          {triage.fyi.length > 0 && (
            <div>
              <TextLink onClick={() => setShowFyi((v) => !v)}>FYI · {triage.fyi.length}</TextLink>
              <AnimatePresence initial={false}>
                {showFyi && (
                  <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
                    <div className="mt-3 divide-y divide-line rounded-[var(--radius)] border border-line">
                      {triage.fyi.slice(0, 5).map((e) => <Row key={e.id} e={e} muted />)}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}
          <p className="text-[13px] text-muted">{triage.ignored} emails ignored for you</p>
        </div>
      )}
    </div>
  );
}
