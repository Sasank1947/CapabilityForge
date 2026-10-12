import type { Grant, PolicyGate } from "../policy/types.js";
import { classifyRisk } from "../policy/config.js";
import type { Redactor } from "../policy/redact.js";
import { resolveNavigateUrl } from "../replay/engine.js";
import type { Observation, ObservedElement, Surface, SurfaceAction } from "../surface/types.js";
import type { EvidenceSink } from "../evidence/types.js";
import { newRunId } from "../evidence/sink.js";
import type { RiskClass, ValueRef } from "../artifact/schema.js";
import { fingerprintFromObserved, targetDescription } from "../artifact/compiler.js";
import type { LlmClient, ChatMessage, ToolCall } from "./llm.js";
import { formatObservation, NUDGE_NO_TOOL, systemPrompt } from "./prompts.js";
import { checkBudget, newStopState, noteSnapshot } from "./stop.js";
import { parseToolArgs, toolSpecs, type DeclareDoneArgs, type ExtractArgs, type NavigateArgs, type RequestHumanArgs, type SelectArgs, type TypeArgs } from "./tools.js";
import type { DiscoveryGoal, RecordedStep, RecordedTarget, RunTrace, StopConfig, StopReason, TypedValue } from "./types.js";
import { DEFAULT_STOP } from "./types.js";

export interface DiscoveryOptions {
  goal: DiscoveryGoal;
  surface: Surface;
  llm: LlmClient;
  policy: PolicyGate;
  inputs: Record<string, string>;
  secrets?: Record<string, string>;
  baseUrl: string;
  routePrefix?: string;
  evidence?: EvidenceSink;
  redactor?: Redactor;
  grants?: Grant[];
  invocationId?: string;
  stop?: Partial<StopConfig>;
  model?: string;
  now?: () => number;
  runId?: string;
  /** After click/navigate/select, poll for a new snapshot hash this long. Tests should use 0. */
  settleMs?: number;
}

export interface DiscoveryResult {
  status: "done" | "stopped";
  stop: StopReason;
  runId: string;
  trace: RunTrace;
  model?: string;
  evidenceDir?: string;
}

function nowIso(ms: number): string {
  return new Date(ms).toISOString();
}

function slugStepId(n: number, rationale: string): string {
  const slug = rationale
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36) || "action";
  return `s${String(n).padStart(2, "0")}-${slug}`;
}

function lookup(obs: Observation, ref: string): ObservedElement | undefined {
  return obs.elements.find((e) => e.ref === ref);
}

function targetFromObserved(el: ObservedElement): RecordedTarget {
  const fingerprint = fingerprintFromObserved(el);
  return {
    description: targetDescription(fingerprint),
    framePath: [...el.framePath],
    fingerprint,
  };
}

function isSensitiveInput(goal: DiscoveryGoal, name: string): boolean {
  const s = goal.inputs[name]?.sensitivity;
  return s === "pii" || s === "secret";
}

interface ResolvedValue {
  ref: ValueRef;
  text: string;
  sensitive: boolean;
}

function resolveTypedValue(
  raw: TypedValue,
  goal: DiscoveryGoal,
  inputs: Record<string, string>,
  secrets: Record<string, string>,
): ResolvedValue {
  if (typeof raw !== "string") {
    if ("param" in raw) {
      if (!goal.inputs[raw.param]) throw new Error(`unknown input '${raw.param}'`);
      const text = inputs[raw.param];
      if (text === undefined) throw new Error(`missing runtime value for input '${raw.param}'`);
      return { ref: { kind: "input", name: raw.param }, text, sensitive: isSensitiveInput(goal, raw.param) };
    }
    if (!goal.secrets[raw.secret]) throw new Error(`unknown secret '${raw.secret}'`);
    const text = secrets[raw.secret];
    if (text === undefined) throw new Error(`missing runtime value for secret '${raw.secret}'`);
    return { ref: { kind: "secret", name: raw.secret }, text, sensitive: true };
  }

  for (const [name, value] of Object.entries(secrets)) {
    if (value && raw === value) return { ref: { kind: "secret", name }, text: value, sensitive: true };
  }
  for (const [name, value] of Object.entries(inputs)) {
    if (value && raw === value && goal.inputs[name]) {
      return { ref: { kind: "input", name }, text: value, sensitive: isSensitiveInput(goal, name) };
    }
  }
  return { ref: { kind: "literal", value: raw }, text: raw, sensitive: false };
}

