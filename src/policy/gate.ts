import type { RiskClass, TargetFingerprint } from "../artifact/schema.js";
import type { Grant, PolicyConfig, PolicyDecision, PolicyGate, PolicyRequest, RiskHandling } from "./types.js";

type Verdict = Exclude<PolicyDecision, { verdict: "logged" }>;

interface CompiledBlock {
  role?: string;
  pattern: RegExp;
  reason: string;
}

/**
 * Glob over URL pathnames: "*" matches within one segment, "/**" matches zero or
 * more trailing/intermediate segments, everything else is literal (case-sensitive,
 * so case-variant paths fall through to deny).
 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; ) {
    if (glob.startsWith("/**", i)) {
      re += "(?:/.*)?";
      i += 3;
    } else if (glob.startsWith("**", i)) {
      re += ".*";
      i += 2;
    } else if (glob[i] === "*") {
      re += "[^/]*";
      i += 1;
    } else {
      re += glob[i]!.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}

type OriginMatcher = (url: URL) => boolean;

function compileOrigin(pattern: string): OriginMatcher {
  const wildcard = /^(https?):\/\/([^/:*?#@\s]+):\*$/.exec(pattern);
  if (wildcard) {
    const [, scheme, host] = wildcard;
    return (u) => u.protocol === `${scheme}:` && u.hostname === host!.toLowerCase();
  }
  const origin = new URL(pattern).origin;
  return (u) => u.origin === origin;
}

export function grantMatches(grant: Grant, req: Pick<PolicyRequest, "invocationId" | "capabilityId" | "stepId">): boolean {
  if (grant.kind !== "approve_irreversible") return false;
  if (grant.invocationId !== req.invocationId) return false;
  if (grant.capabilityId !== undefined && grant.capabilityId !== req.capabilityId) return false;
  if (grant.stepId !== undefined && grant.stepId !== req.stepId) return false;
  return true;
}

/**
 * Single guardrail point for agent, replay, system and human actions. Rules are
 * checked in a fixed order (action type, origin, route, blocked target, risk) and
 * the first one that does not allow decides. Anything not explicitly allowed is denied.
 */
export class DefaultPolicyGate implements PolicyGate {
  private readonly origins: OriginMatcher[];
  private readonly routes: { glob: string; re: RegExp }[];
  private readonly actions: ReadonlySet<string>;
  private readonly blocked: CompiledBlock[];

  constructor(readonly config: PolicyConfig) {
    this.origins = config.allowedOrigins.map(compileOrigin);
    this.routes = config.allowedRoutes.map((glob) => ({ glob, re: globToRegExp(glob) }));
    this.actions = new Set(config.allowedActions);
    this.blocked = config.blockedTargets.map((b) => ({
      role: b.role?.toLowerCase(),
      pattern: new RegExp(b.namePattern, "i"),
      reason: b.reason,
    }));
  }

  evaluate(request: PolicyRequest): PolicyDecision {
    const verdict = this.evaluateAutomation(request);
    if (request.actor !== "human") return verdict;
    const { verdict: would, ruleId, reason } = verdict;
    return {
      verdict: "logged",
      ruleId: "human_log_only",
      reason:
        would === "allow"
          ? `human action logged (automation would be allowed: ${reason})`
          : `human action logged; automation would be ${would === "deny" ? "denied" : "escalated"}: ${reason}`,
      wouldHaveBeen: would,
      underlyingRuleId: ruleId,
    };
  }

  /** URL check on its own, e.g. for frame URLs or redirects observed after an action. */
  checkUrl(rawUrl: string): Verdict {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return { verdict: "deny", ruleId: "origin_allowlist", reason: `unparseable URL '${rawUrl}'` };
    }
    if (url.username || url.password) {
      return { verdict: "deny", ruleId: "origin_allowlist", reason: "URLs with embedded credentials are not allowed" };
    }
    if (!this.origins.some((m) => m(url))) {
      return { verdict: "deny", ruleId: "origin_allowlist", reason: `origin '${url.origin}' is not in allowedOrigins` };
    }
    const route = this.routes.find((r) => r.re.test(url.pathname));
    if (!route) {
      return { verdict: "deny", ruleId: "route_allowlist", reason: `path '${url.pathname}' matches no allowedRoutes glob` };
    }
    return { verdict: "allow", ruleId: "route_allowlist", reason: `'${url.pathname}' matches '${route.glob}'` };
  }

  private evaluateAutomation(req: PolicyRequest): Verdict {
    const { action } = req;
    if (!this.actions.has(action.type)) {
      return { verdict: "deny", ruleId: "action_allowlist", reason: `action type '${action.type}' is not in allowedActions` };
    }

    let url = req.currentUrl;
    if (action.type === "navigate") {
      try {
        url = new URL(action.url, req.currentUrl).href;
      } catch {
        url = action.url;
      }
    }
    const urlVerdict = this.checkUrl(url);
    if (urlVerdict.verdict !== "allow") return urlVerdict;

    if (req.target) {
      const hit = this.matchBlocked(req.target);
      if (hit) return { verdict: "deny", ruleId: "blocked_target", reason: hit };
    }

    return this.applyRisk(req, this.config.risk[req.risk], req.risk);
  }

  private matchBlocked(target: TargetFingerprint): string | undefined {
    const texts = [target.name, target.labelText, target.text].filter((t): t is string => !!t);
    for (const b of this.blocked) {
      if (b.role && b.role !== target.role?.toLowerCase()) continue;
      const text = texts.find((t) => b.pattern.test(t));
      if (text !== undefined) return `target '${text}' is blocked: ${b.reason}`;
    }
    return undefined;
  }

  private applyRisk(req: PolicyRequest, handling: RiskHandling, risk: RiskClass): Verdict {
    const subject = req.stepId ? `step '${req.stepId}' (${risk})` : `${risk} action`;
    switch (handling) {
      case "allow":
        return { verdict: "allow", ruleId: "risk_class", reason: `${subject} is allowed by policy` };
      case "deny":
        return { verdict: "deny", ruleId: "risk_class", reason: `${subject} is denied by policy` };
      case "escalate":
        return { verdict: "escalate", ruleId: "risk_class", reason: `${subject} always requires a human` };
      case "require_grant": {
        // The only grant kind is approve_irreversible, so require_grant on other classes can only escalate.
        const grant = risk === "irreversible" ? req.grants.find((g) => grantMatches(g, req)) : undefined;
        if (grant) {
          return {
            verdict: "allow",
            ruleId: "grant",
            reason: `${subject} approved by ${grant.grantedBy} for invocation ${grant.invocationId}`,
            grant,
          };
        }
        const misScoped = req.grants.some((g) => g.kind === "approve_irreversible");
        return {
          verdict: "escalate",
          ruleId: "grant",
          reason: misScoped
            ? `${subject} needs an approve_irreversible grant; the grants supplied are scoped to a different invocation, capability or step`
            : `${subject} needs an approve_irreversible grant for invocation ${req.invocationId}`,
          requiredGrant: "approve_irreversible",
        };
      }
    }
  }
}
