import { afterEach, describe, expect, it } from "vitest";
import { CapabilityArtifact } from "../src/artifact/schema.js";
import type { EvidenceSink, NewRunEvent, RedactedPayload, RunEvent, RunManifest } from "../src/evidence/types.js";
import {
  ControlState,
  IllegalTransitionError,
  LeaseViolationError,
  SessionController,
  findResumeStep,
  reasonFromEscalate,
  startHandoffHost,
  startOperatorConsole,
  toHumanAction,
  LeasedSurface,
} from "../src/handoff/index.js";
import type { PolicyDecision, PolicyGate } from "../src/policy/types.js";
import { replay } from "../src/replay/engine.js";
import type { EvalContext } from "../src/replay/conditions.js";
import type {
  ActionOutcome,
  Observation,
  Surface,
  SurfaceAction,
} from "../src/surface/types.js";

class MemorySink implements EvidenceSink {
  readonly runId: string;
  readonly dir = ":memory:";
  readonly events: RunEvent[] = [];
  private seq = 0;
  constructor(runId = "handoff-run") {
    this.runId = runId;
  }
  append(event: NewRunEvent): RunEvent {
    const full: RunEvent = {
      runId: this.runId,
      seq: ++this.seq,
      at: new Date().toISOString(),
      actor: event.actor,
      type: event.type,
      payload: event.payload as RedactedPayload,
      ...(event.stepId !== undefined && { stepId: event.stepId }),
    };
    this.events.push(full);
    return full;
  }
  async attach(): Promise<string> {
    return "attachments/handoff.png";
  }
  async close(_manifest: Partial<RunManifest>): Promise<void> {}
}

function observation(text: string, url = "http://localhost/review"): Observation {
  return {
    url,
    title: "CoreLink",
    frames: [],
    elements: [],
    textByFrame: { "": text },
    snapshotHash: text,
    capturedAt: "2026-10-11T20:00:00.000Z",
  };
}

function ctx(obs: Observation): EvalContext {
  return {
    surface: {
      resolve: async () => ({ ok: false, reason: "not_found", attempts: [] }),
    } as unknown as EvalContext["surface"],
    observation: obs,
    templateValues: {},
    resolveValue: () => "",
  };
}

const resumeSteps = [
  {
    id: "login",
    preconditions: [{ kind: "urlMatches" as const, pattern: "/login" }],
    postcondition: { kind: "textPresent" as const, text: "Inquiry" },
  },
  {
    id: "review",
    preconditions: [{ kind: "textPresent" as const, text: "CANNOT BE REVERSED" }],
    postcondition: { kind: "textPresent" as const, text: "TRANSACTION POSTED" },
  },
  {
    id: "extract",
    preconditions: [{ kind: "textPresent" as const, text: "TRANSACTION POSTED" }],
  },
];

class FakeSurface implements Surface {
  readonly kind = "web" as const;
  url = "http://localhost/review";
  text = "CANNOT BE REVERSED";
  readonly acts: SurfaceAction[] = [];
  async observe(): Promise<Observation> {
    return observation(this.text, this.url);
  }
  async resolve() {
    return {
      ok: true as const,
      ref: "e1",
      strategyIndex: 0,
      strategyKind: "text" as const,
      attempts: [{ strategyIndex: 0, strategyKind: "text" as const, matches: 1 }],
      fingerprint: { name: "Submit" },
    };
  }
  async act(action: SurfaceAction): Promise<ActionOutcome> {
    this.acts.push(action);
    if (action.type === "click") this.text = "TRANSACTION POSTED";
    if (action.type === "navigate") this.url = action.url;
    return { ok: true, urlAfter: this.url, durationMs: 1 };
  }
  async extract(): Promise<string> {
    return "CONF-1";
  }
  async screenshot(): Promise<Buffer> {
    return Buffer.from("png");
  }
  async currentUrl(): Promise<string> {
    return this.url;
  }
  async close(): Promise<void> {}
}

