import { useEffect, useState } from "react";
import { Sun, Check, Inbox as InboxIcon, BookOpen } from "lucide-react";
import { useUI, type Screen } from "./store";
import { checkHealth, getPendingProposals, type ServiceName } from "./api";
import Now from "./screens/Now";
import Approve from "./screens/Approve";
import Inbox from "./screens/Inbox";
import Knowledge from "./screens/Knowledge";
import Focus from "./screens/Focus";
import Onboarding from "./screens/Onboarding";
import CommandBar from "./screens/CommandBar";

const NAV: { id: Screen; label: string; Icon: typeof Sun }[] = [
  { id: "now", label: "Now", Icon: Sun },
  { id: "approve", label: "Approve", Icon: Check },
  { id: "inbox", label: "Inbox", Icon: InboxIcon },
  { id: "knowledge", label: "Knowledge", Icon: BookOpen },
];

declare global { interface Window { northstar?: import("../../preload/index").NorthstarBridge } }

export default function App() {
  const { screen, setScreen, focusTask, onboarded, openCommand, pendingCount, setPendingCount } = useUI();
  const [health, setHealth] = useState<Record<ServiceName, boolean>>({ memory: false, inbox: false, actions: false });

  useEffect(() => {
    const tick = async () => {
      setHealth(await checkHealth());
      const n = (await getPendingProposals()).length; setPendingCount(n); window.northstar?.setBadge(n);
    };
    tick(); const t = setInterval(tick, 15000);
    const offCmd = window.northstar?.onCommandBar(() => openCommand());
    const onKey = (e: KeyboardEvent) => { if (e.ctrlKey && e.code === "Space") { e.preventDefault(); openCommand(); } };
    window.addEventListener("keydown", onKey);
    return () => { clearInterval(t); offCmd?.(); window.removeEventListener("keydown", onKey); };
  }, []);

  if (!onboarded) return <Onboarding />;

  return (
    <div className="flex h-full">
      <nav className="drag flex w-[76px] shrink-0 flex-col items-center gap-2 border-r border-line pt-14">
        {NAV.map(({ id, label, Icon }) => (
          <button key={id} onClick={() => setScreen(id)} title={label} aria-label={label}
            className={`no-drag relative flex h-11 w-11 items-center justify-center rounded-xl transition-colors duration-150 ${screen === id ? "bg-soft text-ink" : "text-muted hover:text-ink"}`}>
            <Icon size={20} strokeWidth={1.75} />
            {id === "approve" && pendingCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-accent-ink">{pendingCount}</span>
            )}
          </button>
        ))}
        <div className="mt-auto mb-5 flex flex-col gap-1.5" title="Services">
          {(Object.keys(health) as ServiceName[]).map(s => (
            <span key={s} title={`${s}: ${health[s] ? "online" : "offline (demo data)"}`} className={`h-1.5 w-1.5 rounded-full ${health[s] ? "bg-emerald-500" : "bg-line"}`} />
          ))}
        </div>
      </nav>
      <main className="drag relative flex-1 overflow-y-auto">
        <div className="no-drag mx-auto max-w-[760px] px-12 pt-20 pb-24">
          {screen === "now" && <Now />}
          {screen === "approve" && <Approve />}
          {screen === "inbox" && <Inbox />}
          {screen === "knowledge" && <Knowledge />}
        </div>
      </main>
      {focusTask && <Focus />}
      <CommandBar />
    </div>
  );
}
