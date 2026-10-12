import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type CoreLinkHandle, startCoreLink } from "../apps/corelink/server.js";

const USER = "teller01";
const PASSWORD = "change-me-local-only";

class Client {
  cookies = new Map<string, string>();
  constructor(
    private origin: string,
    private prefix: string,
  ) {}

  async req(
    path: string,
    init: { method?: string; form?: Record<string, string>; headers?: Record<string, string>; raw?: boolean } = {},
  ): Promise<{ status: number; location: string | null; text: string }> {
    const url = path.startsWith("/__admin") || init.raw ? `${this.origin}${path}` : `${this.origin}${this.prefix}${path}`;
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    let body: string | undefined;
    if (init.form) {
      body = new URLSearchParams(init.form).toString();
      headers["content-type"] = "application/x-www-form-urlencoded";
    }
    const res = await fetch(url, { method: init.method ?? (init.form ? "POST" : "GET"), headers, body, redirect: "manual" });
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(";");
      const [k, ...v] = (pair ?? "").split("=");
      if (k) this.cookies.set(k.trim(), v.join("="));
    }
    return { status: res.status, location: res.headers.get("location"), text: await res.text() };
  }

  async login(): Promise<void> {
    const r = await this.req("/login", { form: { fld1: USER, fld2: PASSWORD } });
    expect(r.status).toBe(302);
  }
}

async function state(origin: string) {
  return (await fetch(`${origin}/__admin/state`)).json();
}

