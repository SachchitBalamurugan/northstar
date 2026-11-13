// "Pick up where you left off": one gentle prompt at a time, with the single next step.
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { History } from "lucide-react";
import { getResume, resumeDone, resumeSnooze, type ResumeItem } from "@/assistApi";
import { useUI } from "@/store";
import { Card, Eyebrow, SecondaryButton, TextLink, relTime } from "@/components/ui";

export default function ResumeWork() {
  const startFocus = useUI(s => s.startFocus);
  const [items, setItems] = useState<ResumeItem[]>([]);

  useEffect(() => {
    let alive = true;
    getResume().then(r => alive && setItems(r));
    return () => { alive = false; };
  }, []);

  const item = items[0];
  const drop = (id: string) => setItems(list => list.filter(r => r.id !== id));
  const later = (r: ResumeItem) => { drop(r.id); resumeSnooze(r.id); };
  const finished = (r: ResumeItem) => { drop(r.id); resumeDone(r.id); };

  return (
    <AnimatePresence mode="wait" initial={false}>
      {item && (
        <motion.div key={item.id} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
          <Card className="p-6">
            <div className="mb-3 flex items-center gap-2 text-faint">
              <History size={14} />
              <Eyebrow>Pick up where you left off</Eyebrow>
              {item.lastTouched && <span className="ml-auto text-[12px] tabular-nums">{relTime(item.lastTouched)}</span>}
            </div>
            <p className="text-[17px] font-medium text-ink">{item.project}</p>
            <p className="mt-1 text-[14px] leading-relaxed text-muted">{item.whereYouStopped}</p>
            <div className="mt-4 border-l border-accent pl-4">
              <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-faint">Next step</p>
              <p className="mt-0.5 text-[15px] text-warm">{item.nextStep}</p>
            </div>
            {item.why && <p className="mt-3 text-[13px] leading-relaxed text-faint">{item.why}</p>}
            <div className="mt-5 flex items-center gap-5">
              <SecondaryButton onClick={() => startFocus({ title: item.nextStep, minutes: 25 })} className="h-10 text-[14px]">Start</SecondaryButton>
              <TextLink onClick={() => later(item)}>Later</TextLink>
              <TextLink onClick={() => finished(item)}>Done</TextLink>
            </div>
          </Card>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