export class DiscoveryAgent {
  private readonly goal: DiscoveryGoal;
  private readonly surface: Surface;
  private readonly llm: LlmClient;
  private readonly policy: PolicyGate;
  private readonly inputs: Record<string, string>;
  private readonly secrets: Record<string, string>;
  private readonly baseUrl: string;
  private readonly routePrefix: string;
  private readonly evidence?: EvidenceSink;
  private readonly redactor?: Redactor;
  private readonly grants: Grant[];
  private readonly invocationId: string;
  private readonly stopCfg: StopConfig;
  private readonly modelHint?: string;
  private readonly now: () => number;
  private readonly runId: string;
  private readonly settleMs: number;
  private messages: ChatMessage[] = [];
  private steps: RecordedStep[] = [];
  private lastObs?: Observation;
  private usedModel?: string;
  private noToolNudges = 0;

  constructor(opts: DiscoveryOptions) {
    this.goal = opts.goal;
    this.surface = opts.surface;
    this.llm = opts.llm;
    this.policy = opts.policy;
    this.inputs = opts.inputs;
    this.secrets = opts.secrets ?? {};
    this.baseUrl = opts.baseUrl;
    this.routePrefix = opts.routePrefix ?? "";
    this.evidence = opts.evidence;
    this.redactor = opts.redactor;
    this.grants = opts.grants ?? [];
    this.invocationId = opts.invocationId ?? opts.evidence?.runId ?? "discover";
    this.stopCfg = { ...DEFAULT_STOP, ...opts.stop };
    this.modelHint = opts.model;
    this.now = opts.now ?? Date.now;
    this.runId = opts.runId ?? opts.evidence?.runId ?? newRunId("discovery");
    this.settleMs = opts.settleMs ?? 2_500;
  }

  async run(): Promise<DiscoveryResult> {
    const startedAtMs = this.now();
    const startedAt = nowIso(startedAtMs);
    const stopState = newStopState(startedAtMs);
    this.messages = [{ role: "system", content: systemPrompt(this.goal) }];
    this.emit("run_started", { goal: this.goal.id, instruction: this.goal.instruction });

    let stop: StopReason | undefined;
    try {
      const first = await this.observe();
      stopState.lastHash = first.snapshotHash;
      stopState.consecutiveHash = 1;
      this.messages.push({ role: "user", content: formatObservation(first) });

      while (!stop) {
        const budget = checkBudget(stopState, this.stopCfg, this.now());
        if (budget) {
          stop = budget;
          break;
        }

        const reply = await this.llm.complete({
          messages: this.messages,
          tools: toolSpecs(this.goal),
          model: this.modelHint,
        });
        this.usedModel = reply.model;

        const call = reply.toolCalls[0];
        if (!call) {
          this.noToolNudges += 1;
          this.messages.push({ role: "assistant", content: reply.content });
          if (this.noToolNudges >= 2) {
            stop = { kind: "no_tool_call" };
            break;
          }
          this.messages.push({ role: "user", content: NUDGE_NO_TOOL });
          continue;
        }
        this.noToolNudges = 0;

        const outcome = await this.dispatch(call);
        if (outcome.stop) {
          stop = outcome.stop;
          break;
        }
        if (outcome.acted) {
          stopState.actionCount += 1;
          const screenChanging = outcome.step && (outcome.step.tool === "click" || outcome.step.tool === "navigate" || outcome.step.tool === "select");
          const obs = await this.observeAfter(outcome.step?.snapshotHashBefore, Boolean(screenChanging));
          if (outcome.step) outcome.step.snapshotHashAfter = obs.snapshotHash;
          this.messages.push({
            role: "assistant",
            content: reply.content,
            toolCalls: [call],
          });
          this.messages.push({ role: "tool", toolCallId: call.id, content: outcome.toolResult });
          this.messages.push({ role: "user", content: formatObservation(obs) });
          const stuck = screenChanging ? noteSnapshot(stopState, obs.snapshotHash, this.stopCfg.repeatedStateLimit) : null;
          if (stuck) {
            stop = stuck;
            break;
          }
        } else {
          this.messages.push({ role: "assistant", content: reply.content, toolCalls: [call] });
          this.messages.push({ role: "tool", toolCallId: call.id, content: outcome.toolResult });
        }
      }
    } catch (err) {
      stop = { kind: "llm_error", error: (err as Error).message };
    }

    const finishedAt = nowIso(this.now());
    const final = stop ?? { kind: "llm_error" as const, error: "loop ended without a stop reason" };
    const status = final.kind === "declared_done" ? "done" : "stopped";
    const trace: RunTrace = {
      runId: this.runId,
      goal: this.goal,
      model: this.usedModel,
      startedAt,
      finishedAt,
      status,
      stop: final,
      steps: this.steps,
      runtimeInputs: { ...this.inputs },
      doneEvidence: final.kind === "declared_done" ? final.evidence : undefined,
      appObserved: this.lastObs ? { title: this.lastObs.title, url: this.lastObs.url } : undefined,
    };
    this.emit("run_finished", { status, stop: final.kind, steps: this.steps.length });
    return { status, stop: final, runId: this.runId, trace, model: this.usedModel, evidenceDir: this.evidence?.dir };
  }