describe("CoreLink tenant A", () => {
  let app: CoreLinkHandle;
  let c: Client;

  beforeAll(async () => {
    app = await startCoreLink({ port: 0, tenant: "a", seed: 1 });
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await fetch(`${app.origin}/__admin/reset`);
    c = new Client(app.origin, app.prefix);
  });

  it("redirects anonymous users to login and rejects bad credentials", async () => {
    const r = await c.req("/");
    expect(r.status).toBe(302);
    expect(r.location).toBe("/login");
    const bad = await c.req("/login", { form: { fld1: USER, fld2: "nope" } });
    expect(bad.text).toContain("ERR 0101 - INVALID OPERATOR ID OR PASSWORD");
  });

  it("logs in and serves the frameset", async () => {
    const login = await c.req("/login", { form: { fld1: USER, fld2: PASSWORD } });
    expect(login.location).toBe("/");
    const shell = await c.req("/");
    expect(shell.text).toContain("<frameset");
    expect(shell.text).toContain('<frame name="main" src="/main">');
    const nav = await c.req("/nav");
    expect(nav.text).toContain("Member Inquiry");
    expect(nav.text).toContain("Sign Off");
  });

  it("finds a member and shows balances", async () => {
    await c.login();
    const r = await c.req("/search", { form: { fn: "MBRINQ", fld1: "12345", fld2: "" } });
    expect(r.text).toContain("MEMBER INQUIRY RESULTS");
    expect(r.text).toContain("AVERY J SAMPLE");
    expect(r.text).toContain("1 RECORD(S) FOUND");
    expect(r.text).not.toMatch(/\sid=|data-/);
    const d = await c.req("/member?m=12345");
    expect(d.text).toContain("REGULAR SAVINGS");
    expect(d.text).toContain("$1,520.75");
    expect(d.text).toContain("$842.10");
  });

  it("reports natural not-found for unknown members", async () => {
    await c.login();
    const r = await c.req("/search", { form: { fld1: "99999" } });
    expect(r.text).toContain("NO RECORD FOUND FOR MEMBER 99999");
  });

  it("is deterministic from the seed", async () => {
    const s1 = await state(app.origin);
    const other = await startCoreLink({ port: 0, seed: 1 });
    const s2 = await state(other.origin);
    await other.close();
    expect(s2.members).toEqual(s1.members);
    expect(s1.members).toHaveLength(26);
  });

  it("expires idle sessions", async () => {
    const short = await startCoreLink({ port: 0, idleTimeoutMs: 50 });
    const sc = new Client(short.origin, short.prefix);
    await sc.login();
    expect((await sc.req("/main")).status).toBe(200);
    await new Promise((r) => setTimeout(r, 120));
    expect((await sc.req("/main")).location).toBe("/login?msg=timeout");
    await short.close();
  });

  it("opens a sub-account through review and irreversible submit", async () => {
    await c.login();
    const form = await c.req("/subacct?mbr=12345");
    expect(form.text).toContain("Initial Deposit:");
    const review = await c.req("/subacct", { form: { mbr: "12345", fld1: "S20", fld2: "XMAS FUND", fld3: "100.00", fld4: "S01" } });
    expect(review.text).toContain("CANNOT BE REVERSED");
    const tk = /name="tk" value="([a-f0-9]+)"/.exec(review.text)?.[1];
    expect(tk).toBeTruthy();
    const done = await c.req("/subacct/commit", { form: { tk: tk!, btn: "Submit" } });
    expect(done.text).toContain("TRANSACTION POSTED");
    expect(done.text).toContain("CL0700001");
    const dup = await c.req("/subacct/commit", { form: { tk: tk!, btn: "Submit" } });
    expect(dup.text).toContain("DUPLICATE SUBMISSION");
    const s = await state(app.origin);
    expect(s.created).toHaveLength(1);
    expect(s.created[0]).toMatchObject({ memberNumber: "12345", suffix: "S20", amount: 100, fromSuffix: "S01" });
    expect(s.members[0].accounts.find((a: { suffix: string }) => a.suffix === "S01").balance).toBe(1420.75);
  });

  it("validates the sub-account form naturally", async () => {
    await c.login();
    const r = await c.req("/subacct", { form: { mbr: "12345", fld1: "S20", fld3: "9999", fld4: "S01" } });
    expect(r.text).toContain("ERR 0417 - DEPOSIT AMOUNT EXCEEDS AVAILABLE BALANCE");
  });

  describe("faults", () => {
    it("not_found via header", async () => {
      await c.login();
      const r = await c.req("/search", { form: { fld1: "12345" }, headers: { "X-Fault": "not_found" } });
      expect(r.text).toContain("NO RECORD FOUND FOR MEMBER 12345");
    });

    it("validation_error via cookie", async () => {
      await c.login();
      c.cookies.set("cl_fault", "validation_error");
      const r = await c.req("/subacct", { form: { mbr: "12345", fld1: "S20", fld3: "1.00", fld4: "S01" } });
      expect(r.text).toContain("ERR 0417");
    });

    it("permission_denied on sub-account", async () => {
      await c.login();
      const r = await c.req("/subacct?mbr=12345", { headers: { "X-Fault": "permission_denied" } });
      expect(r.text).toContain("INSUFFICIENT AUTHORITY - SUPERVISOR OVERRIDE REQUIRED");
    });

    it("session_expired redirects to login with banner and kills the session", async () => {
      await c.login();
      const r = await c.req("/main", { headers: { "X-Fault": "session_expired" } });
      expect(r.status).toBe(302);
      expect(r.location).toBe("/login?msg=timeout");
      expect((await c.req("/main")).location).toBe("/login?msg=timeout");
      expect((await c.req("/login?msg=timeout")).text).toContain("SESSION TIMED OUT");
    });

    it("surprise_dialog interstitial preserves the original POST and continues after Acknowledge", async () => {
      await c.login();
      const r = await c.req("/search", { form: { fld1: "12345" }, headers: { "X-Fault": "surprise_dialog" } });
      expect(r.text).toContain("System maintenance tonight");
      expect(r.text).toContain('value="Acknowledge"');
      expect(r.text).toContain('name="fld1" value="12345"');
      const ack = await c.req("/search", { form: { fld1: "12345", __ack: "1" }, headers: { "X-Fault": "surprise_dialog" } });
      expect(ack.text).toContain("1 RECORD(S) FOUND");
    });

    it("slow_load delays the response", async () => {
      await c.login();
      const t0 = Date.now();
      const r = await c.req("/main", { headers: { "X-Fault": "slow_load:600" } });
      expect(Date.now() - t0).toBeGreaterThanOrEqual(550);
      expect(r.status).toBe(200);
    });

    it("server_error returns a legacy 500 page", async () => {
      await c.login();
      const r = await c.req("/member?m=12345", { headers: { "X-Fault": "server_error" } });
      expect(r.status).toBe(500);
      expect(r.text).toContain("CLX-0500 UNHANDLED EXCEPTION");
    });

    it("admin-armed once fault is route/method scoped and consumed", async () => {
      await c.login();
      const set = await (await fetch(`${app.origin}/__admin/fault?set=server_error&once=1&route=/search&method=POST`)).json();
      expect(set.fault.spec).toBe("server_error@POST/search");
      expect((await c.req("/search")).status).toBe(200);
      expect((await c.req("/member?m=12345")).status).toBe(200);
      expect((await c.req("/search", { form: { fld1: "12345" } })).status).toBe(500);
      expect((await c.req("/search", { form: { fld1: "12345" } })).status).toBe(200);
      const s = await state(app.origin);
      expect(s.fault).toBeNull();
      expect(s.faultLog).toHaveLength(1);
      expect(s.faultLog[0]).toMatchObject({ fault: "server_error", source: "admin", method: "POST", path: "/search" });
    });

    it("admin clear disarms and rejects unknown faults", async () => {
      await fetch(`${app.origin}/__admin/fault?set=permission_denied`);
      expect((await state(app.origin)).fault.name).toBe("permission_denied");
      await fetch(`${app.origin}/__admin/fault?clear=1`);
      expect((await state(app.origin)).fault).toBeNull();
      expect((await fetch(`${app.origin}/__admin/fault?set=bogus`)).status).toBe(400);
    });
  });
});

