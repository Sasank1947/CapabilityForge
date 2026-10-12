import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LOOKUP_MEMBER_BALANCE } from "../src/artifact/corelink.js";
import { parseArtifact } from "../src/artifact/schema.js";
import { startCoreLink, type CoreLinkHandle } from "../apps/corelink/server.js";
import type { EvidenceSink, NewRunEvent, RedactedPayload, RunEvent, RunManifest } from "../src/evidence/types.js";
import type { PolicyDecision, PolicyGate } from "../src/policy/types.js";
import { replay } from "../src/replay/engine.js";
import { PlaywrightWebSurface } from "../src/surface/playwright-web.js";

const allowAll: PolicyGate = {
  evaluate: (): PolicyDecision => ({ verdict: "allow", ruleId: "origin_allowlist", reason: "test allow-all" }),
};

class MemorySink implements EvidenceSink {
  readonly runId: string;
  readonly dir = ":memory:";
  readonly events: RunEvent[] = [];
  private seq = 0;
  constructor(runId = "test-run") {
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
      ...(event.rationale !== undefined && { rationale: event.rationale }),
      ...(event.attachments !== undefined && { attachments: event.attachments }),
    };
    this.events.push(full);
    return full;
  }
  async attach(): Promise<string> {
    return "attachments/x";
  }
  async close(_manifest: Partial<RunManifest>): Promise<void> {}
}

const secrets = { username: "teller01", password: "change-me-local-only" };
const artifact = parseArtifact(LOOKUP_MEMBER_BALANCE);

describe("replay engine — corelink.lookup_member_balance", () => {
  let app: CoreLinkHandle;

  beforeAll(async () => {
    app = await startCoreLink({ port: 0, tenant: "a", seed: 1 });
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await fetch(`${app.origin}/__admin/reset`);
  });

  async function runLookup(
    inputs: Record<string, unknown>,
    extras: { headers?: Record<string, string>; escalate?: "resume" | "abort" } = {},
  ) {
    const surface = await PlaywrightWebSurface.launch({
      extraHTTPHeaders: extras.headers,
      actionTimeoutMs: 20_000,
    });
    try {
      return await replay({
        artifact,
        surface,
        policy: allowAll,
        evidence: new MemorySink(),
        inputs,
        secrets,
        baseUrl: app.origin,
        routePrefix: app.prefix,
        onEscalate: async () => extras.escalate ?? "abort",
      });
    } finally {
      await surface.close();
    }
  }

  it("succeeds for member 12345 and extracts savings balance 1520.75", async () => {
    const result = await runLookup({ memberId: "12345" });
    expect(result.status, JSON.stringify(result)).toBe("success");
    if (result.status !== "success") return;
    expect(result.outputs.savingsBalance).toBe(1520.75);
    expect(result.strategyHits.length).toBeGreaterThan(0);
    expect(result.recoveries).toEqual([]);
  });

  it("returns MEMBER_NOT_FOUND for 99999", async () => {
    const result = await runLookup({ memberId: "99999" });
    expect(result.status, JSON.stringify(result)).toBe("business_outcome");
    if (result.status !== "business_outcome") return;
    expect(result.code).toBe("MEMBER_NOT_FOUND");
    expect(result.screenStateId).toBe("memberNotFound");
  });

  it("recovers from surprise_dialog and still succeeds", async () => {
    await fetch(`${app.origin}/__admin/fault?set=surprise_dialog&once=1&route=/search&method=POST`);
    const result = await runLookup({ memberId: "12345" });
    expect(result.status, JSON.stringify(result)).toBe("success");
    if (result.status !== "success") return;
    expect(result.outputs.savingsBalance).toBe(1520.75);
    expect(result.recoveries.some((r) => r.screenStateId === "maintenanceDialog" && r.ok)).toBe(true);
  });

  it("recovers from session_expired and still succeeds", async () => {
    await fetch(`${app.origin}/__admin/fault?set=session_expired&once=1&route=/search&method=POST`);
    const result = await runLookup({ memberId: "12345" });
    expect(result.status, JSON.stringify(result)).toBe("success");
    if (result.status !== "success") return;
    expect(result.outputs.savingsBalance).toBe(1520.75);
    expect(result.recoveries.some((r) => r.screenStateId === "sessionExpired" && r.ok)).toBe(true);
  });

  it("fails on server_error", async () => {
    const result = await runLookup({ memberId: "12345" }, { headers: { "X-Fault": "server_error@GET/search" } });
    expect(result.status, JSON.stringify(result)).toBe("failure");
    if (result.status !== "failure") return;
    expect(result.kind).toBe("app_error");
    expect(result.screenStateId).toBe("serverError");
  });

  it("fails with invalid_input before touching the app", async () => {
    const result = await runLookup({ memberId: "12" });
    expect(result.status).toBe("failure");
    if (result.status !== "failure") return;
    expect(result.kind).toBe("invalid_input");
    expect(result.stepId).toBeNull();
  });

  it("succeeds under slow_load:2000", async () => {
    const result = await runLookup({ memberId: "12345" }, { headers: { "X-Fault": "slow_load:2000" } });
    expect(result.status, JSON.stringify(result)).toBe("success");
    if (result.status !== "success") return;
    expect(result.outputs.savingsBalance).toBe(1520.75);
  });
});
