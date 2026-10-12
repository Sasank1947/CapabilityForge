# CapabilityForge — design write-up

## Architecture

A single Node process with in-process module boundaries. There are no queues, workers, or extra services — the brief penalizes that kind of infrastructure, and a take-home does not need it.

The load-bearing seam is `Surface`: `observe()`, `resolve(target)`, `act(action)`, `screenshot()`, `extract()`. Discovery and replay speak only surface-neutral intents and **target descriptors**. `PlaywrightWebSurface` is one implementation (frame-aware accessibility snapshot, XPath handles). A future `DesktopSurface` (UIA / AX) or `VisionSurface` would implement the same interface; the artifact would not change.

Flow:

1. `forge discover` runs an OpenAI tool loop against a live CoreLink instance. Every tool call carries a short rationale. Stop conditions: max steps, wall-clock timeout, repeated snapshot hash, policy deny, or `declare_done`.
2. The compiler turns the run trace into a `CapabilityArtifact` — not a transcript dump. Parameters are those declared on the goal (`{param: memberId}`), never inferred from typed literals.
3. `forge replay` executes the artifact with no LLM. Policy wraps every `act`. Evidence is a JSONL log plus a masked screenshot; Playwright traces are kept only on failure (they are not redacted).
4. Stuck / irreversible steps escalate through `SessionController` to a local operator console on the **same** Chromium context.

Trade-off: one process is easy to run and reason about. It will not scale to hundreds of concurrent tenants; the abstractions (artifact, surface, policy, lease) are what would.

## Artifact schema

The artifact is the product. It is a Zod-validated, JSON-serializable contract an agent can call:

- **Identity:** `id`, semver `version`, `contentHash` (status-independent), `status` (`draft | approved | deprecated`), provenance (run id + model, no transcript).
- **App + surface kind:** vendor/product/version range, `web | legacy-web | desktop`, entry route, fingerprint (title, version string, landmarks) for drift.
- **Inputs / outputs:** JSON Schema plus a `sensitivity` tag (`public | internal | pii | secret`) that drives redaction. Outputs carry extraction rules (target + transforms).
- **Secrets:** only `env://` / `vault://` refs. Inline credentials fail validation.
- **Steps:** intent, ranked target, action, risk (`safe | reversible | irreversible`), pre/post conditions, timeout.
- **Target descriptor:** a locator ladder — role+name, label proximity, visible text, structural path, CSS/XPath last, visual anchor as a note. Cardinality defaults to `exactlyOne`. Frame path is first-class (framesets).
- **Screen states:** named classifiers with handlers `outcome | recover | fail | escalate`. They live on the artifact, not in the engine, so a new exception is a data change.
- **Success checkpoint:** the final assertion. Passing the last click is not success.
- **Tenant overlays:** label/route/strategy/interstitial patches on a base artifact.

Why this shape: a calling agent needs a typed I/O contract; a reviewer needs to read the flow without a transcript; replay needs something more stable than a CSS selector and more honest than “the model will figure it out.”

## Determinism & error handling

Replay never asks a model what to do. For each step: classify the screen → wait preconditions → resolve the ladder (exactly one match) → policy → act → verify postcondition. Which strategy hit is recorded; a hit past index 0 is a drift signal (`driftReport`).

Runtime exceptions are classified by the artifact:

- **Business outcome** — `NO RECORD FOUND FOR MEMBER` → `{ status: "business_outcome", code: "MEMBER_NOT_FOUND" }`. Not a crash.
- **Recover** — session expiry re-logs in and restarts at `enter-member`; the maintenance interstitial is dismissed and the step retried. Recoveries appear on the result even when the run succeeds.
- **Fail** — a 500 page is `app_error` with expected/observed/step and a Playwright trace.
- **Escalate** — unknown dialogs or a missing irreversible grant pause for a human.

Invalid inputs fail before the browser is driven. Waits are bounded. Recovery retries are bounded. The result is a discriminated union (`success | business_outcome | failure | escalated`).