describe("CoreLink tenant B (MeridianCU)", () => {
  let app: CoreLinkHandle;
  let c: Client;

  beforeAll(async () => {
    app = await startCoreLink({ port: 0, tenant: "b", seed: 1 });
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await fetch(`${app.origin}/__admin/reset`);
    c = new Client(app.origin, app.prefix);
  });

  it("uses the /mcu prefix, rebrands, and adds the post-login notice", async () => {
    expect(app.url).toMatch(/\/mcu\/$/);
    expect((await c.req("/", { raw: true })).location).toBe("/mcu/");
    const login = await c.req("/login");
    expect(login.text).toContain("MeridianCU Teller");
    expect(login.text).toContain("Passcode:");
    expect(login.text).toContain('value="Log In"');
    const r = await c.req("/login", { form: { fld1: USER, fld2: PASSWORD } });
    expect(r.location).toBe("/mcu/notice");
    expect((await c.req("/")).location).toBe("/mcu/notice");
    expect((await c.req("/notice")).text).toContain("Acknowledge Notice");
    const ack = await c.req("/notice", { method: "POST", form: {} });
    expect(ack.location).toBe("/mcu/");
    expect((await c.req("/")).text).toContain('src="/mcu/main"');
  });

  it("relabels search and shifts result columns", async () => {
    await c.login();
    await c.req("/notice", { form: {} });
    const form = await c.req("/search");
    expect(form.text).toContain("Member #:");
    expect(form.text).toContain('value="Look Up"');
    expect(form.text).not.toContain("Member Number:");
    const r = await c.req("/search", { form: { fld1: "12345" } });
    const header = /<tr>(<td style[^]*?)<\/tr>/.exec(r.text)?.[1] ?? "";
    const cols = [...header.matchAll(/<b>([^<]+)<\/b>/g)].map((m) => m[1]);
    expect(cols).toEqual(["Member Name", "Status", "Member #", "Tax ID", "Branch"]);
    const sub = await c.req("/subacct?mbr=12345");
    expect(sub.text).toContain("Opening Deposit:");
    expect(sub.text).toContain("Funding Account:");
  });

  it("applies faults with tenant-relative or prefixed routes", async () => {
    await c.login();
    await c.req("/notice", { form: {} });
    await fetch(`${app.origin}/__admin/fault?set=not_found@/mcu/search&once=1`);
    const r = await c.req("/search", { form: { fld1: "12345" } });
    expect(r.text).toContain("NO RECORD FOUND FOR MEMBER 12345");
    const s = await state(app.origin);
    expect(s.faultLog[0].path).toBe("/mcu/search");
  });

  it("uses tenant confirmation prefix", async () => {
    await c.login();
    await c.req("/notice", { form: {} });
    const review = await c.req("/subacct", { form: { mbr: "12345", fld1: "D20", fld2: "", fld3: "10", fld4: "D10" } });
    const tk = /name="tk" value="([a-f0-9]+)"/.exec(review.text)?.[1] ?? "";
    const done = await c.req("/subacct/commit", { form: { tk, btn: "Submit" } });
    expect(done.text).toContain("MC0700001");
  });
});
