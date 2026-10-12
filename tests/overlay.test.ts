import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startCoreLink, type CoreLinkHandle } from "../apps/corelink/server.js";
import { LOOKUP_MEMBER_BALANCE } from "../src/artifact/corelink.js";
import {
  applyOverlay,
  loadOverlay,
  OverlayError,
  parseOverlay,
  versionSatisfies,
} from "../src/artifact/overlay.js";
import { parseArtifact } from "../src/artifact/schema.js";
import type { EvidenceSink, NewRunEvent, RedactedPayload, RunEvent, RunManifest } from "../src/evidence/types.js";
import type { PolicyDecision, PolicyGate } from "../src/policy/types.js";
import { replay } from "../src/replay/engine.js";
import { driftReport } from "../src/replay/result.js";
import { PlaywrightWebSurface } from "../src/surface/playwright-web.js";

const allowAll: PolicyGate = {
  evaluate: (): PolicyDecision => ({ verdict: "allow", ruleId: "origin_allowlist", reason: "test allow-all" }),
};

class MemorySink implements EvidenceSink {
  readonly runId: string;
  readonly dir = ":memory:";
  private seq = 0;
  constructor(runId = "overlay-run") {
    this.runId = runId;
  }
  append(event: NewRunEvent): RunEvent {
    return {
      runId: this.runId,
      seq: ++this.seq,
      at: new Date().toISOString(),
      actor: event.actor,
      type: event.type,
      payload: event.payload as RedactedPayload,
      ...(event.stepId !== undefined && { stepId: event.stepId }),
    };
  }
  async attach(): Promise<string> {
    return "";
  }
  async close(_manifest: Partial<RunManifest>): Promise<void> {}
}

const secrets = { username: "teller01", password: "change-me-local-only" };
const overlay = loadOverlay("capabilities/overlays/corelink.lookup_member_balance.b.json");

describe("applyOverlay", () => {
  const base = parseArtifact(LOOKUP_MEMBER_BALANCE);

  it("rewrites labels, /mcu/ routes, prepends strategies, and adds notice recover", () => {
    const merged = applyOverlay(base, overlay);
    expect(merged.app.entryRoute).toBe("/mcu/login");
    expect(merged.steps.find((s) => s.id === "open-login")?.action).toMatchObject({ type: "navigate", url: "/mcu/login" });
    expect(merged.steps.find((s) => s.id === "enter-member")?.target?.strategies[0]).toMatchObject({
      kind: "role",
      name: "Member #:",
    });
    expect(merged.steps.find((s) => s.id === "sign-in")?.postcondition).toMatchObject({
      kind: "textPresent",
      text: "Member Lookup",
    });
    expect(merged.successCheckpoint.condition).toEqual(
      expect.objectContaining({
        kind: "all",
        conditions: expect.arrayContaining([expect.objectContaining({ text: "MEMBER PROFILE" })]),
      }),
    );
    const notice = merged.screenStates.find((s) => s.id === "acknowledgeNotice");
    expect(notice?.handler.kind).toBe("recover");
    if (notice?.handler.kind !== "recover") return;
    expect(notice.handler.resume).toEqual({ mode: "restartFrom", stepId: "open-inquiry" });
    expect(notice.detect).toMatchObject({ kind: "any" });
  });

  it("rejects a mismatched base id or version range", () => {
    expect(() => applyOverlay(base, parseOverlay({ ...overlay, baseId: "corelink.open_sub_account" }))).toThrow(OverlayError);
    expect(() => applyOverlay(base, parseOverlay({ ...overlay, baseVersionRange: "^2.0.0" }))).toThrow(OverlayError);
  });

  it("satisfies caret ranges used by overlays", () => {
    expect(versionSatisfies("1.0.0", "^1.0.0")).toBe(true);
    expect(versionSatisfies("1.2.3", "^1.0.0")).toBe(true);
    expect(versionSatisfies("2.0.0", "^1.0.0")).toBe(false);
  });
});

describe("tenant B overlay replay", () => {
  let app: CoreLinkHandle;
  const artifact = applyOverlay(parseArtifact(LOOKUP_MEMBER_BALANCE), overlay);

  beforeAll(async () => {
    app = await startCoreLink({ port: 0, tenant: "b", seed: 1 });
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await fetch(`${app.origin}/__admin/reset`);
  });

  it("replays lookup on startCoreLink({tenant:'b'}) and reports drift", async () => {
    const surface = await PlaywrightWebSurface.launch({ actionTimeoutMs: 20_000 });
    try {
      const result = await replay({
        artifact,
        surface,
        policy: allowAll,
        evidence: new MemorySink(),
        inputs: { memberId: "12345" },
        secrets,
        baseUrl: app.origin,
        routePrefix: "",
        tenant: "b",
        onEscalate: async () => "abort",
      });
      expect(result.status, JSON.stringify(result)).toBe("success");
      if (result.status !== "success") return;
      expect(result.outputs.savingsBalance).toBe(1520.75);
      expect(result.tenant).toBe("b");
      expect(result.recoveries.some((r) => r.screenStateId === "acknowledgeNotice" && r.ok)).toBe(true);

      const report = driftReport(result.strategyHits);
      expect(report.stepsResolved).toBeGreaterThan(0);
      expect(report.driftScore).toBeGreaterThanOrEqual(0);
      expect(report.driftScore).toBeLessThanOrEqual(1);
      expect(report.fallbackSteps.every((s) => s.strategyIndex > 0)).toBe(true);
      expect(report.driftScore, JSON.stringify(report)).toBeLessThan(0.5);
    } finally {
      await surface.close();
    }
  }, 90_000);
});
