import { randomBytes } from "node:crypto";
import type {
  CapabilityArtifact,
  Condition,
  Extraction,
  FailureKind,
  OutputField,
  ScreenState,
  SecretDecl,
  Step,
  StepAction,
  ValueRef,
} from "../artifact/schema.js";
import { inputsValidator } from "../artifact/schema.js";
import type { EvidenceSink, JsonValue, NewRunEvent, RedactedPayload } from "../evidence/types.js";
import type { Grant, PolicyDecision, PolicyGate } from "../policy/types.js";
import { substituteTemplate } from "../surface/resolve.js";
import type { Observation, Surface, SurfaceAction } from "../surface/types.js";
import { applyTransforms, describeCondition, evalCondition, type EvalContext } from "./conditions.js";
import type { RecoveryRecord, ReplayResult, StrategyHit } from "./result.js";

export type EscalateDecision =
  | "resume"
  | "abort"
  | { action: "resume_from"; stepId: string }
  | { action: "fail"; expected: string; observed: string };

export interface EscalateInfo {
  reason: string;
  stepId: string | null;
  screenStateId?: string;
  policy?: PolicyDecision;
}

export interface ReplayEngineOptions {
  artifact: CapabilityArtifact;
  surface: Surface;
  policy: PolicyGate;
  evidence?: EvidenceSink;
  inputs: Record<string, unknown>;
  /** Literal secret values keyed by the artifact's secret name (not the env var). */
  secrets?: Record<string, string>;
  /** Origin (and optional path prefix) used to resolve relative navigate URLs. */
  baseUrl: string;
  /** Tenant route prefix prepended to root-relative paths, e.g. "/mcu". */
  routePrefix?: string;
  grants?: Grant[];
  invocationId?: string;
  tenant?: string;
  /** Called when a policy or screen-state handler escalates. Default is abort. */
  onEscalate?: (info: EscalateInfo) => Promise<EscalateDecision>;
}

const POLL_MS = 150;
const MAX_ITERS = 80;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function nowIso(): string {
  return new Date().toISOString();
}

function asRedacted(payload: Record<string, JsonValue>): RedactedPayload {
  return payload as RedactedPayload;
}

function newId(prefix: string): string {
  return `${prefix}-${randomBytes(6).toString("hex")}`;
}

function isSensitiveInput(artifact: CapabilityArtifact, name: string): boolean {
  const s = artifact.inputs[name]?.sensitivity;
  return s === "pii" || s === "secret";
}

export function resolveSecretEnv(decl: SecretDecl, provided?: string): string | undefined {
  if (provided !== undefined) return provided;
  const m = /^(?:env|vault):\/\/(.+)$/.exec(decl.ref);
  if (!m) return undefined;
  return process.env[m[1]!] ?? undefined;
}

