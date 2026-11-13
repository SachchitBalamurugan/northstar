import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CalendarDays, FileText, Mail, StickyNote } from "lucide-react";
import { getAuthUrl, remember } from "@/api";
import { useUI } from "@/store";
import { AppChip, Eyebrow, Heading, Lead, LogoMark, PrimaryButton, SecondaryButton, Window } from "@/components/ui";
import Orb from "@/three/Orb";
import Wormhole from "@/three/Wormhole";

const FLOATERS = [
  { label: "Emails", icon: <Mail size={16} className="text-[#7AA7FF]" />, pos: "left-[8%] top-[22%]", rot: -8, delay: 0 },
  { label: "Calendar", icon: <CalendarDays size={16} className="text-[#FFB27A]" />, pos: "right-[9%] top-[18%]", rot: 6, delay: 0.8 },
  { label: "Applications", icon: <FileText size={16} className="text-[#FF8CCB]" />, pos: "left-[12%] bottom-[20%]", rot: 5, delay: 1.4 },
  { label: "Notes", icon: <StickyNote size={16} className="text-[#B9A2FF]" />, pos: "right-[11%] bottom-[24%]", rot: -6, delay: 0.4 },
];

export default function Onboarding() {
  const finishOnboarding = useUI(s => s.finishOnboarding);
  const { userName, setUserName } = useUI();
  const [name, setName] = useState(userName);
  const [step, setStep] = useState(userName ? 1 : 0); // 0 = name, 1 = connect, 2 = goals, 3 = done
  const [goals, setGoals] = useState("");
  const [busy, setBusy] = useState(false);
  const next = () => setStep(s => Math.min(3, s + 1));
  const saveName = () => { if (name.trim()) setUserName(name); next(); };

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
    <div className="drag relative flex h-full items-center justify-center overflow-hidden bg-black px-12">
      <div aria-hidden className="pointer-events-none absolute inset-0" style={{ opacity: 0.55 }}><Wormhole /></div>
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(0,0,0,0.35)_0%,rgba(0,0,0,0.75)_55%,#000_100%)]" />

      <AnimatePresence>
        {step === 1 && FLOATERS.map(f => (
          <motion.div key={f.label} className={`absolute hidden lg:block ${f.pos}`}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.5, delay: f.delay * 0.3 }}>
            <motion.div style={{ rotate: f.rot }} animate={{ y: [0, -10, 0] }}
              transition={{ duration: 6, repeat: Infinity, ease: "easeInOut", delay: f.delay }}>
              <AppChip icon={f.icon} label={f.label} />
            </motion.div>
          </motion.div>
        ))}
      </AnimatePresence>

      <div className="no-drag relative z-10 flex w-full max-w-[640px] flex-col items-center text-center">
        <LogoMark size={44} />
        <Eyebrow className="mt-5 mb-8 tabular-nums">{String(step + 1).padStart(2, "0")} / 04</Eyebrow>
        <AnimatePresence mode="wait">
          <motion.div key={step} className="flex w-full flex-col items-center"
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.35, ease: "easeOut" }}>
            {step === 0 && (
              <>
                <Heading className="text-center">What should I<br />call <span className="text-glow">you?</span></Heading>
                <Window className="w-full text-left" bodyClassName="p-6">
                  <input autoFocus value={name} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && name.trim()) saveName(); }}
                    placeholder="Your name" aria-label="Your name" maxLength={80}
                    className="display w-full border-0 bg-transparent text-[26px] tracking-[-0.02em] text-ink outline-none placeholder:text-faint" />
                </Window>
                <div className="mt-8"><PrimaryButton onClick={saveName} disabled={!name.trim()}>Continue</PrimaryButton></div>
              </>
            )}
            {step === 1 && (
              <>
                <Heading size="xl" className="text-center">Hand off the<br />busywork.</Heading>
                <Lead className="-mt-4 max-w-[460px]">Northstar reads your mail and calendar, plans your week, and asks before it acts.</Lead>
                <div className="mt-10 flex items-center gap-3">
                  <PrimaryButton onClick={connect} disabled={busy}>Connect Google</PrimaryButton>
                  <SecondaryButton onClick={next}>Skip for now</SecondaryButton>
                </div>
              </>
            )}
            {step === 2 && (
              <>
                <Heading className="text-center">What matters<br />this <span className="text-glow">semester?</span></Heading>
                <Window className="w-full text-left" bodyClassName="p-6">
                  <textarea autoFocus value={goals} onChange={e => setGoals(e.target.value)} rows={4}
                    placeholder="Land an internship. Keep my GPA up. Sleep before 1am."
                    className="display w-full resize-none border-0 bg-transparent text-[22px] leading-[1.45] tracking-[-0.02em] text-ink outline-none placeholder:text-faint" />
                </Window>
                <div className="mt-8"><PrimaryButton onClick={saveGoals} disabled={busy}>Continue</PrimaryButton></div>
              </>
            )}
            {step === 3 && (
              <>
                <div className="-mt-4 mb-2"><Orb size={300} /></div>
                <Heading className="text-center">You're set{userName ? `, ${userName.trim().split(/\s+/)[0]}` : ""}.</Heading>
                <Lead className="-mt-6 max-w-[440px]">Northstar is catching up on your inbox. Your first plan is ready in a minute.</Lead>
                <div className="mt-10"><PrimaryButton onClick={finishOnboarding}>Open Northstar</PrimaryButton></div>
              </>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
