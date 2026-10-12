import "dotenv/config";
import { describe, expect, it } from "vitest";
import { discover } from "../src/agent/loop.js";
import { ScriptedLlmClient, toolTurn, hasOpenAIKey } from "../src/agent/llm.js";
import { LOOKUP_BALANCE_GOAL } from "../src/agent/presets.js";
import { toolSpecs } from "../src/agent/tools.js";
import { compileTrace } from "../src/artifact/compiler.js";
import { InMemoryEvidenceSink } from "../src/evidence/sink.js";
import { Redactor } from "../src/policy/redact.js";
import type { PolicyDecision, PolicyGate } from "../src/policy/types.js";
import type { SurfaceKind, TargetDescriptor } from "../src/artifact/schema.js";
import type {
  ActionOutcome,
  ElementRef,
  ExtractRead,
  Observation,
  ObservedElement,
  Resolution,
  ScreenshotOptions,
  Surface,
  SurfaceAction,
} from "../src/surface/types.js";

const allowAll: PolicyGate = {
  evaluate: (): PolicyDecision => ({ verdict: "allow", ruleId: "action_allowlist", reason: "test allow" }),
};

const denyAll: PolicyGate = {
  evaluate: (): PolicyDecision => ({ verdict: "deny", ruleId: "origin_allowlist", reason: "test deny" }),
};

function el(partial: Partial<ObservedElement> & Pick<ObservedElement, "ref" | "role">): ObservedElement {
  return { name: "", framePath: [], states: {}, ...partial };
}

function obs(partial: Partial<Observation> & Pick<Observation, "url" | "elements" | "snapshotHash">): Observation {
  return {
    title: "CoreLink Teller",
    frames: [],
    textByFrame: { "": "OPERATOR SIGN ON" },
    capturedAt: "2026-10-11T20:00:00.000Z",
    ...partial,
  };
}

class FakeSurface implements Surface {
  readonly kind: SurfaceKind = "legacy-web";
  readonly actions: SurfaceAction[] = [];
  private index = 0;
  constructor(private readonly screens: Observation[]) {}
  private current(): Observation {
    return this.screens[Math.min(this.index, this.screens.length - 1)]!;
  }
  async observe(): Promise<Observation> {
    return this.current();
  }
  async resolve(_target: TargetDescriptor): Promise<Resolution> {
    return { ok: false, reason: "not_found", attempts: [] };
  }
  async act(action: SurfaceAction): Promise<ActionOutcome> {
    this.actions.push(action);
    if (this.index < this.screens.length - 1) this.index += 1;
    return { ok: true, urlAfter: this.current().url, durationMs: 1 };
  }
  async extract(ref: ElementRef, _read: ExtractRead): Promise<string> {
    const found = this.current().elements.find((e) => e.ref === ref);
    return found?.text ?? found?.value ?? "1,234.56";
  }
  async screenshot(_options?: ScreenshotOptions): Promise<Buffer> {
    return Buffer.from("png");
  }
  async currentUrl(): Promise<string> {
    return this.current().url;
  }
  async close(): Promise<void> {}
}

const loginScreen = obs({
  url: "http://127.0.0.1:4100/login",
  snapshotHash: "sha256:login",
  elements: [
    el({ ref: "e1", role: "textbox", name: "Operator ID:", labelText: "Operator ID:", tag: "input", states: { editable: true } }),
    el({ ref: "e2", role: "textbox", name: "", labelText: "Password:", tag: "input", states: { editable: true } }),
    el({ ref: "e3", role: "button", name: "Sign On", tag: "input" }),
  ],
});

const searchScreen = obs({
  url: "http://127.0.0.1:4100/",
  snapshotHash: "sha256:search",
  title: "CoreLink Teller - Teller Workstation",
  textByFrame: { main: "Member Number:" },
  elements: [
    el({
      ref: "e4",
      role: "textbox",
      name: "Member Number:",
      labelText: "Member Number:",
      framePath: ["main"],
      states: { editable: true },
    }),
    el({ ref: "e5", role: "button", name: "Search", framePath: ["main"] }),
    el({ ref: "e6", role: "link", name: "12345", text: "12345", framePath: ["main"] }),
  ],
});

