import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useUI, type Screen } from "./store";
import { checkHealth, getPendingProposals, type ServiceName } from "./api";
import { AmbientGlow, GlassPill, LogoMark, PrimaryButton, Kbd } from "./components/ui";
import Now from "./screens/Now";
import Approve from "./screens/Approve";
import Inbox from "./screens/Inbox";
import Knowledge from "./screens/Knowledge";
import Focus from "./screens/Focus";
import Onboarding from "./screens/Onboarding";
import CommandBar from "./screens/CommandBar";

const NAV: { id: Screen; label: string }[] = [
  { id: "now", label: "Now" },
  { id: "approve", label: "Approve" },
  { id: "inbox", label: "Inbox" },
  { id: "knowledge", label: "Knowledge" },
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

  if (!onboarded) return <><AmbientGlow /><Onboarding /></>;

  const live = Object.values(health).filter(Boolean).length;

  return (
    <div className="relative flex h-full flex-col">
      <AmbientGlow />
      {/* Top bar: logo · glass pill nav · primary CTA. Right 140px kept clear for Windows caption buttons. */}
      <header className="drag relative z-20 flex h-[84px] shrink-0 items-center px-8 pr-[156px]">
        <button onClick={() => setScreen("now")} className="no-drag flex items-center gap-3">
          <LogoMark />
          <span className="display text-[24px] tracking-[-0.03em]">Northstar</span>
        </button>

        <div className="absolute left-1/2 -translate-x-1/2">
          <GlassPill>
            {NAV.map(({ id, label }) => (
              <button key={id} onClick={() => setScreen(id)}
                className={`relative h-10 rounded-full px-[15px] text-[14.3px] font-medium tracking-[-0.01em] transition-colors duration-200 ${screen === id ? "text-ink" : "text-muted hover:text-ink"}`}>
                {screen === id && <motion.span layoutId="nav-pill" transition={{ duration: 0.3, ease: "easeOut" }} className="absolute inset-0 rounded-full bg-white/10" />}
                <span className="relative flex items-center gap-2">
                  {label}
                  {id === "approve" && pendingCount > 0 && (
                    <span className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent px-1 text-[10.5px] font-semibold text-black">{pendingCount}</span>
                  )}
                </span>
              </button>
            ))}
          </GlassPill>
        </div>

        <div className="ml-auto flex items-center gap-4">
          <span title={`${live}/3 services live. Offline services use demo data.`} className="no-drag flex items-center gap-1.5">
            {(Object.keys(health) as ServiceName[]).map(s => (
              <span key={s} title={`${s}: ${health[s] ? "live" : "demo data"}`} className={`h-1.5 w-1.5 rounded-full ${health[s] ? "bg-emerald-400 shadow-[0_0_8px_#34d399]" : "bg-white/20"}`} />
            ))}
          </span>
          <PrimaryButton onClick={() => openCommand()} className="h-[44px] px-5 text-[14.3px]">
            Hand off a task <Kbd>Ctrl Space</Kbd>
          </PrimaryButton>
        </div>
      </header>

      <main className="relative z-10 flex-1 overflow-y-auto">
        <AnimatePresence mode="wait">
          <motion.div key={screen} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.25, ease: "easeOut" }}
            className="mx-auto max-w-[1120px] px-10 pt-10 pb-24">
            {screen === "now" && <Now />}
            {screen === "approve" && <Approve />}
            {screen === "inbox" && <Inbox />}
            {screen === "knowledge" && <Knowledge />}
          </motion.div>
        </AnimatePresence>
      </main>
      <AnimatePresence>{focusTask && <Focus />}</AnimatePresence>
      <CommandBar />
    </div>
  );
}
