import { randomBytes } from "node:crypto";
import type { EvidenceSink, JsonValue, RedactedPayload } from "../evidence/types.js";
import {
  ControlState,
  IllegalTransitionError,
  LeaseViolationError,
  canTransition,
  type ControlLease,
  type Controller,
  type InterventionRequest,
  type NewIntervention,
  type OperatorAction,
} from "./types.js";

export interface SessionControllerOptions {
  runId: string;
  source: "discovery" | "replay";
  /** Automation actor that owns the lease in AGENT / RESUMING. */
  automation?: Extract<Controller, "agent" | "replay">;
  evidence?: EvidenceSink;
  clock?: () => Date;
  idFactory?: () => string;
}

function asRedacted(payload: Record<string, JsonValue>): RedactedPayload {
  return payload as RedactedPayload;
}

function newId(prefix: string): string {
  return `${prefix}-${randomBytes(6).toString("hex")}`;
}

function copyLease(lease: ControlLease): ControlLease {
  return { ...lease };
}

function copyIntervention(iv: InterventionRequest): InterventionRequest {
  return {
    ...iv,
    allowedActions: [...iv.allowedActions],
    ...(iv.resolution ? { resolution: { ...iv.resolution } } : {}),
  };
}

/**
 * Single control lease for a live session. The actor who may drive the Surface
 * is always explicit: replay/agent in AGENT, nobody in PAUSED, the human in
 * HUMAN, then automation again in RESUMING → AGENT.
 */
export class SessionController {
  readonly runId: string;
  readonly source: "discovery" | "replay";
  readonly automation: Extract<Controller, "agent" | "replay">;
  private readonly evidence?: EvidenceSink;
  private readonly clock: () => Date;
  private readonly idFactory: () => string;
  private _lease: ControlLease;
  private readonly interventions = new Map<string, InterventionRequest>();
  private readonly waiters = new Map<string, Array<(iv: InterventionRequest) => void>>();
  private readonly listeners = new Set<() => void>();

  constructor(opts: SessionControllerOptions) {
    this.runId = opts.runId;
    this.source = opts.source;
    this.automation = opts.automation ?? "replay";
    this.evidence = opts.evidence;
    this.clock = opts.clock ?? (() => new Date());
    this.idFactory = opts.idFactory ?? (() => newId("iv"));
    this._lease = {
      leaseId: newId("lease"),
      holder: this.automation,
      state: ControlState.AGENT,
      since: this.now(),
    };
  }

  get state(): ControlState {
    return this._lease.state;
  }

  get lease(): ControlLease {
    return copyLease(this._lease);
  }

  listInterventions(): InterventionRequest[] {
    return [...this.interventions.values()].map(copyIntervention);
  }

  getIntervention(id: string): InterventionRequest | undefined {
    const iv = this.interventions.get(id);
    return iv ? copyIntervention(iv) : undefined;
  }