function tinyArtifact() {
  return CapabilityArtifact.parse({
    schemaVersion: "capabilityforge/v1",
    id: "test.handoff_resume",
    version: "1.0.0",
    status: "draft",
    title: "Handoff resume fixture",
    description: "Navigate, irreversible click, extract.",
    provenance: { source: "hand-written", recordedAt: "2026-10-11T20:00:00.000Z" },
    app: { vendor: "Test", product: "T", versionRange: "1", surface: "web", entryRoute: "/" },
    inputs: {},
    outputs: {
      ok: {
        type: "string",
        description: "marker",
        sensitivity: "internal",
        extraction: {
          target: { description: "Posted marker", strategies: [{ kind: "text", text: "TRANSACTION POSTED" }] },
          read: "text",
        },
      },
    },
    steps: [
      { id: "go", intent: "Open review", action: { type: "navigate", url: "/review" }, risk: "safe" },
      {
        id: "submit",
        intent: "Post the transaction",
        target: { description: "Submit", strategies: [{ kind: "text", text: "Submit" }] },
        action: { type: "click" },
        risk: "irreversible",
        preconditions: [{ kind: "textPresent", text: "CANNOT BE REVERSED" }],
        postcondition: { kind: "textPresent", text: "TRANSACTION POSTED" },
      },
      {
        id: "read",
        intent: "Read confirmation",
        action: { type: "extract", outputs: ["ok"] },
        risk: "safe",
        preconditions: [{ kind: "textPresent", text: "TRANSACTION POSTED" }],
      },
    ],
    successCheckpoint: { description: "posted", condition: { kind: "textPresent", text: "TRANSACTION POSTED" } },
  });
}

const escalateGate: PolicyGate = {
  evaluate: (req): PolicyDecision =>
    req.risk === "irreversible"
      ? { verdict: "escalate", ruleId: "grant", reason: "irreversible step requires approval", requiredGrant: "approve_irreversible" }
      : { verdict: "allow", ruleId: "action_allowlist", reason: "ok" },
};

const allowAll: PolicyGate = {
  evaluate: (): PolicyDecision => ({ verdict: "allow", ruleId: "action_allowlist", reason: "ok" }),
};

describe("control state machine", () => {
  it("walks AGENT → PAUSED → HUMAN → RESUMING → AGENT and restores the automation lease", () => {
    const c = new SessionController({ runId: "r1", source: "replay" });
    expect(c.state).toBe(ControlState.AGENT);
    expect(c.lease.holder).toBe("replay");
    const iv = c.requestIntervention({
      reason: "irreversible_step_requires_approval",
      message: "submit needs a human",
      url: "http://localhost/review",
      stepId: "submit",
    });
    expect(c.state).toBe(ControlState.PAUSED);
    expect(c.lease.holder).toBeNull();
    expect(iv.allowedActions).toEqual(["take_control", "approve", "abort"]);
    c.takeControl(iv.id, "sasank");
    expect(c.state).toBe(ControlState.HUMAN);
    expect(c.lease.holder).toBe("human");
    c.handBack(iv.id, "sasank", "posted");
    expect(c.state).toBe(ControlState.RESUMING);
    expect(c.lease.holder).toBe("replay");
    c.markResumed();
    expect(c.state).toBe(ControlState.AGENT);
    expect(c.getIntervention(iv.id)?.resolution?.outcome).toBe("handed_back");
  });

  it("supports approve without taking the browser", () => {
    const c = new SessionController({ runId: "r1", source: "replay" });
    const iv = c.requestIntervention({
      reason: "irreversible_step_requires_approval",
      message: "approve me",
      url: "http://localhost/review",
    });
    c.approve(iv.id, "sasank");
    expect(c.state).toBe(ControlState.RESUMING);
    c.markResumed();
    expect(c.getIntervention(iv.id)?.resolution?.outcome).toBe("approved");
  });

  it("rejects illegal transitions and lease violations", () => {
    const c = new SessionController({ runId: "r1", source: "replay" });
    expect(() => c.takeControl("missing")).toThrow(/unknown intervention/);
    c.assertCanAct("replay");
    expect(() => c.assertCanAct("human")).toThrow(LeaseViolationError);
    const iv = c.requestIntervention({ reason: "agent_requested", message: "help", url: "http://x" });
    expect(() => c.assertCanAct("replay")).toThrow(LeaseViolationError);
    expect(() => c.requestIntervention({ reason: "agent_requested", message: "again", url: "http://x" })).toThrow(
      IllegalTransitionError,
    );
    c.abort(iv.id);
    expect(c.state).toBe(ControlState.ABORTED);
    expect(() => c.complete()).toThrow(IllegalTransitionError);
  });

  it("waitForResolution settles when the operator aborts", async () => {
    const c = new SessionController({ runId: "r1", source: "replay" });
    const iv = c.requestIntervention({ reason: "policy_escalation", message: "x", url: "http://x" });
    const pending = c.waitForResolution(iv.id);
    c.abort(iv.id, "sasank", "nope");
    const done = await pending;
    expect(done.status).toBe("aborted");
    expect(done.resolution?.outcome).toBe("aborted");
  });
});