UI drift is secondary (these apps change slowly) but measured: fallback strategy hits and the app fingerprint.

## Heterogeneity & multi-tenant

**Surfaces.** The recorded flow is surface-neutral. Web vs legacy-web vs desktop differs only in how `Surface` perceives and acts. Legacy-web is the implemented case: walk every frame, prefer role/name and adjacent-`<td>` labels, keep CSS as last resort. Desktop would swap Playwright for UIA/AX and keep the same target descriptor (role + accessible name already map). Vision is a fallback when the tree is empty, not the primary channel.

**Tenants.** Hundreds of institutions run the same vendor product with different branding, labels, and route prefixes. The answer is not a fork per tenant. A **base artifact** plus a **tenant overlay** patches labels, routes (`/` → `/mcu/`), prepends locator strategies, and adds extra screen states (Tenant B’s “Acknowledge notice”). Replay of `corelink.lookup_member_balance` + `overlays/…b.json` against Tenant B succeeds, recovers the notice, and emits a drift report. A fingerprint mismatch is how we would detect a vendor upgrade that the overlay no longer covers.

What we would not do: a multi-tenant control plane, per-tenant databases, or recording from scratch for each CU.

## Escalation & handoff

A single **control lease** makes the actor explicit. The state machine is `AGENT → PAUSED → HUMAN → RESUMING → AGENT` (or `ABORTED`). Agent/replay `act` is rejected unless that actor holds the lease (`LeasedSurface`).

Stuck is detected by: policy `escalate` (irreversible without grant), an artifact `escalate` handler, recovery exhaustion, or the discovery agent calling `request_human`. The intervention carries capability, step, reason, URL, screen-state id, and a redacted screenshot.

The operator console is a local page: list requests, Take control, Hand back, Abort. Take control brings the **same** headed Chromium context forward and starts an in-page recorder (`actor: human`, values redacted). Hand-back re-observes, classifies, and resumes at the first incomplete step whose preconditions match. If the human already completed the irreversible click, that step’s postcondition holds and replay skips it.

The evidence pack’s handoff is this mechanism driven by HTTP against a live session (scripted operator, not a person at a keyboard). Remote CDP/noVNC, operator auth, and a distributed audit trail are designed but not built.

## Safety

One `PolicyGate` wraps discovery, replay, and human mode:

- Origin + route allowlist (localhost CoreLink only; `/__admin/*` denied; `javascript:` and userinfo URLs denied).
- Action-type allowlist and blocked target names (`Close Account`, `Wire Transfer`, …).
- Risk classes. Irreversible steps (`require_grant`) escalate unless this invocation carries `approve_irreversible`. Blocking them would break legitimate posting; flagging-only would be unsafe; confirmation reuses the handoff path. Human mode is **log-only** — the operator is not blocked, but the would-have-been verdict is recorded.

Redaction: sensitivity tags scrub exact runtime values; detectors catch SSN / Luhn cards / account numbers / email / phone / tokens; screenshots get a CSS mask over matching inputs and cells before capture. The LLM never sees secret values. Artifacts store `env://` refs. Traces are the exception: they are raw, so they are kept only on failure and called out as unredacted.

Limits: detectors miss novel PII shapes; a headed operator can see the live page; a Playwright trace on a 500 still contains the login POST.

## Cuts

Deliberately thin, with a real seam:

- Operator UI is local and minimal. No remote co-browse, auth, or SSO.
- One surface implementation (Playwright / Chromium). Desktop is designed, not built.
- One real discovery goal (`lookup-balance`). `open_sub_account` is hand-authored so irreversible posting could be tested without a second paid run.
- Compiler default screen-state handlers are conservative (`fail` / `escalate`). Recoveries on the approved artifact were added on review.
- No assisted LLM fallback on replay failure, no flakiness score across N runs, no codegen.
- No queues, clusters, or multi-tenant plumbing.

Next, in order: promote a discovered artifact through a real review/approval gate; keep traces out of default evidence or strip them; a remote operator path over CDP; a second surface (desktop or a real vendor sandbox) to prove the seam.
