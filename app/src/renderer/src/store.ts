import { create } from "zustand";

export type Screen = "dashboard" | "now" | "approve" | "workflow" | "knowledge";
export type WorkflowTab = "inbox" | "calendar" | "discover";

interface UIState {
  screen: Screen; setScreen: (s: Screen) => void;
  workflowTab: WorkflowTab; openWorkflow: (t: WorkflowTab) => void;
  focusTask: { title: string; minutes: number } | null; startFocus: (t: { title: string; minutes: number }) => void; endFocus: () => void;
  commandOpen: boolean; commandPrefill: string; openCommand: (prefill?: string) => void; closeCommand: () => void;
  onboarded: boolean; finishOnboarding: () => void;
  pendingCount: number; setPendingCount: (n: number) => void;
  /** Questions typed into the dashboard's floating input. The chat screen (not built yet) will pick these up. */
  chatQueue: string[]; askChat: (q: string) => void;
}

const ONB_KEY = "ns.onboarded";
const readOnb = () => { try { return localStorage.getItem(ONB_KEY) === "1"; } catch { return false; } };

export const useUI = create<UIState>((set) => ({
  screen: "dashboard", setScreen: (screen) => set({ screen }),
  workflowTab: "inbox", openWorkflow: (workflowTab) => set({ screen: "workflow", workflowTab }),
  focusTask: null, startFocus: (focusTask) => set({ focusTask }), endFocus: () => set({ focusTask: null }),
  commandOpen: false, commandPrefill: "", openCommand: (commandPrefill = "") => set({ commandOpen: true, commandPrefill }), closeCommand: () => set({ commandOpen: false, commandPrefill: "" }),
  onboarded: readOnb(), finishOnboarding: () => { try { localStorage.setItem(ONB_KEY, "1"); } catch {} set({ onboarded: true }); },
  pendingCount: 0, setPendingCount: (pendingCount) => set({ pendingCount }),
  chatQueue: [], askChat: (q) => set((s) => ({ chatQueue: [...s.chatQueue, q] })),
}));
