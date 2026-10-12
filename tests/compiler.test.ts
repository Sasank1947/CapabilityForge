import { describe, expect, it } from "vitest";
import { LOOKUP_BALANCE_GOAL } from "../src/agent/presets.js";
import type { RecordedStep, RunTrace } from "../src/agent/types.js";
import {
  COMPILER_VERSION,
  compileTrace,
  fingerprintFromObserved,
  strategiesFromFingerprint,
} from "../src/artifact/compiler.js";
import { verifyContentHash } from "../src/artifact/hash.js";
import { parseArtifact } from "../src/artifact/schema.js";
import type { ObservedElement } from "../src/surface/types.js";

function el(partial: Partial<ObservedElement> & Pick<ObservedElement, "ref" | "role">): ObservedElement {
  return {
    name: "",
    framePath: [],
    states: {},
    ...partial,
  };
}

function step(partial: RecordedStep): RecordedStep {
  return partial;
}

function trace(steps: RecordedStep[], extras: Partial<RunTrace> = {}): RunTrace {
  return {
    runId: "run-test",
    goal: structuredClone(LOOKUP_BALANCE_GOAL),
    model: "fake-llm",
    startedAt: "2026-10-11T20:00:00.000Z",
    finishedAt: "2026-10-11T20:01:00.000Z",
    status: "done",
    stop: { kind: "declared_done", evidence: "REGULAR SAVINGS" },
    steps,
    runtimeInputs: { memberId: "12345" },
    doneEvidence: "REGULAR SAVINGS",
    ...extras,
  };
}

describe("compiler", () => {
  it("builds ranked strategies from an action-time fingerprint and templates input values", () => {
    const fp = fingerprintFromObserved(
      el({
        ref: "e9",
        role: "link",
        name: "12345",
        labelText: "Member Number:",
        text: "12345",
        tag: "a",
        framePath: ["main"],
      }),
    );
    const strategies = strategiesFromFingerprint(fp, { memberId: "12345" });
    expect(strategies[0]).toMatchObject({ kind: "role", role: "link", name: "{{memberId}}" });
    expect(strategies.some((s) => s.kind === "label" && s.labelText === "Member Number:")).toBe(true);
    expect(strategies.some((s) => s.kind === "visual")).toBe(true);
  });

  it("compiles a login+search+extract trace into a valid parameterized artifact", () => {
    const compiled = compileTrace(
      trace([
        step({
          id: "s01-open-login",
          intent: "Open sign-on",
          tool: "navigate",
          rationale: "Open sign-on",
          action: { type: "navigate", url: "/login" },
          risk: "safe",
        }),
        step({
          id: "s02-type-username",
          intent: "Enter operator username",
          tool: "type",
          rationale: "Enter operator username",
          target: {
            description: "Operator ID field",
            framePath: [],
            fingerprint: { role: "textbox", name: "Operator ID:", labelText: "Operator ID:" },
          },
          action: { type: "type", value: { kind: "secret", name: "username" }, clear: true },
          risk: "safe",
        }),
        step({
          id: "s03-search-member",
          intent: "Type the member number",
          tool: "type",
          rationale: "Type the member number",
          target: {
            description: "Member Number field",
            framePath: ["main"],
            fingerprint: { role: "textbox", name: "Member Number:", labelText: "Member Number:" },
          },
          action: { type: "type", value: { kind: "input", name: "memberId" }, clear: true },
          risk: "safe",
        }),
        step({
          id: "s04-open-row",
          intent: "Open the member row",
          tool: "click",
          rationale: "Open the member row",
          target: {
            description: "12345",
            framePath: ["main"],
            fingerprint: { role: "link", name: "12345", text: "12345" },
          },
          action: { type: "click" },
          risk: "safe",
        }),
        step({
          id: "s05-read-balance",
          intent: "Read Regular Savings",
          tool: "extract",
          rationale: "Read Regular Savings",
          extractName: "savingsBalance",
          extractRead: "text",
          extractedText: "$1,234.56",
          target: {
            description: "REGULAR SAVINGS",
            framePath: ["main"],
            fingerprint: { role: "cell", name: "$1,234.56", labelText: "REGULAR SAVINGS", text: "$1,234.56" },
          },
          action: { type: "extract", outputs: ["savingsBalance"] },
          risk: "safe",
        }),
      ]),
    );

    const artifact = parseArtifact(compiled);
    expect(artifact.provenance.source).toBe("discovery");
    expect(artifact.provenance.discoveryRunId).toBe("run-test");
    expect(artifact.provenance.compilerVersion).toBe(COMPILER_VERSION);
    expect(artifact.status).toBe("draft");
    expect(artifact.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(verifyContentHash(artifact)).toBe(true);

    const typeMember = artifact.steps.find((s) => s.id === "s03-search-member");
    expect(typeMember?.action).toMatchObject({ type: "type", value: { kind: "input", name: "memberId" } });
    const typeUser = artifact.steps.find((s) => s.id === "s02-type-username");
    expect(typeUser?.action).toMatchObject({ type: "type", value: { kind: "secret", name: "username" } });

    const open = artifact.steps.find((s) => s.id === "s04-open-row");
    expect(open?.target?.strategies[0]).toMatchObject({ kind: "role", name: "{{memberId}}" });
    expect(open?.target?.fingerprint?.name).toBe("12345");

    expect(artifact.outputs.savingsBalance?.extraction?.read).toBe("text");
    expect(artifact.successCheckpoint.condition).toMatchObject({ kind: "textPresent", text: "REGULAR SAVINGS" });
    expect(artifact.screenStates.map((s) => s.id)).toContain("memberNotFound");
  });

  it("refuses to compile an empty trace", () => {
    expect(() => compileTrace(trace([]))).toThrow(/empty/i);
  });
});
