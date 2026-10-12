import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  parseArtifact,
  TenantOverlay,
  type CapabilityArtifact,
  type Condition,
  type LocatorStrategy,
  type Step,
  type TargetDescriptor,
} from "./schema.js";

export class OverlayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OverlayError";
  }
}

export interface OverlayListing {
  tenant: string;
  baseId: string;
  baseVersionRange: string;
  path: string;
}

export function parseOverlay(data: unknown): TenantOverlay {
  return TenantOverlay.parse(data);
}

export function loadOverlay(filePath: string): TenantOverlay {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (err) {
    throw new OverlayError(`cannot read overlay ${filePath}: ${(err as Error).message}`);
  }
  try {
    return parseOverlay(JSON.parse(text));
  } catch (err) {
    if (err instanceof OverlayError) throw err;
    throw new OverlayError(`invalid overlay ${filePath}: ${(err as Error).message}`);
  }
}

/** Overlay JSON files in `dir` (non-recursive). */
export function listOverlays(dir: string): OverlayListing[] {
  const root = resolve(dir);
  if (!existsSync(root)) return [];
  const out: OverlayListing[] = [];
  for (const name of readdirSync(root)) {
    if (!name.endsWith(".json")) continue;
    const path = join(root, name);
    try {
      const o = loadOverlay(path);
      out.push({ tenant: o.tenant, baseId: o.baseId, baseVersionRange: o.baseVersionRange, path });
    } catch {
      // Skip files that are not valid overlays.
    }
  }
  return out.sort((a, b) => a.tenant.localeCompare(b.tenant) || a.baseId.localeCompare(b.baseId) || basename(a.path).localeCompare(basename(b.path)));
}

export function findOverlay(dir: string, baseId: string, tenant: string): TenantOverlay | undefined {
  for (const listing of listOverlays(dir)) {
    if (listing.baseId === baseId && listing.tenant === tenant) return loadOverlay(listing.path);
  }
  return undefined;
}

export function resolveOverlayPath(spec: string, overlaysDir = "capabilities/overlays"): string {
  if (existsSync(spec) || spec.endsWith(".json")) return spec;
  const byName = join(overlaysDir, `${spec}.json`);
  if (existsSync(byName)) return byName;
  return spec;
}

interface Semver {
  major: number;
  minor: number;
  patch: number;
}

