// Mac-notch / Dynamic-Island widget at the top-center of the screen.
// On a MacBook with a camera notch it lives in the real notch: collapsed it is hidden behind the cutout (hover the
// notch to open) and the panel grows out of it. Elsewhere: a drawn 220x10 black pill. Expanded: 460x340 of content
// (plus the notch height on a notched Mac). The main process resizes the window.
// Touch to open: the camera sits in the notch, so covering it with a finger turns its picture dark. The widget
// watches for that and opens (touch again to close). Frames are averaged to one brightness number here and dropped.
import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowUpRight, CornerDownLeft } from "lucide-react";
import { getInsights, getEventsBetween, getPendingProposals, runSidekick } from "./api";
import type { CalEventFull } from "./api";
import { getBrief } from "./briefApi";
import type { Brief } from "./briefApi";
import { useProfile, firstName } from "./profile";
import type { Insights } from "@contracts/types";

interface Geometry { hardware: boolean; width: number; height: number; touch?: boolean }
const DRAWN: Geometry = { hardware: false, width: 220, height: 10, touch: false };
const PANEL = { width: 460, height: 340 };

const bridge = () => (window as any).northstar as
  | {
      notchExpand?: () => void; notchCollapse?: () => void; notchOpenMain?: (s: string) => void;
      notchGeometry?: () => Geometry; onNotchGeometry?: (cb: (g: Geometry) => void) => () => void;
      cameraAccess?: () => Promise<boolean>;
    }
  | undefined;

/* ---------- touch the camera to open ---------- */
type TouchState = "off" | "starting" | "watching" | "denied" | "unavailable";
const SAMPLE_MS = 120, SW = 32, SH = 24;
const DARK_MAX = 60;      // a covered lens is never brighter than this (0-255), even with a finger glowing red in sunlight
const DARK_RATIO = 0.45;  // ...and is under 45% of what the room looked like just before
const CLEAR_RATIO = 0.7;  // the finger is gone once brightness is back to 70% of the room

/** Calls onTouch once each time the camera goes from seeing the room to covered. A dark room never triggers. */
function useCameraTouch(enabled: boolean, onTouch: () => void): TouchState {
  const [state, setState] = useState<TouchState>("off");
  const cb = useRef(onTouch); cb.current = onTouch;
  useEffect(() => {
    if (!enabled) { setState("off"); return; }
    let stopped = false, stream: MediaStream | null = null, timer = 0;
    const video = document.createElement("video"); video.muted = true; video.playsInline = true;
    const canvas = document.createElement("canvas"); canvas.width = SW; canvas.height = SH;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    setState("starting");
    (async () => {
      if (!ctx || !navigator.mediaDevices?.getUserMedia) { setState("unavailable"); return; }
      if ((await bridge()?.cameraAccess?.()) === false) { setState("denied"); return; }
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { width: 320, height: 240, frameRate: 10 } });
      if (stopped) { stream.getTracks().forEach((t) => t.stop()); return; }
      video.srcObject = stream; await video.play();
      setState("watching");
      let room = -1, darkFrames = 0, covered = false;
      timer = window.setInterval(() => {
        if (video.readyState < 2) return;
        ctx.drawImage(video, 0, 0, SW, SH);
        const px = ctx.getImageData(0, 0, SW, SH).data;
        let sum = 0;
        for (let i = 0; i < px.length; i += 4) sum += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
        const luma = sum / (SW * SH);
        if (room < 0) { room = luma; return; }
        if (covered) { // wait for the finger to lift before listening for the next touch
          if (luma > room * CLEAR_RATIO) { covered = false; darkFrames = 0; }
          return;
        }
        if (luma < DARK_MAX && luma < room * DARK_RATIO) {
          if (++darkFrames >= 2) { covered = true; cb.current(); } // two frames in a row: not a flicker
        } else { darkFrames = 0; room += (luma - room) * 0.1; } // follow slow changes in room light
      }, SAMPLE_MS);
    })().catch((e: any) => {
      if (!stopped) setState(e?.name === "NotAllowedError" ? "denied" : "unavailable");
    });
    return () => {
      stopped = true; clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop()); video.srcObject = null;
    };
  }, [enabled]);
  return state;
}

interface Data { insights: Insights | null; events: CalEventFull[]; brief: Brief | null; pending: number }

