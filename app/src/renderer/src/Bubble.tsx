// Floating desktop bubble (Clicky-style). One animated orb, always on top.
// Pops in on launch, swirls and breathes while idle, squishes on press, springs on release.
// Drag to move. Click to open/close Northstar. Right-click to hand off a task.
import { useEffect, useRef, useState } from "react";
import { motion, useAnimationControls } from "framer-motion";

const SWIRL = "conic-gradient(from 0deg, #FF8A3D, #FF3DA5, #8B5CF6, #3B82F6, #22D3EE, #FF8A3D)";

export default function Bubble() {
  const [dragging, setDragging] = useState(false);
  const [hover, setHover] = useState(false);
  const press = useAnimationControls();
  const drag = useRef<{ offX: number; offY: number; sx: number; sy: number; moved: boolean } | null>(null);

  useEffect(() => {
    for (const el of [document.documentElement, document.body, document.getElementById("root")!]) {
      el.style.background = "transparent"; el.style.overflow = "hidden"; el.style.margin = "0";
    }
    // Pop in on launch: scale up from nothing with a soft overshoot.
    press.set({ scale: 0, opacity: 0, rotate: -40 });
    press.start({ scale: 1, opacity: 1, rotate: 0, transition: { type: "spring", stiffness: 260, damping: 16, mass: 0.9, delay: 0.15 } });
    // Never leave the orb invisible: if the pop-in animation was paused (window throttled), show it anyway.
    const t = setTimeout(() => press.set({ scale: 1, opacity: 1, rotate: 0 }), 2000);
    return () => clearTimeout(t);
  }, []);

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    drag.current = { offX: e.clientX, offY: e.clientY, sx: e.screenX, sy: e.screenY, moved: false };
    press.start({ scale: 0.86, transition: { type: "spring", stiffness: 600, damping: 30 } });
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current; if (!d) return;
    if (!d.moved && Math.hypot(e.screenX - d.sx, e.screenY - d.sy) > 4) {
      d.moved = true; setDragging(true);
      press.start({ scale: 1.08, transition: { type: "spring", stiffness: 500, damping: 26 } });
    }
    if (d.moved) window.northstar?.bubbleMove(e.screenX - d.offX, e.screenY - d.offY);
  };
  const onUp = () => {
    const d = drag.current; drag.current = null; setDragging(false);
    // Release: spring back past 1 then settle (the "pop").
    press.start({ scale: [null, 1.12, 1], transition: { duration: 0.42, times: [0, 0.45, 1], ease: [0.22, 1, 0.36, 1] } });
    if (d && !d.moved) window.northstar?.bubbleClick();
  };

  return (
    <div style={{ position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", background: "transparent" }}>
      <motion.div animate={press} style={{ width: 48, height: 48, position: "relative" }}>
        {/* Idle breathing + gentle float */}
        <motion.div
          animate={{ scale: hover && !dragging ? 1.07 : [1, 1.045, 1], y: dragging ? 0 : [0, -1.5, 0] }}
          transition={hover && !dragging ? { type: "spring", stiffness: 300, damping: 20 } : { duration: 3.6, repeat: Infinity, ease: "easeInOut" }}
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
          onHoverStart={() => setHover(true)} onHoverEnd={() => setHover(false)}
          onContextMenu={(e) => { e.preventDefault(); window.northstar?.bubbleCommand(); }}
          title="Northstar: click to open · drag to move · right-click to hand off a task"
          style={{
            position: "absolute", inset: 0, borderRadius: "50%", overflow: "hidden", userSelect: "none",
            cursor: dragging ? "grabbing" : "pointer",
            boxShadow: hover
              ? "0 0 18px rgba(255,95,168,.75), 0 0 6px rgba(139,92,246,.8)"
              : "0 0 12px rgba(255,95,168,.5), 0 0 4px rgba(139,92,246,.6)",
            transition: "box-shadow 220ms ease-out",
          }}>
          {/* Swirling color field (rotates, oversized so edges never show) */}
          <motion.div
            animate={{ rotate: 360 }}
            transition={{ duration: hover ? 3.5 : 9, repeat: Infinity, ease: "linear" }}
            style={{ position: "absolute", inset: "-25%", background: SWIRL, filter: "blur(6px)" }}
          />
          {/* Depth: darker rim, soft core */}
          <div style={{ position: "absolute", inset: 0, borderRadius: "50%", background: "radial-gradient(circle at 50% 55%, rgba(255,255,255,0) 35%, rgba(20,10,60,.55) 100%)" }} />
          {/* Glossy highlight that drifts slightly */}
          <motion.div
            animate={{ x: [0, 2, 0], y: [0, 1.5, 0], opacity: [0.85, 1, 0.85] }}
            transition={{ duration: 5, repeat: Infinity, ease: "easeInOut" }}
            style={{ position: "absolute", left: "16%", top: "12%", width: "42%", height: "34%", borderRadius: "50%",
              background: "radial-gradient(circle, rgba(255,255,255,.95) 0%, rgba(255,255,255,0) 70%)", filter: "blur(1px)" }}
          />
        </motion.div>
      </motion.div>
    </div>
  );
}
