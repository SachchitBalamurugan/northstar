// Tab organizer: group open tabs by task (with the why), suggest a few to close, and keep everything restorable.
import { useEffect, useState } from "react";
import { AppWindow, Loader2 } from "lucide-react";
import { archiveTabs, getTabSessions, getTabs, organizeTabs, restoreTabSession, saveTabSession, type Tab, type TabPlan, type TabSession } from "@/assistApi";
import { Window, Eyebrow, SecondaryButton, TextLink, relTime } from "@/components/ui";

const MAX = 5;
const count = (s: TabSession) => (Array.isArray(s.tabs) ? s.tabs.length : Number(s.tabs) || 0);
const plural = (n: number) => `${n} ${n === 1 ? "tab" : "tabs"}`;

export default function TabOrganizer() {
  const [tabs, setTabs] = useState<Tab[] | null>(null);
  const [plan, setPlan] = useState<TabPlan | null>(null);
  const [sessions, setSessions] = useState<TabSession[]>([]);
  const [busy, setBusy] = useState<"organize" | "archive" | "save" | string | null>(null);
  const [note, setNote] = useState("");

  const reload = async () => {
    const [t, s] = await Promise.all([getTabs(), getTabSessions()]);
    setTabs(t); setSessions(s);
  };
  useEffect(() => { reload(); }, []);

  const byId = (id: string) => tabs?.find(t => t.id === id);

  const organize = async () => {
    setBusy("organize"); setNote("");
    setPlan(await organizeTabs(tabs && tabs.length ? tabs : undefined));
    setBusy(null);
  };
  const archive = async () => {
    if (!plan?.archive.length) return;
    setBusy("archive");
    const r = await archiveTabs(plan.archive.map(a => a.tabId));
    setPlan({ ...plan, archive: [] });
    await reload();
    setNote(r?.ok === false ? "Those tabs couldn't be archived just now. Nothing was closed." : `Archived ${plural(r.closed ?? 0)}. They are saved below and you can restore them any time.`);
    setBusy(null);
  };
  const save = async () => {
    setBusy("save");
    const name = `Session, ${new Date().toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}`;
    await saveTabSession(name, tabs && tabs.length ? tabs : undefined);
    await reload();
    setNote(`Saved "${name}". Your tabs stay open.`);
    setBusy(null);
  };
  const restore = async (s: TabSession) => {
    setBusy(s.id);
    const r = await restoreTabSession(s.id);
    await reload();
    setNote(r?.ok === false ? `Couldn't reopen "${s.name}" just now. It is still saved.` : `Reopened ${plural(r.opened ?? 0)} from "${s.name}".`);
    setBusy(null);
  };

  const groups = (plan?.groups ?? []).slice(0, MAX);
  const closing = (plan?.archive ?? []).slice(0, MAX);
  const shownSessions = sessions.slice(0, MAX);

  return (
    <Window title="Tabs" icon={<AppWindow size={16} />} meta={tabs === null ? "" : `${plural(tabs.length)} open`} className="mt-8">
      <div className="flex flex-wrap items-center gap-5 px-6 py-5">
        <p className="min-w-0 flex-1 text-[15px] leading-relaxed text-muted">
          {plan ? "Here is how your tabs line up with what you're working on." : "Too many tabs open? I can sort them by task and suggest a few to put away."}
        </p>
        <TextLink onClick={save} disabled={!!busy} className="shrink-0 disabled:opacity-50">{busy === "save" ? "Saving…" : "Save this session"}</TextLink>
        <SecondaryButton onClick={organize} disabled={!!busy} className="h-11 shrink-0 text-[14px] disabled:opacity-50">
          {busy === "organize" && <Loader2 size={14} className="animate-spin" />}
          {busy === "organize" ? "Sorting your tabs…" : "Organize my tabs"}
        </SecondaryButton>
      </div>

      {note && <p role="status" className="border-t-[0.8px] border-line px-6 py-3 text-[13px] text-muted">{note}</p>}

      {plan && (
        <div className="grid grid-cols-2 items-start border-t-[0.8px] border-line">
          <div className="border-r-[0.8px] border-line px-6 py-5">
            <Eyebrow className="mb-3">Grouped by task</Eyebrow>
            {groups.length === 0 ? <p className="text-[14px] text-muted">Nothing to group right now.</p> : (
              <ul className="space-y-4">
                {groups.map(g => {
                  const titles = g.tabIds.map(id => byId(id)?.title).filter((t): t is string => !!t);
                  return (
                    <li key={g.id} className="border-l border-accent pl-4">
                      <p className="flex items-baseline gap-2 text-[15px] text-ink">{g.name}<span className="text-[12px] tabular-nums text-faint">{plural(g.tabIds.length)}</span></p>
                      <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{g.why}</p>
                      {titles.length > 0 && (
                        <p className="mt-1 truncate text-[12.5px] text-faint">{titles.slice(0, 3).join(" · ")}{titles.length > 3 ? ` · +${titles.length - 3} more` : ""}</p>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <div className="px-6 py-5">
            <Eyebrow className="mb-3">Suggested to close</Eyebrow>
            {closing.length === 0 ? <p className="text-[14px] text-muted">Nothing to close. Every open tab belongs to something you're doing.</p> : (
              <>
                <ul className="space-y-3">
                  {closing.map(a => (
                    <li key={a.tabId}>
                      <p className="truncate text-[14.5px] text-warm">{byId(a.tabId)?.title ?? "A tab"}</p>
                      <p className="text-[13px] leading-relaxed text-faint">{a.why}</p>
                    </li>
                  ))}
                </ul>
                <div className="mt-5 flex flex-wrap items-center gap-4">
                  <SecondaryButton onClick={archive} disabled={!!busy} className="h-10 shrink-0 text-[14px] disabled:opacity-50">
                    {busy === "archive" && <Loader2 size={14} className="animate-spin" />} Archive these
                  </SecondaryButton>
                  <p className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-faint">Nothing is lost. They are saved as a session first, and you can restore them any time.</p>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {shownSessions.length > 0 && (
        <div className="border-t-[0.8px] border-line px-6 py-5">
          <Eyebrow className="mb-3">Saved sessions</Eyebrow>
          <ul className="space-y-2.5">
            {shownSessions.map(s => (
              <li key={s.id} className="flex items-center gap-3 text-[14px]">
                <span className="min-w-0 flex-1 truncate text-warm">{s.name}</span>
                <span className="shrink-0 text-[12.5px] tabular-nums text-faint">{plural(count(s))} · {relTime(s.createdAt)}</span>
                <TextLink onClick={() => restore(s)} disabled={!!busy} className="shrink-0 text-[13px] disabled:opacity-50">{busy === s.id ? "Restoring…" : "Restore"}</TextLink>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Window>
  );
}
