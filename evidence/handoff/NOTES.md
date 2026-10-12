Scripted handoff on the live Chromium session (not a headed human at a keyboard).

Replay of corelink.lookup_member_balance uses a policy that escalates at `open-member`.
The operator console take / hand-back endpoints are driven over HTTP. While the
SessionController lease is held by `human`, the same Playwright page clicks the
member-number link. After hand-back the engine re-classifies the screen and resumes
at `read-balance`. The lease / console / recorder mechanism is the production one;
only the operator gestures are scripted.
