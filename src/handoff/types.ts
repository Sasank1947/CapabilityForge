import type { Actor } from "../evidence/types.js";

export enum ControlState {
  AGENT = "AGENT",
  PAUSED = "PAUSED",
  HUMAN = "HUMAN",
  RESUMING = "RESUMING",
  ABORTED = "ABORTED",
  COMPLETED = "COMPLETED",
}

/** The only legal transitions; anything else is a bug and must throw. */
export const CONTROL_TRANSITIONS: Readonly<Record<ControlState, readonly ControlState[]>> = {
  [ControlState.AGENT]: [ControlState.PAUSED, ControlState.COMPLETED, ControlState.ABORTED],
  [ControlState.PAUSED]: [ControlState.HUMAN, ControlState.RESUMING, ControlState.ABORTED],
  [ControlState.HUMAN]: [ControlState.RESUMING, ControlState.ABORTED],
  [ControlState.RESUMING]: [ControlState.AGENT, ControlState.PAUSED, ControlState.ABORTED],
  [ControlState.ABORTED]: [],
  [ControlState.COMPLETED]: [],
};

export function canTransition(from: ControlState, to: ControlState): boolean {
  return CONTROL_TRANSITIONS[from].includes(to);
}

/** "agent" here covers both the discovery agent and the replay engine. */
export type Controller = Extract<Actor, "agent" | "replay" | "human"> | null;

export interface ControlLease {
  leaseId: string;
  holder: Controller;
  state: ControlState;
  since: string;
}

export type InterventionReason =
  | "irreversible_step_requires_approval"
  | "policy_escalation"
  | "unknown_screen_state"
  | "recovery_exhausted"
  | "artifact_escalate_handler"
  | "agent_requested"
  | "stuck_repeated_state"
  | "max_steps_reached";

export type OperatorAction = "take_control" | "approve" | "hand_back" | "abort";

export type InterventionStatus = "open" | "claimed" | "resolved" | "aborted";

export interface InterventionRequest {
  id: string;
  runId: string;
  createdAt: string;
  source: "discovery" | "replay";
  capabilityId?: string;
  goal?: string;
  stepId?: string;
  stepIntent?: string;
  reason: InterventionReason;
  /** Human-readable, already redacted. */
  message: string;
  screenStateId?: string;
  url: string;
  /** Run-relative path to a redacted screenshot. */
  screenshotPath?: string;
  allowedActions: OperatorAction[];
  status: InterventionStatus;
  resolution?: {
    by: string;
    at: string;
    outcome: "handed_back" | "approved" | "aborted";
    note?: string;
    resumeStepId?: string;
  };
}

export type NewIntervention = Omit<
  InterventionRequest,
  "id" | "runId" | "createdAt" | "status" | "resolution" | "allowedActions" | "source"
> & {
  allowedActions?: OperatorAction[];
  source?: InterventionRequest["source"];
};

/** A redacted human gesture captured by the in-page recorder. */
export interface HumanAction {
  kind: "click" | "type" | "select" | "check" | "press";
  url: string;
  tag?: string;
  role?: string;
  name?: string;
  label?: string;
  text?: string;
  /** Already redacted when `sensitive` or when a Redactor is attached. */
  value?: string;
  sensitive?: boolean;
  framePath?: string[];
  at: string;
}

export interface ResumeMatch {
  stepId: string;
  index: number;
  skippedStepIds: string[];
}

export class IllegalTransitionError extends Error {
  readonly from: ControlState;
  readonly to: ControlState;
  constructor(from: ControlState, to: ControlState) {
    super(`illegal control transition ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
    this.from = from;
    this.to = to;
  }
}

export class LeaseViolationError extends Error {
  readonly holder: Controller;
  readonly actor: Controller;
  readonly state: ControlState;
  constructor(state: ControlState, holder: Controller, actor: Controller) {
    super(`lease held by ${holder ?? "nobody"} in ${state}; ${actor ?? "unknown"} cannot act`);
    this.name = "LeaseViolationError";
    this.holder = holder;
    this.actor = actor;
    this.state = state;
  }
}
