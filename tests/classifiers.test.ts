import { describe, expect, it } from "vitest";
import { ScreenState, TargetDescriptor } from "../src/artifact/schema.js";
import { applyTransforms, classifyScreenState, evalCondition, parseNumber, type EvalContext } from "../src/replay/conditions.js";
import type { Observation, Surface } from "../src/surface/types.js";

function observation(partial: Partial<Observation> = {}): Observation {
  return {
    url: "http://127.0.0.1:4100/search",
    title: "CoreLink Teller - Teller Workstation",
    frames: [{ path: ["main"], url: "http://127.0.0.1:4100/search", name: "main", title: "Inquiry" }],
    elements: [],
    textByFrame: { "": "CoreLink Teller", main: "Member Search" },
    snapshotHash: "h",
    capturedAt: "2026-10-11T20:00:00.000Z",
    ...partial,
  };
}

function ctx(obs: Observation, extras: { resolveOk?: boolean; extract?: string; values?: Record<string, string> } = {}): EvalContext {
  const surface = {
    resolve: async () =>
      extras.resolveOk
        ? {
            ok: true as const,
            ref: "e1",
            strategyIndex: 0,
            strategyKind: "label" as const,
            attempts: [],
            fingerprint: { name: "fld" },
          }
        : { ok: false as const, reason: "not_found" as const, attempts: [] },
    extract: async () => extras.extract ?? "",
  } as unknown as Surface;
  return {
    surface,
    observation: obs,
    templateValues: extras.values ?? { memberId: "12345" },
    resolveValue: (ref) => (ref.kind === "literal" ? ref.value : extras.values?.[ref.name] ?? ""),
  };
}

function state(partial: Parameters<typeof ScreenState.parse>[0]) {
  return ScreenState.parse(partial);
}

describe("evalCondition", () => {
  it("matches textPresent case-insensitively and scopes to a frame", async () => {
    const obs = observation({
      textByFrame: { "": "HEADER", main: "NO RECORD FOUND FOR MEMBER 99999" },
    });
    expect(await evalCondition({ kind: "textPresent", text: "no record found" }, ctx(obs))).toBe(true);
    expect(await evalCondition({ kind: "textPresent", text: "no record found", framePath: ["main"] }, ctx(obs))).toBe(true);
    expect(await evalCondition({ kind: "textPresent", text: "no record found", framePath: ["nav"] }, ctx(obs))).toBe(false);
    expect(await evalCondition({ kind: "textPresent", text: "NO RECORD FOUND FOR MEMBER 99999", exact: true, framePath: ["main"] }, ctx(obs))).toBe(true);
  });

  it("substitutes {{input}} templates in text and URL/title patterns", async () => {
    const obs = observation({
      url: "http://127.0.0.1:4100/member?m=12345",
      title: "Member 12345",
      textByFrame: { main: "Opened member 12345" },
    });
    const c = ctx(obs);
    expect(await evalCondition({ kind: "textPresent", text: "member {{memberId}}", framePath: ["main"] }, c)).toBe(true);
    expect(await evalCondition({ kind: "urlMatches", pattern: "m={{memberId}}$" }, c)).toBe(true);
    expect(await evalCondition({ kind: "titleMatches", pattern: "^Member {{memberId}}$" }, c)).toBe(true);
  });

  it("treats textAbsent as the inverse and composes all/any/not", async () => {
    const obs = observation({ textByFrame: { main: "System maintenance tonight" } });
    const c = ctx(obs);
    expect(await evalCondition({ kind: "textAbsent", text: "Internal Server Error" }, c)).toBe(true);
    expect(await evalCondition({ kind: "textAbsent", text: "maintenance" }, c)).toBe(false);
    expect(
      await evalCondition(
        {
          kind: "all",
          conditions: [
            { kind: "textPresent", text: "maintenance" },
            { kind: "not", condition: { kind: "textPresent", text: "500" } },
          ],
        },
        c,
      ),
    ).toBe(true);
    expect(
      await evalCondition(
        {
          kind: "any",
          conditions: [
            { kind: "titleMatches", pattern: "^500" },
            { kind: "textPresent", text: "Internal Server Error" },
          ],
        },
        c,
      ),
    ).toBe(false);
  });

  it("uses live resolve for visible / hidden / valueEquals", async () => {
    const target = TargetDescriptor.parse({
      description: "Operator ID",
      strategies: [{ kind: "label", labelText: "Operator ID:", relation: "right-of" }],
    });
    expect(await evalCondition({ kind: "visible", target }, ctx(observation(), { resolveOk: true }))).toBe(true);
    expect(await evalCondition({ kind: "hidden", target }, ctx(observation(), { resolveOk: false }))).toBe(true);
    expect(
      await evalCondition(
        { kind: "valueEquals", target, value: { kind: "literal", value: "teller01" } },
        ctx(observation(), { resolveOk: true, extract: "teller01" }),
      ),
    ).toBe(true);
    expect(
      await evalCondition(
        { kind: "valueEquals", target, value: { kind: "literal", value: "teller01" } },
        ctx(observation(), { resolveOk: false }),
      ),
    ).toBe(false);
  });
});

