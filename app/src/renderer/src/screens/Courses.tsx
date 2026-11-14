// Courses: upload a syllabus, see what Northstar found in it, and ask questions across all of them.
import { useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { BookOpen, ChevronDown, FileText, FileUp, Search, Trash2 } from "lucide-react";
import { useUI } from "@/store";
import { Heading, Lead, Eyebrow, Window, Chip, PrimaryButton, TextLink, relTime } from "@/components/ui";
import {
  listCourses, getCourse, deleteCourse, uploadSyllabus, searchCourses,
  type Course, type CourseDeadline, type CourseSearch, type SyllabusUpload,
} from "@/coursesApi";

const KIND: Record<CourseDeadline["kind"], string> = { exam: "Exam", assignment: "Assignment", project: "Project", other: "Other" };
const ACCEPT = /\.(pdf|txt|md)$/i;
const fieldCls = "no-drag w-full rounded-[12px] border-[0.8px] border-line bg-white/[0.03] px-4 text-[15px] text-ink placeholder:text-faint transition-colors duration-150 focus:border-white/25 focus:outline-none";

const readText = (f: File) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsText(f); });
/** Base64 without the "data:...;base64," prefix. */
const readBase64 = (f: File) => new Promise<string>((res, rej) => {
  const r = new FileReader(); r.onload = () => { const s = String(r.result); res(s.slice(s.indexOf(",") + 1)); }; r.onerror = () => rej(r.error); r.readAsDataURL(f);
});

/* ---------------- search ---------------- */

