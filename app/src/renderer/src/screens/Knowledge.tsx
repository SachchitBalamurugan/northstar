import { useEffect, useRef, useState } from "react";
import { Brain, CalendarDays, ChevronRight, FileText, Folder, Lock, Mail } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { AnimatePresence, motion } from "framer-motion";
import type { KnowledgeFile } from "@contracts/types";
import { listKnowledge, getKnowledge, putKnowledge } from "@/api";
import { AppChip, Eyebrow, Heading, Lead, PrimaryButton, TextLink, Window } from "@/components/ui";

const md = {
  h1: (p: any) => <h1 className="display mb-6 text-[40px] leading-[1.05] tracking-[-0.045em] text-ink" {...p} />,
  h2: (p: any) => <h2 className="display mt-8 mb-3 text-[24px] leading-snug text-ink" {...p} />,
  h3: (p: any) => <h3 className="mt-6 mb-2 text-[16px] font-semibold text-ink" {...p} />,
  p: (p: any) => <p className="mb-4 text-[15px] leading-[1.75] text-warm/85" {...p} />,
  ul: (p: any) => <ul className="mb-4 list-disc space-y-1.5 pl-5 text-[15px] leading-[1.75] text-warm/85 marker:text-faint" {...p} />,
  ol: (p: any) => <ol className="mb-4 list-decimal space-y-1.5 pl-5 text-[15px] leading-[1.75] text-warm/85 marker:text-faint" {...p} />,
  strong: (p: any) => <strong className="font-medium text-[#E8C48A]" {...p} />,
  a: (p: any) => <a className="text-[#E8C48A] underline decoration-[#E8C48A]/40 underline-offset-4 hover:decoration-[#E8C48A]" {...p} />,
  code: (p: any) => <code className="rounded-[5px] bg-white/[0.06] px-1.5 py-0.5 font-mono text-[13px] text-warm" {...p} />,
};

const label = (n: string) => n.replace(/\.md$/i, "");

const SOURCES = [
  { icon: <Mail size={16} className="text-[#7AA7FF]" />, label: "Emails", bg: "bg-[#3B82F6]/20" },
  { icon: <CalendarDays size={16} className="text-[#FFB27A]" />, label: "Calendar", bg: "bg-[#FF8A3D]/20" },
  { icon: <FileText size={16} className="text-[#FF8CCB]" />, label: "Applications", bg: "bg-[#FF3DA5]/20" },
  { icon: <Brain size={16} className="text-[#B9A2FF]" />, label: "Memory", bg: "bg-[#8B5CF6]/20" },
];

