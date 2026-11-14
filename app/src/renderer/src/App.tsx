import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useAnimationControls } from "framer-motion";
import { useUI, type Screen } from "./store";
import { checkHealth, getPendingProposals, type ServiceName } from "./api";
import { fetchKnownName } from "./profile";
import { AmbientGlow, GlassPill, LogoMark } from "./components/ui";
import FloatingHandoff from "./components/FloatingHandoff";
import GoogleStatus from "./components/GoogleStatus";
import { NotificationBell } from "./components/Notifications";
import { ProfileButton, ProfilePanel } from "./components/Profile";
import Dashboard, { AskBar } from "./screens/Dashboard";
import Now from "./screens/Now";
import Approve from "./screens/Approve";
import Workflow from "./screens/Workflow";
import Knowledge from "./screens/Knowledge";
import Focus from "./screens/Focus";
import Onboarding from "./screens/Onboarding";
import CommandBar from "./screens/CommandBar";
import Activity from "./screens/Activity";

// Dashboard sits in the center as the hero tab; two tabs on each side.
const NAV: { id: Screen; label: string }[] = [
  { id: "now", label: "Focus" },
  { id: "approve", label: "Approve" },
  { id: "activity", label: "Activity" },
  { id: "dashboard", label: "Dashboard" },
  { id: "workflow", label: "Workflow" },
  { id: "knowledge", label: "Knowledge" },
];

/** The center "home" tab: mint-outlined button, filled solid mint when active. */
function DashboardTab({ active, onClick }: { active: boolean; onClick: () => void }) {
  return (
    <motion.button onClick={onClick} whileTap={{ scale: 0.97 }} transition={{ duration: 0.15, ease: "easeOut" }}
      className={`no-drag relative mx-1.5 flex h-10 items-center gap-2 rounded-[8px] border px-4 text-[14px] font-semibold tracking-[-0.01em] transition-colors duration-200 ${active ? "border-accent bg-accent text-accent-ink" : "border-accent/60 text-accent hover:bg-accent/10"}`}
      aria-current={active ? "page" : undefined} title="Dashboard: what matters most today">
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
        <path d="M8 1.5 L9.6 6.4 L14.5 8 L9.6 9.6 L8 14.5 L6.4 9.6 L1.5 8 L6.4 6.4 Z" fill="currentColor" />
      </svg>
      Dashboard
    </motion.button>
  );
}

declare global { interface Window { northstar?: import("../../preload/index").NorthstarBridge } }

