import { readFileSync } from "node:fs";
import { z } from "zod";
import type { RiskClass, TargetFingerprint } from "../artifact/schema.js";
import type { SurfaceAction, SurfaceActionType } from "../surface/types.js";
import { PolicyConfig, type PolicyConfigInput } from "./types.js";

function compiles(source: string): boolean {
  try {
    new RegExp(source, "i");
    return true;
  } catch {
    return false;
  }
}

/** Strict: an unknown key in a security config is far more likely a typo than an extension. */
const PolicyFile = PolicyConfig.extend({ $schema: z.string().optional(), $comment: z.string().optional() })
  .strict()
  .superRefine((p, ctx) => {
    p.blockedTargets.forEach((b, i) => {
      if (!compiles(b.namePattern)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["blockedTargets", i, "namePattern"], message: "invalid regex" });
      }
    });
    p.allowedRoutes.forEach((r, i) => {
      if (/[?#]/.test(r)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["allowedRoutes", i], message: "route globs match pathnames only" });
      }
    });
  });

export class PolicyConfigError extends Error {
  constructor(
    readonly source: string,
    readonly issues: z.ZodIssue[],
  ) {
    super(`invalid policy ${source}:\n${issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n")}`);
    this.name = "PolicyConfigError";
  }
}

export function parsePolicy(data: unknown, source = "(inline)"): PolicyConfig {
  const r = PolicyFile.safeParse(data);
  if (!r.success) throw new PolicyConfigError(source, r.error.issues);
  const { $schema: _s, $comment: _c, ...config } = r.data;
  return config;
}

/** Loads a JSON policy file. `overrides` replace top-level keys (e.g. a CLI `--origin`). */
export function loadPolicy(path: string, overrides: Partial<PolicyConfigInput> = {}): PolicyConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`cannot read policy ${path}: ${(err as Error).message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PolicyConfigError(path, [{ code: z.ZodIssueCode.custom, path: [], message: "policy must be a JSON object" }]);
  }
  return parsePolicy({ ...raw, ...overrides }, path);
}

// ---------------------------------------------------------------------------
// Discovery-mode risk classification
// ---------------------------------------------------------------------------

export interface RiskContext {
  action: SurfaceAction | { type: SurfaceActionType; url?: string; key?: string };
  target?: TargetFingerprint;
  /** Visible text of the screen (all frames) the action happens on. */
  pageText?: string;
  /** Used for anything no rule recognises. */
  fallback?: RiskClass;
}

export interface RiskAssessment {
  risk: RiskClass;
  reason: string;
}

const FINALITY_TEXT =
  /posting is final|cannot be (?:undone|reversed|cancell?ed)|can ?not be (?:undone|reversed)|irreversible|non-?refundable|final (?:submission|confirmation)|permanently/i;
const DESTRUCTIVE =
  /\b(?:delete|remove|purge|erase|close\s+(?:the\s+)?account|wire|transfer\s+funds|void|reverse|charge[\s-]?off|terminate|write[\s-]?off|disburse)\b/i;
const COMMIT =
  /\b(?:submit|commit|post|confirm|finali[sz]e|approve|authori[sz]e|execute|pay|send|place\s+order|process|complete)\b/i;
const RETREAT = /\b(?:back|cancel|return|close|dismiss|previous|home|menu|help)\b/i;
const READ_ONLY =
  /\b(?:search|find|look\s*up|lookup|inquiry|inquire|query|view|show|details?|refresh|next|prev(?:ious)?\s+page|filter|sort|expand|print\s+preview)\b/i;
const NAV_DESTRUCTIVE = /\/(?:delete|remove|commit|void|reverse|wire|transfer)(?:[/?#]|$)/i;

/**
 * Infers a risk class for an agent action during discovery, where no artifact
 * step declares one. Conservative: anything commit-like is irreversible, and
 * only clearly read-only or retreating controls are classed safe.
 */
export function classifyRisk(ctx: RiskContext): RiskAssessment {
  const fallback = ctx.fallback ?? "reversible";
  const { action } = ctx;
  const name = [ctx.target?.name, ctx.target?.labelText, ctx.target?.text].filter(Boolean).join(" ").trim();
  const finalScreen = ctx.pageText !== undefined && FINALITY_TEXT.test(ctx.pageText);

  if (action.type === "navigate") {
    const url = "url" in action && action.url ? action.url : "";
    if (NAV_DESTRUCTIVE.test(url)) return { risk: "irreversible", reason: `navigation to state-changing path '${url}'` };
    return { risk: "safe", reason: "navigation (GET)" };
  }

  if (name && DESTRUCTIVE.test(name)) return { risk: "irreversible", reason: `destructive control '${name}'` };

  if (action.type === "type" || action.type === "select" || action.type === "check") {
    return { risk: "reversible", reason: "edits local form state only" };
  }

  // click or press: a press without a recognisable target submits whatever form has focus.
  const key = "key" in action ? String(action.key) : "";
  const isEnter = action.type === "press" && /^(?:enter|return|numpadenter)$/i.test(key);
  if (action.type === "press" && !isEnter && !name) return { risk: "reversible", reason: `key press '${key}'` };

  if (name && RETREAT.test(name) && !COMMIT.test(name)) return { risk: "safe", reason: `retreating control '${name}'` };
  if (finalScreen) {
    return { risk: "irreversible", reason: `'${name || "Enter"}' on a screen that states the action is final` };
  }
  if (name && COMMIT.test(name)) return { risk: "irreversible", reason: `commit-like control '${name}'` };
  if (name && READ_ONLY.test(name)) return { risk: "safe", reason: `read-only control '${name}'` };
  return { risk: fallback, reason: name ? `unrecognised control '${name}'; using default` : "no target context; using default" };
}
