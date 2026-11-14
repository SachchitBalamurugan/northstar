// Profile avatar button + slide-over editor. Edits a local draft; saving syncs to Northstar memory.
import { useEffect, useRef, useState, type ReactNode, type KeyboardEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { User, X, Loader2, Download } from "lucide-react";
import { importLinkedIn, getLinkedIn, type LinkedInProfile } from "../jobsApi";
import { useProfile, STATUS_LABELS, contextLine, WORK_AUTH_OPTIONS, activeModes, getField, setField, type Profile, type Status } from "../profile";
import { PrimaryButton, Eyebrow, TextLink } from "./ui";

const initials = (name: string) =>
  name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]!.toUpperCase()).join("");

export function ProfileButton() {
  const profile = useProfile(s => s.profile);
  const sync = useProfile(s => s.sync);
  const setOpen = useProfile(s => s.setOpen);
  const empty = !profile.name.trim() && !profile.school.trim();
  const ini = initials(profile.name);
  const dot = sync === "synced" ? "bg-accent" : sync === "local" ? "bg-warn" : sync === "saving" ? "bg-white/60" : "bg-white/25";

  return (
    <button type="button" title="Your profile" aria-label="Your profile" onClick={() => setOpen(true)}
      className="no-drag relative inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full p-[1.5px] transition-transform duration-150 hover:scale-[1.04] active:scale-[0.97]"
      style={{ background: "var(--line-strong)" }}>
      <span className="flex h-full w-full items-center justify-center rounded-full bg-surface text-[12.5px] font-medium tracking-[0.02em] text-ink">
        {ini || <User size={15} className="text-muted" />}
      </span>
      {empty ? (
        <span className="absolute -top-0.5 -right-0.5 flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-70" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-accent ring-2 ring-black" />
        </span>
      ) : (
        <span className={`absolute right-0 bottom-0 h-2 w-2 rounded-full ring-2 ring-black ${dot}`} />
      )}
    </button>
  );
}

const inputCls = "no-drag w-full rounded-[10px] border-[0.8px] border-line bg-white/[0.03] px-3 py-2.5 text-[14px] text-ink placeholder:text-faint focus:border-white/25 outline-none transition-colors";
const SUGGESTIONS = ["robotics", "hackathons", "startups", "design", "music", "hiking", "food"];

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-2">
      <span className="text-[11.5px] uppercase tracking-[0.12em] text-faint">{label}</span>
      {children}
    </label>
  );
}

