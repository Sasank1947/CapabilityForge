import type { ObservedElement } from "../surface/types.js";
import type { DiscoveryGoal, RecordedStep, RecordedTarget, RunTrace } from "../agent/types.js";
import { withContentHash } from "./hash.js";
import {
  parseArtifact,
  type CapabilityArtifact,
  type Condition,
  type LocatorStrategy,
  type OutputField,
  type ScreenState,
  type Step,
  type TargetDescriptor,
  type TargetFingerprint,
  type Transform,
} from "./schema.js";

export const COMPILER_VERSION = "capabilityforge-compiler/0.1.0";

export interface CompileOptions {
  status?: CapabilityArtifact["status"];
  includeDefaultScreenStates?: boolean;
  recordedOnTenant?: string;
}

export function fingerprintFromObserved(el: ObservedElement): TargetFingerprint {
  return {
    ...(el.role ? { role: el.role } : {}),
    ...(el.name ? { name: el.name } : {}),
    ...(el.tag ? { tag: el.tag } : {}),
    ...(el.labelText ? { labelText: el.labelText } : {}),
    ...(el.text ? { text: el.text } : {}),
    ...(el.bbox ? { bbox: el.bbox } : {}),
  };
}

export function targetDescription(fp: TargetFingerprint, fallback = "control"): string {
  return fp.name || fp.labelText || fp.text || fp.role || fallback;
}

function applyTemplates(text: string, runtimeInputs: Record<string, string>): string {
  let out = text;
  for (const [name, value] of Object.entries(runtimeInputs)) {
    if (!value) continue;
    if (out === value) out = `{{${name}}}`;
  }
  return out;
}

/**
 * Ranked locator strategies from a fingerprint captured at action time.
 * Runtime input values that match name/text/label are rewritten to `{{param}}`.
 */
export function strategiesFromFingerprint(fp: TargetFingerprint, runtimeInputs: Record<string, string> = {}): LocatorStrategy[] {
  const strategies: LocatorStrategy[] = [];
  const name = fp.name ? applyTemplates(fp.name, runtimeInputs) : undefined;
  const label = fp.labelText ? applyTemplates(fp.labelText, runtimeInputs) : undefined;
  const text = fp.text ? applyTemplates(fp.text, runtimeInputs) : undefined;

  if (fp.role && name) {
    strategies.push({ kind: "role", role: fp.role, name, exact: true });
  }
  if (label) {
    strategies.push({
      kind: "label",
      labelText: label,
      relation: "right-of",
      ...(fp.role ? { controlRole: fp.role } : {}),
      exact: true,
    });
  }
  if (text && text !== name) {
    strategies.push({ kind: "text", text, exact: true });
  }
  if (name && !fp.role && !strategies.some((s) => s.kind === "text")) {
    strategies.push({ kind: "text", text: name, exact: true });
  }
  const anchor = name || label || text;
  if (anchor) {
    strategies.push({ kind: "visual", anchorText: anchor, direction: "inside", note: "recorded at action time" });
  }
  if (strategies.length === 0) {
    strategies.push({ kind: "visual", anchorText: fp.role || "control", direction: "inside", note: "fingerprint had no name or label" });
  }
  return strategies;
}

export function compileTarget(target: RecordedTarget, runtimeInputs: Record<string, string> = {}): TargetDescriptor {
  return {
    description: target.description,
    framePath: target.framePath,
    strategies: strategiesFromFingerprint(target.fingerprint, runtimeInputs),
    cardinality: "exactlyOne",
    fingerprint: target.fingerprint,
  };
}

function relativePath(url: string, baseUrl?: string, routePrefix = ""): string {
  try {
    const u = new URL(url, baseUrl || "http://local.invalid");
    let path = u.pathname || "/";
    if (routePrefix && (path === routePrefix || path.startsWith(`${routePrefix}/`))) {
      path = path.slice(routePrefix.length) || "/";
    }
    return path + u.search;
  } catch {
    return url.startsWith("/") ? url : `/${url}`;
  }
}

function defaultTransforms(type: OutputField["type"]): Transform[] {
  if (type === "number") return [{ kind: "trim" }, { kind: "parseNumber", allowCurrency: true }];
  if (type === "integer") return [{ kind: "trim" }, { kind: "parseInteger" }];
  if (type === "boolean") return [{ kind: "trim" }, { kind: "parseBoolean", truthy: ["true", "yes", "y", "1"] }];
  return [{ kind: "trim" }];
}

function compileOutputs(trace: RunTrace): Record<string, OutputField> {
  const out: Record<string, OutputField> = {};
  for (const [name, decl] of Object.entries(trace.goal.outputs)) {
    const extract = [...trace.steps].reverse().find((s) => s.tool === "extract" && s.extractName === name && s.target);
    out[name] = {
      type: decl.type,
      description: decl.description,
      sensitivity: decl.sensitivity,
      ...(extract?.target
        ? {
            extraction: {
              target: compileTarget(extract.target, trace.runtimeInputs),
              read: extract.extractRead ?? "text",
              transforms: defaultTransforms(decl.type),
            },
          }
        : {}),
    };
  }
  for (const step of trace.steps) {
    if (step.tool !== "extract" || !step.extractName || out[step.extractName]) continue;
    out[step.extractName] = {
      type: "string",
      description: step.intent,
      sensitivity: "internal",
      ...(step.target
        ? {
            extraction: {
              target: compileTarget(step.target, trace.runtimeInputs),
              read: step.extractRead ?? "text",
              transforms: [{ kind: "trim" }],
            },
          }
        : {}),
    };
  }
  return out;
}

