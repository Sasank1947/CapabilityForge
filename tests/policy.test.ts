import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyRisk, loadPolicy, parsePolicy, PolicyConfigError } from "../src/policy/config.js";
import { DefaultPolicyGate, globToRegExp } from "../src/policy/gate.js";
import type { Grant, PolicyConfigInput, PolicyRequest } from "../src/policy/types.js";

const POLICY_PATH = join(import.meta.dirname, "..", "policies", "corelink.json");
const A = "http://127.0.0.1:4100";

const corelink = loadPolicy(POLICY_PATH);
const gate = new DefaultPolicyGate(corelink);

function req(overrides: Partial<PolicyRequest> = {}): PolicyRequest {
  return {
    actor: "replay",
    action: { type: "click", ref: "e1" },
    risk: "safe",
    currentUrl: `${A}/search`,
    invocationId: "inv-1",
    capabilityId: "corelink.open_sub_account",
    stepId: "submit",
    grants: [],
    ...overrides,
  };
}

const grant = (g: Partial<Grant> = {}): Grant => ({
  kind: "approve_irreversible",
  invocationId: "inv-1",
  grantedBy: "operator@cu",
  grantedAt: "2026-10-11T18:00:00Z",
  ...g,
});

describe("route globs", () => {
  it("'*' stays within a segment, '/**' spans any depth", () => {
    expect(globToRegExp("/member/*").test("/member/12")).toBe(true);
    expect(globToRegExp("/member/*").test("/member/12/x")).toBe(false);
    expect(globToRegExp("/mcu/**").test("/mcu")).toBe(true);
    expect(globToRegExp("/mcu/**").test("/mcu/a/b")).toBe(true);
    expect(globToRegExp("/mcu/**").test("/mcuX")).toBe(false);
    expect(globToRegExp("/a.b").test("/aXb")).toBe(false);
  });
});

describe("DefaultPolicyGate allowlists", () => {
  it("allows tenant A and tenant B routes on any localhost port", () => {
    for (const url of [`${A}/search`, `${A}/notice`, "http://localhost:55123/mcu/member", `${A}/subacct/commit`, `${A}/`]) {
      expect(gate.evaluate(req({ currentUrl: url })).verdict).toBe("allow");
    }
  });

  it("denies a foreign origin and an https downgrade/upgrade of the same host", () => {
    const d = gate.evaluate(req({ currentUrl: "https://evil.example/search" }));
    expect(d).toMatchObject({ verdict: "deny", ruleId: "origin_allowlist" });
    expect(gate.evaluate(req({ currentUrl: "https://127.0.0.1:4100/search" })).verdict).toBe("deny");
  });

  it("checks the navigate destination (resolved against the current URL), not the current page", () => {
    const nav = (url: string) => gate.evaluate(req({ action: { type: "navigate", url }, currentUrl: `${A}/search` }));
    expect(nav("/member?m=12345").verdict).toBe("allow");
    expect(nav("https://example.com/").verdict).toBe("deny");
    expect(nav("javascript:alert(1)")).toMatchObject({ verdict: "deny", ruleId: "origin_allowlist" });
    expect(nav("http://user:pw@127.0.0.1:4100/search")).toMatchObject({ verdict: "deny", ruleId: "origin_allowlist" });
    // From about:blank (fresh page) only the destination matters.
    expect(gate.evaluate(req({ action: { type: "navigate", url: `${A}/login` }, currentUrl: "about:blank" })).verdict).toBe("allow");
  });

  it("denies /__admin/* for the agent, including traversal and case tricks", () => {
    for (const url of [`${A}/__admin/state`, `${A}/__admin/fault?set=server_error`, `${A}/search/../__admin/reset`, `${A}/%2e%2e/__admin/state`, `${A}/__ADMIN/state`, `${A}/mcu/__admin/state`]) {
      const d = gate.evaluate(req({ actor: "agent", action: { type: "navigate", url } }));
      expect(d, url).toMatchObject({ verdict: "deny", ruleId: "route_allowlist" });
    }
    expect(gate.evaluate(req({ currentUrl: `${A}/__admin/state` })).verdict).toBe("deny");
  });

  it("denies unknown routes by default", () => {
    expect(gate.evaluate(req({ currentUrl: `${A}/wire-transfer` }))).toMatchObject({ verdict: "deny", ruleId: "route_allowlist" });
  });

  it("denies action types outside allowedActions", () => {
    const g = new DefaultPolicyGate(parsePolicy({ allowedOrigins: [A], allowedRoutes: ["/**"], allowedActions: ["navigate", "click"] }));
    const d = g.evaluate(req({ action: { type: "type", ref: "e1", text: "x", clear: true, sensitive: false } }));
    expect(d).toMatchObject({ verdict: "deny", ruleId: "action_allowlist" });
    expect(d.reason).toContain("type");
  });

  it("denies blocked targets by accessible name or label", () => {
    expect(gate.evaluate(req({ target: { role: "button", name: "Close Account" } }))).toMatchObject({ verdict: "deny", ruleId: "blocked_target" });
    expect(gate.evaluate(req({ target: { role: "link", name: "x", labelText: "Wire Transfer" } })).verdict).toBe("deny");
    expect(gate.evaluate(req({ target: { role: "cell", name: "Teller Drawer" } })).verdict).toBe("deny");
    expect(gate.evaluate(req({ target: { role: "button", name: "Search" } })).verdict).toBe("allow");
  });

  it("scopes a blocked target to a role when one is given", () => {
    const g = new DefaultPolicyGate(
      parsePolicy({ allowedOrigins: [A], allowedRoutes: ["/**"], allowedActions: ["click"], blockedTargets: [{ role: "button", namePattern: "^delete$", reason: "no" }] }),
    );
    expect(g.evaluate(req({ target: { role: "button", name: "Delete" } })).verdict).toBe("deny");
    expect(g.evaluate(req({ target: { role: "link", name: "Delete" } })).verdict).toBe("allow");
  });

  it("every decision carries a ruleId and a reason", () => {
    for (const r of [req(), req({ currentUrl: "http://x.test/" }), req({ risk: "irreversible" }), req({ actor: "human", currentUrl: "http://x.test/" })]) {
      const d = gate.evaluate(r);
      expect(d.ruleId).toBeTruthy();
      expect(d.reason.length).toBeGreaterThan(5);
    }
  });
});

