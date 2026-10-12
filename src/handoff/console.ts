import express from "express";
import { createServer, type Server } from "node:http";
import type { SessionController } from "./controller.js";

/**
 * Local operator console for the live Playwright session.
 *
 * Out of scope (documented, not built):
 * - Remote operation over a CDP `Page.startScreencast` or a noVNC sidecar
 * - Operator authentication / SSO
 * - A distributed append-only audit log beyond the local evidence JSONL
 *
 * A future remote console would attach to the same SessionController over a
 * small authenticated HTTP/WebSocket API and stream frames; the lease and the
 * human-action recorder stay in-process with the headed Chromium context.
 */

export interface OperatorConsole {
  url: string;
  port: number;
  close(): Promise<void>;
}

function snapshot(controller: SessionController) {
  return {
    runId: controller.runId,
    state: controller.state,
    lease: controller.lease,
    interventions: controller.listInterventions(),
  };
}

export async function startOperatorConsole(opts: {
  controller: SessionController;
  host?: string;
  port?: number;
}): Promise<OperatorConsole> {
  const host = opts.host ?? "127.0.0.1";
  const app = express();
  app.use(express.json());

  app.get("/", (_req, res) => {
    res.type("html").send(CONSOLE_HTML);
  });

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, runId: opts.controller.runId });
  });

  app.get("/api/state", (_req, res) => {
    res.json(snapshot(opts.controller));
  });

  app.get("/api/events", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const send = (): void => {
      res.write(`data: ${JSON.stringify(snapshot(opts.controller))}\n\n`);
    };
    send();
    const unsub = opts.controller.onChange(send);
    req.on("close", unsub);
  });

  app.post("/api/interventions/:id/take", (req, res) => {
    try {
      const iv = opts.controller.takeControl(req.params.id!, String(req.body?.operator ?? "operator"));
      res.json(iv);
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  });

  app.post("/api/interventions/:id/approve", (req, res) => {
    try {
      const iv = opts.controller.approve(
        req.params.id!,
        String(req.body?.operator ?? "operator"),
        typeof req.body?.note === "string" ? req.body.note : undefined,
      );
      res.json(iv);
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  });

  app.post("/api/interventions/:id/hand-back", (req, res) => {
    try {
      const iv = opts.controller.handBack(
        req.params.id!,
        String(req.body?.operator ?? "operator"),
        typeof req.body?.note === "string" ? req.body.note : undefined,
      );
      res.json(iv);
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  });

  app.post("/api/interventions/:id/abort", (req, res) => {
    try {
      const iv = opts.controller.abort(
        req.params.id,
        String(req.body?.operator ?? "operator"),
        typeof req.body?.note === "string" ? req.body.note : undefined,
      );
      res.json(iv ?? { ok: true });
    } catch (err) {
      res.status(409).json({ error: (err as Error).message });
    }
  });

  const server: Server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.listen(opts.port ?? 0, host, () => resolve());
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("operator console failed to bind");
  const url = `http://${host}:${address.port}`;
  return {
    url,
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

const CONSOLE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>CapabilityForge operator</title>
<style>
  :root { color-scheme: dark; }
  body { font: 14px/1.45 ui-sans-serif, system-ui, sans-serif; margin: 0; background: #111814; color: #e8f0e8; }
  header { padding: 16px 20px; background: #1b2a1d; border-bottom: 1px solid #2f4a32; display: flex; justify-content: space-between; align-items: baseline; gap: 16px; }
  h1 { font-size: 16px; margin: 0; letter-spacing: .04em; }
  .badge { font: 12px ui-monospace, monospace; padding: 2px 8px; border-radius: 999px; background: #2a4030; }
  .badge.HUMAN { background: #7a4a12; }
  .badge.PAUSED { background: #6a3a12; }
  .badge.ABORTED { background: #5a2020; }
  .badge.AGENT, .badge.RESUMING, .badge.COMPLETED { background: #1f4d32; }
  main { padding: 20px; max-width: 860px; }
  .card { background: #18241c; border: 1px solid #2f4a32; border-radius: 8px; padding: 14px 16px; margin: 0 0 12px; }
  .muted { color: #9ab09a; font-size: 12px; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
  button { font: inherit; padding: 6px 12px; border: 0; border-radius: 6px; cursor: pointer; background: #d7e6c8; color: #132016; }
  button.warn { background: #e6c8c8; }
  button:disabled { opacity: .45; cursor: not-allowed; }
  code { font-family: ui-monospace, monospace; }
  img { max-width: 100%; border: 1px solid #2f4a32; margin-top: 8px; }
</style>
</head>
<body>
<header>
  <h1>CapabilityForge operator</h1>
  <div id="lease" class="badge">connecting…</div>
</header>
<main>
  <p class="muted">Local console for the live headed session. Take control to use the same Chromium window, then hand back or abort. Remote CDP/noVNC, auth, and a distributed audit trail are not built.</p>
  <div id="list"><p class="muted">No intervention requests.</p></div>
</main>
<script>
const list = document.getElementById("list");
const lease = document.getElementById("lease");
function render(state) {
  lease.textContent = state.lease.holder
    ? state.state + " · " + state.lease.holder
    : state.state;
  lease.className = "badge " + state.state;
  if (!state.interventions.length) {
    list.innerHTML = '<p class="muted">No intervention requests. A replay will appear here when it escalates.</p>';
    return;
  }
  list.innerHTML = state.interventions.map((iv) => {
    const actions = (iv.allowedActions || []).map((a) => {
      const label = a.replace(/_/g, " ");
      const warn = a === "abort" ? " warn" : "";
      return '<button class="' + warn + '" data-id="' + iv.id + '" data-act="' + a + '">' + label + "</button>";
    }).join("");
    const shot = iv.screenshotPath ? '<p class="muted">screenshot: <code>' + iv.screenshotPath + "</code></p>" : "";
    return '<article class="card">'
      + "<div><strong>" + (iv.reason || "") + "</strong> · " + iv.status + "</div>"
      + '<div class="muted"><code>' + iv.id + "</code> · step " + (iv.stepId || "—") + "</div>"
      + "<p>" + (iv.message || "") + "</p>"
      + '<div class="muted">' + (iv.url || "") + (iv.stepIntent ? " · " + iv.stepIntent : "") + "</div>"
      + shot
      + (actions ? '<div class="row">' + actions + "</div>" : "")
      + "</article>";
  }).join("");
}
async function act(id, action) {
  const path = action === "take_control" ? "take"
    : action === "hand_back" ? "hand-back"
    : action;
  await fetch("/api/interventions/" + id + "/" + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operator: "operator" }),
  });
}
list.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  act(btn.dataset.id, btn.dataset.act);
});
const ev = new EventSource("/api/events");
ev.onmessage = (m) => render(JSON.parse(m.data));
ev.onerror = async () => {
  const r = await fetch("/api/state");
  if (r.ok) render(await r.json());
};
</script>
</body>
</html>
`;
