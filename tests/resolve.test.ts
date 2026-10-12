import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TargetDescriptor } from "../src/artifact/schema.js";
import { startCoreLink, type CoreLinkHandle } from "../apps/corelink/server.js";
import { applyTemplates, resolveLadder, substituteTemplate } from "../src/surface/resolve.js";
import { PlaywrightWebSurface } from "../src/surface/playwright-web.js";

describe("resolveLadder", () => {
  it("substitutes {{input}} templates and leaves unknown placeholders intact", () => {
    expect(substituteTemplate("Member {{memberId}}", { memberId: "12345" })).toBe("Member 12345");
    expect(substituteTemplate("{{ missing }}", {})).toBe("{{ missing }}");
    const s = applyTemplates({ kind: "role", role: "link", name: "{{memberId}}", exact: true }, { memberId: "12345" });
    expect(s.kind === "role" && s.name).toBe("12345");
  });

  it("returns frame_not_found when the frame path cannot be resolved", async () => {
    const t = TargetDescriptor.parse({ description: "x", framePath: ["nope"], strategies: [{ kind: "css", selector: "a" }] });
    const r = await resolveLadder(t, {}, async () => null, async () => ["h"]);
    expect(r).toEqual({ ok: false, reason: "frame_not_found", attempts: [] });
  });

  it("falls through an ambiguous strategy and reports fallback when a later unique one hits", async () => {
    const t = TargetDescriptor.parse({
      description: "x",
      strategies: [
        { kind: "role", role: "button", name: "Go" },
        { kind: "css", selector: "#only" },
      ],
    });
    const r = await resolveLadder(
      t,
      {},
      async () => "frame",
      async (_f, s) => (s.kind === "role" ? ["a", "b"] : ["only"]),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.handle).toBe("only");
      expect(r.strategyIndex).toBe(1);
      expect(r.strategyKind).toBe("css");
      expect(r.attempts.map((a) => a.matches)).toEqual([2, 1]);
    }
  });

  it("fails as ambiguous when every matching strategy has cardinality > 1", async () => {
    const t = TargetDescriptor.parse({
      description: "x",
      strategies: [
        { kind: "text", text: "x" },
        { kind: "visual", anchorText: "x", direction: "below" },
      ],
    });
    const r = await resolveLadder(t, {}, async () => "f", async () => ["a", "b"]);
    expect(r).toMatchObject({ ok: false, reason: "ambiguous" });
    expect(r.attempts[1]).toEqual({ strategyIndex: 1, strategyKind: "visual", matches: 0 });
  });

  it("accepts the first of many matches when cardinality is atLeastOne", async () => {
    const t = TargetDescriptor.parse({
      description: "x",
      cardinality: "atLeastOne",
      strategies: [{ kind: "css", selector: "td" }],
    });
    const r = await resolveLadder(t, {}, async () => "f", async () => ["first", "second"]);
    expect(r.ok && r.handle).toBe("first");
  });
});

