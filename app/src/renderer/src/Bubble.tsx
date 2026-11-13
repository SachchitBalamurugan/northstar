// Floating desktop bubble (Clicky-style). Lives at the top of the screen, always on top.
// Drag to move it anywhere. Click to open/close Northstar. Right-click to hand off a task.
import { useEffect, useRef, useState } from "react";
import { getPendingProposals } from "./api";

export default function Bubble() {
  const [count, setCount] = useState(0);
  const [hover, setHover] = useState(false);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ offX: number; offY: number; sx: number; sy: number; moved: boolean } | null>(null);

  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    const tick = async () => setCount((await getPendingProposals()).length);
    tick(); const t = setInterval(tick, 15000);
    return () => clearInterval(t);
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
    <div className="flex h-screen w-screen items-center justify-center select-none" style={{ background: "transparent" }}>
      <button
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
        onContextMenu={(e) => { e.preventDefault(); window.northstar?.bubbleCommand(); }}
        onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
        title="Northstar: click to open · drag to move · right-click to hand off a task"
        className="relative h-[52px] w-[52px] rounded-full outline-none"
        style={{ cursor: dragging ? "grabbing" : "pointer", transform: `scale(${dragging ? 1.08 : hover ? 1.05 : 1})`, transition: "transform 160ms ease-out" }}>
        {/* glow */}
        <span className="absolute -inset-1 rounded-full opacity-70 blur-[8px]"
          style={{ background: "conic-gradient(from 0deg,#FF8A3D,#FF3DA5,#8B5CF6,#3B82F6,#22D3EE,#FF8A3D)", animation: "ns-spin 6s linear infinite" }} />
        {/* iridescent ring */}
        <span className="absolute inset-0 rounded-full p-[2px]"
          style={{ background: "conic-gradient(from 0deg,#FF8A3D,#FF3DA5,#8B5CF6,#3B82F6,#22D3EE,#FF8A3D)", animation: "ns-spin 6s linear infinite" }}>
          <span className="block h-full w-full rounded-full bg-black" />
        </span>
        {/* inner orb */}
        <span className="absolute inset-[7px] rounded-full"
          style={{ background: "radial-gradient(circle at 35% 30%, #ffffff 0%, #FFB37A 18%, #FF3DA5 45%, #8B5CF6 70%, #1e1b4b 100%)", boxShadow: "inset 0 0 10px rgba(0,0,0,.5)", animation: "ns-breathe 4s ease-in-out infinite" }} />
        {count > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex h-[19px] min-w-[19px] items-center justify-center rounded-full border-2 border-black bg-white px-1 text-[10.5px] font-semibold text-black">
            {count}
          </span>
        )}
      </button>
    </div>
  );
}