describe("DefaultPolicyGate risk and grants", () => {
  it("escalates an irreversible step without a grant (require_grant)", () => {
    const d = gate.evaluate(req({ risk: "irreversible" }));
    expect(d).toMatchObject({ verdict: "escalate", ruleId: "grant", requiredGrant: "approve_irreversible" });
  });

  it("allows an irreversible step with a grant for this invocation, and returns the grant", () => {
    const g = grant();
    const d = gate.evaluate(req({ risk: "irreversible", grants: [g] }));
    expect(d).toMatchObject({ verdict: "allow", ruleId: "grant" });
    expect(d.verdict === "allow" && d.grant).toEqual(g);
  });

  it("rejects grants scoped to another invocation, step or capability", () => {
    for (const g of [grant({ invocationId: "inv-2" }), grant({ stepId: "other" }), grant({ capabilityId: "corelink.other" })]) {
      const d = gate.evaluate(req({ risk: "irreversible", grants: [g] }));
      expect(d.verdict).toBe("escalate");
      expect(d.reason).toMatch(/different invocation/);
    }
    expect(gate.evaluate(req({ risk: "irreversible", grants: [grant({ stepId: "submit" })] })).verdict).toBe("allow");
    // A step-scoped grant does not cover a request without a step.
    expect(gate.evaluate(req({ risk: "irreversible", stepId: undefined, grants: [grant({ stepId: "submit" })] })).verdict).toBe("escalate");
  });

  it("does not let a grant bypass the allowlist", () => {
    expect(gate.evaluate(req({ risk: "irreversible", grants: [grant()], currentUrl: `${A}/__admin/reset` })).verdict).toBe("deny");
  });

  it("follows the configured handling per class", () => {
    const make = (risk: PolicyConfigInput["risk"]) =>
      new DefaultPolicyGate(parsePolicy({ allowedOrigins: [A], allowedRoutes: ["/**"], allowedActions: ["click"], risk }));
    expect(make({ irreversible: "escalate" }).evaluate(req({ risk: "irreversible", grants: [grant()] }))).toMatchObject({ verdict: "escalate", ruleId: "risk_class" });
    expect(make({ irreversible: "deny" }).evaluate(req({ risk: "irreversible", grants: [grant()] }))).toMatchObject({ verdict: "deny", ruleId: "risk_class" });
    expect(make({ irreversible: "allow" }).evaluate(req({ risk: "irreversible" })).verdict).toBe("allow");
    expect(make({ reversible: "require_grant" }).evaluate(req({ risk: "reversible", grants: [grant()] })).verdict).toBe("escalate");
    expect(make({}).evaluate(req({ risk: "reversible" }))).toMatchObject({ verdict: "allow", ruleId: "risk_class" });
  });
});