describe("PlaywrightWebSurface against CoreLink", () => {
  let app: CoreLinkHandle;
  let surface: PlaywrightWebSurface;

  beforeAll(async () => {
    app = await startCoreLink({ port: 0, tenant: "a", seed: 1 });
    surface = await PlaywrightWebSurface.launch({ actionTimeoutMs: 10_000 });
  });
  afterAll(async () => {
    await surface.close();
    await app.close();
  });

  async function login(): Promise<void> {
    await surface.act({ type: "navigate", url: `${app.origin}/login` });
    const user = await surface.resolve(
      TargetDescriptor.parse({
        description: "Operator ID",
        strategies: [
          { kind: "role", role: "textbox", name: "Operator ID:" },
          { kind: "label", labelText: "Operator ID:", relation: "right-of", controlRole: "textbox" },
        ],
      }),
    );
    const pw = await surface.resolve(
      TargetDescriptor.parse({ description: "Password", strategies: [{ kind: "label", labelText: "Password:", relation: "right-of" }] }),
    );
    expect(user.ok, JSON.stringify(user)).toBe(true);
    expect(pw.ok, JSON.stringify(pw)).toBe(true);
    if (!user.ok || !pw.ok) return;
    expect(user.strategyKind === "label" || user.strategyKind === "role").toBe(true);
    await surface.act({ type: "type", ref: user.ref, text: "teller01", clear: true, sensitive: true });
    await surface.act({ type: "type", ref: pw.ref, text: "change-me-local-only", clear: true, sensitive: true });
    const btn = await surface.resolve(
      TargetDescriptor.parse({ description: "Sign On", strategies: [{ kind: "role", role: "button", name: "Sign On" }] }),
    );
    expect(btn.ok).toBe(true);
    if (btn.ok) await surface.act({ type: "click", ref: btn.ref });
  }

  it("observes frameset frames and resolves adjacent-td labels plus {{input}} templates", async () => {
    await login();
    const obs = await surface.observe();
    expect(obs.frames.map((f) => f.name).filter((n): n is string => Boolean(n)).sort()).toEqual(["hdr", "main", "nav"]);
    expect(obs.elements.some((e) => e.framePath[0] === "nav" && e.name === "Member Inquiry")).toBe(true);

    const nav = await surface.resolve(
      TargetDescriptor.parse({
        description: "Member Inquiry",
        framePath: ["nav"],
        strategies: [{ kind: "role", role: "link", name: "Member Inquiry" }],
      }),
      { timeoutMs: 8_000 },
    );
    expect(nav.ok, JSON.stringify(nav)).toBe(true);
    if (!nav.ok) return;
    expect(nav.strategyIndex).toBe(0);
    await surface.act({ type: "click", ref: nav.ref });

    const member = await surface.resolve(
      TargetDescriptor.parse({
        description: "Member Number",
        framePath: ["main"],
        strategies: [
          { kind: "role", role: "textbox", name: "Member Number:" },
          { kind: "label", labelText: "Member Number:", relation: "right-of", controlRole: "textbox" },
          { kind: "css", selector: "input[name=fld1]" },
        ],
      }),
      { timeoutMs: 8_000 },
    );
    expect(member.ok, JSON.stringify(member)).toBe(true);
    if (!member.ok) return;
    expect(member.strategyKind === "label" || member.strategyKind === "css" || member.strategyKind === "role").toBe(true);
    expect(member.attempts[0]?.matches).toBeDefined();
    await surface.act({ type: "type", ref: member.ref, text: "12345", clear: true, sensitive: true });

    const search = await surface.resolve(
      TargetDescriptor.parse({
        description: "Search",
        framePath: ["main"],
        strategies: [{ kind: "role", role: "button", name: "Search" }],
      }),
    );
    expect(search.ok).toBe(true);
    if (search.ok) await surface.act({ type: "click", ref: search.ref });

    const link = await surface.resolve(
      TargetDescriptor.parse({
        description: "row",
        framePath: ["main"],
        strategies: [{ kind: "role", role: "link", name: "{{memberId}}" }],
      }),
      { timeoutMs: 8_000, templateValues: { memberId: "12345" } },
    );
    expect(link.ok, JSON.stringify(link)).toBe(true);
    if (!link.ok) return;
    expect(link.fingerprint.name).toBe("12345");
    await surface.act({ type: "click", ref: link.ref });

    const bal = await surface.resolve(
      TargetDescriptor.parse({
        description: "savings",
        framePath: ["main"],
        strategies: [{ kind: "label", labelText: "REGULAR SAVINGS", relation: "right-of" }],
      }),
      { timeoutMs: 8_000 },
    );
    expect(bal.ok, JSON.stringify(bal)).toBe(true);
    if (!bal.ok) return;
    const text = await surface.extract(bal.ref, { read: "text" });
    expect(text).toContain("1,520.75");

    const shot = await surface.screenshot({ maskValues: ["12345", "teller01"] });
    expect(shot.length).toBeGreaterThan(100);
  });
});
