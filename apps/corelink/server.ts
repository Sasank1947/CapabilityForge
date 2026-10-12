/**
 * CoreLink Teller — deliberately hostile legacy core-banking mock (synthetic data only).
 *
 * Tenants share one vendor implementation, themed via THEMES (theme.ts):
 *   a = "CoreLink Teller"   prefix ""      b = "MeridianCU Teller"  prefix "/mcu" (+ post-login notice)
 *
 * Routes (P = tenant prefix):
 *   GET  P/login[?msg=timeout|signoff]  sign-on page (frame-busts to top). fld1=operator id, fld2=password
 *   POST P/login                         -> P/ (a) or P/notice (b); sets CLSESSID cookie (idle expiry)
 *   GET  P/logout                        clears session -> P/login?msg=signoff
 *   GET|POST P/notice                    tenant b "Acknowledge notice" interstitial (POST acknowledges)
 *   GET  P/                              frameset: hdr (P/hdr) + nav (P/nav) + main (P/main)
 *   GET  P/search   POST P/search        member inquiry; fld1=member number, fld2=last name, hidden fn
 *   GET  P/member?m=<num>                member detail with S00/S01/D10 balances
 *   GET  P/subacct?mbr=<num>[&tk=]       open sub-account form: fld1 type, fld2 nickname, fld3 deposit, fld4 from
 *   POST P/subacct                       validate -> review screen (hidden tk)
 *   POST P/subacct/commit                IRREVERSIBLE: tk, btn=Submit -> confirmation number
 *   GET  P/unavail                       "function not available" (nav onclick td)
 *   GET  /__admin/state                  JSON: tenant, seed, fault, faultLog, created sub-accounts, members
 *   GET  /__admin/fault?set=&once=1&count=&route=&method=&ms=   arm a fault; ?clear=1 disarms; no args = read
 *   GET  /__admin/reset                  reseed data, clear fault, log, sessions
 *
 * Faults: not_found, validation_error, permission_denied, session_expired, surprise_dialog, slow_load, server_error.
 * Source precedence: `X-Fault` header > `cl_fault` cookie > admin-armed. Spec grammar (all sources):
 *   <name>[:<ms>][@[METHOD]<route>]   e.g. `slow_load:1500`, `server_error@POST/search`, `surprise_dialog@/subacct*`
 * Without a route each fault has a default scope (see faults.ts); routes are tenant-relative (`/mcu/x` == `/x`).
 * Admin faults persist until cleared unless once=1 / count=N. surprise_dialog is skipped on requests carrying __ack=1.
 */
import express, { type NextFunction, type Request, type Response } from "express";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import {
  type Member,
  SUB_ACCOUNT_TYPES,
  availableCents,
  fmtMoney,
  fullName,
  generateMembers,
  mulberry32,
} from "./data.js";
import {
  type ArmedFault,
  type FaultSource,
  type FaultSpec,
  FAULT_NAMES,
  describeFault,
  faultApplies,
  normalizeRoute,
  parseFaultSpec,
} from "./faults.js";
import { THEMES, type TenantId, type Theme } from "./theme.js";
import * as V from "./views.js";

export interface CoreLinkOptions {
  port?: number;
  tenant?: TenantId;
  seed?: number;
  host?: string;
  idleTimeoutMs?: number;
  user?: string;
  password?: string;
}

export interface CoreLinkHandle {
  /** Entry URL (tenant prefix included, trailing slash). */
  url: string;
  origin: string;
  prefix: string;
  tenant: TenantId;
  close(): Promise<void>;
}

interface Session {
  id: string;
  user: string;
  lastSeen: number;
  noticeAck: boolean;
  pending: Map<string, V.PendingSub>;
}

interface CreatedSub {
  confirmation: string;
  tenant: TenantId;
  memberNumber: string;
  suffix: string;
  type: string;
  description: string;
  nickname: string;
  amountCents: number;
  amount: number;
  fromSuffix: string;
  operator: string;
  postedAt: string;
}

interface FaultLogEntry {
  seq: number;
  fault: string;
  source: FaultSource;
  method: string;
  path: string;
  delayMs?: number;
  at: string;
}

const SESSION_COOKIE = "CLSESSID";
const FAULT_COOKIE = "cl_fault";

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[k] = part.slice(i + 1).trim();
    }
  }
  return out;
}