export function ProfilePanel() {
  const { profile, sync, open, setOpen, save } = useProfile();
  const [draft, setDraft] = useState<Profile>(profile);
  const [tag, setTag] = useState("");
  const [saving, setSaving] = useState(false);
  const closeTimer = useRef<number | undefined>(undefined);
  type LiState = { kind: "idle" } | { kind: "importing" } | { kind: "needsLogin" } | { kind: "error"; msg: string } | { kind: "success"; p: LinkedInProfile };
  const [li, setLi] = useState<LiState>({ kind: "idle" });
  const [lastImport, setLastImport] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setDraft(profile); setTag(""); setSaving(false); setLi({ kind: "idle" });
      void getLinkedIn().then(p => setLastImport(p?.importedAt ?? null));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  const close = () => setOpen(false);
  const set = <K extends keyof Profile>(k: K, v: Profile[K]) => setDraft(d => ({ ...d, [k]: v }));

  const addTags = (raw: string) => {
    const items = raw.split(",").map(s => s.trim()).filter(Boolean);
    if (!items.length) return;
    setDraft(d => ({ ...d, interests: [...d.interests, ...items.filter(i => !d.interests.some(x => x.toLowerCase() === i.toLowerCase()))] }));
  };
  const removeTag = (t: string) => setDraft(d => ({ ...d, interests: d.interests.filter(x => x !== t) }));
  const doImport = async () => {
    const url = draft.linkedin.trim();
    if (!url) { setLi({ kind: "error", msg: "Paste your LinkedIn profile URL first." }); return; }
    setLi({ kind: "importing" });
    const r = await importLinkedIn(url);
    if (r.ok) {
      const p = r.profile;
      const edu = p.education?.[0];
      const top = (p.skills ?? []).slice(0, 5);
      setDraft(d => ({
        ...d,
        name: d.name.trim() ? d.name : p.name ?? "",
        location: d.location.trim() ? d.location : p.location ?? "",
        work: d.work.trim() ? d.work : p.headline || p.experience?.[0]?.title || "",
        school: d.school.trim() ? d.school : edu?.school ?? "",
        program: d.program.trim() ? d.program : edu?.degree ?? "",
        interests: [...d.interests, ...top.filter(s => !d.interests.some(x => x.toLowerCase() === s.toLowerCase()))],
      }));
      setLastImport(p.importedAt ?? new Date().toISOString());
      setLi({ kind: "success", p });
    } else if (r.needsLogin) setLi({ kind: "needsLogin" });
    else setLi({ kind: "error", msg: r.error });
  };
  const toggleStatus = (s: Status) =>
    setDraft(d => ({ ...d, statuses: d.statuses.includes(s) ? d.statuses.filter(x => x !== s) : [...d.statuses, s] }));

  const doSave = async () => {
    if (saving) return;
    setSaving(true);
    const pending = tag.trim();
    const final = pending ? { ...draft, interests: [...draft.interests, ...pending.split(",").map(s => s.trim()).filter(s => s && !draft.interests.includes(s))] } : draft;
    await save(final);
    closeTimer.current = window.setTimeout(() => { setSaving(false); close(); }, 600);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); close(); }
      else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void doSave(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const onTagKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === "Enter" && !e.metaKey && !e.ctrlKey) || e.key === ",") {
      e.preventDefault(); addTags(tag); setTag("");
    } else if (e.key === "Backspace" && !tag && draft.interests.length) {
      e.preventDefault(); set("interests", draft.interests.slice(0, -1));
    }
  };

  const syncText = sync === "saving" ? "Saving…" : sync === "synced" ? "Synced to Northstar memory ✓" : sync === "local" ? "Saved on this device (memory service offline)" : "";
  const preview = contextLine(draft);
  const modes = activeModes(draft);
  const suggestions = SUGGESTIONS.filter(s => !draft.interests.some(x => x.toLowerCase() === s));

  return (
    <AnimatePresence>
      {open && (
        <motion.div key="profile-overlay" className="no-drag fixed inset-0 z-[66] bg-black/50 backdrop-blur-sm"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}
          onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
          <motion.aside role="dialog" aria-label="Profile"
            className="absolute top-0 right-0 flex h-full w-[460px] max-w-full flex-col border-l-[0.8px] border-line bg-surface shadow-[-24px_0_80px_rgba(0,0,0,0.45)]"
            initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }} transition={{ type: "spring", stiffness: 380, damping: 38 }}>
            <div className="flex-1 overflow-y-auto px-7 pt-8 pb-6">
              <div className="mb-8 flex items-start justify-between gap-4">
                <div>
                  <Eyebrow className="mb-3">Profile</Eyebrow>
                  <h2 className="display text-[30px] text-ink">Tell Northstar<br />about you.</h2>
                  <p className="mt-3 text-[14px] leading-relaxed text-muted">The AI uses this to personalize research, events and suggestions.</p>
                </div>
                <button type="button" onClick={close} aria-label="Close" title="Close (Esc)"
                  className="no-drag -mt-1 -mr-2 rounded-full p-2 text-muted transition-colors hover:bg-white/[0.06] hover:text-ink">
                  <X size={18} />
                </button>
              </div>

              <div className="flex flex-col gap-6">
                <Field label="Name">
                  <input className={inputCls} value={draft.name} placeholder="Your name" autoFocus onChange={e => set("name", e.target.value)} />
                </Field>

                <div className="flex flex-col gap-2">
                  <span className="text-[11.5px] uppercase tracking-[0.12em] text-faint">Status</span>
                  <div className="flex flex-wrap gap-2">
                    {(Object.keys(STATUS_LABELS) as Status[]).map(s => {
                      const on = draft.statuses.includes(s);
                      return (
                        <button key={s} type="button" aria-pressed={on} onClick={() => toggleStatus(s)}
                          className={`no-drag h-8 rounded-full border-[0.8px] px-3.5 text-[13px] transition-colors duration-150 ${on ? "border-white bg-white text-accent-ink" : "border-line bg-white/[0.03] text-warm hover:bg-white/[0.07]"}`}>
                          {STATUS_LABELS[s]}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Status-driven sections: each status unlocks its own questions. */}
                {modes.length === 0 ? (
                  <p className="rounded-[12px] border-[0.8px] border-dashed border-line px-4 py-3 text-[13px] leading-relaxed text-faint">
                    Pick what you're up to above. <span className="text-muted">In school</span> asks about classes,{" "}
                    <span className="text-muted">Working</span> about your role, <span className="text-muted">Job hunting</span> about what you want,
                    and <span className="text-muted">Taking it easy</span> about hobbies and things to do.
                  </p>
                ) : (
                  <AnimatePresence initial={false}>
                    {modes.map(m => (
                      <motion.section key={m.id} layout
                        initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0, marginTop: -12 }}
                        transition={{ duration: 0.22, ease: "easeOut" }}
                        className="overflow-hidden rounded-[14px] border-[0.8px] border-line bg-white/[0.02] p-4">
                        <div className="mb-3">
                          <p className="text-[14px] font-medium text-ink">{m.title}</p>
                          <p className="text-[12.5px] leading-relaxed text-faint">{m.blurb}</p>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          {m.fields.map(f => {
                            const v = getField(draft, f);
                            const onChange = (val: string) => setDraft(d => setField(d, f, val));
                            return (
                              <div key={f.key} className={f.half ? "" : "col-span-2"}>
                                <Field label={f.label}>
                                  {f.kind === "textarea" ? (
                                    <textarea className={`${inputCls} resize-none`} rows={2} value={v} placeholder={f.placeholder} onChange={e => onChange(e.target.value)} />
                                  ) : f.kind === "select" ? (
                                    <select className={inputCls} value={v} onChange={e => onChange(e.target.value)}>
                                      <option value="">Choose…</option>
                                      {f.options?.map(o => <option key={o} value={o}>{o}</option>)}
                                    </select>
                                  ) : (
                                    <input className={inputCls} value={v} placeholder={f.placeholder} onChange={e => onChange(e.target.value)} />
                                  )}
                                </Field>
                              </div>
                            );
                          })}
                        </div>
                      </motion.section>
                    ))}
                  </AnimatePresence>
                )}
                <Field label="Location"><input className={inputCls} value={draft.location} placeholder="Berkeley, CA" onChange={e => set("location", e.target.value)} /></Field>

                <div className="flex flex-col gap-2">
                  <span className="text-[11.5px] uppercase tracking-[0.12em] text-faint">Interests</span>
                  <div className="no-drag flex min-h-[46px] flex-wrap items-center gap-1.5 rounded-[10px] border-[0.8px] border-line bg-white/[0.03] px-2 py-1.5 focus-within:border-white/25">
                    {draft.interests.map(t => (
                      <span key={t} className="inline-flex h-7 items-center gap-1 rounded-full bg-white/[0.08] pr-1 pl-2.5 text-[12.5px] text-warm">
                        {t}
                        <button type="button" onClick={() => removeTag(t)} aria-label={`Remove ${t}`}
                          className="no-drag rounded-full p-0.5 text-faint hover:bg-white/10 hover:text-ink"><X size={12} /></button>
                      </span>
                    ))}
                    <input className="no-drag min-w-[120px] flex-1 bg-transparent px-1 py-1 text-[14px] text-ink outline-none placeholder:text-faint"
                      value={tag} placeholder={draft.interests.length ? "" : "Type and press Enter"}
                      onChange={e => { const v = e.target.value; if (v.includes(",")) { addTags(v); setTag(""); } else setTag(v); }}
                      onKeyDown={onTagKey} onBlur={() => { if (tag.trim()) { addTags(tag); setTag(""); } }} />
                  </div>
                  {suggestions.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {suggestions.map(s => (
                        <button key={s} type="button" onClick={() => addTags(s)}
                          className="no-drag h-6 rounded-full border-[0.8px] border-dashed border-line px-2.5 text-[12px] text-muted transition-colors hover:border-white/25 hover:text-ink">
                          + {s}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="flex flex-col gap-4 pt-2">
                  <span className="text-[11.5px] uppercase tracking-[0.12em] text-muted">Applications</span>
                  <p className="-mt-2 text-[12.5px] leading-relaxed text-faint">Used to fill job and event forms for you. Nothing is submitted without your OK.</p>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Email"><input className={inputCls} type="email" value={draft.email} placeholder="you@berkeley.edu" onChange={e => set("email", e.target.value)} /></Field>
                    <Field label="Phone"><input className={inputCls} type="tel" value={draft.phone} placeholder="(510) 555-0123" onChange={e => set("phone", e.target.value)} /></Field>
                    <Field label="GPA"><input className={inputCls} value={draft.gpa} placeholder="3.8" onChange={e => set("gpa", e.target.value)} /></Field>
                    <Field label="Grad year"><input className={inputCls} value={draft.gradYear} placeholder="2028" onChange={e => set("gradYear", e.target.value)} /></Field>
                  </div>
                  <div className="flex flex-col gap-2">
                    <Field label="LinkedIn">
                      <div className="flex gap-2">
                        <input className={inputCls} value={draft.linkedin} placeholder="https://linkedin.com/in/..." onChange={e => set("linkedin", e.target.value)} />
                        <button type="button" onClick={() => void doImport()} disabled={li.kind === "importing"}
                          className="no-drag inline-flex shrink-0 items-center gap-1.5 rounded-[10px] border-[0.8px] border-line bg-white/[0.06] px-3 text-[13px] text-ink transition-colors hover:bg-white/[0.1] disabled:opacity-50">
                          {li.kind === "importing" ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                          Import from LinkedIn
                        </button>
                      </div>
                    </Field>
                    {li.kind === "importing" && <p className="text-[12.5px] text-muted">Reading your LinkedIn in Chrome…</p>}
                    {li.kind === "needsLogin" && <p className="text-[12.5px] text-accent">Sign in to LinkedIn in the Northstar Chrome window, then click Import again.</p>}
                    {li.kind === "error" && <p className="text-[12.5px] text-amber-300/90">{li.msg}</p>}
                    {li.kind === "success" && <p className="text-[12.5px] text-emerald-400/90">Imported: {li.p.headline || li.p.name} · {li.p.skills?.length ?? 0} skills</p>}
                    {li.kind !== "success" && lastImport && <p className="text-[12px] text-faint">Last imported {new Date(lastImport).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</p>}
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="GitHub"><input className={inputCls} value={draft.github} placeholder="https://github.com/..." onChange={e => set("github", e.target.value)} /></Field>
                    <Field label="Website"><input className={inputCls} value={draft.website} placeholder="https://..." onChange={e => set("website", e.target.value)} /></Field>
                  </div>
                  <Field label="Work authorization">
                    <select className={inputCls} value={draft.workAuthorization} onChange={e => set("workAuthorization", e.target.value)}>
                      <option value="" className="bg-surface">Not set</option>
                      {WORK_AUTH_OPTIONS.map(o => <option key={o} value={o} className="bg-surface">{o}</option>)}
                    </select>
                  </Field>
                  <Field label="Resume (full path to PDF)"><input className={inputCls} value={draft.resumePath} placeholder={"C:\\Users\\you\\Documents\\resume.pdf"} onChange={e => set("resumePath", e.target.value)} /></Field>
                </div>

                <Field label="Goals">
                  <textarea className={`${inputCls} resize-none leading-relaxed`} rows={3} value={draft.goals}
                    placeholder="What are you working toward?" onChange={e => set("goals", e.target.value)} />
                </Field>
                <Field label="Anything else the AI should know?">
                  <textarea className={`${inputCls} resize-none leading-relaxed`} rows={5} value={draft.context}
                    placeholder="e.g. I have ADHD and work best 2–5pm. I prefer free events. I'm looking for SF startup events."
                    onChange={e => set("context", e.target.value)} />
                </Field>

                <div className="rounded-[12px] bg-raised px-4 py-3 text-[12.5px] leading-relaxed text-faint">
                  <span className="text-muted">How Northstar sees you: </span>{preview || "Nothing yet"}
                </div>
              </div>
            </div>

            <div className="sticky bottom-0 flex items-center gap-4 border-t-[0.8px] border-line bg-surface px-7 py-4">
              <span className={`min-w-0 flex-1 truncate text-[12.5px] ${sync === "synced" ? "text-emerald-400/90" : sync === "local" ? "text-amber-300/90" : "text-faint"}`}>
                {syncText}
              </span>
              <TextLink type="button" onClick={close}>Cancel</TextLink>
              <PrimaryButton type="button" glow={false} className="h-10 px-5 text-[14px]" disabled={saving} onClick={() => void doSave()}>
                Save profile
              </PrimaryButton>
            </div>
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
