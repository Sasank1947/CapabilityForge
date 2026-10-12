import { z } from "zod";
import { RiskClass, type TargetFingerprint } from "../artifact/schema.js";
import type { Actor } from "../evidence/types.js";
import type { SurfaceAction } from "../surface/types.js";

export const SURFACE_ACTION_TYPES = ["navigate", "click", "type", "select", "check", "press"] as const;

export const RiskHandling = z.enum(["allow", "require_grant", "escalate", "deny"]);
export type RiskHandling = z.infer<typeof RiskHandling>;

export const BlockedTarget = z.object({
  role: z.string().optional(),
  /** Regex source matched against the target's accessible name or label text. */
  namePattern: z.string().min(1),
  reason: z.string().min(1),
});
export type BlockedTarget = z.infer<typeof BlockedTarget>;

/** An exact origin ("http://localhost:4100") or a host with any port ("http://127.0.0.1:*"). */
export const OriginPattern = z
  .string()
  .refine((s) => /^https?:\/\/[^/:*?#@\s]+:\*$/.test(s) || URL.canParse(s), {
    message: 'must be an origin like "http://localhost:4100" or "http://127.0.0.1:*"',
  });

export const PolicyConfig = z.object({
  allowedOrigins: z.array(OriginPattern).min(1),
  /** Glob patterns over URL pathnames ("*" = one segment, "**" = any depth). */
  allowedRoutes: z.array(z.string().startsWith("/")).min(1),
  allowedActions: z.array(z.enum(SURFACE_ACTION_TYPES)).min(1),
  blockedTargets: z.array(BlockedTarget).default([]),
  risk: z
    .object({
      safe: RiskHandling.default("allow"),
      reversible: RiskHandling.default("allow"),
      irreversible: RiskHandling.default("require_grant"),
    })
    .default({}),
  /** Human actions are never blocked (the human is the escape hatch) but are evaluated and logged. */
  humanMode: z.literal("log_only").default("log_only"),
  /** Risk assumed for agent actions during discovery, where no artifact step declares one. */
  discoveryDefaultRisk: RiskClass.default("reversible"),
});
export type PolicyConfig = z.infer<typeof PolicyConfig>;
export type PolicyConfigInput = z.input<typeof PolicyConfig>;

/** Per-invocation permission, e.g. `--approve irreversible` on a replay. */
export const Grant = z.object({
  kind: z.literal("approve_irreversible"),
  invocationId: z.string(),
  capabilityId: z.string().optional(),
  /** Omitted means every irreversible step of this invocation. */
  stepId: z.string().optional(),
  grantedBy: z.string(),
  grantedAt: z.string().datetime({ offset: true }),
});
export type Grant = z.infer<typeof Grant>;

export interface PolicyRequest {
  actor: Actor;
  action: SurfaceAction;
  risk: RiskClass;
  /** URL the action runs on; for navigate, the destination is taken from the action. */
  currentUrl: string;
  target?: TargetFingerprint;
  invocationId: string;
  capabilityId?: string;
  stepId?: string;
  grants: Grant[];
}

export type PolicyRuleId =
  | "origin_allowlist"
  | "route_allowlist"
  | "action_allowlist"
  | "blocked_target"
  | "risk_class"
  | "grant"
  | "human_log_only";

export type PolicyDecision =
  | { verdict: "allow"; ruleId: PolicyRuleId; reason: string; grant?: Grant }
  | { verdict: "deny"; ruleId: PolicyRuleId; reason: string }
  | { verdict: "escalate"; ruleId: PolicyRuleId; reason: string; requiredGrant?: Grant["kind"] }
  /** Returned for every human action; `wouldHaveBeen` is the verdict automation would have received. */
  | {
      verdict: "logged";
      ruleId: "human_log_only";
      reason: string;
      wouldHaveBeen: "allow" | "deny" | "escalate";
      underlyingRuleId?: PolicyRuleId;
    };

export type PolicyVerdict = PolicyDecision["verdict"];

export interface PolicyGate {
  evaluate(request: PolicyRequest): PolicyDecision;
}
