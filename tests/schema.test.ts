import { describe, expect, it } from "vitest";
import {
  CapabilityArtifact,
  TenantOverlay,
  artifactJsonSchema,
  inputsJsonSchema,
  inputsValidator,
  irreversibleSteps,
  safeParseArtifact,
  templatePlaceholders,
  type CapabilityArtifactInput,
} from "../src/artifact/schema.js";
import { computeContentHash, stableStringify, verifyContentHash, withContentHash } from "../src/artifact/hash.js";
import { ReplayResult, driftReport } from "../src/replay/result.js";
import { CONTROL_TRANSITIONS, ControlState, canTransition } from "../src/handoff/types.js";
import { PolicyConfig } from "../src/policy/types.js";

const mainFrame = ["main"];

function example(): CapabilityArtifactInput {
  return {
    schemaVersion: "capabilityforge/v1",
    id: "corelink.lookup_member_balance",
    version: "1.0.0",
    status: "draft",
    title: "Look up member savings balance",
    description: "Finds a member by member number and returns their current savings balance. Returns MEMBER_NOT_FOUND if no such member exists.",
    provenance: { source: "hand-written", recordedAt: "2026-10-11T18:00:00Z" },
    app: {
      vendor: "CoreLink",
      product: "Teller",
      versionRange: ">=4.2 <5",
      surface: "legacy-web",
      entryRoute: "/login",
      fingerprint: { titlePattern: "CoreLink Teller", landmarks: ["Member Search"] },
    },
    inputs: {
      memberId: { type: "string", description: "Member number", sensitivity: "pii", pattern: "^[0-9]{5}$", example: "12345" },
    },
    outputs: {
      savingsBalance: {
        type: "number",
        description: "Current savings balance in USD",
        sensitivity: "pii",
        extraction: {
          target: {
            description: "Savings balance value cell",
            framePath: mainFrame,
            strategies: [{ kind: "label", labelText: "Savings Balance", relation: "right-of" }],
          },
          transforms: [{ kind: "trim" }, { kind: "parseNumber" }],
        },
      },
    },
    secrets: {
      username: { ref: "env://CORELINK_USER", description: "Teller login" },
      password: { ref: "env://CORELINK_PASSWORD", description: "Teller password" },
    },
    steps: [
      { id: "open-login", intent: "Open the login page", action: { type: "navigate", url: "/login" }, risk: "safe" },
      {
        id: "enter-username",
        intent: "Enter operator username",
        target: { description: "User ID field", strategies: [{ kind: "label", labelText: "User ID" }, { kind: "css", selector: "input[name=uid]" }] },
        action: { type: "type", value: { kind: "secret", name: "username" } },
        risk: "safe",
      },
      {
        id: "enter-password",
        intent: "Enter operator password",
        target: { description: "Password field", strategies: [{ kind: "label", labelText: "Password" }] },
        action: { type: "type", value: { kind: "secret", name: "password" } },
        risk: "safe",
      },
      {
        id: "sign-in",
        intent: "Submit login",
        target: { description: "Sign On button", strategies: [{ kind: "role", role: "button", name: "Sign On" }] },
        action: { type: "click" },
        risk: "safe",
        postcondition: { kind: "urlMatches", pattern: "/teller" },
      },
      {
        id: "enter-member",
        intent: "Type the member number into search",
        target: {
          description: "Member Number search field",
          framePath: mainFrame,
          strategies: [
            { kind: "role", role: "textbox", name: "Member Number" },
            { kind: "label", labelText: "Member Number" },
            { kind: "structural", path: "table[1]/tr[2]/td[2]/input[1]" },
          ],
        },
        action: { type: "type", value: { kind: "input", name: "memberId" } },
        risk: "safe",
      },
      {
        id: "search",
        intent: "Run the member search",
        target: { description: "Search button", framePath: mainFrame, strategies: [{ kind: "role", role: "button", name: "Search" }] },
        action: { type: "click" },
        risk: "safe",
      },
      {
        id: "open-member",
        intent: "Open the matching member row",
        target: { description: "Result row link", framePath: mainFrame, strategies: [{ kind: "role", role: "link", name: "{{memberId}}" }] },
        action: { type: "click" },
        risk: "safe",
        postcondition: { kind: "textPresent", text: "Savings Balance", framePath: mainFrame },
      },
      { id: "read-balance", intent: "Read the savings balance", action: { type: "extract", outputs: ["savingsBalance"] }, risk: "safe" },
    ],
    screenStates: [
      {
        id: "memberNotFound",
        description: "Search returned no rows",
        detect: { kind: "textPresent", text: "No members match", framePath: mainFrame },
        appliesTo: ["open-member"],
        handler: { kind: "outcome", code: "MEMBER_NOT_FOUND", message: "No member with that number" },
      },
      {
        id: "sessionExpired",
        description: "Bounced back to login",
        detect: { kind: "textPresent", text: "Your session has expired" },
        priority: 10,
        handler: { kind: "recover", retry: { maxAttempts: 1, initialBackoffMs: 0 }, resume: { mode: "restartFrom", stepId: "enter-username" } },
      },
      {
        id: "maintenanceDialog",
        description: "System maintenance interstitial",
        detect: { kind: "textPresent", text: "System maintenance tonight" },
        handler: {
          kind: "recover",
          steps: [
            {
              id: "dismiss-maintenance",
              intent: "Dismiss the interstitial",
              target: { description: "Continue button", strategies: [{ kind: "role", role: "button", name: "Continue" }] },
              action: { type: "click" },
              risk: "safe",
            },
          ],
          retry: { maxAttempts: 2, initialBackoffMs: 250 },
          resume: { mode: "retryStep" },
        },
      },
      {
        id: "serverError",
        description: "Application error page",
        detect: { kind: "any", conditions: [{ kind: "titleMatches", pattern: "^500" }, { kind: "textPresent", text: "Internal Server Error" }] },
        handler: { kind: "fail", failureKind: "app_error", message: "CoreLink returned a server error" },
      },
    ],
    successCheckpoint: {
      description: "Member detail page with a balance is shown",
      condition: { kind: "all", conditions: [{ kind: "textPresent", text: "Savings Balance", framePath: mainFrame }, { kind: "not", condition: { kind: "textPresent", text: "Error" } }] },
    },
  };
}