function parseSemver(s: string): Semver | null {
  const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)/.exec(s.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function cmpSemver(a: Semver, b: Semver): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

function satisfiesToken(version: Semver, token: string): boolean {
  if (token === "*" || token === "x" || token === "X") return true;
  if (token.startsWith("^")) {
    const t = parseSemver(token.slice(1));
    if (!t) return false;
    if (t.major === 0) return version.major === 0 && version.minor === t.minor && cmpSemver(version, t) >= 0;
    return version.major === t.major && cmpSemver(version, t) >= 0;
  }
  if (token.startsWith("~")) {
    const t = parseSemver(token.slice(1));
    return t !== null && version.major === t.major && version.minor === t.minor && cmpSemver(version, t) >= 0;
  }
  const m = /^(>=|<=|>|<|=)?(.+)$/.exec(token);
  if (!m) return false;
  const t = parseSemver(m[2]!);
  if (!t) return false;
  const c = cmpSemver(version, t);
  switch (m[1] || "=") {
    case ">=":
      return c >= 0;
    case "<=":
      return c <= 0;
    case ">":
      return c > 0;
    case "<":
      return c < 0;
    default:
      return c === 0;
  }
}

/** npm-style range fragments (`^1.0.0`, `>=7.4 <8`) combined with AND. */
export function versionSatisfies(version: string, range: string): boolean {
  const parsed = parseSemver(version);
  if (!parsed) return false;
  const tokens = range.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  return tokens.every((token) => satisfiesToken(parsed, token));
}

function rewriteLabels(text: string, labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort((a, b) => b.length - a.length);
  let out = text;
  for (const key of keys) {
    const to = labels[key];
    if (to === undefined || !out.includes(key)) continue;
    out = out.split(key).join(to);
  }
  return out;
}

function rewriteRoute(value: string, routes: TenantOverlay["routes"]): string {
  if (/^https?:\/\//i.test(value)) return value;
  const ordered = [...routes].sort((a, b) => b.fromPrefix.length - a.fromPrefix.length);
  for (const route of ordered) {
    if (value.startsWith(route.fromPrefix)) {
      return `${route.toPrefix}${value.slice(route.fromPrefix.length)}`;
    }
    const idx = value.indexOf(route.fromPrefix);
    if (idx > 0 && !/[A-Za-z0-9]/.test(value[idx - 1]!)) {
      return `${value.slice(0, idx)}${route.toPrefix}${value.slice(idx + route.fromPrefix.length)}`;
    }
  }
  return value;
}

function mapStrategy(strategy: LocatorStrategy, labels: Record<string, string>): LocatorStrategy {
  switch (strategy.kind) {
    case "role":
      return { ...strategy, name: rewriteLabels(strategy.name, labels) };
    case "label":
      return { ...strategy, labelText: rewriteLabels(strategy.labelText, labels) };
    case "text":
      return { ...strategy, text: rewriteLabels(strategy.text, labels) };
    default:
      return strategy;
  }
}

function mapTarget(target: TargetDescriptor, labels: Record<string, string>): TargetDescriptor {
  return {
    ...target,
    strategies: target.strategies.map((s) => mapStrategy(s, labels)),
    fingerprint: target.fingerprint
      ? {
          ...target.fingerprint,
          name: target.fingerprint.name !== undefined ? rewriteLabels(target.fingerprint.name, labels) : undefined,
          labelText: target.fingerprint.labelText !== undefined ? rewriteLabels(target.fingerprint.labelText, labels) : undefined,
          text: target.fingerprint.text !== undefined ? rewriteLabels(target.fingerprint.text, labels) : undefined,
        }
      : target.fingerprint,
  };
}

function mapCondition(cond: Condition, labels: Record<string, string>, routes: TenantOverlay["routes"]): Condition {
  switch (cond.kind) {
    case "all":
    case "any":
      return { ...cond, conditions: cond.conditions.map((c) => mapCondition(c, labels, routes)) };
    case "not":
      return { ...cond, condition: mapCondition(cond.condition, labels, routes) };
    case "textPresent":
    case "textAbsent":
      return { ...cond, text: rewriteLabels(cond.text, labels) };
    case "titleMatches":
      return { ...cond, pattern: rewriteLabels(cond.pattern, labels) };
    case "urlMatches":
      return { ...cond, pattern: rewriteRoute(cond.pattern, routes) };
    case "visible":
    case "hidden":
      return { ...cond, target: mapTarget(cond.target, labels) };
    case "valueEquals":
      return { ...cond, target: mapTarget(cond.target, labels) };
  }
}

function mapStep(step: Step, labels: Record<string, string>, routes: TenantOverlay["routes"]): Step {
  const action =
    step.action.type === "navigate" ? { ...step.action, url: rewriteRoute(step.action.url, routes) } : step.action;
  return {
    ...step,
    action,
    target: step.target ? mapTarget(step.target, labels) : step.target,
    preconditions: step.preconditions.map((c) => mapCondition(c, labels, routes)),
    postcondition: step.postcondition ? mapCondition(step.postcondition, labels, routes) : step.postcondition,
  };
}

/**
 * Specialize a reviewed base artifact for one tenant. Only labels, routes, locator
 * hints and extra interstitials change; inputs, outputs, step order and risk stay put.
 */
export function applyOverlay(artifact: CapabilityArtifact, overlay: TenantOverlay): CapabilityArtifact {
  if (overlay.baseId !== artifact.id) {
    throw new OverlayError(`overlay baseId '${overlay.baseId}' does not match artifact '${artifact.id}'`);
  }
  if (!versionSatisfies(artifact.version, overlay.baseVersionRange)) {
    throw new OverlayError(
      `overlay baseVersionRange '${overlay.baseVersionRange}' does not include artifact version '${artifact.version}'`,
    );
  }

  const next = structuredClone(artifact);

  for (const [stepId, patch] of Object.entries(overlay.targets)) {
    const step = next.steps.find((s) => s.id === stepId);
    if (!step) throw new OverlayError(`overlay target references unknown step '${stepId}'`);
    if (!step.target) throw new OverlayError(`overlay cannot prepend strategies on untargeted step '${stepId}'`);
    if (patch.prependStrategies.length > 0) {
      step.target = { ...step.target, strategies: [...patch.prependStrategies, ...step.target.strategies] };
    }
    if (patch.framePath !== undefined) {
      step.target = { ...step.target, framePath: patch.framePath };
    }
  }

  if (overlay.extraScreenStates.length > 0) {
    next.screenStates = [...next.screenStates, ...structuredClone(overlay.extraScreenStates)];
  }

  if (overlay.appFingerprint) {
    next.app = { ...next.app, fingerprint: { ...next.app.fingerprint, ...overlay.appFingerprint } };
  }

  next.app = { ...next.app, entryRoute: rewriteRoute(next.app.entryRoute, overlay.routes) };
  next.steps = next.steps.map((s) => mapStep(s, overlay.labels, overlay.routes));
  next.screenStates = next.screenStates.map((state) => {
    const handler =
      state.handler.kind === "recover"
        ? { ...state.handler, steps: state.handler.steps.map((s) => mapStep(s, overlay.labels, overlay.routes)) }
        : state.handler;
    return {
      ...state,
      detect: mapCondition(state.detect, overlay.labels, overlay.routes),
      handler,
    };
  });
  next.outputs = Object.fromEntries(
    Object.entries(next.outputs).map(([name, field]) => [
      name,
      field.extraction ? { ...field, extraction: { ...field.extraction, target: mapTarget(field.extraction.target, overlay.labels) } } : field,
    ]),
  );
  next.successCheckpoint = {
    ...next.successCheckpoint,
    condition: mapCondition(next.successCheckpoint.condition, overlay.labels, overlay.routes),
  };

  try {
    return parseArtifact(next);
  } catch (err) {
    throw new OverlayError(`overlay produced an invalid artifact: ${(err as Error).message}`);
  }
}
