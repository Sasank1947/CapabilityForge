import type { LocatorStrategy, TargetDescriptor } from "../artifact/schema.js";
import type { StrategyAttempt } from "./types.js";

/**
 * The resolution ladder, independent of any concrete surface. A surface supplies
 * `findFrame` (frame path -> frame handle) and `match` (one strategy -> candidate
 * handles, already filtered to visible/actionable elements); this module applies
 * rank order and the cardinality contract.
 *
 * Semantics:
 * - Strategies are tried strictly in declared order inside `target.framePath`.
 * - With `exactlyOne`, a strategy that yields more than one candidate is *ambiguous*:
 *   it never wins by first-match. The ladder falls through to the next strategy (a
 *   more specific one may still be unique, and that hit is reported as a fallback).
 * - If no strategy yields an acceptable match, the failure reason is `ambiguous` when
 *   any strategy matched more than one element, otherwise `not_found`.
 * - `visual` strategies are descriptive (for vision surfaces and reviewers) and are
 *   recorded with 0 matches by DOM surfaces.
 */
export type LadderResult<H> =
  | { ok: true; handle: H; strategyIndex: number; strategyKind: LocatorStrategy["kind"]; attempts: StrategyAttempt[] }
  | { ok: false; reason: "not_found" | "ambiguous" | "frame_not_found"; attempts: StrategyAttempt[] };

export async function resolveLadder<F, H>(
  target: TargetDescriptor,
  templateValues: Record<string, string>,
  findFrame: (framePath: string[]) => Promise<F | null>,
  match: (frame: F, strategy: LocatorStrategy) => Promise<H[]>,
): Promise<LadderResult<H>> {
  const frame = await findFrame(target.framePath ?? []);
  if (frame === null) return { ok: false, reason: "frame_not_found", attempts: [] };

  const attempts: StrategyAttempt[] = [];
  let sawAmbiguous = false;
  for (const [i, raw] of target.strategies.entries()) {
    const strategy = applyTemplates(raw, templateValues);
    const handles = strategy.kind === "visual" ? [] : await match(frame, strategy);
    attempts.push({ strategyIndex: i, strategyKind: strategy.kind, matches: handles.length });
    if (handles.length === 0) continue;
    if (handles.length === 1 || target.cardinality === "atLeastOne") {
      return { ok: true, handle: handles[0]!, strategyIndex: i, strategyKind: strategy.kind, attempts };
    }
    sawAmbiguous = true;
  }
  return { ok: false, reason: sawAmbiguous ? "ambiguous" : "not_found", attempts };
}

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;

/** Substitutes `{{name}}` placeholders; unknown placeholders are left intact (and so will not match). */
export function substituteTemplate(s: string, values: Record<string, string>): string {
  return s.replace(PLACEHOLDER_RE, (whole, name: string) => (name in values ? values[name]! : whole));
}

export function applyTemplates(strategy: LocatorStrategy, values: Record<string, string>): LocatorStrategy {
  switch (strategy.kind) {
    case "role":
      return { ...strategy, name: substituteTemplate(strategy.name, values) };
    case "label":
      return { ...strategy, labelText: substituteTemplate(strategy.labelText, values) };
    case "text":
      return { ...strategy, text: substituteTemplate(strategy.text, values) };
    default:
      return strategy;
  }
}

/** Frame path segments match a frame's name, or (when starting with "/") its URL pathname. */
export function framePathMatches(wanted: string[], actual: { name: string; pathname: string }[]): boolean {
  if (wanted.length !== actual.length) return false;
  return wanted.every((seg, i) => {
    const a = actual[i]!;
    return seg.startsWith("/") ? a.pathname === seg || a.pathname.endsWith(seg) : a.name === seg;
  });
}
