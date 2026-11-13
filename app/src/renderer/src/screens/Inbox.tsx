import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Inbox as InboxIcon, ChevronDown } from "lucide-react";
import type { Email, Proposal, Triage } from "@contracts/types";
import { getTriage, draftReply, approve } from "@/api";
import { Heading, Lead, Eyebrow, Window, PrimaryButton, TextLink, Why, Chip, relTime } from "@/components/ui";
import { approveEdited } from "@/assistApi";
import GoogleConnect from "@/components/GoogleConnect";
import RefineControls from "@/components/RefineControls";
import InboxBrief from "@/screens/InboxBrief";

const TWO_DAYS = 2 * 24 * 36e5;

function Row({ e, dim = false, selected = false, onClick }: { e: Email; dim?: boolean; selected?: boolean; onClick?: () => void }) {
  const when = e.dueAt ? `due ${relTime(e.dueAt)}` : relTime(e.receivedAt);
  const soon = !!e.dueAt && new Date(e.dueAt).getTime() - Date.now() < TWO_DAYS;
  return (
    <button onClick={onClick} disabled={!onClick}
      className={`no-drag flex w-full items-start gap-4 px-5 py-4 text-left transition-colors duration-150 ${onClick ? "hover:bg-white/[0.03]" : ""} ${selected ? "selected" : ""} ${dim ? "opacity-60" : ""}`}>
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/8 text-[14px] font-medium text-ink">
        {e.from.trim().charAt(0).toUpperCase()}
      </span>
      <div className="min-w-0 flex-1">
        <div className="mb-0.5 flex items-center gap-2">
          <span className="truncate text-[15px] font-medium text-ink">{e.from}</span>
          {e.fromRole && <Chip>{e.fromRole}</Chip>}
        </div>
        <p className="truncate text-[15px] text-warm">{e.subject}</p>
        <p className="truncate text-[14px] text-faint">{e.snippet}</p>
      </div>
      <span className={`shrink-0 pt-1 text-[12px] ${soon ? "text-accent" : "text-faint"}`}>{when}</span>
    </button>
  );
}

export default function Inbox() {
  const [triage, setTriage] = useState<Triage | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Proposal | "loading">>({});
  const [done, setDone] = useState<Record<string, boolean>>({});
  const [showFyi, setShowFyi] = useState(false);
  // Reply bodies the user refined (by email id). When set, this is the text that gets sent on approve.
  const [edited, setEdited] = useState<Record<string, string>>({});

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
    const body = edited[id];
    if (body !== undefined && body.trim() && body !== p.payload?.body) approveEdited(p, body);
    else approve(p);
    setDone((d) => ({ ...d, [id]: true }));
    setOpenId(null);
  };

  const needs = triage ? triage.needsYou.filter((e) => !done[e.id]).slice(0, 5) : [];
  const total = triage ? triage.needsYou.filter((e) => !done[e.id]).length : 0;

  return (
    <div className="max-w-[860px]">
      <InboxBrief />
      <GoogleConnect onSynced={() => { getTriage().then(setTriage); }} />
      <Eyebrow className="mb-4">Inbox</Eyebrow>
      <Heading size="lg" className="mb-6">Only what<br />needs <span className="text-glow">you.</span></Heading>
      {triage && (
        <Lead className="mb-10">{triage.ignored} emails handled quietly. {triage.needsYou.length} need a human.</Lead>
      )}

      {triage && (
        <Window title="Needs you" icon={<InboxIcon size={16} strokeWidth={1.75} />} tag="TRIAGED" meta={`${needs.length} of ${total}`}>
          {needs.length === 0 ? (
            <div className="px-6 py-12 text-center">
              <p className="display text-[26px] text-ink">Nothing needs you.</p>
              <p className="mt-2 text-[14px] text-faint">Replies you approve go out right away.</p>
            </div>
          ) : (
            <div className="divide-y divide-line">
              {needs.map((e) => {
                const d = drafts[e.id];
                const isOpen = openId === e.id;
                return (
                  <div key={e.id} className={isOpen ? "selected" : ""}>
                    <Row e={e} onClick={() => open(e.id)} />
                    <AnimatePresence initial={false}>
                      {isOpen && (
                        <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.22, ease: "easeOut" }} className="overflow-hidden">
                          <div className="pb-5 pl-[72px] pr-5">
                            <div className="rounded-[12px] bg-raised p-5">
                              {d === "loading" || !d ? (
                                <p className="text-[14px] text-faint">Writing a draft…</p>
                              ) : (
                                <>
                                  <div className="mb-3"><Why>{d.why}</Why></div>
                                  <div className="max-h-[10rem] overflow-auto">
                                    <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-warm">{edited[e.id] ?? d.payload?.body}</p>
                                  </div>
                                  {typeof d.payload?.body === "string" && (
                                    <RefineControls className="mt-4" text={edited[e.id] ?? d.payload.body} context={`Reply to ${e.from}: ${e.subject}`}
                                      onChange={(t) => setEdited((m) => ({ ...m, [e.id]: t }))} />
                                  )}
                                  <div className="mt-5 flex items-center gap-6">
                                    <PrimaryButton onClick={() => onApprove(e.id)}>Approve draft</PrimaryButton>
                                    <TextLink onClick={() => setOpenId(null)}>Not now</TextLink>
                                  </div>
                                </>
                              )}
                            </div>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                );
              })}
            </div>
          )}
        </Window>
      )}

      {triage && triage.fyi.length > 0 && (
        <div className="mt-6 cursor-pointer" onClick={() => setShowFyi((v) => !v)}>
          <Window title="FYI" icon={<ChevronDown size={15} strokeWidth={1.75} className={`transition-transform duration-200 ${showFyi ? "" : "-rotate-90"}`} />}
            meta={`${triage.fyi.length}`} className="opacity-80">
            <AnimatePresence initial={false}>
              {showFyi && (
                <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden"
                  onClick={(ev) => ev.stopPropagation()}>
                  <div className="cursor-default divide-y divide-line">
                    {triage.fyi.slice(0, 5).map((e) => <Row key={e.id} e={e} dim />)}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </Window>
        </div>
      )}
    </div>
  );
}
