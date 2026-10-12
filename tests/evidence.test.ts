import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyScreenshotMask, MASK_ATTRIBUTE, withScreenshotMask } from "../src/evidence/mask.js";
import { InMemoryEvidenceSink, JsonlEvidenceSink, newRunId } from "../src/evidence/sink.js";
import { startTrace, withTraceOnFailure } from "../src/evidence/trace.js";
import type { RunEvent } from "../src/evidence/types.js";
import { Redactor } from "../src/policy/redact.js";

const MEMBER = "12345";
const PASSWORD = "Tr0ub4dor&3";
const SSN = "900-12-3456";

function runRedactor(): Redactor {
  return Redactor.forRun(
    { inputs: { memberId: { sensitivity: "pii" } }, outputs: {}, secrets: { operatorPassword: {} } } as never,
    { inputs: { memberId: MEMBER }, secrets: { operatorPassword: PASSWORD } },
  );
}

describe("JsonlEvidenceSink", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "cf-runs-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("writes events.jsonl, manifest.json and attachments under runs/<runId>/", async () => {
    const redactor = runRedactor();
    const sink = new JsonlEvidenceSink({ rootDir: root, mode: "replay", redactor, manifest: { capabilityId: "corelink.lookup_member_balance", goal: `look up member ${MEMBER}` } });
    expect(sink.dir).toBe(join(root, sink.runId));
    expect(existsSync(join(sink.dir, "manifest.json"))).toBe(true);

    sink.record("replay", "run_started", { inputs: { memberId: MEMBER } });
    sink.record("replay", "action", { type: "type", ref: "e3", text: PASSWORD, clear: true, sensitive: true }, { stepId: "login", rationale: `typing password ${PASSWORD}` });
    sink.append({ actor: "replay", type: "observation", payload: redactor.redact({ text: `Member ${MEMBER} SSN ${SSN}`, url: `http://127.0.0.1:4100/member?m=${MEMBER}` }) });
    const shot = await sink.attach(`member-${MEMBER}.png`, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const dom = await sink.attachText("dom.html", `<td>${SSN}</td><input value="${MEMBER}">`);
    sink.record("replay", "error", { message: "boom" }, { attachments: [shot, dom] });
    await sink.close({ status: "failure" });

    const lines = readFileSync(sink.eventsPath, "utf8").trim().split("\n");
    const events = lines.map((l) => JSON.parse(l) as RunEvent);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(events.every((e) => e.runId === sink.runId && !Number.isNaN(Date.parse(e.at)) && e.at.endsWith("Z"))).toBe(true);
    expect(events[1]).toMatchObject({ stepId: "login", payload: { text: "[SECRET]" }, rationale: "typing password [SECRET]" });
    expect(events[3]!.attachments).toEqual([shot, dom]);

    expect(shot).toMatch(/^attachments\/001-member-_PII_memberId_[0-9a-f]{4}_\.png$/);
    expect(readdirSync(sink.attachmentsDir)).toHaveLength(2);
    expect(readFileSync(sink.pathOf(dom), "utf8")).not.toContain(SSN);

    const manifest = JSON.parse(readFileSync(sink.manifestPath, "utf8"));
    expect(manifest).toMatchObject({ runId: sink.runId, mode: "replay", status: "failure", capabilityId: "corelink.lookup_member_balance" });
    expect(manifest.finishedAt).toBeTruthy();

    const everything = [readFileSync(sink.eventsPath, "utf8"), readFileSync(sink.manifestPath, "utf8"), ...readdirSync(sink.attachmentsDir), readFileSync(sink.pathOf(dom), "utf8")].join("\n");
    for (const raw of [MEMBER, PASSWORD, SSN, encodeURIComponent(PASSWORD)]) expect(everything, raw).not.toContain(raw);
  });

  it("rejects writes after close and unsafe run ids", async () => {
    const sink = new JsonlEvidenceSink({ rootDir: root, mode: "discovery", redactor: new Redactor() });
    await sink.close({});
    expect(() => sink.record("agent", "decision", {})).toThrow(/closed/);
    expect(() => new JsonlEvidenceSink({ rootDir: root, mode: "replay", runId: "../escape", redactor: new Redactor() })).toThrow(/unsafe/);
  });

  it("generates sortable run ids", () => {
    expect(newRunId("replay", new Date("2026-10-11T18:51:02.123Z"))).toMatch(/^20261011T185102Z-replay-[0-9a-f]{6}$/);
  });
});

