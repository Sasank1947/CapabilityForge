export type Actor = "agent" | "replay" | "human" | "system";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

declare const redactedBrand: unique symbol;

/**
 * A payload that has passed through the redactor. Only the redaction module may
 * create this type (via a cast); the evidence store accepts nothing else, so raw
 * values cannot reach disk by accident.
 */
export type RedactedPayload = { readonly [key: string]: JsonValue } & { readonly [redactedBrand]: true };

export type RunEventType =
  | "run_started"
  | "run_finished"
  | "observation"
  | "decision"
  | "policy_decision"
  | "action"
  | "action_result"
  | "target_resolved"
  | "screen_state"
  | "recovery"
  | "extraction"
  | "checkpoint"
  | "intervention_requested"
  | "control_changed"
  | "human_action"
  | "artifact_written"
  | "error";

export type RunMode = "discovery" | "replay";

export interface RunEvent {
  runId: string;
  /** Monotonic per run, starting at 1. */
  seq: number;
  at: string;
  actor: Actor;
  type: RunEventType;
  stepId?: string;
  /** Agent rationale (discovery) or engine reason (replay), already redacted. */
  rationale?: string;
  payload: RedactedPayload;
  /** Paths relative to the run directory. */
  attachments?: string[];
}

export type NewRunEvent = Omit<RunEvent, "runId" | "seq" | "at">;

export interface RunManifest {
  runId: string;
  mode: RunMode;
  capabilityId?: string;
  capabilityVersion?: string;
  goal?: string;
  tenant?: string;
  startedAt: string;
  finishedAt?: string;
  status?: string;
}

export interface EvidenceSink {
  readonly runId: string;
  readonly dir: string;
  append(event: NewRunEvent): RunEvent;
  /** Writes an already-redacted binary (e.g. masked screenshot) and returns its run-relative path. */
  attach(name: string, data: Buffer): Promise<string>;
  close(manifest: Partial<RunManifest>): Promise<void>;
}
