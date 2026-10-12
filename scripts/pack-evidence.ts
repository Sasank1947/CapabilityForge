/**
 * Builds the /evidence pack: copies the real discovery run, then records
 * success / exception replays, a scripted handoff, and a Tenant B overlay run.
 *
 * Usage: npx tsx scripts/pack-evidence.ts
 */
import "dotenv/config";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startCoreLink, type CoreLinkHandle } from "../apps/corelink/server.js";
import { applyOverlay, loadOverlay } from "../src/artifact/overlay.js";
import { parseArtifact, type CapabilityArtifact } from "../src/artifact/schema.js";
import { JsonlEvidenceSink } from "../src/evidence/sink.js";
import { startTrace } from "../src/evidence/trace.js";
import type { EvidenceSink, NewRunEvent, RunEvent, RunManifest } from "../src/evidence/types.js";
import { LeasedSurface, startHandoffHost } from "../src/handoff/index.js";
import { loadPolicy } from "../src/policy/config.js";
import { DefaultPolicyGate } from "../src/policy/gate.js";
import { Redactor } from "../src/policy/redact.js";
import type { PolicyDecision, PolicyGate } from "../src/policy/types.js";
import { replay } from "../src/replay/engine.js";
import { driftReport, type ReplayResult } from "../src/replay/result.js";
import { PlaywrightWebSurface } from "../src/surface/playwright-web.js";

const ROOT = "evidence";
const DISCOVERY_RUN = "runs/20261012T042431Z-discovery-295346";
const DISCOVERED_ARTIFACT = "runs/live-discover.json";
const APPROVED = "capabilities/corelink.lookup_member_balance.json";
const OVERLAY = "capabilities/overlays/corelink.lookup_member_balance.b.json";

const secrets = {
  username: process.env.CORELINK_USER ?? "teller01",
  password: process.env.CORELINK_PASSWORD ?? "change-me-local-only",
};

const allowAll: PolicyGate = {
  evaluate: (): PolicyDecision => ({ verdict: "allow", ruleId: "origin_allowlist", reason: "evidence pack allow" }),
};