export default function App() {
  const { screen, setScreen, focusTask, onboarded, openCommand, pendingCount, setPendingCount } = useUI();
  const [health, setHealth] = useState<Record<ServiceName, boolean>>({ memory: false, inbox: false, actions: false });
  const pop = useAnimationControls();
  const inElectron = !!window.northstar;
  const [origin, setOrigin] = useState("50% 0%");
  const state = useRef<"hidden" | "shown">(inElectron ? "hidden" : "shown");

  // Zoom the whole window out of the floating orb when it opens, and back into the orb when it hides.
  useEffect(() => {
    if (!inElectron) return;
    const zoomIn = (o?: { x: number; y: number }) => {
      if (o) setOrigin(`${o.x}px ${o.y}px`);
      state.current = "shown";
      pop.set({ scale: 0.04, opacity: 0, borderRadius: 400 });
      pop.start({
        scale: 1, borderRadius: 16, opacity: 1,
        transition: { scale: { duration: 0.5, ease: [0.16, 1, 0.3, 1] }, borderRadius: { duration: 0.5, ease: [0.16, 1, 0.3, 1] }, opacity: { duration: 0.16, ease: "easeOut" } },
      });
    };
    const offIn = window.northstar!.onPopIn(zoomIn);
    const offOut = window.northstar!.onPopOut(async (o) => {
      if (o) setOrigin(`${o.x}px ${o.y}px`);
      state.current = "hidden";
      await pop.start({
        scale: 0.04, borderRadius: 400, opacity: 0,
        transition: { scale: { duration: 0.32, ease: [0.7, 0, 0.84, 0] }, borderRadius: { duration: 0.32, ease: [0.7, 0, 0.84, 0] }, opacity: { duration: 0.14, delay: 0.18, ease: "easeIn" } },
      });
      window.northstar!.poppedOut();
    });
    // Fallback: if the window became visible without a pop-in event (first launch), zoom in from the top.
    const onFocus = () => { if (state.current === "hidden") zoomIn(); };
    window.addEventListener("focus", onFocus);
    return () => { offIn(); offOut(); window.removeEventListener("focus", onFocus); };
  }, []);

  const shell = (children: React.ReactNode) => (
    <motion.div animate={pop} initial={inElectron ? { scale: 0.04, opacity: 0, borderRadius: 400 } : false}
      style={{ transformOrigin: origin, willChange: "transform, opacity" }}
      className={`relative flex h-full flex-col overflow-hidden bg-bg ${inElectron ? "rounded-[16px] border border-line" : ""}`}>
      {children}
      {inElectron && <WindowControls />}
    </motion.div>
  );

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

  // Land on a screen when asked: `ns:navigate` from Electron (Ask window → maximize), or #activity / #approve in a browser.
  useEffect(() => {
    const go = (s: string) => { if (NAV.some(n => n.id === s)) setScreen(s as Screen); };
    const fromHash = () => { const h = window.location.hash.slice(1); if (h === "activity" || h === "approve") go(h); };
    fromHash(); window.addEventListener("hashchange", fromHash);
    const offNav = window.northstar?.onNavigate(go);
    return () => { window.removeEventListener("hashchange", fromHash); offNav?.(); };
  }, []);

  // No name in this browser yet: adopt one the services already know (typed earlier), otherwise the greeting asks for it.
  useEffect(() => {
    if (useUI.getState().userName) return;
    fetchKnownName().then(n => { if (n && !useUI.getState().userName) { try { localStorage.setItem("ns.userName", n); } catch {} useUI.setState({ userName: n }); } });
  }, []);

  const live = Object.values(health).filter(Boolean).length;
  const dragArea = useRef<HTMLDivElement>(null);

  if (!onboarded) return shell(<><AmbientGlow /><div className="drag absolute inset-x-0 top-0 h-12" /><Onboarding /></>);

  return shell(
    <>
      <AmbientGlow />
      {/* Top bar: logo · glass pill nav · primary CTA. Right side kept clear for our window controls. */}
      <header className="drag relative z-20 flex h-[84px] shrink-0 items-center px-8 pr-[132px]">
        <button onClick={() => setScreen("dashboard")} className="no-drag flex items-center gap-3">
          <LogoMark />
          <span className="display text-[24px] tracking-[-0.03em]">Northstar</span>
        </button>

        <div className="absolute left-1/2 -translate-x-[56%]">
          <GlassPill>
            {NAV.map(({ id, label }) => id === "dashboard" ? (
              <DashboardTab key={id} active={screen === "dashboard"} onClick={() => setScreen("dashboard")} />
            ) : (
              <button key={id} onClick={() => setScreen(id)}
                className={`relative h-10 rounded-[8px] px-3 text-[14px] font-medium tracking-[-0.01em] transition-colors duration-200 ${screen === id ? "text-accent" : "text-muted hover:text-ink"}`}>
                {screen === id && <motion.span layoutId="nav-pill" transition={{ duration: 0.25, ease: "easeOut" }} className="absolute inset-x-3 bottom-1 h-[2px] rounded-full bg-accent" />}
                <span className="relative flex items-center gap-2">
                  {label}
                  {id === "approve" && pendingCount > 0 && (
                    <span className="flex h-[18px] min-w-[18px] items-center justify-center rounded-[5px] bg-accent px-1 font-mono text-[10.5px] font-semibold text-accent-ink">{pendingCount}</span>
                  )}
                </span>
              </button>
            ))}
          </GlassPill>
        </div>

        <div className="ml-auto flex items-center gap-4">
          <NotificationBell />
          <GoogleStatus />
          <ProfileButton />
          <span title={`${live}/3 services live. Offline services use demo data.`} className="no-drag flex items-center gap-1.5">
            {(Object.keys(health) as ServiceName[]).map(s => (
              <span key={s} title={`${s}: ${health[s] ? "live" : "demo data"}`} className={`h-1.5 w-1.5 rounded-full ${health[s] ? "bg-accent" : "bg-white/20"}`} />
            ))}
          </span>
        </div>
      </header>

      <main className="relative z-10 flex-1 overflow-y-auto">
        <AnimatePresence mode="wait">
          <motion.div key={screen} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.25, ease: "easeOut" }}
            className="mx-auto max-w-[1120px] px-10 pt-10 pb-24">
            {screen === "dashboard" && <Dashboard />}
            {screen === "now" && <Now />}
            {screen === "activity" && <Activity />}
            {screen === "approve" && <Approve />}
            {screen === "workflow" && <Workflow />}
            {screen === "knowledge" && <Knowledge />}
          </motion.div>
        </AnimatePresence>
      </main>
      <AnimatePresence>{screen === "dashboard" && !focusTask && <AskBar key="ask" />}</AnimatePresence>
      {/* Drag area for the floating hand-off button: everything below the top bar, with a small margin. */}
      <div ref={dragArea} aria-hidden className="pointer-events-none absolute inset-x-4 top-[88px] bottom-4" />
      {!focusTask && <FloatingHandoff bounds={dragArea} onOpen={() => openCommand()} />}
      <AnimatePresence>{focusTask && <Focus />}</AnimatePresence>
      <CommandBar />
      <ProfilePanel />
    </>
  );
}

/** Minimal window buttons for the frameless window. Close/minimize zoom back into the orb. */
function WindowControls() {
  const btn = "no-drag flex h-8 w-8 items-center justify-center rounded-full text-muted transition-colors duration-150 hover:bg-white/[0.06] hover:text-ink";
  return (
    <div className="absolute top-[26px] right-5 z-30 flex items-center gap-1">
      <button aria-label="Minimize" className={btn} onClick={() => window.northstar?.winMin()}>
        <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 6h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
      </button>
      <button aria-label="Maximize" className={btn} onClick={() => window.northstar?.winMax()}>
        <svg width="12" height="12" viewBox="0 0 12 12"><rect x="2.2" y="2.2" width="7.6" height="7.6" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>
      </button>
      <button aria-label="Close" className={`${btn} hover:bg-danger/80 hover:text-white`} onClick={() => window.northstar?.winClose()}>
        <svg width="12" height="12" viewBox="0 0 12 12"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
      </button>
    </div>
  );
}