  private async observe(emit = true): Promise<Observation> {
    const obs = await this.surface.observe();
    this.lastObs = obs;
    if (emit) {
      this.emit("observation", { url: obs.url, title: obs.title, hash: obs.snapshotHash, elements: obs.elements.length });
    }
    return obs;
  }

  /** Frameset posts often leave the top URL unchanged; wait briefly for the child frame to refresh. */
  private async observeAfter(prevHash: string | undefined, waitForChange: boolean): Promise<Observation> {
    if (!waitForChange || this.settleMs <= 0) return this.observe();
    const deadline = this.now() + this.settleMs;
    let last = await this.observe(false);
    while (prevHash && last.snapshotHash === prevHash && this.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150));
      last = await this.observe(false);
    }
    this.emit("observation", { url: last.url, title: last.title, hash: last.snapshotHash, elements: last.elements.length });
    return last;
  }

  private async dispatch(call: ToolCall): Promise<{
    stop?: StopReason;
    acted: boolean;
    toolResult: string;
    step?: RecordedStep;
  }> {
    const parsed = parseToolArgs(call.name, call.arguments);
    if (!parsed.ok) {
      this.emit("decision", { tool: call.name, error: parsed.error }, undefined, (call.arguments.rationale as string) || undefined);
      return { acted: false, toolResult: `ERROR: ${parsed.error}` };
    }
    const rationale =
      typeof (parsed.args as { rationale?: string }).rationale === "string"
        ? (parsed.args as { rationale: string }).rationale
        : call.name;

    this.emit("decision", { tool: call.name, args: this.safeArgs(call.name, parsed.args) }, undefined, rationale);

    switch (call.name) {
      case "declare_done": {
        const a = parsed.args as DeclareDoneArgs;
        return { stop: { kind: "declared_done", evidence: a.evidence }, acted: false, toolResult: "OK done" };
      }
      case "request_human": {
        const a = parsed.args as RequestHumanArgs;
        return { stop: { kind: "human_requested", reason: a.reason }, acted: false, toolResult: "OK escalating" };
      }
      case "navigate":
        return this.doNavigate(parsed.args as NavigateArgs);
      case "click":
        return this.doClick(parsed.args as { rationale: string; ref: string });
      case "type":
        return this.doType(parsed.args as TypeArgs);
      case "select":
        return this.doSelect(parsed.args as SelectArgs);
      case "extract":
        return this.doExtract(parsed.args as ExtractArgs);
      default:
        return { acted: false, toolResult: `ERROR: unknown tool '${call.name}'` };
    }
  }

  private safeArgs(name: string, args: unknown): Record<string, unknown> {
    const a = (args ?? {}) as Record<string, unknown>;
    if (name === "type" || name === "select") {
      return { rationale: a.rationale, ref: a.ref, value: a.value };
    }
    return { ...a };
  }

  private async doNavigate(args: NavigateArgs) {
    const url = resolveNavigateUrl(args.url, this.baseUrl, this.routePrefix, this.inputs);
    const action: SurfaceAction = { type: "navigate", url };
    const gated = await this.gateAndAct(action, args.rationale);
    if (gated.stop) return { stop: gated.stop, acted: false, toolResult: `ERROR: ${gated.stop.kind}` };
    const step = this.record({
      rationale: args.rationale,
      tool: "navigate",
      action: { type: "navigate", url: this.relativeForArtifact(args.url) },
      risk: gated.risk,
      urlAfter: gated.outcome.urlAfter,
    });
    return { acted: true, toolResult: gated.outcome.ok ? `OK navigated to ${gated.outcome.urlAfter}` : `ERROR: ${gated.outcome.error}`, step };
  }

  private async doClick(args: { rationale: string; ref: string }) {
    const el = this.requireEl(args.ref);
    if (!el) return { acted: false, toolResult: `ERROR: unknown or expired ref '${args.ref}'` };
    const target = targetFromObserved(el);
    const action: SurfaceAction = { type: "click", ref: args.ref };
    const gated = await this.gateAndAct(action, args.rationale, target);
    if (gated.stop) return { stop: gated.stop, acted: false, toolResult: `ERROR: ${gated.stop.kind}` };
    const step = this.record({
      rationale: args.rationale,
      tool: "click",
      ref: args.ref,
      target,
      action: { type: "click" },
      risk: gated.risk,
      urlAfter: gated.outcome.urlAfter,
    });
    return { acted: true, toolResult: gated.outcome.ok ? "OK click" : `ERROR: ${gated.outcome.error}`, step };
  }

  private async doType(args: TypeArgs) {
    const el = this.requireEl(args.ref);
    if (!el) return { acted: false, toolResult: `ERROR: unknown or expired ref '${args.ref}'` };
    let resolved: ResolvedValue;
    try {
      resolved = resolveTypedValue(args.value, this.goal, this.inputs, this.secrets);
    } catch (err) {
      return { acted: false, toolResult: `ERROR: ${(err as Error).message}` };
    }
    const target = targetFromObserved(el);
    const action: SurfaceAction = { type: "type", ref: args.ref, text: resolved.text, clear: true, sensitive: resolved.sensitive };
    const gated = await this.gateAndAct(action, args.rationale, target);
    if (gated.stop) return { stop: gated.stop, acted: false, toolResult: `ERROR: ${gated.stop.kind}` };
    const step = this.record({
      rationale: args.rationale,
      tool: "type",
      ref: args.ref,
      target,
      action: { type: "type", value: resolved.ref, clear: true },
      risk: gated.risk,
      urlAfter: gated.outcome.urlAfter,
    });
    const shown = resolved.ref.kind === "literal" ? "literal" : `${resolved.ref.kind}:${resolved.ref.name}`;
    return { acted: true, toolResult: gated.outcome.ok ? `OK typed ${shown}` : `ERROR: ${gated.outcome.error}`, step };
  }

  private async doSelect(args: SelectArgs) {
    const el = this.requireEl(args.ref);
    if (!el) return { acted: false, toolResult: `ERROR: unknown or expired ref '${args.ref}'` };
    let resolved: ResolvedValue;
    try {
      resolved = resolveTypedValue(args.value, this.goal, this.inputs, this.secrets);
    } catch (err) {
      return { acted: false, toolResult: `ERROR: ${(err as Error).message}` };
    }
    const target = targetFromObserved(el);
    const action: SurfaceAction = { type: "select", ref: args.ref, option: resolved.text, sensitive: resolved.sensitive };
    const gated = await this.gateAndAct(action, args.rationale, target);
    if (gated.stop) return { stop: gated.stop, acted: false, toolResult: `ERROR: ${gated.stop.kind}` };
    const step = this.record({
      rationale: args.rationale,
      tool: "select",
      ref: args.ref,
      target,
      action: { type: "select", value: resolved.ref },
      risk: gated.risk,
      urlAfter: gated.outcome.urlAfter,
    });
    return { acted: true, toolResult: gated.outcome.ok ? "OK select" : `ERROR: ${gated.outcome.error}`, step };
  }

  private async doExtract(args: ExtractArgs) {
    const el = this.requireEl(args.ref);
    if (!el) return { acted: false, toolResult: `ERROR: unknown or expired ref '${args.ref}'` };
    const target = targetFromObserved(el);
    let text: string;
    try {
      text = await this.surface.extract(args.ref, { read: args.read });
    } catch (err) {
      return { acted: false, toolResult: `ERROR: ${(err as Error).message}` };
    }
    if (this.redactor && (this.goal.outputs[args.name]?.sensitivity === "pii" || this.goal.outputs[args.name]?.sensitivity === "secret")) {
      this.redactor.addValue(text, this.goal.outputs[args.name]!.sensitivity, args.name);
    }
    const step = this.record({
      rationale: args.rationale,
      tool: "extract",
      ref: args.ref,
      target,
      action: { type: "extract", outputs: [args.name] },
      risk: "safe",
      extractName: args.name,
      extractRead: args.read,
      extractedText: text,
    });
    this.emit("extraction", { name: args.name, read: args.read }, step.id, args.rationale);
    return { acted: true, toolResult: `OK extracted ${args.name}`, step };
  }

  private requireEl(ref: string): ObservedElement | undefined {
    return this.lastObs ? lookup(this.lastObs, ref) : undefined;
  }

  private relativeForArtifact(url: string): string {
    if (/^https?:\/\//i.test(url)) {
      try {
        const u = new URL(url);
        const base = new URL(this.baseUrl);
        if (u.origin === base.origin) {
          let path = u.pathname + u.search;
          if (this.routePrefix && (path === this.routePrefix || path.startsWith(`${this.routePrefix}/`))) {
            path = path.slice(this.routePrefix.length) || "/";
          }
          return path;
        }
      } catch {
        return url;
      }
    }
    return url.startsWith("/") ? url : `/${url}`;
  }

  private async gateAndAct(
    action: SurfaceAction,
    rationale: string,
    target?: RecordedTarget,
  ): Promise<{
    stop?: StopReason;
    risk: RiskClass;
    outcome: { ok: boolean; error?: string; urlAfter: string; durationMs: number };
  }> {
    const pageText = this.lastObs ? Object.values(this.lastObs.textByFrame).join("\n") : undefined;
    const assessed = classifyRisk({
      action,
      target: target?.fingerprint,
      pageText,
      fallback: "reversible",
    });
    const currentUrl = this.lastObs?.url ?? (await this.surface.currentUrl());
    const decision = this.policy.evaluate({
      actor: "agent",
      action,
      risk: assessed.risk,
      currentUrl,
      target: target?.fingerprint,
      invocationId: this.invocationId,
      capabilityId: this.goal.id,
      grants: this.grants,
    });
    this.emit("policy_decision", { verdict: decision.verdict, ruleId: decision.ruleId, reason: decision.reason, risk: assessed.risk }, undefined, rationale);

    if (decision.verdict === "deny" || decision.verdict === "escalate") {
      return {
        stop: { kind: "policy_denied", reason: decision.reason, verdict: decision.verdict },
        risk: assessed.risk,
        outcome: { ok: false, error: decision.reason, urlAfter: currentUrl, durationMs: 0 },
      };
    }

    this.emit("action", { type: action.type, ref: "ref" in action ? action.ref : undefined }, undefined, rationale);
    const outcome = await this.surface.act(action);
    this.emit("action_result", { ok: outcome.ok, error: outcome.error ?? null, urlAfter: outcome.urlAfter }, undefined, rationale);
    return { risk: assessed.risk, outcome };
  }

  private record(
    partial: Omit<RecordedStep, "id" | "intent"> & { rationale: string },
  ): RecordedStep {
    const id = slugStepId(this.steps.length + 1, partial.rationale);
    const step: RecordedStep = {
      id,
      intent: partial.rationale,
      tool: partial.tool,
      rationale: partial.rationale,
      action: partial.action,
      risk: partial.risk,
      snapshotHashBefore: this.lastObs?.snapshotHash,
      urlBefore: this.lastObs?.url,
      ...(partial.ref !== undefined && { ref: partial.ref }),
      ...(partial.target && { target: partial.target }),
      ...(partial.extractName !== undefined && { extractName: partial.extractName }),
      ...(partial.extractRead !== undefined && { extractRead: partial.extractRead }),
      ...(partial.extractedText !== undefined && { extractedText: partial.extractedText }),
      ...(partial.urlAfter !== undefined && { urlAfter: partial.urlAfter }),
    };
    this.steps.push(step);
    return step;
  }

  private emit(type: Parameters<EvidenceSink["append"]>[0]["type"], payload: object, stepId?: string, rationale?: string): void {
    if (!this.evidence) return;
    const body = this.redactor ? this.redactor.redact(payload) : (payload as never);
    this.evidence.append({
      actor: "agent",
      type,
      payload: body,
      ...(stepId ? { stepId } : {}),
      ...(rationale ? { rationale } : {}),
    });
  }
}

export async function discover(opts: DiscoveryOptions): Promise<DiscoveryResult> {
  return new DiscoveryAgent(opts).run();
}
