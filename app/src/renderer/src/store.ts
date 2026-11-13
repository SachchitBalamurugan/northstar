import { create } from "zustand";

export type Screen = "now" | "approve" | "inbox" | "knowledge";

interface UIState {
  screen: Screen; setScreen: (s: Screen) => void;
  focusTask: { title: string; minutes: number } | null; startFocus: (t: { title: string; minutes: number }) => void; endFocus: () => void;
  commandOpen: boolean; commandPrefill: string; openCommand: (prefill?: string) => void; closeCommand: () => void;
  onboarded: boolean; finishOnboarding: () => void;
  pendingCount: number; setPendingCount: (n: number) => void;
}

const ONB_KEY = "ns.onboarded";
const readOnb = () => { try { return localStorage.getItem(ONB_KEY) === "1"; } catch { return false; } };

export const useUI = create<UIState>((set) => ({
  screen: "now", setScreen: (screen) => set({ screen }),
  focusTask: null, startFocus: (focusTask) => set({ focusTask }), endFocus: () => set({ focusTask: null }),
  commandOpen: false, commandPrefill: "", openCommand: (commandPrefill = "") => set({ commandOpen: true, commandPrefill }), closeCommand: () => set({ commandOpen: false, commandPrefill: "" }),
  onboarded: readOnb(), finishOnboarding: () => { try { localStorage.setItem(ONB_KEY, "1"); } catch {} set({ onboarded: true }); },
  pendingCount: 0, setPendingCount: (pendingCount) => set({ pendingCount }),
}));
