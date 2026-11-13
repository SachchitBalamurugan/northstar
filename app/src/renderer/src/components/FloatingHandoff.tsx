// Floating "Hand off a task" button. Starts at the bottom of the window, can be dragged anywhere inside it,
// and remembers where the user left it. A drag never counts as a click.
import { useEffect, useRef, type RefObject } from "react";
import { motion, useMotionValue, animate } from "framer-motion";
import { GripVertical } from "lucide-react";
import { Kbd } from "./ui";

const KEY = "ns.handoffPos";

export default function FloatingHandoff({ bounds, onOpen }: { bounds: RefObject<HTMLElement | null>; onOpen: () => void }) {
  const x = useMotionValue(0), y = useMotionValue(0);
  const dragged = useRef(false);

  // Restore saved offset (relative to the default bottom-right spot).
  useEffect(() => {
    try {
      const p = JSON.parse(localStorage.getItem(KEY) || "null");
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) { x.set(p.x); y.set(p.y); }
    } catch { /* ignore */ }
  }, []);

  const save = () => { try { localStorage.setItem(KEY, JSON.stringify({ x: x.get(), y: y.get() })); } catch { /* ignore */ } };
  const reset = () => { animate(x, 0, { type: "spring", stiffness: 300, damping: 30 }); animate(y, 0, { type: "spring", stiffness: 300, damping: 30, onComplete: save }); };

  return (
    <motion.div
      drag dragConstraints={bounds} dragElastic={0.08} dragMomentum={false}
      style={{ x, y }}
      initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1], delay: 0.2 }}
      onDragStart={() => { dragged.current = true; }}
      onDragEnd={() => { save(); setTimeout(() => { dragged.current = false; }, 0); }}
      whileDrag={{ scale: 1.05, cursor: "grabbing" }}
      onDoubleClick={reset}
      className="no-drag absolute right-8 bottom-7 z-40 isolate touch-none select-none"
      title="Drag to move · double-click to reset">
      <span aria-hidden className="cta-glow" />
      <div className="relative flex h-[50px] items-center rounded-full bg-white pr-5 pl-2 text-black shadow-[0_18px_50px_rgba(0,0,0,.55)]">
        <span className="flex h-full cursor-grab items-center px-1.5 text-black/35 active:cursor-grabbing" aria-label="Drag handle">
          <GripVertical size={16} />
        </span>
        <button
          onClick={() => { if (!dragged.current) onOpen(); }}
          className="flex h-full items-center gap-2 text-[14.5px] font-medium tracking-[-0.01em]">
          Hand off a task <Kbd>Ctrl Space</Kbd>
        </button>
      </div>
    </motion.div>
  );
}