function issues(data: unknown): string[] {
  const r = safeParseArtifact(data);
  return r.success ? [] : r.error.issues.map((i) => i.message);
}

describe("capability artifact schema", () => {
  it("accepts the example artifact and applies defaults", () => {
    const a = CapabilityArtifact.parse(example());
    expect(a.steps).toHaveLength(8);
    expect(a.inputs.memberId?.required).toBe(true);
    expect(a.steps[1]?.target?.cardinality).toBe("exactlyOne");
    expect(a.steps[1]?.target?.framePath).toEqual([]);
    expect(a.steps[0]?.timeoutMs).toBe(10_000);
    expect(irreversibleSteps(a)).toHaveLength(0);
  });

  it("rejects references to undeclared inputs and secrets", () => {
    const a = example();
    a.steps[4]!.action = { type: "type", value: { kind: "input", name: "memberNo" } };
    a.steps[1]!.action = { type: "type", value: { kind: "secret", name: "token" } };
    expect(issues(a)).toEqual(expect.arrayContaining(["unknown input 'memberNo'", "unknown secret 'token'"]));
  });

  it("rejects templates that reference secret inputs", () => {
    const a = example();
    a.inputs.pin = { type: "string", description: "PIN", sensitivity: "secret" };
    a.steps[6]!.target!.strategies = [{ kind: "text", text: "{{pin}}" }];
    expect(issues(a)).toContain("template must not reference secret input 'pin'");
  });

  it("rejects duplicate step ids, untargeted clicks and dangling restartFrom", () => {
    const a = example();
    a.steps[2]!.id = "enter-username";
    delete a.steps[3]!.target;
    a.screenStates![1]!.handler = { kind: "recover", retry: { maxAttempts: 1, initialBackoffMs: 0 }, resume: { mode: "restartFrom", stepId: "nope" } };
    expect(issues(a)).toEqual(
      expect.arrayContaining(["duplicate step id 'enter-username'", "action 'click' requires a target", "unknown step 'nope'"]),
    );
  });

  it("rejects inline credentials in secret refs", () => {
    const a = example();
    a.secrets!.username = { ref: "hunter2", description: "bad" };
    expect(issues(a).length).toBeGreaterThan(0);
  });

  it("requires every extraction rule to be used by an extract step", () => {
    const a = example();
    a.steps.pop();
    expect(issues(a)).toContain("output 'savingsBalance' has an extraction rule but no extract step uses it");
  });

  it("exports a JSON Schema", () => {
    const schema = artifactJsonSchema() as { definitions: Record<string, { properties?: Record<string, unknown> }> };
    const props = schema.definitions.CapabilityArtifact?.properties ?? {};
    expect(Object.keys(props)).toEqual(expect.arrayContaining(["inputs", "outputs", "steps", "screenStates", "successCheckpoint"]));
  });

  it("derives per-capability input schema and validator", () => {
    const a = CapabilityArtifact.parse(example());
    expect(inputsJsonSchema(a.inputs)).toMatchObject({ required: ["memberId"], properties: { memberId: { "x-sensitivity": "pii" } } });
    const v = inputsValidator(a.inputs);
    expect(v.safeParse({ memberId: "12345" }).success).toBe(true);
    expect(v.safeParse({ memberId: "12" }).success).toBe(false);
    expect(v.safeParse({ memberId: "12345", extra: 1 }).success).toBe(false);
  });

  it("finds template placeholders", () => {
    expect(templatePlaceholders("Member {{ memberId }} / {{x}}")).toEqual(["memberId", "x"]);
  });
});

