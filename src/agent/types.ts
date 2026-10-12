import type {
  AppIdentity,
  FieldType,
  InputField,
  RiskClass,
  SecretDecl,
  Sensitivity,
  StepAction,
  TargetFingerprint,
  ValueRef,
} from "../artifact/schema.js";

export type AgentToolName =
  | "click"
  | "type"
  | "select"
  | "navigate"
  | "extract"
  | "declare_done"
  | "request_human";

/** A tool value that is a declared input, a secret, or (discouraged) a constant. */
export type TypedValue = { param: string } | { secret: string } | string;

export interface OutputDecl {
  type: FieldType;
  description: string;
  sensitivity: Sensitivity;
}

export interface DiscoveryGoal {
  id: string;
  title: string;
  description: string;
  /** Imperative instruction sent to the model. */
  instruction: string;
  inputs: Record<string, InputField>;
  outputs: Record<string, OutputDecl>;
  secrets: Record<string, SecretDecl>;
  app: AppIdentity;
  version?: string;
}

export interface RecordedTarget {
  /** Taken from the observed control at action time, never from the model. */
  description: string;
  framePath: string[];
  fingerprint: TargetFingerprint;
}

export interface RecordedStep {
  id: string;
  intent: string;
  tool: Exclude<AgentToolName, "declare_done" | "request_human">;
  rationale: string;
  ref?: string;
  target?: RecordedTarget;
  action: StepAction;
  risk: RiskClass;
  extractName?: string;
  extractRead?: "text" | "value";
  extractedText?: string;
  urlBefore?: string;
  urlAfter?: string;
  snapshotHashBefore?: string;
  snapshotHashAfter?: string;
}

export type StopReason =
  | { kind: "declared_done"; evidence: string }
  | { kind: "max_steps"; steps: number }
  | { kind: "timeout"; elapsedMs: number }
  | { kind: "repeated_state"; hash: string; count: number }
  | { kind: "policy_denied"; reason: string; verdict: "deny" | "escalate" }
  | { kind: "human_requested"; reason: string }
  | { kind: "action_failed"; error: string }
  | { kind: "llm_error"; error: string }
  | { kind: "no_tool_call" };

export interface RunTrace {
  runId: string;
  goal: DiscoveryGoal;
  model?: string;
  startedAt: string;
  finishedAt: string;
  status: "done" | "stopped";
  stop: StopReason;
  steps: RecordedStep[];
  /** Runtime input values used for `{{param}}` templating. Secrets are never stored. */
  runtimeInputs: Record<string, string>;
  doneEvidence?: string;
  appObserved?: { title: string; url: string };
}

export interface StopConfig {
  maxSteps: number;
  timeoutMs: number;
  /** Consecutive identical snapshot hashes after which the loop treats the run as stuck. */
  repeatedStateLimit: number;
}

export const DEFAULT_STOP: StopConfig = {
  maxSteps: 40,
  timeoutMs: 180_000,
  repeatedStateLimit: 3,
};

export function valueRefFromTyped(value: TypedValue): ValueRef {
  if (typeof value === "string") return { kind: "literal", value };
  if ("param" in value) return { kind: "input", name: value.param };
  return { kind: "secret", name: value.secret };
}
