import type { Page } from "playwright";
import type { EvidenceSink, JsonValue, RedactedPayload } from "../evidence/types.js";
import type { PolicyGate, PolicyRequest } from "../policy/types.js";
import type { Redactor } from "../policy/redact.js";
import type { SurfaceAction } from "../surface/types.js";
import type { HumanAction } from "./types.js";

const BINDING = "cfHumanAction";

/**
 * Installed in every frame (including after navigation). Clicks, inputs and
 * selects are forwarded to the Node binding; password fields never send a value.
 */
const INJECT = `(() => {
  if (window.__cfRecorder) return;
  window.__cfRecorder = true;
  const send = (payload) => {
    try { window.${BINDING}(payload); } catch (_) { /* binding gone */ }
  };
  const desc = (el) => {
    const tag = (el.tagName || "").toLowerCase();
    const type = (el.type || "").toLowerCase();
    const sensitive = type === "password" || el.autocomplete === "current-password" || el.autocomplete === "new-password";
    const label = el.getAttribute("aria-label")
      || (el.labels && el.labels[0] && el.labels[0].innerText)
      || (el.previousElementSibling && el.previousElementSibling.innerText)
      || "";
    return {
      tag,
      type,
      name: el.name || el.getAttribute("name") || "",
      role: el.getAttribute("role") || "",
      label: String(label).slice(0, 80),
      text: String(el.innerText || el.value || "").slice(0, 80),
      sensitive,
    };
  };
  document.addEventListener("click", (e) => {
    const el = e.target;
    if (!(el instanceof Element)) return;
    send({ kind: "click", url: location.href, ...desc(el) });
  }, true);
  document.addEventListener("change", (e) => {
    const el = e.target;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)) return;
    const d = desc(el);
    const kind = el instanceof HTMLSelectElement ? "select" : el.type === "checkbox" || el.type === "radio" ? "check" : "type";
    send({
      kind,
      url: location.href,
      ...d,
      value: d.sensitive ? "" : String(el.value ?? ""),
      checked: el instanceof HTMLInputElement ? el.checked : undefined,
    });
  }, true);
})();`;

export interface RawHumanEvent {
  kind: HumanAction["kind"];
  url: string;
  tag?: string;
  type?: string;
  name?: string;
  role?: string;
  label?: string;
  text?: string;
  value?: string;
  sensitive?: boolean;
  checked?: boolean;
}

export function toHumanAction(raw: RawHumanEvent, redactor?: Redactor, at = new Date().toISOString()): HumanAction {
  const sensitive = Boolean(raw.sensitive);
  let value = raw.value;
  if (sensitive) value = value ? "[SECRET]" : undefined;
  else if (value && redactor) value = redactor.redactString(value);
  const text = raw.text && redactor ? redactor.redactString(raw.text) : raw.text;
  const label = raw.label && redactor ? redactor.redactString(raw.label) : raw.label;
  return {
    kind: raw.kind,
    url: raw.url,
    tag: raw.tag || undefined,
    role: raw.role || undefined,
    name: raw.name || undefined,
    label: label || undefined,
    text: text || undefined,
    value,
    sensitive,
    at,
  };
}

export async function focusLiveSession(page: Page): Promise<void> {
  await page.bringToFront();
  try {
    const cdp = await page.context().newCDPSession(page);
    const { windowId } = await cdp.send("Browser.getWindowForTarget");
    await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
  } catch {
    // Headless, or the browser target has no window (tests).
  }
}

export interface HumanActionRecorderOptions {
  page: Page;
  evidence?: EvidenceSink;
  redactor?: Redactor;
  policy?: PolicyGate;
  invocationId?: string;
  capabilityId?: string;
  clock?: () => Date;
}

/**
 * Injects a click/input recorder into the live headed session. Events are
 * redacted and written as `human_action` evidence (actor: human). Policy is
 * evaluated in log-only mode when a gate is provided.
 */
export class HumanActionRecorder {
  readonly actions: HumanAction[] = [];
  private running = false;
  private bound = false;
  private readonly page: Page;
  private readonly evidence?: EvidenceSink;
  private readonly redactor?: Redactor;
  private readonly policy?: PolicyGate;
  private readonly invocationId: string;
  private readonly capabilityId?: string;
  private readonly clock: () => Date;

  constructor(opts: HumanActionRecorderOptions) {
    this.page = opts.page;
    this.evidence = opts.evidence;
    this.redactor = opts.redactor;
    this.policy = opts.policy;
    this.invocationId = opts.invocationId ?? "human";
    this.capabilityId = opts.capabilityId;
    this.clock = opts.clock ?? (() => new Date());
  }

  get isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (!this.bound) {
      await this.page.exposeBinding(BINDING, (_source, raw: RawHumanEvent) => {
        this.onEvent(raw);
      });
      await this.page.addInitScript(INJECT);
      this.bound = true;
    }
    for (const frame of this.page.frames()) {
      if (frame.isDetached()) continue;
      await frame.evaluate(INJECT).catch(() => undefined);
    }
    this.running = true;
  }

  stop(): void {
    this.running = false;
  }

  private onEvent(raw: RawHumanEvent): void {
    if (!this.running) return;
    const action = toHumanAction(raw, this.redactor, this.clock().toISOString());
    this.actions.push(action);
    if (this.policy) {
      const decision = this.policy.evaluate(toPolicyRequest(action, this.invocationId, this.capabilityId));
      this.evidence?.append({
        actor: "human",
        type: "policy_decision",
        payload: { verdict: decision.verdict, ruleId: decision.ruleId, reason: decision.reason } as unknown as RedactedPayload,
      });
    }
    this.evidence?.append({
      actor: "human",
      type: "human_action",
      payload: action as unknown as RedactedPayload,
    });
  }
}

function toPolicyRequest(action: HumanAction, invocationId: string, capabilityId?: string): PolicyRequest {
  const surface: SurfaceAction =
    action.kind === "type"
      ? { type: "type", ref: "human", text: action.value ?? "", clear: false, sensitive: Boolean(action.sensitive) }
      : action.kind === "select"
        ? { type: "select", ref: "human", option: action.value ?? "", sensitive: Boolean(action.sensitive) }
        : action.kind === "check"
          ? { type: "check", ref: "human", checked: true }
          : action.kind === "press"
            ? { type: "press", key: action.value ?? "Enter" }
            : { type: "click", ref: "human" };
  return {
    actor: "human",
    action: surface,
    risk: "reversible",
    currentUrl: action.url,
    invocationId,
    capabilityId,
    grants: [],
  };
}

export function asJson(action: HumanAction): Record<string, JsonValue> {
  return { ...action };
}