  /** Most recent open or claimed request, if any. */
  activeIntervention(): InterventionRequest | undefined {
    const open = [...this.interventions.values()].reverse().find((iv) => iv.status === "open" || iv.status === "claimed");
    return open ? copyIntervention(open) : undefined;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /**
   * AGENT → PAUSED. Opens an intervention and drops the automation lease so
   * further agent/replay acts are rejected until the operator resolves it.
   */
  requestIntervention(input: NewIntervention): InterventionRequest {
    this.transition(ControlState.PAUSED, null);
    const allowed = input.allowedActions?.length ? [...input.allowedActions] : defaultActions(input.reason);
    const iv: InterventionRequest = {
      ...input,
      id: this.idFactory(),
      runId: this.runId,
      createdAt: this.now(),
      source: input.source ?? this.source,
      allowedActions: allowed,
      status: "open",
    };
    this.interventions.set(iv.id, iv);
    this.emit("intervention_requested", {
      interventionId: iv.id,
      reason: iv.reason,
      stepId: iv.stepId ?? null,
    });
    this.notify();
    return copyIntervention(iv);
  }

  /** PAUSED → HUMAN. The same headed Chromium session is now the operator's. */
  takeControl(id: string, by = "operator"): InterventionRequest {
    const iv = this.require(id, "open");
    this.transition(ControlState.HUMAN, "human");
    iv.status = "claimed";
    iv.allowedActions = ["hand_back", "abort"];
    this.emit("control_changed", { interventionId: id, action: "take_control", by });
    this.notify();
    return copyIntervention(iv);
  }

  /** PAUSED → RESUMING. Operator approved without taking the browser. */
  approve(id: string, by = "operator", note?: string): InterventionRequest {
    const iv = this.require(id, "open");
    this.transition(ControlState.RESUMING, this.automation);
    this.resolve(iv, "approved", by, note);
    this.notify();
    return copyIntervention(iv);
  }

  /** HUMAN → RESUMING. Engine will re-classify the screen and pick a resume step. */
  handBack(id: string, by = "operator", note?: string, resumeStepId?: string): InterventionRequest {
    const iv = this.require(id, "claimed");
    this.transition(ControlState.RESUMING, this.automation);
    this.resolve(iv, "handed_back", by, note, resumeStepId);
    this.notify();
    return copyIntervention(iv);
  }

  /** RESUMING → AGENT. Automation holds the lease again. */
  markResumed(): ControlLease {
    return this.transition(ControlState.AGENT, this.automation);
  }

  /** Re-open an intervention after a failed resume (RESUMING → PAUSED). */
  pauseAgain(): ControlLease {
    return this.transition(ControlState.PAUSED, null);
  }

  abort(id?: string, by = "operator", note?: string): InterventionRequest | undefined {
    const target = id ? this.interventions.get(id) : this.activeInterventionRaw();
    if (this.state !== ControlState.ABORTED) this.transition(ControlState.ABORTED, null);
    if (!target) {
      this.notify();
      return undefined;
    }
    if (target.status === "open" || target.status === "claimed") {
      target.status = "aborted";
      target.allowedActions = [];
      target.resolution = { by, at: this.now(), outcome: "aborted", ...(note ? { note } : {}) };
      this.finishWait(target);
    }
    this.emit("control_changed", { interventionId: target.id, action: "abort", by });
    this.notify();
    return copyIntervention(target);
  }

  complete(): ControlLease {
    return this.transition(ControlState.COMPLETED, this.automation);
  }

  /** Rejects any Surface.act whose actor does not currently hold the lease. */
  assertCanAct(actor: Exclude<Controller, null>): void {
    const { state, holder } = this._lease;
    if (state === ControlState.ABORTED || state === ControlState.COMPLETED) {
      throw new LeaseViolationError(state, holder, actor);
    }
    if (actor === "human") {
      if (state !== ControlState.HUMAN || holder !== "human") {
        throw new LeaseViolationError(state, holder, actor);
      }
      return;
    }
    if (state !== ControlState.AGENT || holder !== actor) {
      throw new LeaseViolationError(state, holder, actor);
    }
  }

  waitForResolution(id: string, timeoutMs = 0): Promise<InterventionRequest> {
    const current = this.requireExisting(id);
    if (current.status === "resolved" || current.status === "aborted") {
      return Promise.resolve(copyIntervention(current));
    }
    return new Promise((resolve, reject) => {
      const finish = (iv: InterventionRequest): void => {
        if (timer) clearTimeout(timer);
        resolve(copyIntervention(iv));
      };
      const list = this.waiters.get(id) ?? [];
      list.push(finish);
      this.waiters.set(id, list);
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              const remaining = (this.waiters.get(id) ?? []).filter((w) => w !== finish);
              if (remaining.length) this.waiters.set(id, remaining);
              else this.waiters.delete(id);
              reject(new Error(`intervention ${id} timed out after ${timeoutMs}ms`));
            }, timeoutMs)
          : undefined;
    });
  }

  private transition(to: ControlState, holder: Controller): ControlLease {
    const from = this._lease.state;
    if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
    this._lease = {
      leaseId: newId("lease"),
      holder,
      state: to,
      since: this.now(),
    };
    this.emit("control_changed", { from, to, holder: holder ?? "none", leaseId: this._lease.leaseId });
    this.notify();
    return copyLease(this._lease);
  }

  private resolve(
    iv: InterventionRequest,
    outcome: "handed_back" | "approved" | "aborted",
    by: string,
    note?: string,
    resumeStepId?: string,
  ): void {
    iv.status = outcome === "aborted" ? "aborted" : "resolved";
    iv.allowedActions = [];
    iv.resolution = {
      by,
      at: this.now(),
      outcome,
      ...(note ? { note } : {}),
      ...(resumeStepId ? { resumeStepId } : {}),
    };
    this.emit("control_changed", { interventionId: iv.id, action: outcome, by, resumeStepId: resumeStepId ?? null });
    this.finishWait(iv);
  }

  private require(id: string, status: InterventionRequest["status"]): InterventionRequest {
    const iv = this.requireExisting(id);
    if (iv.status !== status) throw new Error(`intervention ${id} is ${iv.status}, expected ${status}`);
    return iv;
  }

  private requireExisting(id: string): InterventionRequest {
    const iv = this.interventions.get(id);
    if (!iv) throw new Error(`unknown intervention '${id}'`);
    return iv;
  }

  private activeInterventionRaw(): InterventionRequest | undefined {
    return [...this.interventions.values()].reverse().find((iv) => iv.status === "open" || iv.status === "claimed");
  }

  private finishWait(iv: InterventionRequest): void {
    const wait = this.waiters.get(iv.id);
    if (!wait) return;
    this.waiters.delete(iv.id);
    for (const resolve of wait) resolve(iv);
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  private now(): string {
    return this.clock().toISOString();
  }

  private emit(type: "intervention_requested" | "control_changed", payload: Record<string, JsonValue>): void {
    this.evidence?.append({
      actor: "system",
      type,
      payload: asRedacted(payload),
    });
  }
}

function defaultActions(reason: NewIntervention["reason"]): OperatorAction[] {
  if (reason === "irreversible_step_requires_approval" || reason === "policy_escalation") {
    return ["take_control", "approve", "abort"];
  }
  return ["take_control", "abort"];
}
