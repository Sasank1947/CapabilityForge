# CapabilityForge

CapabilityForge is a computer-use system for the long tail of bank / credit-union back-office apps that have no API. An LLM discovers a goal once by driving a live UI. The successful run is compiled into a typed, versioned **capability artifact**. Production invocations **replay** that artifact deterministically — no model in the loop — and return a three-way result: success, a known business outcome, or a failure with evidence.

The target is **CoreLink Teller**, a local mock of a hostile legacy core-banking app (frameset, nested tables, no test IDs, injectable runtime faults, plus a Tenant B variant).

## Setup

Requires Node 20+.

```bash
npm install
npx playwright install chromium
cp .env.example .env
```

`.env` keys (see `.env.example`):

| Variable | Required for | Notes |
|---|---|---|
| `OPENAI_API_KEY` | `forge discover` only | Never committed. Replay, tests, and the mock app run without it. |
| `OPENAI_MODEL` | optional | Defaults to `gpt-4.1`. |
| `CORELINK_USER` / `CORELINK_PASSWORD` | replay / discover | Synthetic teller credentials. Artifacts store `env://CORELINK_USER`, never the value. |
| `CORELINK_PORT` | optional | Default `4100` if you serve the app yourself. |

All CLI commands below use **npm** (not pnpm):

```bash
npm run forge -- <subcommand> …
```

## Offline path (no API key)

Replay, the test suite, typecheck, and the mock app do not call OpenAI.

```bash
npm test
npm run typecheck
npm run app
# CoreLink Teller at http://localhost:4100  (tenant B: npm run forge -- app --tenant b)
```

Replay the approved lookup against an ephemeral CoreLink instance:

```bash
npm run forge -- replay capabilities/corelink.lookup_member_balance.json --input memberId=12345
```

Expected stdout: `{ "status": "success", "outputs": { "savingsBalance": 1520.75 }, … }`.

Other offline commands:

```bash
npm run forge -- replay capabilities/corelink.lookup_member_balance.json --input memberId=99999
# → status: business_outcome, code: MEMBER_NOT_FOUND

npm run forge -- replay capabilities/corelink.lookup_member_balance.json --input memberId=12345 --fault surprise_dialog
npm run forge -- replay capabilities/corelink.lookup_member_balance.json --input memberId=12345 --overlay capabilities/overlays/corelink.lookup_member_balance.b.json --tenant b
npm run forge -- replay capabilities/corelink.open_sub_account.json -i memberId=12345 -i accountType=S20 -i nickname=XMAS -i deposit=25.00 -i fromSuffix=S01 --approve-irreversible
npm run forge -- operator
npm run forge -- serve-mcp
npm run forge -- schema
```

Each replay writes a redacted run under `runs/<id>/` (`events.jsonl`, `manifest.json`, masked `final.png`, and `trace.zip` on failure).

## Demo path: discover, then replay

This is the end-to-end thread the brief asks for. Discover needs `OPENAI_API_KEY` in `.env`. Replay does not.

```bash
# 1. LLM-driven discovery. Compiles a draft artifact and writes runs/<id>/.
npm run forge -- discover --preset lookup-balance --input memberId=12345

# 2. Deterministic replay of the approved (reviewed) artifact — no model.
npm run forge -- replay capabilities/corelink.lookup_member_balance.json --input memberId=12345
```

`discover` prints `{ status, runId, artifactPath, evidenceDir, … }`. The compiled draft lands at `capabilities/corelink.lookup_member_balance.discovered.json` unless you pass `--out`. Production replay uses the reviewed artifact in `capabilities/corelink.lookup_member_balance.json` (recover handlers for session expiry and the maintenance dialog were added on review; the compiler emits conservative defaults).

A saved discovery run, the compiled artifact, success / exception replays, a scripted handoff, and a Tenant B overlay run are in [`evidence/`](evidence/).

## Layout

- `apps/corelink/` — hostile mock app + fault injector + Tenant B
- `src/surface/` — `Surface` adapter (`PlaywrightWebSurface`)
- `src/agent/` — discovery loop (OpenAI tools)
- `src/artifact/` — Zod schema, compiler, overlays
- `src/replay/` — locator ladder, screen-state classifiers, result contract
- `src/policy/` — allowlist + irreversible grant + redaction
- `src/handoff/` — control lease, operator console, resume
- `src/catalog/` — MCP catalog of approved artifacts
- `src/evidence/` — JSONL sink, screenshot masks, Playwright traces
- `capabilities/` — reviewed artifacts + Tenant B overlay
- `evidence/` — demonstration pack (see `evidence/README.md`)
- `REPORT.md` — design write-up