export default function Knowledge() {
  const [files, setFiles] = useState<KnowledgeFile[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    listKnowledge().then(fs => { setFiles(fs); if (fs[0]) setSel(s => s ?? fs[0].name); });
  }, []);

  useEffect(() => {
    if (!sel) return;
    let live = true;
    setEditing(false); setSaved(false);
    getKnowledge(sel).then(f => { if (live) { setContent(f.content ?? ""); setDraft(f.content ?? ""); } });
    return () => { live = false; };
  }, [sel]);

  useEffect(() => {
    const el = ta.current; if (!el) return;
    el.style.height = "auto"; el.style.height = `${Math.max(320, el.scrollHeight)}px`;
  }, [draft, editing]);

  const save = async () => {
    if (!sel) return;
    setSaving(true);
    await putKnowledge(sel, draft);
    setContent(draft); setSaving(false); setEditing(false); setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const others = files.filter(f => f.name !== sel);

  return (
    <div>
      <Heading>What Northstar<br />knows about <span className="text-glow">you.</span></Heading>
      <Lead className="-mt-6 mb-10">Plain Markdown files you own. Edit anything that's wrong.</Lead>

      <div className="mb-8 flex flex-wrap items-center justify-center gap-3">
        {SOURCES.map(s => (
          <AppChip key={s.label} label={s.label}
            icon={<span className={`flex h-8 w-8 items-center justify-center rounded-[9px] ${s.bg}`}>{s.icon}</span>} />
        ))}
      </div>

      <Window title="Knowledge" icon={<Folder size={15} strokeWidth={1.75} />} tag="LOCAL"
        meta={<span className="inline-flex items-center gap-1.5"><Lock size={12} strokeWidth={1.75} />On your PC</span>}>
        <div className="grid min-h-[520px] grid-cols-[230px_1fr_220px]">
          {/* left: files */}
          <aside className="flex flex-col border-r-[0.8px] border-line p-4">
            <Eyebrow className="mb-3 px-2">Your knowledge</Eyebrow>
            <ul className="flex flex-col gap-0.5">
              {files.map(f => (
                <li key={f.name}>
                  <button onClick={() => setSel(f.name)}
                    className={`no-drag flex w-full items-center gap-2.5 rounded-[8px] px-2.5 py-2 text-left text-[13px] transition-colors duration-150 ${sel === f.name ? "selected text-ink" : "text-muted hover:text-ink"}`}>
                    <FileText size={14} strokeWidth={1.75} className="shrink-0" />
                    <span className="truncate">{f.name}</span>
                  </button>
                </li>
              ))}
            </ul>
            <p className="mt-auto px-2 pt-6 text-[12px] text-faint">Plain Markdown. Entirely yours.</p>
          </aside>

          {/* center: document */}
          <section className="flex min-w-0 flex-col">
            <div className="flex h-11 items-center justify-between border-b-[0.8px] border-line px-6">
              <span className="inline-flex items-center gap-2 font-mono text-[12px] text-muted">
                <FileText size={13} strokeWidth={1.75} />{sel ?? "README.md"}
              </span>
              {sel && (
                <div className="flex items-center gap-4">
                  <AnimatePresence>
                    {saved && <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} className="text-[12px] text-faint">Saved</motion.span>}
                  </AnimatePresence>
                  <TextLink className="text-[13px]" onClick={() => { if (editing) setDraft(content); setEditing(e => !e); }}>{editing ? "Cancel" : "Edit"}</TextLink>
                </div>
              )}
            </div>
            <div className="flex-1 px-10 py-9">
              <AnimatePresence mode="wait">
                {editing ? (
                  <motion.div key="edit" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
                    <textarea ref={ta} value={draft} onChange={e => setDraft(e.target.value)} spellCheck={false}
                      className="w-full resize-none bg-transparent font-mono text-[13px] leading-[1.75] text-warm outline-none" />
                    <div className="mt-5"><PrimaryButton glow={false} className="h-10 px-5 text-[14px]" onClick={save} disabled={saving}>Save</PrimaryButton></div>
                  </motion.div>
                ) : (
                  <motion.div key={`view-${sel}`} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
                    <ReactMarkdown components={md}>{content}</ReactMarkdown>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </section>

          {/* right: connected notes */}
          <aside className="border-l-[0.8px] border-line p-4">
            <Eyebrow className="mb-3 px-1">Connected notes</Eyebrow>
            <ul className="flex flex-col">
              {others.map(f => (
                <li key={f.name} className="border-b-[0.8px] border-line last:border-b-0">
                  <button onClick={() => setSel(f.name)}
                    className="no-drag group flex w-full items-center gap-2.5 px-1 py-3 text-left text-[13px] text-muted transition-colors duration-150 hover:text-ink">
                    <FileText size={14} strokeWidth={1.75} className="shrink-0 text-faint group-hover:text-muted" />
                    <span className="flex-1 truncate">{label(f.name)}</span>
                    <ChevronRight size={14} strokeWidth={1.75} className="shrink-0 text-faint" />
                  </button>
                </li>
              ))}
            </ul>
          </aside>
        </div>
        <div className="flex h-10 items-center justify-between border-t-[0.8px] border-line px-5 text-[12px] text-faint">
          <span>{files.length} files · Plain Markdown</span>
          <span>Shared with all agents via Universal Memory</span>
        </div>
      </Window>
    </div>
  );
}