function str(v: unknown): string {
  if (Array.isArray(v)) return str(v[0]);
  return typeof v === "string" ? v : "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function createCoreLinkApp(opts: CoreLinkOptions = {}) {
  const tenant: TenantId = opts.tenant ?? "a";
  const theme: Theme = THEMES[tenant];
  const P = theme.prefix;
  const seed = opts.seed ?? (Number(process.env.CORELINK_SEED) || 1);
  const idleMs = opts.idleTimeoutMs ?? (Number(process.env.CORELINK_IDLE_MS) || 15 * 60_000);
  const user = opts.user ?? process.env.CORELINK_USER ?? "teller01";
  const password = opts.password ?? process.env.CORELINK_PASSWORD ?? "change-me-local-only";

  const state = {
    members: [] as Member[],
    sessions: new Map<string, Session>(),
    created: [] as CreatedSub[],
    usedTokens: new Map<string, CreatedSub>(),
    armed: null as ArmedFault | null,
    faultLog: [] as FaultLogEntry[],
    faultSeq: 0,
    confSeq: 0,
    delayRng: mulberry32(seed ^ 0x51ed),
  };

  function reset(): void {
    state.members = generateMembers(seed);
    state.sessions.clear();
    state.created = [];
    state.usedTokens.clear();
    state.armed = null;
    state.faultLog = [];
    state.faultSeq = 0;
    state.confSeq = 0;
    state.delayRng = mulberry32(seed ^ 0x51ed);
  }
  reset();

  const findMember = (n: string) => state.members.find((m) => m.memberNumber === n);

  const app = express();
  app.disable("x-powered-by");
  app.disable("etag");
  app.use(express.urlencoded({ extended: false }));
  app.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    res.set("Server", "Apache-Coyote/1.1");
    next();
  });

  // ------------------------------------------------------------ admin (never faulted)
  app.get("/__admin/state", (_req, res) => {
    res.json({
      tenant,
      app: theme.appName,
      prefix: P,
      seed,
      fault: state.armed ? { ...state.armed, spec: describeFault(state.armed) } : null,
      faultLog: state.faultLog,
      created: state.created,
      sessions: state.sessions.size,
      members: state.members.map((m) => ({
        memberNumber: m.memberNumber,
        name: fullName(m),
        status: m.status,
        accounts: m.accounts.map((a) => ({
          suffix: a.suffix,
          description: a.description,
          nickname: a.nickname ?? null,
          balance: a.balanceCents / 100,
          available: availableCents(a) / 100,
        })),
      })),
    });
  });

  app.all("/__admin/fault", (req, res) => {
    const q = { ...req.query, ...(req.body ?? {}) } as Record<string, unknown>;
    if (str(q.clear) === "1") {
      state.armed = null;
      res.json({ ok: true, fault: null });
      return;
    }
    const set = str(q.set);
    if (set) {
      const spec = parseFaultSpec(set, P);
      if (!spec) {
        res.status(400).json({ ok: false, error: `unknown fault '${set}'`, valid: FAULT_NAMES });
        return;
      }
      if (str(q.route)) spec.route = normalizeRoute(str(q.route), P);
      if (str(q.method)) spec.method = str(q.method).toUpperCase();
      if (str(q.ms)) spec.ms = Number(str(q.ms));
      const count = str(q.once) === "1" ? 1 : str(q.count) ? Math.max(1, Number(str(q.count))) : null;
      state.armed = { ...spec, remaining: count };
    }
    res.json({ ok: true, fault: state.armed ? { ...state.armed, spec: describeFault(state.armed) } : null });
  });

  app.all("/__admin/reset", (_req, res) => {
    reset();
    res.json({ ok: true });
  });

  // ------------------------------------------------------------ tenant router
  const r = express.Router();
  const PUBLIC = new Set(["/login", "/logout"]);

  r.use((req: Request, res: Response, next: NextFunction) => {
    if (PUBLIC.has(req.path)) return next();
    const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const sess = sid ? state.sessions.get(sid) : undefined;
    if (!sess) {
      res.redirect(302, `${P}/login${sid ? "?msg=timeout" : ""}`);
      return;
    }
    if (Date.now() - sess.lastSeen > idleMs) {
      state.sessions.delete(sess.id);
      res.redirect(302, `${P}/login?msg=timeout`);
      return;
    }
    sess.lastSeen = Date.now();
    res.locals.session = sess;
    next();
  });

  r.use(async (req: Request, res: Response, next: NextFunction) => {
    const rel = req.path;
    const method = req.method;
    let active: { spec: FaultSpec; source: FaultSource } | null = null;
    const hdr = parseFaultSpec(req.header("x-fault"), P);
    if (hdr) active = { spec: hdr, source: "header" };
    else {
      const ck = parseFaultSpec(parseCookies(req.headers.cookie)[FAULT_COOKIE], P);
      if (ck) active = { spec: ck, source: "cookie" };
      else if (state.armed) active = { spec: state.armed, source: "admin" };
    }
    if (!active || !faultApplies(active.spec, method, rel)) return next();
    const { spec, source } = active;
    const acked = str(req.query.__ack) === "1" || str((req.body ?? {}).__ack) === "1";
    if (spec.name === "surprise_dialog" && acked) return next();

    if (source === "admin" && state.armed && state.armed.remaining !== null) {
      state.armed.remaining -= 1;
      if (state.armed.remaining <= 0) state.armed = null;
    }
    const entry: FaultLogEntry = {
      seq: ++state.faultSeq,
      fault: spec.name,
      source,
      method,
      path: `${P}${rel}`,
      at: new Date().toISOString(),
    };
    state.faultLog.push(entry);

    switch (spec.name) {
      case "slow_load": {
        const delay = spec.ms ?? 3000 + Math.floor(state.delayRng() * 5001);
        entry.delayMs = delay;
        await sleep(delay);
        return next();
      }
      case "server_error":
        res.status(500).send(V.serverErrorPage(theme, `INC-${String(seed).padStart(4, "0")}-${String(entry.seq).padStart(5, "0")}`, `${P}${rel}`));
        return;
      case "session_expired": {
        const sess = res.locals.session as Session | undefined;
        if (sess) state.sessions.delete(sess.id);
        res.redirect(302, `${P}/login?msg=timeout`);
        return;
      }
      case "permission_denied":
        res.send(
          V.messagePage(theme, "AUTHORIZATION", "AUTH0703", "INSUFFICIENT AUTHORITY - SUPERVISOR OVERRIDE REQUIRED", `${P}/search`, "Return"),
        );
        return;
      case "surprise_dialog": {
        const src = (method === "POST" ? req.body : req.query) as Record<string, unknown>;
        const fields = Object.entries(src ?? {}).map(([k, v]) => [k, str(v)] as [string, string]);
        res.send(V.maintenanceDialog(theme, method, `${P}${rel}`, fields));
        return;
      }
      default:
        res.locals.fault = spec.name;
        return next();
    }
  });

  // ------------------------------------------------------------ auth
  r.get("/login", (req, res) => {
    const msg = str(req.query.msg);
    const banner =
      msg === "timeout" ? "SESSION TIMED OUT - PLEASE SIGN ON AGAIN" : msg === "signoff" ? "YOU HAVE BEEN SIGNED OFF" : undefined;
    res.send(V.loginPage(theme, { banner }));
  });

  r.post("/login", (req, res) => {
    const u = str(req.body?.fld1).trim();
    const pw = str(req.body?.fld2);
    if (u.toLowerCase() !== user.toLowerCase() || pw !== password) {
      res.send(V.loginPage(theme, { error: "ERR 0101 - INVALID OPERATOR ID OR PASSWORD" }));
      return;
    }
    const id = randomBytes(12).toString("hex");
    state.sessions.set(id, { id, user: u, lastSeen: Date.now(), noticeAck: !theme.postLoginNotice, pending: new Map() });
    res.set("Set-Cookie", `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax`);
    res.redirect(302, theme.postLoginNotice ? `${P}/notice` : `${P}/`);
  });

  r.get("/logout", (req, res) => {
    const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (sid) state.sessions.delete(sid);
    res.set("Set-Cookie", `${SESSION_COOKIE}=; Path=/; Max-Age=0`);
    res.redirect(302, `${P}/login?msg=signoff`);
  });

  r.get("/notice", (_req, res) => {
    if (!theme.postLoginNotice) return res.redirect(302, `${P}/`);
    res.send(V.noticePage(theme));
  });

  r.post("/notice", (_req, res) => {
    (res.locals.session as Session).noticeAck = true;
    res.redirect(302, `${P}/`);
  });

  // ------------------------------------------------------------ shell
  r.get("/", (_req, res) => {
    const sess = res.locals.session as Session;
    if (!sess.noticeAck) return res.redirect(302, `${P}/notice`);
    res.send(V.frameset(theme));
  });
  r.get("/hdr", (_req, res) => res.send(V.headerFrame(theme, (res.locals.session as Session).user)));
  r.get("/nav", (_req, res) => res.send(V.navFrame(theme)));
  r.get("/main", (_req, res) => res.send(V.welcomePage(theme, (res.locals.session as Session).user)));
  r.get("/unavail", (_req, res) =>
    res.send(V.messagePage(theme, "TELLER DRAWER", "DRW00001", "FUNCTION NOT AVAILABLE AT THIS WORKSTATION")),
  );

  // ------------------------------------------------------------ inquiry
  r.get("/search", (_req, res) => res.send(V.searchPage(theme, {})));

  r.post("/search", (req, res) => {
    const fld1 = str(req.body?.fld1).trim();
    const fld2 = str(req.body?.fld2).trim();
    if (!fld1 && !fld2) {
      res.send(V.searchPage(theme, { error: "ERR 0200 - ENTER MEMBER NUMBER OR LAST NAME" }));
      return;
    }
    if (fld1 && !/^\d{1,10}$/.test(fld1)) {
      res.send(V.searchPage(theme, { error: "ERR 0201 - INVALID MEMBER NUMBER FORMAT", fld1, fld2 }));
      return;
    }
    const forced = res.locals.fault === "not_found";
    const ln = fld2.toUpperCase();
    const results = forced
      ? []
      : state.members.filter((m) => (!fld1 || m.memberNumber === fld1) && (!ln || m.last.startsWith(ln)));
    if (!results.length) {
      res.send(V.searchPage(theme, { fld1, fld2, message: `NO RECORD FOUND FOR MEMBER ${fld1 || ln}` }));
      return;
    }
    res.send(V.searchPage(theme, { fld1, fld2, results }));
  });

  r.get("/member", (req, res) => {
    const n = str(req.query.m).trim();
    const m = res.locals.fault === "not_found" ? undefined : findMember(n);
    if (!m) {
      res.send(V.messagePage(theme, theme.labels.detailTitle, "MBRDTL02", `NO RECORD FOUND FOR MEMBER ${n}`, `${P}/search`, theme.labels.newInquiryLink));
      return;
    }
    res.send(V.memberPage(theme, m));
  });

  // ------------------------------------------------------------ open sub-account
  function memberForSub(n: string, res: Response): Member | undefined {
    const m = findMember(n);
    if (!m) {
      res.send(V.messagePage(theme, theme.labels.subTitle, "SUBOPN03", `NO RECORD FOUND FOR MEMBER ${n}`, `${P}/search`, theme.labels.newInquiryLink));
      return undefined;
    }
    if (m.status !== "ACTIVE") {
      res.send(V.messagePage(theme, theme.labels.subTitle, "SUBOPN03", "ERR 0510 - MEMBER STATUS DORMANT - FUNCTION NOT PERMITTED", `${P}/member?m=${m.memberNumber}`, theme.labels.returnToMemberLink));
      return undefined;
    }
    return m;
  }

  function validate(m: Member, form: V.SubForm): { error: string } | { type: (typeof SUB_ACCOUNT_TYPES)[number]; amountCents: number; nickname: string; from: string } {
    const type = SUB_ACCOUNT_TYPES.find((t) => t.code === form.fld1);
    if (!type) return { error: "ERR 0411 - SELECT ACCOUNT TYPE" };
    const nickname = (form.fld2 ?? "").trim();
    if (nickname.length > 20 || !/^[A-Za-z0-9 \-]*$/.test(nickname))
      return { error: "ERR 0414 - NICKNAME INVALID (MAX 20 LETTERS/DIGITS)" };
    const raw = (form.fld3 ?? "").replace(/[$,\s]/g, "");
    if (!/^\d+(\.\d{1,2})?$/.test(raw)) return { error: "ERR 0415 - INVALID AMOUNT" };
    const amountCents = Math.round(Number(raw) * 100);
    if (amountCents <= 0) return { error: "ERR 0416 - AMOUNT MUST BE GREATER THAN ZERO" };
    const from = m.accounts.find((a) => a.suffix === form.fld4);
    if (!from) return { error: "ERR 0413 - SELECT FUNDING ACCOUNT" };
    if (amountCents < type.minCents)
      return { error: `ERR 0419 - MINIMUM OPENING DEPOSIT FOR ${type.code} IS ${fmtMoney(type.minCents)}` };
    if (amountCents > availableCents(from)) return { error: "ERR 0417 - DEPOSIT AMOUNT EXCEEDS AVAILABLE BALANCE IN SOURCE ACCOUNT" };
    return { type, amountCents, nickname, from: from.suffix };
  }

  r.get("/subacct", (req, res) => {
    const m = memberForSub(str(req.query.mbr).trim(), res);
    if (!m) return;
    const pend = (res.locals.session as Session).pending.get(str(req.query.tk));
    const form: V.SubForm = pend
      ? { fld1: pend.type, fld2: pend.nickname, fld3: (pend.amountCents / 100).toFixed(2), fld4: pend.fromSuffix }
      : {};
    res.send(V.subAccountForm(theme, m, form));
  });

  r.post("/subacct", (req, res) => {
    const m = memberForSub(str(req.body?.mbr).trim(), res);
    if (!m) return;
    const form: V.SubForm = { fld1: str(req.body?.fld1), fld2: str(req.body?.fld2), fld3: str(req.body?.fld3), fld4: str(req.body?.fld4) };
    if (res.locals.fault === "validation_error") {
      res.send(V.subAccountForm(theme, m, form, "ERR 0417 - DEPOSIT AMOUNT EXCEEDS AVAILABLE BALANCE IN SOURCE ACCOUNT"));
      return;
    }
    const v = validate(m, form);
    if ("error" in v) {
      res.send(V.subAccountForm(theme, m, form, v.error));
      return;
    }
    const pend: V.PendingSub = {
      token: randomBytes(8).toString("hex"),
      memberNumber: m.memberNumber,
      type: v.type.code,
      nickname: v.nickname,
      amountCents: v.amountCents,
      fromSuffix: v.from,
    };
    (res.locals.session as Session).pending.set(pend.token, pend);
    res.send(V.reviewPage(theme, m, pend));
  });

  r.post("/subacct/commit", (req, res) => {
    const sess = res.locals.session as Session;
    const tk = str(req.body?.tk);
    const dup = state.usedTokens.get(tk);
    if (dup) {
      const dm = findMember(dup.memberNumber);
      if (dm) {
        res.send(V.confirmPage(theme, dm, dup, true));
        return;
      }
    }
    const pend = sess.pending.get(tk);
    const m = pend ? findMember(pend.memberNumber) : undefined;
    if (!pend || !m) {
      res.send(V.messagePage(theme, theme.labels.reviewTitle, "SUBOPN04", "ERR 0430 - REVIEW TOKEN INVALID OR EXPIRED - RESTART TRANSACTION", `${P}/search`, theme.labels.newInquiryLink));
      return;
    }
    const v = validate(m, { fld1: pend.type, fld2: pend.nickname, fld3: (pend.amountCents / 100).toFixed(2), fld4: pend.fromSuffix });
    if ("error" in v) {
      res.send(V.subAccountForm(theme, m, {}, v.error));
      return;
    }
    const from = m.accounts.find((a) => a.suffix === v.from)!;
    const letter = v.type.code.charAt(0);
    let n = Number(v.type.code.slice(1));
    while (m.accounts.some((a) => a.suffix === `${letter}${String(n).padStart(2, "0")}`)) n++;
    const suffix = `${letter}${String(n).padStart(2, "0")}`;
    from.balanceCents -= v.amountCents;
    m.accounts.push({ suffix, type: v.type.code, description: v.type.description, nickname: v.nickname || undefined, balanceCents: v.amountCents });
    const created: CreatedSub = {
      confirmation: `${theme.confPrefix}${String(700000 + ++state.confSeq).padStart(7, "0")}`,
      tenant,
      memberNumber: m.memberNumber,
      suffix,
      type: v.type.code,
      description: v.type.description,
      nickname: v.nickname,
      amountCents: v.amountCents,
      amount: v.amountCents / 100,
      fromSuffix: v.from,
      operator: sess.user,
      postedAt: new Date().toISOString(),
    };
    state.created.push(created);
    state.usedTokens.set(tk, created);
    sess.pending.delete(tk);
    res.send(V.confirmPage(theme, m, created));
  });

  if (P) {
    app.get("/", (_req, res) => res.redirect(302, `${P}/`));
    app.use(P, r);
  } else {
    app.use(r);
  }

  app.use((req, res) => {
    res.status(404).send(V.notFoundPage(req.path));
  });

  return { app, theme, state, reset };
}

export async function startCoreLink(opts: CoreLinkOptions = {}): Promise<CoreLinkHandle> {
  const { app, theme } = createCoreLinkApp(opts);
  const host = opts.host ?? "127.0.0.1";
  const server = await new Promise<import("node:http").Server>((resolve, reject) => {
    const s = app.listen(opts.port ?? 0, host, () => resolve(s));
    s.once("error", reject);
  });
  const { port } = server.address() as AddressInfo;
  const origin = `http://${host}:${port}`;
  return {
    url: `${origin}${theme.prefix}/`,
    origin,
    prefix: theme.prefix,
    tenant: theme.tenant,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