describe("InMemoryEvidenceSink", () => {
  it("sequences monotonically and re-redacts on append", async () => {
    const redactor = runRedactor();
    const sink = new InMemoryEvidenceSink({ mode: "discovery", redactor });
    for (let i = 0; i < 5; i++) sink.record("agent", "decision", { i, note: `member ${MEMBER}` });
    // A payload redacted by a redactor that did not know the value is still scrubbed by the sink's redactor.
    sink.append({ actor: "agent", type: "observation", payload: new Redactor().redact({ text: `pw=${PASSWORD} m=${MEMBER}` }) });
    await sink.close({ status: "success" });
    expect(sink.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    const dump = sink.dump();
    expect(dump).not.toContain(MEMBER);
    expect(dump).not.toContain(PASSWORD);
    expect(sink.closedManifest?.status).toBe("success");
  });
});

describe("Playwright helpers", () => {
  let browser: Browser;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader("content-type", "text/html");
      if (req.url === "/inner") {
        res.end(`<html><body><table><tr><td>SSN</td><td id="ssn">${SSN}</td></tr><tr><td id="pub">Branch 004</td></tr></table></body></html>`);
      } else {
        res.end(
          `<html><body><input id="pw" type="password" value="whatever"><input id="mbr" value="${MEMBER}"><span id="plain">hello</span><div class="acct">S00 Share</div>` +
            `<iframe name="main" src="/inner" width="400" height="200"></iframe></body></html>`,
        );
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser?.close();
    await new Promise((r) => server.close(r));
  });

  it("masks sensitive inputs, text and selectors across frames, then removes the mask", async () => {
    const page = await browser.newPage();
    await page.goto(base);
    const inner = page.frame({ name: "main" })!;
    await inner.waitForSelector("#ssn");

    const marked = async () => ({
      top: await page.$$eval(`[${MASK_ATTRIBUTE}="el"]`, (els) => els.map((e) => e.id || e.className)),
      inner: await inner.$$eval(`[${MASK_ATTRIBUTE}="el"]`, (els) => els.map((e) => e.id)),
    });

    const mask = await applyScreenshotMask(page, { values: [MEMBER, SSN], selectors: [".acct"] });
    expect(mask.failedFrames).toEqual([]);
    const m = await marked();
    expect(m.top.sort()).toEqual(["acct", "mbr", "pw"]);
    expect(m.inner).toEqual(["ssn"]);
    expect(await inner.$$eval(`[${MASK_ATTRIBUTE}="box"]`, (b) => b.length)).toBe(1);
    expect(await page.$eval("#mbr", (e) => getComputedStyle(e).color)).toBe("rgba(0, 0, 0, 0)");
    await mask.remove();
    expect(await marked()).toEqual({ top: [], inner: [] });

    const png = await withScreenshotMask(page, { values: [MEMBER] }, async (mk) => {
      expect(mk.masked).toBeGreaterThan(0);
      return page.screenshot();
    });
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(await page.$$(`[${MASK_ATTRIBUTE}]`)).toHaveLength(0);
    await page.close();
  });

  it("keeps a trace only on failure", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const sink = new InMemoryEvidenceSink({ mode: "replay", redactor: new Redactor() });

    const ok = await startTrace(context, sink);
    await page.goto(base);
    expect(await ok.stop({ keep: false })).toBeUndefined();
    expect(sink.attachments.size).toBe(0);

    let tracePath: string | undefined;
    const result = await withTraceOnFailure(context, sink, async () => {
      await page.goto(`${base}/inner`);
      return { status: "failure" as const };
    }, { isFailure: (r) => r.status === "failure", onTrace: (p) => (tracePath = p) });
    expect(result.status).toBe("failure");
    expect(tracePath).toMatch(/^attachments\/\d{3}-trace\.zip$/);
    const zip = sink.attachments.get(tracePath!)!;
    expect(zip.subarray(0, 2).toString()).toBe("PK");

    await expect(withTraceOnFailure(context, sink, async () => {
      throw new Error("step failed");
    })).rejects.toThrow("step failed");
    expect(sink.attachments.size).toBe(2);
    await context.close();
  });
});