class DeferredCloseSink implements EvidenceSink {
  constructor(readonly inner: JsonlEvidenceSink) {}
  get runId(): string {
    return this.inner.runId;
  }
  get dir(): string {
    return this.inner.dir;
  }
  append(event: NewRunEvent): RunEvent {
    return this.inner.append(event);
  }
  attach(name: string, data: Buffer): Promise<string> {
    return this.inner.attach(name, data);
  }
  async close(_manifest: Partial<RunManifest>): Promise<void> {}
  finish(manifest: Partial<RunManifest>): Promise<void> {
    return this.inner.close(manifest);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function redactScan(dir: string): void {
  const forbidden = ["OPENAI_API_KEY", "sk-proj-", "sk-live-", "change-me-local-only"];
  const walk = (p: string): string[] => {
    const out: string[] = [];
    for (const name of readdirSync(p)) {
      if (name === "trace.zip" || name.endsWith(".png")) continue;
      const full = join(p, name);
      if (statSync(full).isDirectory()) out.push(...walk(full));
      else if (/\.(json|jsonl|md|txt)$/i.test(name)) out.push(full);
    }
    return out;
  };
  for (const file of walk(dir)) {
    const text = readFileSync(file, "utf8");
    for (const needle of forbidden) {
      if (text.includes(needle)) throw new Error(`refusing to pack ${file}: contains ${needle}`);
    }
  }
}

function copyDiscovery(): void {
  const dest = join(ROOT, "discovery");
  mkdirSync(join(dest, "attachments"), { recursive: true });
  cpSync(join(DISCOVERY_RUN, "events.jsonl"), join(dest, "events.jsonl"));
  cpSync(join(DISCOVERY_RUN, "manifest.json"), join(dest, "manifest.json"));
  cpSync(DISCOVERED_ARTIFACT, join(dest, "artifact.json"));
  writeFileSync(
    join(dest, "SOURCE.md"),
    [
      "This is a real LLM-driven discovery run (not a scripted walk).",
      "",
      `- run id: 20261012T042431Z-discovery-295346`,
      `- model: gpt-4.1-2025-04-14`,
      `- goal: lookup-balance / memberId parameterised (value redacted in logs)`,
      `- compiled artifact: artifact.json (status=draft; compiler default screen-state handlers)`,
      "",
      "The original run did not persist screenshots because the accessibility tree was sufficient;",
      "attachments/ were captured afterwards by walking the same screens with CSS masking.",
      "Live discovery was not re-run for this pack.",
      "",
    ].join("\n"),
  );
}

async function captureDiscoveryScreens(app: CoreLinkHandle): Promise<void> {
  const dest = join(ROOT, "discovery", "attachments");
  const surface = await PlaywrightWebSurface.launch({ actionTimeoutMs: 15_000 });
  const mask = [secrets.username, secrets.password, "12345"];
  try {
    await surface.act({ type: "navigate", url: `${app.origin}/login` });
    await surface.screenshot({ path: join(dest, "01-login.png"), maskValues: mask });

    const user = await surface.resolve({
      description: "Operator ID",
      framePath: [],
      cardinality: "exactlyOne",
      strategies: [
        { kind: "role", role: "textbox", name: "Operator ID:" },
        { kind: "label", labelText: "Operator ID:", relation: "right-of" },
      ],
    });
    const pw = await surface.resolve({
      description: "Password",
      framePath: [],
      cardinality: "exactlyOne",
      strategies: [{ kind: "label", labelText: "Password:", relation: "right-of" }],
    });
    if (!user.ok || !pw.ok) throw new Error("discovery screenshot walk: login fields not found");
    await surface.act({ type: "type", ref: user.ref, text: secrets.username, clear: true, sensitive: true });
    await surface.act({ type: "type", ref: pw.ref, text: secrets.password, clear: true, sensitive: true });
    const signOn = await surface.resolve({
      description: "Sign On",
      framePath: [],
      cardinality: "exactlyOne",
      strategies: [{ kind: "role", role: "button", name: "Sign On" }],
    });
    if (!signOn.ok) throw new Error("discovery screenshot walk: Sign On not found");
    await surface.act({ type: "click", ref: signOn.ref });

    const inquiry = await surface.resolve({
      description: "Member Inquiry",
      framePath: ["nav"],
      cardinality: "exactlyOne",
      strategies: [{ kind: "role", role: "link", name: "Member Inquiry" }],
    });
    if (!inquiry.ok) throw new Error("discovery screenshot walk: Member Inquiry not found");
    await surface.act({ type: "click", ref: inquiry.ref });
    await surface.screenshot({ path: join(dest, "02-search.png"), maskValues: mask });

    const member = await surface.resolve({
      description: "Member Number",
      framePath: ["main"],
      cardinality: "exactlyOne",
      strategies: [
        { kind: "label", labelText: "Member Number:", relation: "right-of" },
        { kind: "css", selector: "input[name=fld1]" },
      ],
    });
    if (!member.ok) throw new Error("discovery screenshot walk: member field not found");
    await surface.act({ type: "type", ref: member.ref, text: "12345", clear: true, sensitive: true });
    const search = await surface.resolve({
      description: "Search",
      framePath: ["main"],
      cardinality: "exactlyOne",
      strategies: [{ kind: "role", role: "button", name: "Search" }],
    });
    if (!search.ok) throw new Error("discovery screenshot walk: Search not found");
    await surface.act({ type: "click", ref: search.ref });
    await surface.screenshot({ path: join(dest, "03-results.png"), maskValues: mask });

    const link = await surface.resolve({
      description: "row",
      framePath: ["main"],
      cardinality: "exactlyOne",
      strategies: [{ kind: "role", role: "link", name: "{{memberId}}" }],
    }, { templateValues: { memberId: "12345" } });
    if (!link.ok) throw new Error("discovery screenshot walk: member link not found");
    await surface.act({ type: "click", ref: link.ref });
    await surface.screenshot({ path: join(dest, "04-detail.png"), maskValues: mask });
  } finally {
    await surface.close();
  }
}

async function runReplay(opts: {
  id: string;
  artifact: CapabilityArtifact;
  app: CoreLinkHandle;
  inputs: Record<string, string>;
  headers?: Record<string, string>;
  tenant?: string;
  routePrefix?: string;
  policy?: PolicyGate;
  expect: ReplayResult["status"] | ((r: ReplayResult) => void);
}): Promise<ReplayResult> {
  const redactor = Redactor.forRun(opts.artifact, { inputs: opts.inputs, secrets });
  const sink = new DeferredCloseSink(
    new JsonlEvidenceSink({
      rootDir: ROOT,
      runId: opts.id,
      redactor,
      mode: "replay",
      manifest: { capabilityId: opts.artifact.id, capabilityVersion: opts.artifact.version, tenant: opts.tenant },
    }),
  );
  const surface = await PlaywrightWebSurface.launch({
    extraHTTPHeaders: opts.headers,
    actionTimeoutMs: 20_000,
  });
  const trace = await startTrace(surface.context, sink, { title: opts.id });
  try {
    const result = await replay({
      artifact: opts.artifact,
      surface,
      policy: opts.policy ?? (existsSync("policies/corelink.json") ? new DefaultPolicyGate(loadPolicy("policies/corelink.json")) : allowAll),
      evidence: sink,
      inputs: opts.inputs,
      secrets,
      baseUrl: opts.app.origin,
      routePrefix: opts.routePrefix ?? opts.app.prefix,
      tenant: opts.tenant,
      onEscalate: async () => "abort",
    });
    try {
      const shot = await surface.screenshot({ maskValues: redactor.screenshotMaskValues() });
      await sink.attach("final.png", shot);
    } catch {
      /* page may already be gone */
    }
    const keepTrace = result.status === "failure";
    const tracePath = await trace.stop({ keep: keepTrace, name: "trace.zip" });
    if (result.status === "failure" && tracePath) result.evidencePaths.push(tracePath);
    writeFileSync(join(sink.dir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
    if (opts.tenant === "b") {
      writeFileSync(join(sink.dir, "drift-report.json"), `${JSON.stringify(driftReport(result.strategyHits), null, 2)}\n`);
    }
    await sink.finish({ status: result.status, capabilityId: opts.artifact.id, tenant: opts.tenant });
    if (typeof opts.expect === "function") opts.expect(result);
    else if (result.status !== opts.expect) {
      throw new Error(`${opts.id}: expected ${opts.expect}, got ${result.status} ${JSON.stringify(result)}`);
    }
    return result;
  } finally {
    await surface.close();
  }
}

async function runHandoff(app: CoreLinkHandle, artifact: CapabilityArtifact): Promise<void> {
  if (existsSync(join(ROOT, "handoff"))) rmSync(join(ROOT, "handoff"), { recursive: true, force: true });
  const inputs = { memberId: "12345" };
  const redactor = Redactor.forRun(artifact, { inputs, secrets });
  const sink = new DeferredCloseSink(
    new JsonlEvidenceSink({
      rootDir: ROOT,
      runId: "handoff",
      redactor,
      mode: "replay",
      manifest: { capabilityId: artifact.id, capabilityVersion: artifact.version },
    }),
  );
  const surface = await PlaywrightWebSurface.launch({ actionTimeoutMs: 20_000 });
  let handedOff = false;
  const policy: PolicyGate = {
    evaluate: (req): PolicyDecision =>
      req.stepId === "open-member" && !handedOff
        ? { verdict: "escalate", ruleId: "grant", reason: "scripted handoff at open-member", requiredGrant: "approve_irreversible" }
        : { verdict: "allow", ruleId: "action_allowlist", reason: "ok" },
  };
  const host = await startHandoffHost({
    runId: sink.runId,
    source: "replay",
    surface,
    artifact,
    evidence: sink,
    policy,
    redactor,
    invocationId: "evidence-handoff",
    port: 0,
    inputs,
    secrets,
  });
  const gated = new LeasedSurface(surface, host.controller, "replay");

  writeFileSync(
    join(sink.dir, "NOTES.md"),
    [
      "Scripted handoff on the live Chromium session (not a headed human at a keyboard).",
      "",
      "Replay of corelink.lookup_member_balance uses a policy that escalates at `open-member`.",
      "The operator console take / hand-back endpoints are driven over HTTP. While the",
      "SessionController lease is held by `human`, the same Playwright page clicks the",
      "member-number link. After hand-back the engine re-classifies the screen and resumes",
      "at `read-balance`. The lease / console / recorder mechanism is the production one;",
      "only the operator gestures are scripted.",
      "",
    ].join("\n"),
  );

  try {
    const pending = replay({
      artifact,
      surface: gated,
      policy,
      evidence: sink,
      inputs,
      secrets,
      baseUrl: app.origin,
      routePrefix: app.prefix,
      invocationId: "evidence-handoff",
      onEscalate: (info) => host.escalate(info),
    });

    const operator = (async () => {
      for (let i = 0; i < 200; i++) {
        const iv = host.controller.activeIntervention();
        if (iv && (iv.status === "open" || iv.status === "claimed")) {
          if (iv.status === "open") {
            const take = await fetch(`${host.console.url}/api/interventions/${iv.id}/take`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ operator: "sasank" }),
            });
            if (!take.ok) throw new Error(`take control failed: ${take.status}`);
          }
          const link = await surface.resolve(
            {
              description: "member row",
              framePath: ["main"],
              cardinality: "exactlyOne",
              strategies: [{ kind: "role", role: "link", name: "{{memberId}}" }],
            },
            { templateValues: { memberId: "12345" } },
          );
          if (!link.ok) throw new Error(`handoff: member link not found (${link.reason})`);
          await surface.act({ type: "click", ref: link.ref });
          for (let w = 0; w < 40; w++) {
            const obs = await surface.observe();
            if (Object.values(obs.textByFrame).some((t) => /REGULAR SAVINGS/i.test(t))) break;
            await sleep(100);
          }
          handedOff = true;
          const hand = await fetch(`${host.console.url}/api/interventions/${iv.id}/hand-back`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ note: "opened member detail from operator console" }),
          });
          if (!hand.ok) throw new Error(`hand-back failed: ${hand.status}`);
          return;
        }
        await sleep(50);
      }
      throw new Error("handoff: no intervention opened");
    })();

    const [result] = await Promise.all([pending, operator]);
    const shot = await surface.screenshot({ maskValues: redactor.screenshotMaskValues() }).catch(() => undefined);
    if (shot) await sink.attach("final.png", shot);
    writeFileSync(join(sink.dir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
    if (result.status !== "success") {
      throw new Error(`handoff: expected success after scripted take/hand-back, got ${result.status} ${JSON.stringify(result)}`);
    }
    await host.close();
    await sink.finish({ status: result.status, capabilityId: artifact.id });
  } finally {
    await surface.close();
  }
}

