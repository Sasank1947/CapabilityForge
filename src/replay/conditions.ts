import type { Condition, Transform, ValueRef } from "../artifact/schema.js";
import { substituteTemplate } from "../surface/resolve.js";
import type { Observation, Surface } from "../surface/types.js";

export interface EvalContext {
  surface: Surface;
  observation: Observation;
  templateValues: Record<string, string>;
  resolveValue: (ref: ValueRef) => string;
}

function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function textsFor(obs: Observation, framePath?: string[]): string[] {
  if (framePath) {
    const key = framePath.join("/");
    const exact = obs.textByFrame[key];
    return exact !== undefined ? [exact] : [];
  }
  return Object.values(obs.textByFrame);
}

function titlesOf(obs: Observation): string[] {
  return [obs.title, ...obs.frames.map((f) => f.title ?? "")].filter(Boolean);
}

function textMatches(actual: string, wanted: string, exact?: boolean): boolean {
  const a = norm(actual);
  const w = norm(wanted);
  if (!w) return false;
  return exact ? a === w : a.toLowerCase().includes(w.toLowerCase());
}

/**
 * Evaluates a condition against the current observation (and, for visibility /
 * value checks, a live resolve). Used for preconditions, postconditions,
 * checkpoints and screen-state detectors.
 */
export async function evalCondition(cond: Condition, ctx: EvalContext): Promise<boolean> {
  switch (cond.kind) {
    case "all": {
      for (const c of cond.conditions) if (!(await evalCondition(c, ctx))) return false;
      return true;
    }
    case "any": {
      for (const c of cond.conditions) if (await evalCondition(c, ctx)) return true;
      return false;
    }
    case "not":
      return !(await evalCondition(cond.condition, ctx));
    case "textPresent": {
      const wanted = substituteTemplate(cond.text, ctx.templateValues);
      return textsFor(ctx.observation, cond.framePath).some((t) => textMatches(t, wanted, cond.exact));
    }
    case "textAbsent": {
      const wanted = substituteTemplate(cond.text, ctx.templateValues);
      return !textsFor(ctx.observation, cond.framePath).some((t) => textMatches(t, wanted, cond.exact));
    }
    case "urlMatches": {
      const pattern = substituteTemplate(cond.pattern, ctx.templateValues);
      return new RegExp(pattern).test(ctx.observation.url);
    }
    case "titleMatches": {
      const pattern = substituteTemplate(cond.pattern, ctx.templateValues);
      const re = new RegExp(pattern);
      return titlesOf(ctx.observation).some((t) => re.test(t));
    }
    case "visible": {
      const res = await ctx.surface.resolve(cond.target, { templateValues: ctx.templateValues, timeoutMs: 0 });
      return res.ok;
    }
    case "hidden": {
      const res = await ctx.surface.resolve(cond.target, { templateValues: ctx.templateValues, timeoutMs: 0 });
      return !res.ok;
    }
    case "valueEquals": {
      const res = await ctx.surface.resolve(cond.target, { templateValues: ctx.templateValues, timeoutMs: 0 });
      if (!res.ok) return false;
      const actual = await ctx.surface.extract(res.ref, { read: "value" });
      return norm(actual) === norm(ctx.resolveValue(cond.value));
    }
  }
}

export function parseNumber(raw: string, allowCurrency = true): number {
  let t = raw.replace(/\s+/g, "").trim();
  const paren = /^\((.*)\)$/.exec(t);
  const neg = paren !== null;
  if (paren) t = paren[1] ?? "";
  if (allowCurrency) t = t.replace(/[$€£¥]/g, "");
  t = t.replace(/,/g, "");
  const n = Number(t);
  if (!Number.isFinite(n)) throw new Error(`not a number: ${raw}`);
  return neg ? -n : n;
}

export function applyTransforms(raw: string, transforms: Transform[]): string | number | boolean {
  let value: string | number | boolean = raw;
  for (const t of transforms) {
    switch (t.kind) {
      case "trim":
        value = String(value).trim();
        break;
      case "regex": {
        const m = new RegExp(t.pattern).exec(String(value));
        value = m?.[t.group] ?? "";
        break;
      }
      case "parseNumber":
        value = parseNumber(String(value), t.allowCurrency);
        break;
      case "parseInteger": {
        const n = parseNumber(String(value), true);
        if (!Number.isInteger(n)) throw new Error(`not an integer: ${value}`);
        value = n;
        break;
      }
      case "parseBoolean":
        value = t.truthy.some((x) => x.toLowerCase() === String(value).trim().toLowerCase());
        break;
      case "parseDate":
        value = String(value).trim();
        break;
    }
  }
  return value;
}

export function describeCondition(cond: Condition): string {
  switch (cond.kind) {
    case "visible":
      return `visible:${cond.target.description}`;
    case "hidden":
      return `hidden:${cond.target.description}`;
    case "textPresent":
      return `textPresent:${cond.text}`;
    case "textAbsent":
      return `textAbsent:${cond.text}`;
    case "urlMatches":
      return `urlMatches:${cond.pattern}`;
    case "titleMatches":
      return `titleMatches:${cond.pattern}`;
    case "valueEquals":
      return `valueEquals:${cond.target.description}`;
    case "all":
      return `all(${cond.conditions.map(describeCondition).join(" & ")})`;
    case "any":
      return `any(${cond.conditions.map(describeCondition).join(" | ")})`;
    case "not":
      return `not(${describeCondition(cond.condition)})`;
  }
}