describe("resume by screen re-classification", () => {
  it("resumes at the escalated step while its postcondition is still open", async () => {
    const match = await findResumeStep({
      steps: resumeSteps,
      ctx: ctx(observation("Please confirm. CANNOT BE REVERSED.")),
      fromStepId: "review",
    });
    expect(match?.stepId).toBe("review");
  });

  it("skips a completed irreversible step and resumes at extract", async () => {
    const match = await findResumeStep({
      steps: resumeSteps,
      ctx: ctx(observation("TRANSACTION POSTED Confirmation Number: 9")),
      fromStepId: "review",
    });
    expect(match?.stepId).toBe("extract");
  });

  it("skips a step with empty preconditions whose postcondition already holds", async () => {
    const steps = [
      { id: "submit", preconditions: [], postcondition: { kind: "textPresent" as const, text: "TRANSACTION POSTED" } },
      { id: "extract", preconditions: [] },
    ];
    const match = await findResumeStep({
      steps,
      ctx: ctx(observation("TRANSACTION POSTED Confirmation Number: 9")),
      fromStepId: "submit",
    });
    expect(match?.stepId).toBe("extract");
    expect(match?.skippedStepIds).toContain("submit");
  });

  it("wraps back to login only when login preconditions match", async () => {
    const match = await findResumeStep({
      steps: resumeSteps,
      ctx: ctx(observation("PLEASE SIGN ON AGAIN", "http://localhost/login")),
      fromStepId: "review",
    });
    expect(match?.stepId).toBe("login");
  });

  it("does not wrap to an unconstrained step on a foreign screen", async () => {
    const steps = [
      { id: "open", preconditions: [] },
      { id: "submit", preconditions: [{ kind: "textPresent" as const, text: "CANNOT BE REVERSED" }] },
    ];
    const match = await findResumeStep({
      steps,
      ctx: ctx(observation("mystery interstitial", "http://localhost/other")),
      fromStepId: "submit",
    });
    expect(match).toBeNull();
  });
});

describe("leased surface", () => {
  it("rejects replay acts unless the replay actor holds the lease", async () => {
    const inner = new FakeSurface();
    const c = new SessionController({ runId: "r1", source: "replay" });
    const surface = new LeasedSurface(inner, c, "replay");
    await expect(surface.act({ type: "click", ref: "e1" })).resolves.toMatchObject({ ok: true });
    c.requestIntervention({ reason: "policy_escalation", message: "x", url: "http://x" });
    await expect(surface.act({ type: "click", ref: "e1" })).rejects.toThrow(LeaseViolationError);
  });
});

describe("human action redaction", () => {
  it("masks password values before they are logged", () => {
    const action = toHumanAction({
      kind: "type",
      url: "http://localhost/login",
      tag: "input",
      type: "password",
      name: "fld2",
      value: "change-me-local-only",
      sensitive: true,
    });
    expect(action.value).toBe("[SECRET]");
    expect(action.sensitive).toBe(true);
  });
});