function AskSyllabi({ hasCourses }: { hasCourses: boolean }) {
  const [q, setQ] = useState("");
  const [asked, setAsked] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<CourseSearch | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const query = q.trim(); if (!query || busy) return;
    setBusy(true); setAsked(query);
    const r = await searchCourses(query);
    setRes({ ...r, results: (r.results ?? []).slice(0, 3) }); setBusy(false);
  };

  return (
    <div className="mb-8">
      <form onSubmit={submit}>
        <label className="flex h-[54px] items-center gap-3 rounded-full border-[0.8px] border-line bg-white/[0.03] px-5 transition-colors duration-150 focus-within:border-white/25">
          <Search size={16} className="shrink-0 text-faint" />
          <input value={q} onChange={e => setQ(e.target.value)} aria-label="Ask your syllabi"
            placeholder="Ask your syllabi: when is the midterm? what's the late policy?"
            className="no-drag w-full bg-transparent text-[15px] text-ink placeholder:text-faint focus:outline-none" />
          {q.trim() && <button type="submit" className="no-drag shrink-0 text-[14px] text-muted transition-colors hover:text-ink">{busy ? "Looking…" : "Ask"}</button>}
        </label>
      </form>

      <AnimatePresence initial={false}>
        {(busy || res) && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: "easeOut" }} className="overflow-hidden">
            <div className="mt-4 rounded-[18px] border-[0.8px] border-line bg-surface p-6" aria-live="polite">
              {busy || !res ? (
                <p className="text-[14px] text-faint">Reading your syllabi…</p>
              ) : res.results.length === 0 && !res.answer ? (
                <p className="text-[14.5px] leading-relaxed text-muted">
                  {hasCourses ? `I could not find that in your syllabi. Try other words, or it may not be written down.` : "Add a syllabus first, then I can answer from it."}
                </p>
              ) : (
                <>
                  <div className="mb-1 flex items-center justify-between gap-4">
                    <p className="truncate text-[12.5px] text-faint">You asked: {asked}</p>
                    <TextLink className="shrink-0 !text-[13px]" onClick={() => { setRes(null); setQ(""); }}>Clear</TextLink>
                  </div>
                  {res.answer && <p className="mb-5 text-[17px] leading-relaxed text-ink">{res.answer}</p>}
                  {res.results.length > 0 && (
                    <>
                      <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.12em] text-faint">{res.answer ? "Why: from your syllabus" : "Closest passages"}</p>
                      <ul className="flex flex-col gap-2">
                        {res.results.map((h, i) => (
                          <li key={h.courseId + i} className="rounded-[12px] bg-raised px-4 py-3">
                            <p className="mb-1 text-[12.5px] text-accent">{h.course}</p>
                            <p className="line-clamp-3 text-[14px] leading-relaxed text-warm">{h.snippet}</p>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ---------------- course card ---------------- */

function CourseCard({ c, open, onToggle, onRemoved }: { c: Course; open: boolean; onToggle: () => void; onRemoved: () => void }) {
  const [deadlines, setDeadlines] = useState<CourseDeadline[] | null>(null);
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    if (open && !deadlines) getCourse(c.id).then(d => setDeadlines(d?.deadlines ?? []));
  }, [open, deadlines, c.id]);
  useEffect(() => { if (!open) setConfirm(false); }, [open]);

  const sorted = [...(deadlines ?? [])].sort((a, b) => +new Date(a.dueAt) - +new Date(b.dueAt));
  const upcoming = sorted.filter(d => +new Date(d.dueAt) >= Date.now());
  const shown = (upcoming.length ? upcoming : sorted).slice(0, 5);
  const more = (upcoming.length ? upcoming.length : sorted.length) - shown.length;

  return (
    <div className={`overflow-hidden rounded-[18px] border-[0.8px] border-line bg-surface shadow-[0_24px_80px_rgba(0,0,0,0.33),inset_0_1px_0_rgba(255,255,255,0.02)] ${open ? "selected" : ""}`}>
      <button onClick={onToggle} aria-expanded={open} className="no-drag flex w-full items-start gap-4 p-6 text-left transition-colors duration-150 hover:bg-white/[0.02]">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-white/[0.08] text-muted"><BookOpen size={16} /></span>
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-2.5">
            <h3 className="display truncate text-[22px] text-ink">{c.name}</h3>
            <Chip tone={c.deadlineCount ? "accent" : "default"}>{c.deadlineCount} {c.deadlineCount === 1 ? "deadline" : "deadlines"}</Chip>
          </div>
          <p className="text-[14.5px] leading-relaxed text-muted">{c.summary}</p>
          {c.facts.length > 0 && (
            <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3">
              {c.facts.slice(0, 4).map(f => (
                <div key={f.label} className="min-w-0">
                  <dt className="text-[11px] font-medium uppercase tracking-[0.12em] text-faint">{f.label}</dt>
                  <dd className="text-[14px] leading-snug text-warm">{f.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
        <ChevronDown size={16} className={`mt-2 shrink-0 text-faint transition-transform duration-200 ${open ? "" : "-rotate-90"}`} />
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: "easeOut" }} className="overflow-hidden">
            <div className="border-t-[0.8px] border-line px-6 pb-5 pt-2">
              {!deadlines ? (
                <p className="py-4 text-[14px] text-faint">Loading deadlines…</p>
              ) : shown.length === 0 ? (
                <p className="py-4 text-[14px] text-faint">No dated deadlines found in this syllabus.</p>
              ) : (
                <ul>
                  {shown.map(d => {
                    const t = +new Date(d.dueAt), past = t < Date.now(), soon = !past && t - Date.now() < 3 * 864e5;
                    return (
                      <li key={d.id} className={`flex items-center gap-4 border-b-[0.8px] border-line py-3.5 last:border-b-0 ${past ? "opacity-40" : ""}`}>
                        <span className="w-[92px] shrink-0 text-[13px] tabular-nums text-muted">{new Date(d.dueAt).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}</span>
                        <span className={`h-8 w-[3px] shrink-0 rounded-full ${d.kind === "exam" ? "bg-accent" : "bg-white/20"}`} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[15px] text-ink">{d.title}</p>
                          <p className="text-[12.5px] text-faint">{KIND[d.kind] ?? "Other"}{d.proposalId ? " · waiting in Approve" : ""}</p>
                        </div>
                        <span className={`shrink-0 text-[12px] ${soon ? "text-accent" : "text-faint"}`}>{relTime(d.dueAt)}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
              {more > 0 && <p className="pt-2 text-[12.5px] text-faint">{more} more later on. Showing the next five so it stays readable.</p>}
              <div className="mt-3 flex items-center justify-between gap-4 text-[12.5px] text-faint">
                <span className="flex min-w-0 items-center gap-1.5 truncate"><FileText size={12} className="shrink-0" /> {c.filename ?? "Pasted text"} · added {relTime(c.uploadedAt)}</span>
                {confirm ? (
                  <span className="flex shrink-0 items-center gap-4">
                    <span>Remove this syllabus?</span>
                    <button onClick={onRemoved} className="no-drag text-ink hover:opacity-80">Remove</button>
                    <button onClick={() => setConfirm(false)} className="no-drag text-muted hover:text-ink">Keep</button>
                  </span>
                ) : (
                  <button onClick={() => setConfirm(true)} className="no-drag flex shrink-0 items-center gap-1.5 text-faint transition-colors hover:text-ink"><Trash2 size={12} /> Remove</button>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ---------------- upload ---------------- */

function UploadBox({ onDone }: { onDone: () => void }) {
  const { setScreen } = useUI();
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState("");
  const [paste, setPaste] = useState(false);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [found, setFound] = useState<{ course: string; n: number; offline: boolean } | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  const take = (f?: File | null) => {
    if (!f) return;
    if (!ACCEPT.test(f.name)) { setNote("That file type is not supported yet. Use a .pdf, .txt or .md file."); return; }
    setNote(""); setFile(f); setPaste(false);
    if (!name.trim()) setName(f.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").replace(/\s*syllabus\s*/i, " ").trim());
  };
  const onDrop = (e: DragEvent) => { e.preventDefault(); setOver(false); take(e.dataTransfer.files?.[0]); };

  const ready = !!name.trim() && (paste ? !!text.trim() : !!file);

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true); setNote("");
    try {
      const body: SyllabusUpload = { course: name.trim() };
      if (paste) body.text = text.trim();
      else if (file) {
        body.filename = file.name;
        if (/\.pdf$/i.test(file.name)) body.pdfBase64 = await readBase64(file); else body.text = await readText(file);
      }
      const r = await uploadSyllabus(body);
      setFound({ course: r.course?.name ?? body.course, n: r.deadlines?.length ?? r.course?.deadlineCount ?? 0, offline: !!r.offline });
      setName(""); setFile(null); setText(""); setPaste(false);
      onDone();
    } catch {
      setNote("I could not read that one this time. Nothing was added. Try again, or paste the text instead.");
    } finally { setBusy(false); }
  };

  if (found) {
    return (
      <div className="px-5 py-6">
        <p className="mb-1 text-[12.5px] text-faint">{found.course}</p>
        {found.n > 0 ? (
          <>
            <p className="display mb-2 text-[24px] text-ink">Found {found.n} {found.n === 1 ? "deadline" : "deadlines"}.</p>
            <p className="mb-6 text-[14.5px] leading-relaxed text-muted">
              {found.offline
                ? "This is a sample reading: the inbox service is offline, so nothing was sent to Approve yet."
                : `${found.n === 1 ? "It is" : "They're"} waiting in Approve. Nothing goes on your calendar until you say so.`}
            </p>
            <div className="flex items-center gap-6">
              <PrimaryButton onClick={() => setScreen("approve")}>Review in Approve</PrimaryButton>
              <TextLink onClick={() => setFound(null)}>Add another</TextLink>
            </div>
          </>
        ) : (
          <>
            <p className="display mb-2 text-[24px] text-ink">Syllabus saved.</p>
            <p className="mb-6 text-[14.5px] leading-relaxed text-muted">I did not find any dated deadlines in it, so nothing was suggested. You can still ask questions about it.</p>
            <TextLink onClick={() => setFound(null)}>Add another</TextLink>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 px-5 py-5">
      <p className="text-[13.5px] leading-relaxed text-muted">
        Northstar reads the syllabus, pulls out the dates, and suggests them for your calendar. You approve each one.
      </p>
      <input value={name} onChange={e => setName(e.target.value)} placeholder="Course name, like CS70" aria-label="Course name" className={`${fieldCls} h-[46px]`} />

      {paste ? (
        <textarea value={text} onChange={e => setText(e.target.value)} placeholder="Paste the syllabus text here" aria-label="Syllabus text" rows={7}
          className={`${fieldCls} resize-none py-3 leading-relaxed`} />
      ) : (
        <button type="button" onClick={() => picker.current?.click()} onDrop={onDrop}
          onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
          className={`no-drag flex h-[148px] flex-col items-center justify-center gap-2 rounded-[14px] border-[0.8px] border-dashed px-4 text-center transition-colors duration-150 ${over ? "border-accent bg-accent/[0.06]" : "border-line hover:bg-white/[0.03]"}`}>
          {file ? (
            <>
              <FileText size={20} className="text-muted" />
              <span className="max-w-full truncate text-[14.5px] text-ink">{file.name}</span>
              <span className="text-[12.5px] text-faint">Click to choose a different file</span>
            </>
          ) : (
            <>
              <FileUp size={20} className="text-faint" />
              <span className="text-[14.5px] text-warm">Drop a syllabus here, or click to choose</span>
              <span className="text-[12.5px] text-faint">.pdf, .txt or .md</span>
            </>
          )}
        </button>
      )}
      <input ref={picker} type="file" accept=".pdf,.txt,.md,application/pdf,text/plain,text/markdown" className="hidden"
        onChange={e => { take(e.target.files?.[0]); e.target.value = ""; }} />

      {note && <p className="text-[13px] text-muted">{note}</p>}

      <div className="flex items-center gap-6">
        <PrimaryButton onClick={submit} disabled={!ready || busy} glow={ready && !busy}>{busy ? "Reading…" : "Read syllabus"}</PrimaryButton>
        <TextLink onClick={() => { setPaste(p => !p); setNote(""); }}>{paste ? "Use a file instead" : "Paste text instead"}</TextLink>
      </div>
      {busy && <p className="text-[12.5px] text-faint" role="status">Reading the syllabus. A long one can take a minute.</p>}
    </div>
  );
}

/* ---------------- screen ---------------- */

export default function Courses() {
  const [courses, setCourses] = useState<Course[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = () => listCourses().then(setCourses);
  useEffect(() => { void load(); }, []);

  const remove = (id: string) => {
    setCourses(cs => cs?.filter(c => c.id !== id) ?? cs);
    setOpenId(null);
    void deleteCourse(id);
  };

  const shown = courses?.slice(0, 5) ?? [];

  return (
    <div>
      <Eyebrow className="mb-4">Courses</Eyebrow>
      <Heading size="lg" className="mb-6">Every syllabus,<br />already <span className="text-glow">read.</span></Heading>
      <Lead className="mb-8 max-w-[54ch]">Add a syllabus once. Northstar finds the deadlines and answers questions from it, so you never have to dig for it again.</Lead>

      <div className="grid grid-cols-[1.35fr_1fr] items-start gap-6">
        <div className="min-w-0">
          <AskSyllabi hasCourses={shown.length > 0} />
          {!courses ? (
            <p className="text-[14px] text-faint">Loading your courses…</p>
          ) : shown.length === 0 ? (
            <div className="flex flex-col items-center rounded-[18px] border-[0.8px] border-dashed border-line px-6 py-14 text-center">
              <BookOpen size={24} className="mb-4 text-faint" />
              <p className="display text-[24px] text-ink">No syllabi yet.</p>
              <p className="mt-2 max-w-[38ch] text-[14px] leading-relaxed text-faint">Add one on the right. Start with the class that worries you most.</p>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {shown.map(c => (
                <CourseCard key={c.id} c={c} open={openId === c.id} onToggle={() => setOpenId(openId === c.id ? null : c.id)} onRemoved={() => remove(c.id)} />
              ))}
              {courses.length > shown.length && <p className="text-[12.5px] text-faint">Showing 5 of {courses.length} courses. Search covers all of them.</p>}
            </div>
          )}
        </div>

        <Window title="Add a syllabus" icon={<FileUp size={15} />} tag="AGENT">
          <UploadBox onDone={load} />
        </Window>
      </div>
    </div>
  );
}