function have(id: string): boolean {
  return existsSync(join(ROOT, id, "result.json"));
}

async function main(): Promise<void> {
  mkdirSync(ROOT, { recursive: true });
  if (!existsSync(DISCOVERY_RUN) || !existsSync(DISCOVERED_ARTIFACT)) {
    throw new Error("missing discovery run; expected runs/20261012T042431Z-discovery-295346 and runs/live-discover.json");
  }
  if (!existsSync(join(ROOT, "discovery", "events.jsonl"))) copyDiscovery();
  cpSync(APPROVED, join(ROOT, "corelink.lookup_member_balance.json"));

  const appA = await startCoreLink({ port: 0, tenant: "a", seed: 1 });
  const appB = await startCoreLink({ port: 0, tenant: "b", seed: 1 });
  const lookup = parseArtifact(JSON.parse(readFileSync(APPROVED, "utf8")));
  const overlayed = applyOverlay(lookup, loadOverlay(OVERLAY));

  try {
    if (!existsSync(join(ROOT, "discovery", "attachments", "04-detail.png"))) {
      await captureDiscoveryScreens(appA);
    }

    if (!have("replay-success")) {
      await runReplay({
        id: "replay-success",
        artifact: lookup,
        app: appA,
        inputs: { memberId: "12345" },
        expect: (r) => {
          if (r.status !== "success") throw new Error(`replay-success: ${r.status}`);
          if (r.outputs.savingsBalance !== 1520.75) throw new Error(`unexpected balance ${r.outputs.savingsBalance}`);
        },
      });
    }

    if (!have("replay-not-found")) {
      await fetch(`${appA.origin}/__admin/reset`);
      await runReplay({
        id: "replay-not-found",
        artifact: lookup,
        app: appA,
        inputs: { memberId: "99999" },
        expect: (r) => {
          if (r.status !== "business_outcome" || r.code !== "MEMBER_NOT_FOUND") {
            throw new Error(`replay-not-found: ${JSON.stringify(r)}`);
          }
        },
      });
    }

    if (!have("replay-session-expired")) {
      await fetch(`${appA.origin}/__admin/reset`);
      await fetch(`${appA.origin}/__admin/fault?set=session_expired&once=1&route=/search&method=POST`);
      await runReplay({
        id: "replay-session-expired",
        artifact: lookup,
        app: appA,
        inputs: { memberId: "12345" },
        expect: (r) => {
          if (r.status !== "success") throw new Error(`session_expired: ${r.status}`);
          if (!r.recoveries.some((x) => x.screenStateId === "sessionExpired" && x.ok)) {
            throw new Error(`session_expired: no recovery ${JSON.stringify(r.recoveries)}`);
          }
        },
      });
    }

    if (!have("replay-surprise-dialog")) {
      await fetch(`${appA.origin}/__admin/reset`);
      await fetch(`${appA.origin}/__admin/fault?set=surprise_dialog&once=1&route=/search&method=POST`);
      await runReplay({
        id: "replay-surprise-dialog",
        artifact: lookup,
        app: appA,
        inputs: { memberId: "12345" },
        expect: (r) => {
          if (r.status !== "success") throw new Error(`surprise_dialog: ${r.status}`);
          if (!r.recoveries.some((x) => x.screenStateId === "maintenanceDialog" && x.ok)) {
            throw new Error(`surprise_dialog: no recovery ${JSON.stringify(r.recoveries)}`);
          }
        },
      });
    }

    if (!have("replay-server-error")) {
      await fetch(`${appA.origin}/__admin/reset`);
      await runReplay({
        id: "replay-server-error",
        artifact: lookup,
        app: appA,
        inputs: { memberId: "12345" },
        headers: { "X-Fault": "server_error@GET/search" },
        expect: (r) => {
          if (r.status !== "failure" || r.kind !== "app_error") throw new Error(`server_error: ${JSON.stringify(r)}`);
        },
      });
    }

    if (!have("handoff")) {
      await fetch(`${appA.origin}/__admin/reset`);
      await runHandoff(appA, lookup);
    }

    if (!have("tenant-b")) {
      await runReplay({
        id: "tenant-b",
        artifact: overlayed,
        app: appB,
        inputs: { memberId: "12345" },
        tenant: "b",
        routePrefix: "",
        expect: (r) => {
          if (r.status !== "success") throw new Error(`tenant-b: ${r.status} ${JSON.stringify(r)}`);
          if (r.outputs.savingsBalance !== 1520.75) throw new Error(`tenant-b balance ${r.outputs.savingsBalance}`);
          if (!r.recoveries.some((x) => x.screenStateId === "acknowledgeNotice" && x.ok)) {
            throw new Error(`tenant-b: missing acknowledgeNotice recovery`);
          }
        },
      });
    }
  } finally {
    await appA.close();
    await appB.close();
  }

  writeFileSync(
    join(ROOT, "README.md"),
    [
      "# Evidence pack",
      "",
      "Demonstration of the end-to-end CapabilityForge flow. Secrets and raw PII are redacted.",
      "Playwright `trace.zip` is kept only on failure and is **not** redacted (raw DOM / network).",
      "",
      "| Path | What it is |",
      "|---|---|",
      "| `discovery/` | Real LLM discovery run (`gpt-4.1`, run `20261012T042431Z-discovery-295346`). `events.jsonl` + `manifest.json` from the live run; `artifact.json` is the compiler output; `attachments/*.png` are redacted screenshots of the same screens (original run did not persist shots — the a11y tree was enough). See `SOURCE.md`. |",
      "| `corelink.lookup_member_balance.json` | Approved artifact used for production replay (recover handlers reviewed in). |",
      "| `replay-success/` | Deterministic replay for `memberId=12345` → `savingsBalance: 1520.75`. |",
      "| `replay-not-found/` | Replay for `99999` → `business_outcome` / `MEMBER_NOT_FOUND`. |",
      "| `replay-session-expired/` | Injected `session_expired` on POST `/search`; recovered by re-login; run succeeded. |",
      "| `replay-surprise-dialog/` | Injected `surprise_dialog`; recovered by dismissing the interstitial; run succeeded. |",
      "| `replay-server-error/` | Injected 500 on GET `/search` → `failure` / `app_error` plus `attachments/*trace.zip`. |",
      "| `handoff/` | Scripted operator on the live Chromium session: policy escalates at `open-member`, console take/hand-back via HTTP, same page clicks the member link, replay resumes at `read-balance`. See `NOTES.md`. |",
      "| `tenant-b/` | Base artifact + Tenant B overlay against MeridianCU; `drift-report.json` from strategy-fallback hits. |",
      "",
      "Each replay directory contains `events.jsonl`, `manifest.json`, `result.json`, and `attachments/final.png`.",
      "",
      "Live discovery was **not** re-run for this pack; the existing successful run was copied.",
      "",
    ].join("\n"),
  );
  redactScan(ROOT);
  process.stdout.write("evidence pack written to evidence/\n");
}

await main();