describe("content hash", () => {
  it("is stable across key order and independent of status", () => {
    const a = CapabilityArtifact.parse(example());
    const reordered = JSON.parse(stableStringify(a)) as unknown;
    const b = CapabilityArtifact.parse(reordered);
    expect(computeContentHash(b)).toBe(computeContentHash(a));
    expect(computeContentHash({ ...a, status: "approved" })).toBe(computeContentHash(a));
    expect(computeContentHash(a)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("changes when behaviour changes and verifies", () => {
    const a = withContentHash(CapabilityArtifact.parse(example()));
    expect(verifyContentHash(a)).toBe(true);
    const changed = { ...a, steps: a.steps.map((s) => (s.id === "search" ? { ...s, timeoutMs: 5000 } : s)) };
    expect(verifyContentHash(changed)).toBe(false);
  });
});

describe("tenant overlay", () => {
  it("parses a label/route/interstitial overlay", () => {
    const o = TenantOverlay.parse({
      schemaVersion: "capabilityforge/v1",
      tenant: "tenant-b",
      baseId: "corelink.lookup_member_balance",
      baseVersionRange: "^1.0.0",
      routes: [{ fromPrefix: "/", toPrefix: "/cu/" }],
      labels: { "Member Number": "Member #" },
      targets: { "enter-member": { prependStrategies: [{ kind: "label", labelText: "Member #" }] } },
      extraScreenStates: [
        {
          id: "acknowledgeNotice",
          description: "Tenant B notice interstitial",
          detect: { kind: "textPresent", text: "Acknowledge notice" },
          handler: {
            kind: "recover",
            steps: [{ id: "ack", intent: "Acknowledge", target: { description: "Acknowledge", strategies: [{ kind: "role", role: "button", name: "Acknowledge" }] }, action: { type: "click" }, risk: "safe" }],
            retry: { maxAttempts: 1, initialBackoffMs: 0 },
            resume: { mode: "retryStep" },
          },
        },
      ],
    });
    expect(o.targets["enter-member"]?.prependStrategies).toHaveLength(1);
  });
});

describe("shared contracts", () => {
  const base = {
    runId: "r1",
    capabilityId: "corelink.lookup_member_balance",
    capabilityVersion: "1.0.0",
    startedAt: "2026-10-11T18:00:00Z",
    finishedAt: "2026-10-11T18:00:02Z",
    durationMs: 2000,
  };

  it("discriminates replay results", () => {
    const r = ReplayResult.parse({ ...base, status: "business_outcome", code: "MEMBER_NOT_FOUND", message: "none", screenStateId: "memberNotFound", stepId: "open-member" });
    expect(r.status).toBe("business_outcome");
    expect(r.recoveries).toEqual([]);
    expect(ReplayResult.safeParse({ ...base, status: "failure", kind: "flaky", stepId: null, message: "", expected: "", observed: "" }).success).toBe(false);
  });

  it("computes a drift report from strategy hits", () => {
    const d = driftReport([
      { stepId: "a", strategyIndex: 0, strategyKind: "role", fallback: false, attempts: [], fromOverlay: false },
      { stepId: "b", strategyIndex: 1, strategyKind: "label", fallback: true, attempts: [], fromOverlay: false },
    ]);
    expect(d.driftScore).toBe(0.5);
    expect(d.fallbackSteps).toEqual([{ stepId: "b", strategyIndex: 1, strategyKind: "label" }]);
  });

  it("defines a closed control-state machine", () => {
    expect(canTransition(ControlState.AGENT, ControlState.PAUSED)).toBe(true);
    expect(canTransition(ControlState.AGENT, ControlState.HUMAN)).toBe(false);
    expect(CONTROL_TRANSITIONS[ControlState.ABORTED]).toEqual([]);
  });

  it("defaults irreversible actions to require a grant", () => {
    const p = PolicyConfig.parse({ allowedOrigins: ["http://localhost:4100"], allowedRoutes: ["/**"], allowedActions: ["click"] });
    expect(p.risk.irreversible).toBe("require_grant");
  });
});
