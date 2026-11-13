import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { getAuthUrl, remember } from "@/api";
import { useUI } from "@/store";
import { Heading, PrimaryButton, TextLink, Why } from "@/components/ui";

export default function Onboarding() {
  const finishOnboarding = useUI(s => s.finishOnboarding);
  const [step, setStep] = useState(0);
  const [goals, setGoals] = useState("");
  const [busy, setBusy] = useState(false);
  const next = () => setStep(s => Math.min(2, s + 1));

  const connect = async () => {
    setBusy(true);
    const { url } = await getAuthUrl();
    if (url) { if (window.northstar) window.northstar.openExternal(url); else window.open(url); }
    setBusy(false); next();
  };

  const saveGoals = async () => {
    setBusy(true);
    if (goals.trim()) await remember(goals.trim(), ["goals"]);
    setBusy(false); next();
  };

  return (
    <div className="drag flex h-full items-center justify-center bg-bg px-12">
      <div className="no-drag w-full max-w-[560px]">
        <div className="mb-12 flex gap-2" aria-label={`Step ${step + 1} of 3`}>
          {[0, 1, 2].map(i => (
            <span key={i} className={`h-1.5 w-1.5 rounded-full transition-colors duration-200 ${i <= step ? "bg-ink" : "bg-line"}`} />
          ))}
        </div>
        <AnimatePresence mode="wait">
          <motion.div key={step} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2, ease: "easeOut" }}>
            {step === 0 && (
              <>
                <Heading>Hand off the<br />busywork.</Heading>
                <Why>Northstar reads your mail and calendar, plans your week, and asks before it acts.</Why>
                <div className="mt-10 flex items-center gap-6">
                  <PrimaryButton onClick={connect} disabled={busy}>Connect Google</PrimaryButton>
                  <TextLink onClick={next}>Skip for now</TextLink>
                </div>
              </>
            )}
            {step === 1 && (
              <>
                <Heading>What matters<br />this semester?</Heading>
                <textarea autoFocus value={goals} onChange={e => setGoals(e.target.value)} rows={4}
                  placeholder="Land an internship. Keep my GPA up. Sleep before 1am."
                  className="w-full resize-none bg-transparent font-serif text-[24px] leading-[1.45] text-ink outline-none placeholder:text-muted" />
                <div className="mt-8"><PrimaryButton onClick={saveGoals} disabled={busy}>Continue</PrimaryButton></div>
              </>
            )}
            {step === 2 && (
              <>
                <Heading>You're set.</Heading>
                <Why>Your first suggestions arrive in a minute.</Why>
                <div className="mt-10"><PrimaryButton onClick={finishOnboarding}>Open Northstar</PrimaryButton></div>
              </>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