const detailScreen = obs({
  url: "http://127.0.0.1:4100/member",
  snapshotHash: "sha256:detail",
  textByFrame: { main: "MEMBER DETAIL REGULAR SAVINGS $1,234.56" },
  elements: [
    el({
      ref: "e7",
      role: "cell",
      name: "$1,234.56",
      labelText: "REGULAR SAVINGS",
      text: "$1,234.56",
      framePath: ["main"],
    }),
  ],
});

const secrets = { username: "teller01", password: "change-me-local-only" };
const inputs = { memberId: "12345" };

function sink() {
  const redactor = Redactor.forRun(
    { inputs: LOOKUP_BALANCE_GOAL.inputs, outputs: LOOKUP_BALANCE_GOAL.outputs as never, secrets: LOOKUP_BALANCE_GOAL.secrets },
    { inputs, secrets },
  );
  return { redactor, evidence: new InMemoryEvidenceSink({ redactor, mode: "discovery", runId: "test-discover" }) };
}

describe("discovery tools", () => {
  it("requires rationale and types {param}/{secret} in the JSON schema", () => {
    const specs = toolSpecs(LOOKUP_BALANCE_GOAL);
    const type = specs.find((t) => t.name === "type");
    expect(type?.parameters).toMatchObject({ required: expect.arrayContaining(["rationale", "ref", "value"]) });
    const value = (type?.parameters as { properties: { value: { oneOf: { properties?: { param?: { enum: string[] }; secret?: { enum: string[] } } }[] } } }).properties.value;
    const enums = value.oneOf.flatMap((v) => v.properties?.param?.enum ?? v.properties?.secret?.enum ?? []);
    expect(enums).toEqual(expect.arrayContaining(["memberId", "username", "password"]));
  });
});

