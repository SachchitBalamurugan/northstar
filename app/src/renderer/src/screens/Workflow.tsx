// Workflow: one place for the day-to-day streams. Sub-tabs: Inbox · Calendar · Discover.
import { AnimatePresence, motion } from "framer-motion";
import { Inbox as InboxIcon, CalendarDays, Compass } from "lucide-react";
import { useUI, type WorkflowTab } from "@/store";
import { Heading, Lead } from "@/components/ui";
import Inbox from "./Inbox";
import CalendarApp from "./calendar/CalendarApp";

const TABS: { id: WorkflowTab; label: string; Icon: typeof InboxIcon }[] = [
  { id: "inbox", label: "Inbox", Icon: InboxIcon },
  { id: "calendar", label: "Calendar", Icon: CalendarDays },
  { id: "discover", label: "Discover", Icon: Compass },
];

export default function Workflow() {
  const { workflowTab, openWorkflow } = useUI();

  return (
    <div>
      {/* Sub-tab switcher */}
      <div className="mb-10 flex items-center gap-1 rounded-full border-[0.8px] border-line bg-white/[0.03] p-1 w-fit">
        {TABS.map(({ id, label, Icon }) => (
          <button key={id} onClick={() => openWorkflow(id)}
            className={`no-drag relative flex h-9 items-center gap-2 rounded-full px-4 text-[14px] font-medium transition-colors duration-200 ${workflowTab === id ? "text-ink" : "text-muted hover:text-ink"}`}>
            {workflowTab === id && <motion.span layoutId="workflow-tab" transition={{ duration: 0.28, ease: "easeOut" }} className="absolute inset-0 rounded-full bg-white/10" />}
            <Icon size={15} className="relative" />
            <span className="relative">{label}</span>
          </button>
        ))}
      </div>

      <AnimatePresence mode="wait">
        <motion.div key={workflowTab} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.2, ease: "easeOut" }}>
          {workflowTab === "inbox" && <Inbox />}
          {workflowTab === "calendar" && <CalendarApp />}
          {workflowTab === "discover" && <DiscoverTab />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

/* ---------------- Discover (placeholder: function to be specified) ---------------- */

function DiscoverTab() {
  return (
    <div>
      <Heading eyebrow="Discover">Something new<br />is coming here.</Heading>
      <Lead className="max-w-[46ch]">Discover is being set up. Check back soon.</Lead>
      <div className="mt-10 flex h-[260px] items-center justify-center rounded-[18px] border-[0.8px] border-dashed border-line">
        <Compass size={28} className="text-faint" />
      </div>
    </div>
  );
}