export function resolveNavigateUrl(url: string, baseUrl: string, routePrefix = "", templateValues: Record<string, string>): string {
  const templated = substituteTemplate(url, templateValues);
  if (/^https?:\/\//i.test(templated)) return templated;
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  if (templated.startsWith("/")) {
    return new URL(`${routePrefix}${templated}`, base).href;
  }
  return new URL(templated, base).href;
}

type StepOutcome =
  | { kind: "done" }
  | { kind: "retry" }
  | { kind: "restart"; stepId: string }
  | { kind: "result"; result: ReplayResult };

/**
 * Deterministic replay: classify → wait preconditions → resolve → policy → act →
 * postcondition. Screen-state handlers live in the artifact; this engine never
 * calls an LLM.
 */
export class ReplayEngine {
  private readonly artifact: CapabilityArtifact;
  private readonly surface: Surface;
  private readonly policy: PolicyGate;
  private readonly evidence?: EvidenceSink;
  private readonly inputs: Record<string, unknown>;
  private readonly secrets: Record<string, string> = {};
  private readonly baseUrl: string;
  private readonly routePrefix: string;
  private readonly grants: Grant[];
  private readonly invocationId: string;
  private readonly tenant?: string;
  private readonly onEscalate?: ReplayEngineOptions["onEscalate"];
  private readonly templateValues: Record<string, string> = {};
  private readonly runId: string;
  private readonly startedAt: string;
  private readonly recoveries: RecoveryRecord[] = [];
  private readonly strategyHits: StrategyHit[] = [];
  private readonly outputs: Record<string, string | number | boolean | null> = {};
  private readonly recoverCount = new Map<string, number>();
  private readonly evidencePaths: string[] = [];
  private lastObservation: Observation | null = null;

  constructor(opts: ReplayEngineOptions) {
    this.artifact = opts.artifact;
    this.surface = opts.surface;
    this.policy = opts.policy;
    this.evidence = opts.evidence;
    this.inputs = opts.inputs;
    this.baseUrl = opts.baseUrl;
    this.routePrefix = opts.routePrefix ?? "";
    this.grants = opts.grants ?? [];
    this.invocationId = opts.invocationId ?? newId("inv");
    this.tenant = opts.tenant;
    this.onEscalate = opts.onEscalate;
    this.runId = opts.evidence?.runId ?? newId("replay");
    this.startedAt = nowIso();
    for (const [name, value] of Object.entries(opts.inputs)) {
      if (value !== undefined && value !== null) this.templateValues[name] = String(value);
    }
    for (const [name, decl] of Object.entries(this.artifact.secrets)) {
      const value = resolveSecretEnv(decl, opts.secrets?.[name]);
      if (value !== undefined) this.secrets[name] = value;
    }
  }

  async run(): Promise<ReplayResult> {
    this.emit("run_started", {
      capabilityId: this.artifact.id,
      inputs: Object.fromEntries(
        Object.entries(this.inputs).map(([k, v]) => [k, isSensitiveInput(this.artifact, k) ? "[redacted]" : (v as JsonValue)]),
      ),
    });
    try {
      const invalid = this.validateInputs();
      if (invalid) return invalid;
      const missing = this.missingSecrets();
      if (missing) return missing;

      const steps = this.artifact.steps;
      let i = 0;
      let iters = 0;
      while (i < steps.length) {
        if (++iters > MAX_ITERS) {
          return this.fail("recovery_exhausted", steps[i]?.id ?? null, "bounded replay iteration limit", `exceeded ${MAX_ITERS} step iterations`);
        }
        const step = steps[i]!;
        const outcome = await this.runStep(step, false);
        if (outcome.kind === "done") {
          i += 1;
          continue;
        }
        if (outcome.kind === "retry") continue;
        if (outcome.kind === "restart") {
          const next = steps.findIndex((s) => s.id === outcome.stepId);
          if (next < 0) {
            return this.fail("internal_error", step.id, `restart at '${outcome.stepId}'`, "unknown step");
          }
          i = next;
          continue;
        }
        return outcome.result;
      }

      const check = await this.waitCondition(this.artifact.successCheckpoint.condition, this.artifact.steps.at(-1)?.timeoutMs ?? 10_000);
      this.emit("checkpoint", { ok: check.ok, description: this.artifact.successCheckpoint.description }, this.artifact.steps.at(-1)?.id);
      if (!check.ok) {
        return this.fail(
          "checkpoint_failed",
          this.artifact.steps.at(-1)?.id ?? null,
          this.artifact.successCheckpoint.description,
          check.observed,
        );
      }
      return this.finish({
        status: "success",
        outputs: { ...this.outputs },
      });
    } catch (err) {
      return this.fail("internal_error", null, "replay completed without throwing", (err as Error).message);
    } finally {
      this.emit("run_finished", { outputs: Object.keys(this.outputs) });
      await this.evidence?.close({
        status: "closed",
        capabilityId: this.artifact.id,
        capabilityVersion: this.artifact.version,
        tenant: this.tenant,
      });
    }
  }

  private validateInputs(): ReplayResult | null {
    const parsed = inputsValidator(this.artifact.inputs).safeParse(this.inputs);
    if (parsed.success) return null;
    const observed = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    return this.fail("invalid_input", null, "inputs matching the capability JSON Schema", observed);
  }

  private missingSecrets(): ReplayResult | null {
    const missing = Object.keys(this.artifact.secrets).filter((name) => this.secrets[name] === undefined);
    if (missing.length === 0) return null;
    return this.fail("invalid_input", null, `secrets ${missing.join(", ")} resolved from env or ReplayEngineOptions.secrets`, "missing");
  }

  private resolveValue(ref: ValueRef): string {
    if (ref.kind === "literal") return ref.value;
    if (ref.kind === "input") {
      const v = this.inputs[ref.name];
      if (v === undefined || v === null) {
        if (this.artifact.inputs[ref.name] && !this.artifact.inputs[ref.name]!.required) return "";
        throw new Error(`missing input '${ref.name}'`);
      }
      return String(v);
    }
    const secret = this.secrets[ref.name];
    if (secret === undefined) throw new Error(`missing secret '${ref.name}'`);
    return secret;
  }

  private valueIsSensitive(ref: ValueRef): boolean {
    if (ref.kind === "secret") return true;
    if (ref.kind === "literal") return false;
    return isSensitiveInput(this.artifact, ref.name);
  }

  private async observe(): Promise<Observation> {
    this.lastObservation = await this.surface.observe();
    return this.lastObservation;
  }

  private evalCtx(obs: Observation): EvalContext {
    return {
      surface: this.surface,
      observation: obs,
      templateValues: this.templateValues,
      resolveValue: (ref) => this.resolveValue(ref),
    };
  }

  private async classify(stepId: string, obs: Observation): Promise<ScreenState | null> {
    const ranked = this.artifact.screenStates
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => !s.appliesTo || s.appliesTo.includes(stepId))
      .sort((a, b) => b.s.priority - a.s.priority || a.i - b.i);
    const ctx = this.evalCtx(obs);
    for (const { s } of ranked) {
      if (await evalCondition(s.detect, ctx)) {
        this.emit("screen_state", { id: s.id, handler: s.handler.kind }, stepId);
        return s;
      }
    }
    return null;
  }

  private async waitCondition(cond: Condition, timeoutMs: number): Promise<{ ok: boolean; observed: string }> {
    const deadline = Date.now() + timeoutMs;
    let last = "";
    for (;;) {
      const obs = await this.observe();
      last = `url=${obs.url} title=${obs.title}`;
      if (await evalCondition(cond, this.evalCtx(obs))) return { ok: true, observed: last };
      if (Date.now() >= deadline) return { ok: false, observed: last };
      await sleep(POLL_MS);
    }
  }

  private async runStep(step: Step, isRecovery: boolean): Promise<StepOutcome> {
    if (!isRecovery) {
      const early = await this.classifyLoop(step);
      if (early) return early;
    }

    for (const pre of step.preconditions) {
      const waited = await this.waitCondition(pre, step.timeoutMs);
      if (!waited.ok) {
        const handled = isRecovery ? null : await this.classifyLoop(step);
        if (handled) return handled;
        return {
          kind: "result",
          result: this.fail("precondition_timeout", step.id, describeCondition(pre), waited.observed),
        };
      }
    }

    if (step.action.type === "extract") {
      try {
        await this.extractNamed(step.action.outputs);
        return { kind: "done" };
      } catch (err) {
        return { kind: "result", result: this.fail("extraction_failed", step.id, step.action.outputs.join(", "), (err as Error).message) };
      }
    }

    const acted = await this.actStep(step);
    if (acted) return acted;

    if (step.postcondition) {
      const deadline = Date.now() + step.timeoutMs;
      for (;;) {
        if (!isRecovery) {
          const handled = await this.classifyLoop(step);
          if (handled) return handled;
        }
        const obs = this.lastObservation ?? (await this.observe());
        if (await evalCondition(step.postcondition, this.evalCtx(obs))) break;
        if (Date.now() >= deadline) {
          return {
            kind: "result",
            result: this.fail("postcondition_failed", step.id, describeCondition(step.postcondition), `url=${obs.url} title=${obs.title}`),
          };
        }
        await sleep(POLL_MS);
        await this.observe();
      }
    } else if (!isRecovery) {
      const handled = await this.classifyLoop(step);
      if (handled) return handled;
    }
    return { kind: "done" };
  }

  private async classifyLoop(step: Step): Promise<StepOutcome | null> {
    const obs = await this.observe();
    const state = await this.classify(step.id, obs);
    if (!state) return null;
    return this.handleState(state, step);
  }

  private async handleState(state: ScreenState, step: Step): Promise<StepOutcome> {
    const h = state.handler;
    if (h.kind === "outcome") {
      try {
        if (h.outputs.length) await this.extractNamed(h.outputs);
      } catch {
        // Outcome still stands; partial outputs are fine.
      }
      return {
        kind: "result",
        result: this.finish({
          status: "business_outcome",
          code: h.code,
          message: h.message,
          screenStateId: state.id,
          stepId: step.id,
          outputs: { ...this.outputs },
        }),
      };
    }
    if (h.kind === "fail") {
      return {
        kind: "result",
        result: this.fail(h.failureKind, step.id, h.message, `screen state '${state.id}'`, state.id),
      };
    }
    if (h.kind === "escalate") {
      const esc = await this.escalate({ reason: h.reason, stepId: step.id, screenStateId: state.id });
      if (esc.kind === "done") return { kind: "retry" };
      return esc;
    }

    const attempt = (this.recoverCount.get(state.id) ?? 0) + 1;
    if (attempt > h.retry.maxAttempts) {
      this.recoveries.push({
        screenStateId: state.id,
        duringStepId: step.id,
        attempt,
        resume: h.resume.mode,
        ok: false,
        at: nowIso(),
        note: "recovery_exhausted",
      });
      return {
        kind: "result",
        result: this.fail("recovery_exhausted", step.id, `recover '${state.id}' within ${h.retry.maxAttempts} attempt(s)`, `attempt ${attempt}`, state.id),
      };
    }
    this.recoverCount.set(state.id, attempt);
    const backoff = Math.min(h.retry.maxBackoffMs, h.retry.initialBackoffMs * h.retry.factor ** (attempt - 1));
    if (backoff > 0) await sleep(backoff);

    for (const rs of h.steps) {
      const inner = await this.runStep(rs, true);
      if (inner.kind === "result") {
        this.recoveries.push({
          screenStateId: state.id,
          duringStepId: step.id,
          attempt,
          resume: h.resume.mode,
          ok: false,
          at: nowIso(),
          note: inner.result.status,
        });
        return inner;
      }
    }

    const resumedAtStepId = h.resume.mode === "restartFrom" ? h.resume.stepId : step.id;
    this.recoveries.push({
      screenStateId: state.id,
      duringStepId: step.id,
      attempt,
      resume: h.resume.mode,
      resumedAtStepId,
      ok: true,
      at: nowIso(),
    });
    this.emit("recovery", { screenStateId: state.id, attempt, resume: h.resume.mode, resumedAtStepId }, step.id);
    if (h.resume.mode === "restartFrom") return { kind: "restart", stepId: h.resume.stepId };
    return { kind: "retry" };
  }

  private async actStep(step: Step): Promise<StepOutcome | null> {
    let ref: string | undefined;
    let fingerprint = step.target?.fingerprint;
    if (step.target && step.action.type !== "navigate" && step.action.type !== "extract") {
      const resolution = await this.surface.resolve(step.target, {
        templateValues: this.templateValues,
        timeoutMs: step.timeoutMs,
      });
      this.emit(
        "target_resolved",
        { ok: resolution.ok, attempts: resolution.attempts as unknown as JsonValue, reason: resolution.ok ? null : resolution.reason },
        step.id,
      );
      if (!resolution.ok) {
        const handled = await this.classifyLoop(step);
        if (handled) return handled;
        const kind: FailureKind = resolution.reason === "ambiguous" ? "target_ambiguous" : resolution.reason === "frame_not_found" ? "target_not_found" : "target_not_found";
        return {
          kind: "result",
          result: this.fail(kind, step.id, step.target.description, resolution.reason),
        };
      }
      ref = resolution.ref;
      fingerprint = resolution.fingerprint;
      this.strategyHits.push({
        stepId: step.id,
        strategyIndex: resolution.strategyIndex,
        strategyKind: resolution.strategyKind,
        fallback: resolution.strategyIndex > 0,
        attempts: resolution.attempts,
        fromOverlay: false,
      });
    }

    let action: SurfaceAction;
    try {
      action = this.toSurfaceAction(step.action, ref);
    } catch (err) {
      return { kind: "result", result: this.fail("internal_error", step.id, "well-formed surface action", (err as Error).message) };
    }

    const currentUrl = action.type === "navigate" ? action.url : (this.lastObservation?.url ?? (await this.surface.currentUrl()));
    const decision = this.policy.evaluate({
      actor: "replay",
      action,
      risk: step.risk,
      currentUrl,
      target: fingerprint,
      invocationId: this.invocationId,
      capabilityId: this.artifact.id,
      stepId: step.id,
      grants: this.grants,
    });
    this.emit("policy_decision", { verdict: decision.verdict, ruleId: decision.ruleId, reason: decision.reason }, step.id);

    if (decision.verdict === "deny") {
      return { kind: "result", result: this.fail("policy_denied", step.id, "policy allow", decision.reason) };
    }
    if (decision.verdict === "escalate") {
      const esc = await this.escalate({ reason: decision.reason, stepId: step.id, policy: decision });
      if (esc.kind !== "done") return esc;
    }

    this.emit("action", { type: action.type, risk: step.risk }, step.id, step.intent);
    const outcome = await this.surface.act(action);
    this.emit("action_result", { ok: outcome.ok, error: outcome.error ?? null, urlAfter: outcome.urlAfter }, step.id);
    if (!outcome.ok) {
      const handled = await this.classifyLoop(step);
      if (handled) return handled;
      return {
        kind: "result",
        result: this.fail(step.action.type === "navigate" ? "navigation_error" : "app_error", step.id, "successful action", outcome.error ?? "act failed"),
      };
    }
    await this.observe();
    return null;
  }

  private toSurfaceAction(action: StepAction, ref: string | undefined): SurfaceAction {
    switch (action.type) {
      case "navigate":
        return { type: "navigate", url: resolveNavigateUrl(action.url, this.baseUrl, this.routePrefix, this.templateValues) };
      case "click":
        if (!ref) throw new Error("click requires a resolved target");
        return { type: "click", ref };
      case "type":
        if (!ref) throw new Error("type requires a resolved target");
        return { type: "type", ref, text: this.resolveValue(action.value), clear: action.clear, sensitive: this.valueIsSensitive(action.value) };
      case "select":
        if (!ref) throw new Error("select requires a resolved target");
        return { type: "select", ref, option: this.resolveValue(action.value), sensitive: this.valueIsSensitive(action.value) };
      case "check":
        if (!ref) throw new Error("check requires a resolved target");
        return { type: "check", ref, checked: action.checked };
      case "press":
        return { type: "press", key: action.key, ref };
      case "extract":
        throw new Error("extract is not a surface action");
    }
  }

  private async extractNamed(names: string[]): Promise<void> {
    for (const name of names) {
      const field = this.artifact.outputs[name];
      if (!field?.extraction) continue;
      this.outputs[name] = await this.extractOne(field, field.extraction);
      this.emit("extraction", { name, type: field.type }, undefined);
    }
  }

  private async extractOne(field: OutputField, extraction: Extraction): Promise<string | number | boolean> {
    const res = await this.surface.resolve(extraction.target, { templateValues: this.templateValues, timeoutMs: 8_000 });
    if (!res.ok) throw new Error(`extraction target '${extraction.target.description}': ${res.reason}`);
    const read =
      extraction.read === "attribute"
        ? { read: "attribute" as const, attribute: extraction.attribute ?? "" }
        : { read: extraction.read };
    const raw = await this.surface.extract(res.ref, read);
    const value = applyTransforms(raw, extraction.transforms);
    if (field.type === "number" || field.type === "integer") {
      const n = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(n)) throw new Error(`output is not a number: ${raw}`);
      if (field.type === "integer" && !Number.isInteger(n)) throw new Error(`output is not an integer: ${raw}`);
      return n;
    }
    if (field.type === "boolean") return typeof value === "boolean" ? value : Boolean(value);
    return String(value);
  }

  private async escalate(info: EscalateInfo): Promise<StepOutcome> {
    const decision = this.onEscalate ? await this.onEscalate(info) : "abort";
    if (decision === "resume") return { kind: "done" };
    if (typeof decision === "object" && decision.action === "resume_from") {
      this.emit("control_changed", { resumeStepId: decision.stepId, reason: info.reason }, info.stepId ?? undefined);
      return { kind: "restart", stepId: decision.stepId };
    }
    if (typeof decision === "object" && decision.action === "fail") {
      return {
        kind: "result",
        result: this.fail("unknown_screen_state", info.stepId, decision.expected, decision.observed),
      };
    }
    const interventionId = newId("iv");
    this.emit("intervention_requested", { reason: info.reason, interventionId }, info.stepId ?? undefined);
    return {
      kind: "result",
      result: this.finish({
        status: "escalated",
        interventionId,
        reason: info.reason,
        stepId: info.stepId,
      }),
    };
  }

  private fail(kind: FailureKind, stepId: string | null, expected: string, observed: string, screenStateId?: string): ReplayResult {
    this.emit("error", { kind, expected, observed }, stepId ?? undefined);
    return this.finish({
      status: "failure",
      kind,
      stepId,
      message: `${kind}: ${observed}`,
      expected,
      observed,
      screenStateId,
      url: this.lastObservation?.url,
      evidencePaths: [...this.evidencePaths],
    });
  }

  private finish(partial: Record<string, unknown> & { status: ReplayResult["status"] }): ReplayResult {
    const finishedAt = nowIso();
    const base = {
      runId: this.runId,
      capabilityId: this.artifact.id,
      capabilityVersion: this.artifact.version,
      contentHash: this.artifact.contentHash,
      tenant: this.tenant,
      startedAt: this.startedAt,
      finishedAt,
      durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(this.startedAt)),
      recoveries: this.recoveries,
      strategyHits: this.strategyHits,
      evidenceDir: this.evidence?.dir,
    };
    return { ...base, ...partial } as ReplayResult;
  }

  private emit(type: NewRunEvent["type"], payload: Record<string, JsonValue>, stepId?: string, rationale?: string): void {
    this.evidence?.append({
      actor: "replay",
      type,
      payload: asRedacted(payload),
      ...(stepId !== undefined && { stepId }),
      ...(rationale !== undefined && { rationale }),
    });
  }
}

export function replay(opts: ReplayEngineOptions): Promise<ReplayResult> {
  return new ReplayEngine(opts).run();
}