const greeting = (d: Date) => { const h = d.getHours(); return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"; };
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const firstSentence = (s: string) => (s.match(/^.*?[.!?](\s|$)/)?.[0] ?? s).trim();

function Skel({ w = "100%" }: { w?: string }) {
  return <div className="h-[9px] rounded-full bg-white/10 animate-pulse my-[5px]" style={{ width: w }} />;
}

function Section({ label, children, onClick }: { label: string; children: React.ReactNode; onClick?: () => void }) {
  return (
    <div onClick={onClick} className={`min-w-0 ${onClick ? "cursor-pointer rounded-lg -mx-1.5 px-1.5 py-0.5 hover:bg-white/5 transition-colors" : ""}`}>
      <div className="text-[10px] uppercase tracking-[0.08em] text-faint mb-0.5">{label}</div>
      {children}
    </div>
  );
}

export default function Notch() {
  const profile = useProfile((s) => s.profile);
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(new Date());
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(false);
  const [task, setTask] = useState("");
  const [step, setStep] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const leaveTimer = useRef<number | null>(null);
  const [geo, setGeo] = useState<Geometry>(() => { try { return bridge()?.notchGeometry?.() ?? DRAWN; } catch { return DRAWN; } });
  useEffect(() => bridge()?.onNotchGeometry?.(setGeo), []);
  // Content starts below the hardware cutout; the panel is that much taller.
  const inset = geo.hardware ? geo.height : 0;
  const closed = { scaleX: geo.width / PANEL.width, scaleY: geo.height / (PANEL.height + inset) };

  useEffect(() => {
    for (const el of [document.documentElement, document.body, document.getElementById("root")]) {
      if (!el) continue;
      el.style.background = "transparent"; el.style.overflow = "hidden"; el.style.margin = "0";
    }
  }, []);

  useEffect(() => { const t = window.setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);

  const load = useCallback(async () => {
    setLoading((l) => l || !data);
    const start = new Date();
    const end = new Date(); end.setHours(23, 59, 59, 999);
    const [insights, events, brief, pending] = await Promise.all([
      getInsights().catch(() => null),
      getEventsBetween(start, end).catch(() => [] as CalEventFull[]),
      getBrief().catch(() => null),
      getPendingProposals().then((p) => p.length).catch(() => 0),
    ]);
    const upcoming = events.filter((e) => new Date(e.end) > new Date()).sort((a, b) => +new Date(a.start) - +new Date(b.start)).slice(0, 3);
    setData({ insights, events: upcoming, brief, pending });
    setLoading(false);
  }, [data]);

  useEffect(() => {
    if (!expanded) return;
    load();
    const t = window.setInterval(load, 60_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  const clearLeave = () => { if (leaveTimer.current) { clearTimeout(leaveTimer.current); leaveTimer.current = null; } };

  const expand = () => {
    clearLeave();
    if (expanded) return;
    bridge()?.notchExpand?.();
    setExpanded(true);
  };
  const collapse = useCallback(() => { clearLeave(); setExpanded(false); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") collapse(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [collapse]);
  useEffect(() => () => clearLeave(), []);

  const onLeave = () => { clearLeave(); leaveTimer.current = window.setTimeout(collapse, 700); };

  // A touch on the camera toggles the widget. Opened by touch with the pointer elsewhere, it closes itself after a while.
  const touchState = useCameraTouch(!!geo.touch, () => {
    if (expanded) { collapse(); return; }
    expand();
    leaveTimer.current = window.setTimeout(collapse, 12_000);
  });
  const touchNote = touchState === "denied" ? "Touch to open is off: allow the camera in System Settings > Privacy & Security > Camera, then restart Northstar."
    : touchState === "unavailable" ? "Touch to open is off: the camera could not be started." : "";
  const open = (s: string) => bridge()?.notchOpenMain?.(s);

  const submit = async () => {
    const text = task.trim(); if (!text || running) return;
    setRunning(true); setStep("Starting…"); setTask("");
    try { await runSidekick(text, (s) => setStep(s.detail || s.action)); }
    catch (e: any) { setStep(`Couldn't run: ${e?.message ?? "error"}`); }
    finally { setRunning(false); }
  };

  const name = profile?.name?.trim() ? firstName(profile) : "";
  const next = data?.insights?.nextThing;
  const highs = (data?.brief?.items ?? []).filter((i) => i.importance === "high").slice(0, 2);

  return (
    <div className="fixed inset-0 overflow-hidden flex justify-center items-start font-sans" style={{ background: "transparent" }}>
      <AnimatePresence
        initial={false}
        mode="wait"
        onExitComplete={() => { if (!expanded) bridge()?.notchCollapse?.(); }}
      >
        {!expanded ? (
          <motion.div
            key="pill"
            onMouseEnter={expand}
            onClick={expand}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.05 } }}
            className="rounded-b-[10px] bg-black cursor-pointer"
            style={{
              width: geo.width, height: geo.height,
              // Behind real hardware the pill stays pure black so it is indistinguishable from the cutout.
              boxShadow: geo.hardware ? undefined : "inset 0 -1px 0 rgba(255,255,255,0.12), inset 0 0 0 1px rgba(255,255,255,0.04)",
            }}
          />
        ) : (
          <motion.div
            key="panel"
            onMouseEnter={clearLeave}
            onMouseLeave={onLeave}
            initial={{ ...closed, opacity: geo.hardware ? 1 : 0.6 }}
            animate={{ scaleY: 1, scaleX: 1, opacity: 1, transition: { duration: 0.22, ease: "easeOut" } }}
            exit={{ ...closed, opacity: geo.hardware ? 1 : 0, transition: { duration: 0.18, ease: "easeIn" } }}
            style={{ transformOrigin: "top center", width: PANEL.width, height: PANEL.height + inset, paddingTop: inset }}
            className="rounded-b-[24px] bg-black border border-white/10 border-t-0 shadow-2xl overflow-hidden text-[13px] text-ink"
          >
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0, transition: { delay: 0.12, duration: 0.18 } }}
              exit={{ opacity: 0, transition: { duration: 0.06 } }}
              className="h-full flex flex-col gap-2.5 px-5 pt-3 pb-3.5"
            >
              {/* Top row */}
              <div className="flex items-center justify-between gap-3 min-w-0">
                <div className="min-w-0">
                  <div className="font-medium truncate">{greeting(now)}{name ? `, ${name}` : ""}</div>
                  <div className="text-[11px] text-muted truncate">
                    {now.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" })}
                    <span className="text-faint"> · </span>
                    <span className="tabular-nums">{now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}</span>
                  </div>
                  {touchNote && <div className="text-[10.5px] text-faint truncate" title={touchNote}>{touchNote}</div>}
                </div>
                <button onClick={() => open("dashboard")} className="shrink-0 flex items-center gap-1 text-[11px] text-muted hover:text-ink border border-white/10 rounded-full px-2.5 py-1 transition-colors">
                  Open <ArrowUpRight size={12} />
                </button>
              </div>

              {/* Next up */}
              <Section label="Next up">
                {loading || !data ? (<><Skel w="70%" /><Skel w="90%" /></>) : next ? (
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{next.title}</div>
                      <div className="truncate text-[11.5px] text-muted">{next.why}</div>
                    </div>
                    <button onClick={() => open("now")} className="shrink-0 rounded-full px-3 py-1 text-[11.5px] font-medium text-black" style={{ background: "#E26D45" }}>Start</button>
                  </div>
                ) : <div className="text-faint truncate">Nothing pressing.</div>}
              </Section>

              <div className="grid grid-cols-2 gap-4 min-w-0">
                {/* Today */}
                <Section label="Today">
                  {loading || !data ? (<><Skel w="85%" /><Skel w="75%" /><Skel w="60%" /></>) : data.events.length ? (
                    <div className="space-y-0.5">
                      {data.events.map((e) => (
                        <div key={e.id} className="flex gap-2 min-w-0 text-[12px]">
                          <span className="shrink-0 tabular-nums text-muted w-[54px]">{e.allDay ? "All day" : fmtTime(e.start)}</span>
                          <span className="truncate">{e.title}</span>
                        </div>
                      ))}
                    </div>
                  ) : <div className="text-faint text-[12px]">Clear for the rest of today.</div>}
                </Section>

                {/* Inbox */}
                <Section label="Inbox" onClick={() => open("workflow")}>
                  {loading || !data ? (<><Skel w="90%" /><Skel w="70%" /><Skel w="80%" /></>) : (
                    <div className="space-y-0.5 min-w-0">
                      <div className="truncate text-[12px] text-muted">{data.brief?.summary ? firstSentence(data.brief.summary) : "No brief yet."}</div>
                      {highs.map((i) => (
                        <div key={i.emailId} className="truncate text-[12px]">
                          <span className="text-ink">{i.from.replace(/<.*>/, "").trim()}</span>
                          <span className="text-faint"> · </span>
                          <span className="text-muted">{i.subject}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </Section>
              </div>

              {/* Approvals */}
              <Section label="Approvals">
                {loading || !data ? <Skel w="45%" /> : (
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[12.5px] truncate">
                      {data.pending ? <><span className="font-medium" style={{ color: "#E26D45" }}>{data.pending}</span> waiting on you</> : <span className="text-faint">All caught up</span>}
                    </span>
                    {data.pending > 0 && (
                      <button onClick={() => open("approve")} className="shrink-0 rounded-full border border-white/15 px-3 py-0.5 text-[11.5px] hover:bg-white/10 transition-colors">Review</button>
                    )}
                  </div>
                )}
              </Section>

              {/* Hand off */}
              <div className="mt-auto min-w-0">
                <div className="flex items-center gap-2 rounded-full bg-white/[0.06] border border-white/10 px-3 h-8 focus-within:border-white/25">
                  <input
                    value={task}
                    onChange={(e) => setTask(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") submit(); if (e.key === "Escape") { e.stopPropagation(); collapse(); } }}
                    placeholder="Hand off a task…"
                    disabled={running}
                    className="flex-1 min-w-0 bg-transparent outline-none text-[12.5px] text-ink placeholder:text-faint"
                  />
                  <CornerDownLeft size={13} className="text-faint shrink-0" />
                </div>
                <div className="h-4 mt-1 px-3 text-[11px] text-muted truncate">
                  {step && <>{running && <span className="inline-block w-1.5 h-1.5 rounded-full mr-1.5 align-middle animate-pulse" style={{ background: "#E26D45" }} />}{step}</>}
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
