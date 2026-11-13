// Floating desktop bubble (Clicky-style). One clean orb, always on top.
// Drag to move. Click to open/close Northstar. Right-click to hand off a task.
import { useEffect, useRef, useState } from "react";

export default function Bubble() {
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ offX: number; offY: number; sx: number; sy: number; moved: boolean } | null>(null);

  useEffect(() => {
    for (const el of [document.documentElement, document.body, document.getElementById("root")!]) {
      el.style.background = "transparent";
      el.style.overflow = "hidden";
      el.style.margin = "0";
    }
  }, []);

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = { offX: e.clientX, offY: e.clientY, sx: e.screenX, sy: e.screenY, moved: false };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current; if (!d) return;
    if (!d.moved && Math.hypot(e.screenX - d.sx, e.screenY - d.sy) > 4) { d.moved = true; setDragging(true); }
    if (d.moved) window.northstar?.bubbleMove(e.screenX - d.offX, e.screenY - d.offY);
  };
  const onUp = () => {
    const d = drag.current; drag.current = null; setDragging(false);
    if (d && !d.moved) window.northstar?.bubbleClick();
  };

  return (
    <div style={{ position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", background: "transparent" }}>
      <div
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
        onContextMenu={(e) => { e.preventDefault(); window.northstar?.bubbleCommand(); }}
        title="Northstar: click to open · drag to move · right-click to hand off a task"
        style={{
          width: 48, height: 48, borderRadius: "50%", cursor: dragging ? "grabbing" : "pointer", userSelect: "none",
          background: "radial-gradient(circle at 34% 28%, #FFFFFF 0%, #FFC48A 16%, #FF5FA8 42%, #8B5CF6 70%, #2B2A8F 100%)",
          boxShadow: "0 0 14px rgba(255,95,168,.55), 0 0 4px rgba(139,92,246,.6), inset 0 -4px 10px rgba(0,0,0,.35)",
          transform: `scale(${dragging ? 1.06 : 1})`, transition: "transform 150ms ease-out",
        }}
      />
    </div>
  );
}