describe("discovery loop (fake LlmClient)", () => {
  it("types {param} and {secret}, fingerprints at action time, and compiles", async () => {
    const llm = new ScriptedLlmClient([
      toolTurn("navigate", { rationale: "Open the sign-on page", url: "/login" }),
      toolTurn("type", { rationale: "Enter operator username", ref: "e1", value: { secret: "username" } }),
      toolTurn("type", { rationale: "Enter operator password", ref: "e2", value: { secret: "password" } }),
      toolTurn("click", { rationale: "Submit sign-on", ref: "e3" }),
      toolTurn("type", { rationale: "Enter the member number", ref: "e4", value: { param: "memberId" } }),
      toolTurn("extract", { rationale: "Read Regular Savings", name: "savingsBalance", ref: "e7" }),
      toolTurn("declare_done", { rationale: "Balance is on screen", evidence: "REGULAR SAVINGS" }),
    ]);
    const blank = obs({ url: "about:blank", snapshotHash: "sha256:blank", elements: [] });
    const surface = new FakeSurface([blank, loginScreen, loginScreen, loginScreen, searchScreen, detailScreen]);
    const { redactor, evidence } = sink();

    const result = await discover({
      goal: LOOKUP_BALANCE_GOAL,
      surface,
      llm,
      policy: allowAll,
      inputs,
      secrets,
      baseUrl: "http://127.0.0.1:4100",
      evidence,
      redactor,
      settleMs: 0,
    });

    expect(result.status).toBe("done");
    expect(result.stop).toMatchObject({ kind: "declared_done", evidence: "REGULAR SAVINGS" });

    const typed = surface.actions.filter((a): a is Extract<SurfaceAction, { type: "type" }> => a.type === "type");
    expect(typed.map((a) => a.text)).toEqual(["teller01", "change-me-local-only", "12345"]);
    expect(typed[2]?.sensitive).toBe(true);

    const userStep = result.trace.steps.find((s) => s.tool === "type" && s.action.type === "type" && s.action.value.kind === "secret");
    expect(userStep?.action).toMatchObject({ type: "type", value: { kind: "secret", name: "username" } });
    const memberStep = result.trace.steps.find((s) => s.action.type === "type" && s.action.value.kind === "input");
    expect(memberStep?.action).toMatchObject({ value: { kind: "input", name: "memberId" } });

    const click = result.trace.steps.find((s) => s.tool === "click");
    expect(click?.target?.fingerprint).toEqual({ role: "button", name: "Sign On", tag: "input" });
    expect(click?.target?.description).toBe("Sign On");

    const decisions = evidence.events.filter((e) => e.type === "decision");
    expect(decisions.every((e) => e.rationale)).toBe(true);
    expect(evidence.dump()).not.toContain("change-me-local-only");

    const artifact = compileTrace(result.trace);
    expect(artifact.steps.some((s) => s.action.type === "type" && s.action.value.kind === "input")).toBe(true);
    expect(artifact.outputs.savingsBalance?.extraction).toBeTruthy();
  });

  it("stops on max steps", async () => {
    const llm = new ScriptedLlmClient([
      toolTurn("click", { rationale: "try one", ref: "e3" }),
      toolTurn("click", { rationale: "try two", ref: "e3" }),
      toolTurn("click", { rationale: "try three", ref: "e3" }),
    ]);
    const result = await discover({
      goal: LOOKUP_BALANCE_GOAL,
      surface: new FakeSurface([loginScreen]),
      llm,
      policy: allowAll,
      inputs,
      secrets,
      baseUrl: "http://127.0.0.1:4100",
      stop: { maxSteps: 2, repeatedStateLimit: 99 },
      settleMs: 0,
    });
    expect(result.status).toBe("stopped");
    expect(result.stop.kind).toBe("max_steps");
  });

  it("stops on repeated snapshot hash", async () => {
    const llm = new ScriptedLlmClient([
      toolTurn("click", { rationale: "again 1", ref: "e3" }),
      toolTurn("click", { rationale: "again 2", ref: "e3" }),
      toolTurn("click", { rationale: "again 3", ref: "e3" }),
    ]);
    const result = await discover({
      goal: LOOKUP_BALANCE_GOAL,
      surface: new FakeSurface([loginScreen]),
      llm,
      policy: allowAll,
      inputs,
      secrets,
      baseUrl: "http://127.0.0.1:4100",
      stop: { maxSteps: 20, repeatedStateLimit: 3 },
      settleMs: 0,
    });
    expect(result.stop.kind).toBe("repeated_state");
  });

  it("stops on policy denial", async () => {
    const llm = new ScriptedLlmClient([toolTurn("navigate", { rationale: "leave the app", url: "https://evil.example/" })]);
    const result = await discover({
      goal: LOOKUP_BALANCE_GOAL,
      surface: new FakeSurface([loginScreen]),
      llm,
      policy: denyAll,
      inputs,
      secrets,
      baseUrl: "http://127.0.0.1:4100",
    });
    expect(result.stop).toMatchObject({ kind: "policy_denied", verdict: "deny" });
    expect(result.trace.steps).toHaveLength(0);
  });

  it("stops on wall-clock timeout", async () => {
    let t = 0;
    const llm = new ScriptedLlmClient([toolTurn("click", { rationale: "too late", ref: "e3" })]);
    const result = await discover({
      goal: LOOKUP_BALANCE_GOAL,
      surface: new FakeSurface([loginScreen]),
      llm,
      policy: allowAll,
      inputs,
      secrets,
      baseUrl: "http://127.0.0.1:4100",
      now: () => {
        t += 10_000;
        return t;
      },
      stop: { timeoutMs: 5_000, maxSteps: 20, repeatedStateLimit: 99 },
    });
    expect(result.stop.kind).toBe("timeout");
  });

  it("rejects a missing rationale without acting", async () => {
    const llm = new ScriptedLlmClient([
      toolTurn("click", { ref: "e3" }),
      toolTurn("declare_done", { rationale: "give up", evidence: "OPERATOR SIGN ON" }),
    ]);
    const surface = new FakeSurface([loginScreen]);
    const result = await discover({
      goal: LOOKUP_BALANCE_GOAL,
      surface,
      llm,
      policy: allowAll,
      inputs,
      secrets,
      baseUrl: "http://127.0.0.1:4100",
    });
    expect(surface.actions).toHaveLength(0);
    expect(result.status).toBe("done");
  });
});

const live = Boolean(process.env.OPENAI_API_KEY?.trim()) && process.env.LIVE_DISCOVERY === "1";

describe.skipIf(!live)("live discovery (optional)", () => {
  it("has a key when LIVE_DISCOVERY=1", () => {
    expect(hasOpenAIKey()).toBe(true);
  });
});
