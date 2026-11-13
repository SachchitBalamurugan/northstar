// The user's first name inside a greeting. Click it (or the "add your name" prompt) to type or change it.
import { useEffect, useRef, useState } from "react";
import { useUI } from "@/store";
import { firstNameOf } from "@/profile";

export default function NameInline() {
  const { userName, setUserName } = useUI();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(userName);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) { setDraft(userName); input.current?.focus(); input.current?.select(); } }, [editing]);

  const commit = () => { const v = draft.trim(); if (v && v !== userName) setUserName(v); setEditing(false); };

  if (editing) {
    return (
      <input ref={input} value={draft} onChange={e => setDraft(e.target.value)} onBlur={commit} aria-label="Your name"
        onKeyDown={e => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
        placeholder="your name" size={Math.max(8, draft.length + 1)}
        className="no-drag inline-block border-0 border-b-[1.5px] border-white/30 bg-transparent p-0 text-inherit outline-none placeholder:text-faint" />
    );
  }
  return userName ? (
    <button onClick={() => setEditing(true)} title="Change your name" className="no-drag cursor-text rounded-[6px] text-inherit transition-colors hover:bg-white/[0.06]">
      {firstNameOf(userName)}
    </button>
  ) : (
    <button onClick={() => setEditing(true)} className="no-drag rounded-[6px] text-faint underline decoration-white/25 decoration-dashed underline-offset-[6px] transition-colors hover:text-warm">
      add your name
    </button>
  );
}
