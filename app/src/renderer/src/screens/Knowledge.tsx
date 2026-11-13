import { useEffect, useRef, useState } from "react";
import { FileText } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { AnimatePresence, motion } from "framer-motion";
import type { KnowledgeFile } from "@contracts/types";
import { listKnowledge, getKnowledge, putKnowledge } from "@/api";
import { Heading, Card, PrimaryButton, TextLink, Why } from "@/components/ui";

const md = {
  h1: (p: any) => <h1 className="mb-4 font-serif text-[28px] leading-tight text-ink" {...p} />,
  h2: (p: any) => <h2 className="mt-6 mb-2 font-serif text-[21px] leading-snug text-ink" {...p} />,
  h3: (p: any) => <h3 className="mt-5 mb-2 text-[16px] font-semibold text-ink" {...p} />,
  p: (p: any) => <p className="mb-3" {...p} />,
  ul: (p: any) => <ul className="mb-3 list-disc space-y-1 pl-5" {...p} />,
  ol: (p: any) => <ol className="mb-3 list-decimal space-y-1 pl-5" {...p} />,
  strong: (p: any) => <strong className="font-semibold text-ink" {...p} />,
  a: (p: any) => <a className="text-ink underline underline-offset-4" {...p} />,
};

const label = (n: string) => n.replace(/\.md$/i, "");

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
    el.style.height = "auto"; el.style.height = `${Math.max(280, el.scrollHeight)}px`;
  }, [draft, editing]);

  const save = async () => {
    if (!sel) return;
    setSaving(true);
    await putKnowledge(sel, draft);
    setContent(draft); setSaving(false); setEditing(false); setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <div>
      <Heading eyebrow="Knowledge">What Northstar<br />knows about you.</Heading>
      <div className="-mt-6 mb-8"><Why>Plain files you own. Edit anything that's wrong.</Why></div>
      <Card className="flex min-h-[420px] overflow-hidden">
        <ul className="w-[200px] shrink-0 border-r border-line p-2">
          {files.map(f => (
            <li key={f.name}>
              <button onClick={() => setSel(f.name)}
                className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[14px] transition-colors duration-150 ${sel === f.name ? "bg-soft text-ink" : "text-muted hover:text-ink"}`}>
                <FileText size={15} strokeWidth={1.75} className="shrink-0" />
                <span className="truncate">{label(f.name)}</span>
              </button>
            </li>
          ))}
        </ul>
        <section className="min-w-0 flex-1 p-8">
          {sel && (
            <div className="mb-5 flex items-center justify-between">
              <p className="text-[13px] font-medium tracking-wide text-muted uppercase">{label(sel)}</p>
              <div className="flex items-center gap-4">
                <AnimatePresence>
                  {saved && <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} className="text-[14px] text-muted">Saved</motion.span>}
                </AnimatePresence>
                <TextLink onClick={() => { if (editing) setDraft(content); setEditing(e => !e); }}>{editing ? "Cancel" : "Edit"}</TextLink>
              </div>
            </div>
          )}
          <AnimatePresence mode="wait">
            {editing ? (
              <motion.div key="edit" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
                <textarea ref={ta} value={draft} onChange={e => setDraft(e.target.value)} spellCheck={false}
                  className="w-full resize-none rounded-lg bg-soft p-4 font-mono text-[13.5px] leading-[1.7] text-ink outline-none" />
                <div className="mt-4"><PrimaryButton onClick={save} disabled={saving}>Save</PrimaryButton></div>
              </motion.div>
            ) : (
              <motion.div key={`view-${sel}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}
                className="text-[15px] leading-[1.7] text-ink">
                <ReactMarkdown components={md}>{content}</ReactMarkdown>
              </motion.div>
            )}
          </AnimatePresence>
        </section>
      </Card>
    </div>
  );
}