describe("operator console", () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (closers.length) await closers.pop()!();
  });

  it("lists an intervention and take / hand-back through HTTP", async () => {
    const c = new SessionController({ runId: "r-console", source: "replay" });
    const server = await startOperatorConsole({ controller: c, port: 0 });
    closers.push(() => server.close());
    const iv = c.requestIntervention({
      reason: "irreversible_step_requires_approval",
      message: "submit",
      url: "http://localhost/review",
      stepId: "submit",
    });
    const state = (await (await fetch(`${server.url}/api/state`)).json()) as {
      interventions: { id: string; status: string }[];
    };
    expect(state.interventions[0]?.id).toBe(iv.id);
    const page = await (await fetch(server.url)).text();
    expect(page).toMatch(/take control/i);
    await fetch(`${server.url}/api/interventions/${iv.id}/take`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operator: "sasank" }),
    });
    expect(c.state).toBe(ControlState.HUMAN);
    await fetch(`${server.url}/api/interventions/${iv.id}/hand-back`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "done" }),
    });
    expect(c.state).toBe(ControlState.RESUMING);
  });
});

describe("focused handoff through replay", () => {
  it("maps escalate reasons", () => {
    expect(
      reasonFromEscalate({
        reason: "needs grant",
        stepId: "submit",
        policy: { verdict: "escalate", ruleId: "grant", reason: "x", requiredGrant: "approve_irreversible" },
      }),
    ).toBe("irreversible_step_requires_approval");
    expect(reasonFromEscalate({ reason: "dialog", stepId: "x", screenStateId: "maintenanceDialog" })).toBe(
      "artifact_escalate_handler",
    );
  });

  it("reclassifies after a human completes the irreversible step and does not click again", async () => {
    const artifact = tinyArtifact();
    const surface = new FakeSurface();
    const evidence = new MemorySink();
    const result = await replay({
      artifact,
      surface,
      policy: escalateGate,
      evidence,
      inputs: {},
      baseUrl: "http://localhost",
      invocationId: "inv-1",
      onEscalate: async (info) => {
        expect(info.stepId).toBe("submit");
        surface.text = "TRANSACTION POSTED";
        const match = await findResumeStep({
          steps: artifact.steps,
          ctx: ctx(await surface.observe()),
          fromStepId: info.stepId ?? undefined,
        });
        expect(match?.stepId).toBe("read");
        return { action: "resume_from", stepId: match!.stepId };
      },
    });
    expect(result.status, JSON.stringify(result)).toBe("success");
    if (result.status !== "success") return;
    expect(result.outputs.ok).toBe("CONF-1");
    expect(surface.acts.some((a) => a.type === "click")).toBe(false);
    expect(evidence.events.some((e) => e.type === "control_changed")).toBe(true);
  });

  it("continues and acts when the operator approves", async () => {
    const artifact = tinyArtifact();
    const surface = new FakeSurface();
    const result = await replay({
      artifact,
      surface,
      policy: escalateGate,
      inputs: {},
      baseUrl: "http://localhost",
      onEscalate: async () => "resume",
    });
    expect(result.status, JSON.stringify(result)).toBe("success");
    expect(surface.acts.some((a) => a.type === "click")).toBe(true);
  });

  it("returns escalated when the operator aborts", async () => {
    const result = await replay({
      artifact: tinyArtifact(),
      surface: new FakeSurface(),
      policy: escalateGate,
      inputs: {},
      baseUrl: "http://localhost",
      onEscalate: async () => "abort",
    });
    expect(result.status).toBe("escalated");
  });

  it("host waits for take/hand-back then resumes from the matching step", async () => {
    const artifact = tinyArtifact();
    const surface = new FakeSurface();
    const host = await startHandoffHost({
      runId: "host-1",
      source: "replay",
      surface,
      artifact,
      evidence: new MemorySink("host-1"),
      policy: allowAll,
      invocationId: "inv-host",
      port: 0,
    });
    try {
      const pending = host.escalate({
        reason: "irreversible step requires approval",
        stepId: "submit",
        policy: { verdict: "escalate", ruleId: "grant", reason: "grant", requiredGrant: "approve_irreversible" },
      });
      await new Promise((r) => setImmediate(r));
      const iv = host.controller.activeIntervention();
      expect(iv?.reason).toBe("irreversible_step_requires_approval");
      host.controller.takeControl(iv!.id);
      surface.text = "TRANSACTION POSTED";
      host.controller.handBack(iv!.id, "sasank");
      const decision = await pending;
      expect(decision).toEqual({ action: "resume_from", stepId: "read" });
      expect(host.controller.state).toBe(ControlState.AGENT);
    } finally {
      await host.close();
    }
  });
});
