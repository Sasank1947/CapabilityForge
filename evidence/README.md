# Evidence pack

Demonstration of the end-to-end CapabilityForge flow. Secrets and raw PII are redacted.
Playwright `trace.zip` is kept only on failure and is **not** redacted (raw DOM / network).

| Path | What it is |
|---|---|
| `discovery/` | Real LLM discovery run (`gpt-4.1`, run `20261012T042431Z-discovery-295346`). `events.jsonl` + `manifest.json` from the live run; `artifact.json` is the compiler output; `attachments/*.png` are redacted screenshots of the same screens (original run did not persist shots — the a11y tree was enough). See `SOURCE.md`. |
| `corelink.lookup_member_balance.json` | Approved artifact used for production replay (recover handlers reviewed in). |
| `replay-success/` | Deterministic replay for `memberId=12345` → `savingsBalance: 1520.75`. |
| `replay-not-found/` | Replay for `99999` → `business_outcome` / `MEMBER_NOT_FOUND`. |
| `replay-session-expired/` | Injected `session_expired` on POST `/search`; recovered by re-login; run succeeded. |
| `replay-surprise-dialog/` | Injected `surprise_dialog`; recovered by dismissing the interstitial; run succeeded. |
| `replay-server-error/` | Injected 500 on GET `/search` → `failure` / `app_error` plus `attachments/*trace.zip`. |
| `handoff/` | Scripted operator on the live Chromium session: policy escalates at `open-member`, console take/hand-back via HTTP, same page clicks the member link, replay resumes at `read-balance`. See `NOTES.md`. |
| `tenant-b/` | Base artifact + Tenant B overlay against MeridianCU; `drift-report.json` from strategy-fallback hits. |

Each replay directory contains `events.jsonl`, `manifest.json`, `result.json`, and `attachments/final.png`.

Live discovery was **not** re-run for this pack; the existing successful run was copied.