describe("DefaultPolicyGate human log_only", () => {
  it("never blocks a human but logs what automation would have received", () => {
    const denied = gate.evaluate(req({ actor: "human", currentUrl: `${A}/__admin/state` }));
    expect(denied).toMatchObject({ verdict: "logged", ruleId: "human_log_only", wouldHaveBeen: "deny", underlyingRuleId: "route_allowlist" });
    const escalated = gate.evaluate(req({ actor: "human", risk: "irreversible" }));
    expect(escalated).toMatchObject({ verdict: "logged", wouldHaveBeen: "escalate", underlyingRuleId: "grant" });
    const allowed = gate.evaluate(req({ actor: "human" }));
    expect(allowed).toMatchObject({ verdict: "logged", wouldHaveBeen: "allow" });
  });

  it("enforces policy for system actions (e.g. recovery steps)", () => {
    expect(gate.evaluate(req({ actor: "system", currentUrl: `${A}/__admin/reset` })).verdict).toBe("deny");
  });
});

describe("loadPolicy", () => {
  it("parses the committed CoreLink policy with defaults", () => {
    expect(corelink.risk.irreversible).toBe("require_grant");
    expect(corelink.allowedRoutes.some((r) => r.includes("__admin"))).toBe(false);
  });

  it("rejects unknown keys, bad regexes and bad origins with a readable error", () => {
    const dir = mkdtempSync(join(tmpdir(), "cf-policy-"));
    const bad = join(dir, "bad.json");
    writeFileSync(
      bad,
      JSON.stringify({ allowedOrigins: ["not a url"], allowedRoutes: ["/**"], allowedActions: ["click"], blockedTarget: [], blockedTargets: [{ namePattern: "(", reason: "x" }] }),
    );
    expect(() => loadPolicy(bad)).toThrow(PolicyConfigError);
    try {
      loadPolicy(bad);
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("allowedOrigins.0");
      expect(msg).toContain("blockedTarget");
    }
    expect(() => parsePolicy({ allowedOrigins: [A], allowedRoutes: ["/**"], allowedActions: ["click"], blockedTargets: [{ namePattern: "(", reason: "x" }] })).toThrow(/invalid regex/);
  });

  it("applies top-level overrides", () => {
    const p = loadPolicy(POLICY_PATH, { allowedOrigins: ["http://localhost:4100"] });
    expect(new DefaultPolicyGate(p).evaluate(req({ currentUrl: `${A}/search` })).verdict).toBe("deny");
  });
});

describe("classifyRisk", () => {
  const click = { type: "click" as const, ref: "e1" };
  it("treats Submit on a POSTING IS FINAL screen as irreversible", () => {
    const r = classifyRisk({ action: click, target: { role: "button", name: "Submit" }, pageText: "WARNING: POSTING IS FINAL. THIS TRANSACTION CANNOT BE REVERSED." });
    expect(r.risk).toBe("irreversible");
  });

  it("treats Enter on a final screen as irreversible but Back as safe", () => {
    const pageText = "POSTING IS FINAL";
    expect(classifyRisk({ action: { type: "press", key: "Enter" }, pageText }).risk).toBe("irreversible");
    expect(classifyRisk({ action: click, target: { role: "button", name: "Back" }, pageText }).risk).toBe("safe");
  });

  it("classes search and navigation as safe, form edits as reversible", () => {
    expect(classifyRisk({ action: click, target: { role: "button", name: "Search" } }).risk).toBe("safe");
    expect(classifyRisk({ action: { type: "navigate", url: "/member?m=1" } }).risk).toBe("safe");
    expect(classifyRisk({ action: { type: "type", ref: "e1", text: "x", clear: true, sensitive: false } }).risk).toBe("reversible");
  });

  it("is conservative about commit-like and destructive names", () => {
    expect(classifyRisk({ action: click, target: { role: "button", name: "Confirm" } }).risk).toBe("irreversible");
    expect(classifyRisk({ action: click, target: { role: "button", name: "Delete member" } }).risk).toBe("irreversible");
    expect(classifyRisk({ action: { type: "navigate", url: "/subacct/commit" } }).risk).toBe("irreversible");
  });

  it("falls back to the configured default for unknown controls", () => {
    expect(classifyRisk({ action: click, target: { role: "button", name: "Continue" } }).risk).toBe("reversible");
    expect(classifyRisk({ action: click, target: { role: "button", name: "Continue" }, fallback: "irreversible" }).risk).toBe("irreversible");
  });
});
