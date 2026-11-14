// App-local types that extend or sit beside contracts/types.ts (which this folder does not own).
import type { SidekickStep } from "@contracts/types";

/** A Sidekick stream step. The actions service may attach the run and (when it pauses) the proposal to approve. */
export interface TaskCheckpoint {
  id: string;
  kind: "plan" | "submit" | "payment" | "signin" | "question";
  title: string; detail: string;
  steps?: string[]; finalAction?: string | null;
}
export type AskStep = SidekickStep & { runId?: string; proposalId?: string; checkpoint?: TaskCheckpoint };

export interface RunStep { step: number; action: string; detail: string; at: string }
export interface Run {
  id: string; kind: "sidekick" | "fill"; instruction: string;
  status: "running" | "done" | "stopped" | "error"; startedAt: string; endedAt?: string;
  steps: RunStep[]; lastDetail: string; proposalId?: string; url?: string;
}