describe("classifyScreenState", () => {
  const memberNotFound = state({
    id: "memberNotFound",
    description: "Search returned no matching member",
    detect: { kind: "textPresent", text: "NO RECORD FOUND FOR MEMBER" },
    priority: 10,
    appliesTo: ["open-member"],
    handler: { kind: "outcome", code: "MEMBER_NOT_FOUND", message: "No member with that number" },
  });
  const sessionExpired = state({
    id: "sessionExpired",
    description: "Session timed out",
    detect: {
      kind: "any",
      conditions: [
        { kind: "textPresent", text: "SESSION TIMED OUT" },
        { kind: "textPresent", text: "PLEASE SIGN ON AGAIN" },
      ],
    },
    priority: 20,
    handler: { kind: "recover", retry: { maxAttempts: 1, initialBackoffMs: 0 }, resume: { mode: "restartFrom", stepId: "enter-username" } },
  });
  const serverError = state({
    id: "serverError",
    description: "Application 500 page",
    detect: { kind: "any", conditions: [{ kind: "titleMatches", pattern: "^500" }, { kind: "textPresent", text: "Internal Server Error" }] },
    priority: 30,
    handler: { kind: "fail", failureKind: "app_error", message: "CoreLink returned a server error" },
  });
  const maintenance = state({
    id: "maintenanceDialog",
    description: "System maintenance interstitial",
    detect: { kind: "textPresent", text: "System maintenance tonight" },
    priority: 15,
    handler: {
      kind: "recover",
      steps: [
        {
          id: "dismiss",
          intent: "Dismiss",
          target: { description: "Continue", strategies: [{ kind: "role", role: "button", name: "Continue" }] },
          action: { type: "click" },
          risk: "safe",
        },
      ],
      retry: { maxAttempts: 2, initialBackoffMs: 0 },
      resume: { mode: "retryStep" },
    },
  });

  const states = [memberNotFound, sessionExpired, maintenance, serverError];

  it("returns the highest-priority matching classifier", async () => {
    const obs = observation({
      title: "500 Internal Server Error",
      textByFrame: { "": "Internal Server Error — SESSION TIMED OUT" },
    });
    const hit = await classifyScreenState(states, "search", ctx(obs));
    expect(hit?.id).toBe("serverError");
  });

  it("honours appliesTo so a not-found banner is ignored on unrelated steps", async () => {
    const obs = observation({ textByFrame: { main: "NO RECORD FOUND FOR MEMBER" } });
    expect((await classifyScreenState(states, "open-member", ctx(obs)))?.id).toBe("memberNotFound");
    expect(await classifyScreenState(states, "enter-username", ctx(obs))).toBeNull();
  });

  it("classifies session expiry, maintenance, and a clean search screen", async () => {
    expect(
      (
        await classifyScreenState(
          states,
          "search",
          ctx(observation({ textByFrame: { "": "PLEASE SIGN ON AGAIN", main: "" } })),
        )
      )?.id,
    ).toBe("sessionExpired");
    expect(
      (
        await classifyScreenState(
          states,
          "search",
          ctx(observation({ textByFrame: { main: "System maintenance tonight" } })),
        )
      )?.id,
    ).toBe("maintenanceDialog");
    expect(await classifyScreenState(states, "search", ctx(observation()))).toBeNull();
  });
});

describe("applyTransforms", () => {
  it("parses currency, parenthetical negatives, and regex groups", () => {
    expect(parseNumber("$1,520.75")).toBe(1520.75);
    expect(parseNumber("(12.00)")).toBe(-12);
    expect(applyTransforms("  $1,520.75  ", [{ kind: "trim" }, { kind: "parseNumber", allowCurrency: true }])).toBe(1520.75);
    expect(applyTransforms("Confirmation Number: 88421", [{ kind: "regex", pattern: "(\\d+)", group: 1 }])).toBe("88421");
    expect(applyTransforms("YES", [{ kind: "parseBoolean", truthy: ["yes", "true"] }])).toBe(true);
  });
});