function compileSteps(trace: RunTrace): Step[] {
  return trace.steps.map((s) => {
    const step: Step = {
      id: s.id,
      intent: s.intent,
      action: s.action,
      risk: s.risk,
      preconditions: [],
      timeoutMs: 10_000,
      ...(s.target && s.action.type !== "navigate" && s.action.type !== "extract" ? { target: compileTarget(s.target, trace.runtimeInputs) } : {}),
    };
    return step;
  });
}

function successCheckpoint(trace: RunTrace): { description: string; condition: Condition } {
  const evidence = trace.doneEvidence?.trim();
  if (evidence) {
    return { description: evidence, condition: { kind: "textPresent", text: evidence.slice(0, 120) } };
  }
  const lastExtract = [...trace.steps].reverse().find((s) => s.tool === "extract" && s.target);
  if (lastExtract?.target) {
    return {
      description: `Extracted ${lastExtract.extractName ?? "output"} is visible`,
      condition: { kind: "visible", target: compileTarget(lastExtract.target, trace.runtimeInputs) },
    };
  }
  const lastUrl = trace.steps.at(-1)?.urlAfter ?? trace.appObserved?.url;
  if (lastUrl) {
    const path = relativePath(lastUrl);
    return { description: `Landed on ${path}`, condition: { kind: "urlMatches", pattern: path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") } };
  }
  return { description: "Discovery declared done", condition: { kind: "titleMatches", pattern: "." } };
}

function defaultScreenStates(): ScreenState[] {
  return [
    {
      id: "memberNotFound",
      description: "Search returned no matching member",
      detect: { kind: "textPresent", text: "NO RECORD FOUND FOR MEMBER" },
      priority: 10,
      handler: { kind: "outcome", code: "MEMBER_NOT_FOUND", message: "No member with that number", outputs: [] },
    },
    {
      id: "sessionExpired",
      description: "Session timed out back to sign-on",
      detect: {
        kind: "any",
        conditions: [
          { kind: "textPresent", text: "SESSION TIMED OUT" },
          { kind: "textPresent", text: "PLEASE SIGN ON AGAIN" },
        ],
      },
      priority: 20,
      handler: { kind: "fail", failureKind: "timeout", message: "Session expired" },
    },
    {
      id: "maintenanceDialog",
      description: "System maintenance interstitial",
      detect: { kind: "textPresent", text: "System maintenance tonight" },
      priority: 15,
      handler: { kind: "escalate", reason: "Unexpected maintenance dialog" },
    },
    {
      id: "serverError",
      description: "Application 500 page",
      detect: {
        kind: "any",
        conditions: [
          { kind: "titleMatches", pattern: "^500" },
          { kind: "textPresent", text: "Internal Server Error" },
        ],
      },
      priority: 30,
      handler: { kind: "fail", failureKind: "app_error", message: "Application returned a server error" },
    },
  ];
}

function firstNavigatePath(trace: RunTrace, goal: DiscoveryGoal): string {
  const nav = trace.steps.find((s) => s.action.type === "navigate");
  if (nav && nav.action.type === "navigate") return relativePath(nav.action.url);
  return goal.app.entryRoute;
}

export function compileTrace(trace: RunTrace, options: CompileOptions = {}): CapabilityArtifact {
  if (trace.steps.length === 0) {
    throw new Error("cannot compile an empty discovery trace");
  }
  const goal = trace.goal;
  const outputs = compileOutputs(trace);
  // Drop outputs that have extraction rules but no extract step (schema forbids that).
  for (const [name, field] of Object.entries(outputs)) {
    if (!field.extraction) continue;
    const used = trace.steps.some((s) => s.action.type === "extract" && s.action.outputs.includes(name));
    if (!used) delete field.extraction;
  }

  const draft = {
    schemaVersion: "capabilityforge/v1" as const,
    id: goal.id,
    version: goal.version ?? "0.1.0",
    status: options.status ?? "draft",
    title: goal.title,
    description: goal.description,
    provenance: {
      source: "discovery" as const,
      discoveryRunId: trace.runId,
      model: trace.model,
      recordedAt: trace.finishedAt,
      recordedOnTenant: options.recordedOnTenant,
      compilerVersion: COMPILER_VERSION,
    },
    app: {
      ...goal.app,
      entryRoute: firstNavigatePath(trace, goal),
    },
    inputs: goal.inputs,
    outputs,
    secrets: goal.secrets,
    steps: compileSteps(trace),
    screenStates: options.includeDefaultScreenStates === false ? [] : defaultScreenStates(),
    successCheckpoint: successCheckpoint(trace),
  };

  return withContentHash(parseArtifact(draft));
}

export function compileGoalDefaults(goal: DiscoveryGoal): Pick<CapabilityArtifact, "id" | "title" | "description" | "app"> {
  return { id: goal.id, title: goal.title, description: goal.description, app: goal.app };
}
