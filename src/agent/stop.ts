import type { StopConfig, StopReason } from "./types.js";

export interface StopState {
  startedAtMs: number;
  actionCount: number;
  lastHash?: string;
  consecutiveHash: number;
}

export function newStopState(nowMs: number): StopState {
  return { startedAtMs: nowMs, actionCount: 0, consecutiveHash: 0 };
}

/** Record a post-action observation hash. Returns a stop reason when the same screen repeats. */
export function noteSnapshot(state: StopState, hash: string, limit: number): StopReason | null {
  if (state.lastHash === hash) {
    state.consecutiveHash += 1;
  } else {
    state.lastHash = hash;
    state.consecutiveHash = 1;
  }
  if (state.consecutiveHash >= limit) {
    return { kind: "repeated_state", hash, count: state.consecutiveHash };
  }
  return null;
}

export function checkBudget(state: StopState, config: StopConfig, nowMs: number): StopReason | null {
  const elapsedMs = nowMs - state.startedAtMs;
  if (elapsedMs >= config.timeoutMs) return { kind: "timeout", elapsedMs };
  if (state.actionCount >= config.maxSteps) return { kind: "max_steps", steps: state.actionCount };
  return null;
}

export function isTerminal(reason: StopReason): boolean {
  return reason.kind !== "declared_done";
}
