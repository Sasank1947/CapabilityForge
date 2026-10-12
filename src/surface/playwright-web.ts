import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Browser,
  type BrowserContext,
  type Frame,
  type Locator,
  type Page,
  chromium,
} from "playwright";
import type { LocatorStrategy, SurfaceKind, TargetDescriptor, TargetFingerprint } from "../artifact/schema.js";
import { type DomElementInfo, type DomFrameSnapshot, domLibCall } from "./dom-lib.js";
import { framePathMatches, resolveLadder } from "./resolve.js";
import type {
  ActionOutcome,
  ElementRef,
  ExtractRead,
  FrameInfo,
  Observation,
  ObservedElement,
  ObserveOptions,
  Resolution,
  ResolveOptions,
  ScreenshotOptions,
  Surface,
  SurfaceAction,
} from "./types.js";

export interface PlaywrightWebSurfaceOptions {
  headless?: boolean;
  /** Reuse an already-launched browser (tests); the surface then only owns its context. */
  browser?: Browser;
  viewport?: { width: number; height: number };
  /** Extra HTTP headers for every request (e.g. `X-Fault` for fault injection). */
  extraHTTPHeaders?: Record<string, string>;
  slowMoMs?: number;
  /** Default timeout for individual Playwright actions. */
  actionTimeoutMs?: number;
  kind?: SurfaceKind;
}

interface RefEntry {
  frame: Frame;
  xpath: string;
}

const POLL_MS = 150;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function pathnameOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** Frame path from the top document: frame names, or the URL pathname for unnamed frames. */
export function framePathOf(frame: Frame): string[] {
  const path: string[] = [];
  let f: Frame | null = frame;
  while (f && f.parentFrame()) {
    path.unshift(f.name() || pathnameOf(f.url()));
    f = f.parentFrame();
  }
  return path;
}

function frameSegments(frame: Frame): { name: string; pathname: string }[] {
  const segs: { name: string; pathname: string }[] = [];
  let f: Frame | null = frame;
  while (f && f.parentFrame()) {
    segs.unshift({ name: f.name(), pathname: pathnameOf(f.url()) });
    f = f.parentFrame();
  }
  return segs;
}

/**
 * Surface over a Chromium page via Playwright. Perception walks every frame
 * (framesets included) and builds a numbered snapshot of interactive controls with
 * computed role, accessible name and adjacent-cell label text. Refs are opaque
 * (`e<N>`) and map to a frame plus an absolute XPath captured at observe/resolve time.
 */
export class PlaywrightWebSurface implements Surface {
  readonly kind: SurfaceKind;
  private refs = new Map<ElementRef, RefEntry>();
  private refSeq = 0;
  private closed = false;

  private constructor(
    private readonly _page: Page,
    private readonly _context: BrowserContext,
    private readonly ownedBrowser: Browser | null,
    private readonly actionTimeoutMs: number,
    kind: SurfaceKind,
  ) {
    this.kind = kind;
  }

  static async launch(opts: PlaywrightWebSurfaceOptions = {}): Promise<PlaywrightWebSurface> {
    const ownedBrowser = opts.browser
      ? null
      : await chromium.launch({ headless: opts.headless ?? true, slowMo: opts.slowMoMs });
    const browser = opts.browser ?? ownedBrowser!;
    const context = await browser.newContext({
      viewport: opts.viewport ?? { width: 1280, height: 860 },
      extraHTTPHeaders: opts.extraHTTPHeaders,
    });
    const page = await context.newPage();
    return new PlaywrightWebSurface(page, context, ownedBrowser, opts.actionTimeoutMs ?? 5_000, opts.kind ?? "legacy-web");
  }

  /** Wrap an existing page (e.g. the live session a handoff module hands back). */
  static fromPage(page: Page, opts: { actionTimeoutMs?: number; kind?: SurfaceKind } = {}): PlaywrightWebSurface {
    return new PlaywrightWebSurface(page, page.context(), null, opts.actionTimeoutMs ?? 5_000, opts.kind ?? "legacy-web");
  }

  /** The live page. The handoff module uses this to put the same headed session in front of a human. */
  get page(): Page {
    return this._page;
  }

  get context(): BrowserContext {
    return this._context;
  }

  // ------------------------------------------------------------------ perception

  async observe(options: ObserveOptions = {}): Promise<Observation> {
    const frames: FrameInfo[] = [];
    const elements: ObservedElement[] = [];
    const textByFrame: Record<string, string> = {};
    const max = options.maxElements ?? 300;
    for (const frame of this._page.frames()) {
      if (frame.isDetached()) continue;
      const path = framePathOf(frame);
      const snap = await this.evalIn<DomFrameSnapshot>(frame, domLibCall("observe", { max }));
      frames.push({ path, url: frame.url(), name: frame.name() || undefined, title: snap?.title });
      textByFrame[path.join("/")] = snap?.text ?? "";
      for (const el of snap?.elements ?? []) {
        if (elements.length >= max) break;
        elements.push(this.toObserved(frame, path, el));
      }
    }
    const structure = {
      frames: frames.map((f) => [f.path.join("/"), pathnameOf(f.url)]),
      elements: elements.map((e) => [e.framePath.join("/"), e.role, e.name, e.labelText ?? "", e.tag ?? ""]),
    };
    const observation: Observation = {
      url: this._page.url(),
      title: await this._page.title().catch(() => ""),
      frames,
      elements,
      textByFrame,
      snapshotHash: `sha256:${createHash("sha256").update(JSON.stringify(structure)).digest("hex")}`,
      capturedAt: new Date().toISOString(),
    };
    if (options.includeScreenshot) {
      const screenshotPath = join(tmpdir(), `cf-obs-${Date.now()}-${this.refSeq}.png`);
      await this.screenshot({ path: screenshotPath });
      observation.screenshotPath = screenshotPath;
    }
    return observation;
  }

  private toObserved(frame: Frame, path: string[], el: DomElementInfo): ObservedElement {
    const ref = this.newRef(frame, el.xpath);
    return {
      ref,
      role: el.role,
      name: el.name,
      labelText: el.labelText || undefined,
      text: el.text || undefined,
      value: el.value,
      tag: el.tag,
      framePath: path,
      bbox: el.bbox,
      states: el.states,
    };
  }

  private newRef(frame: Frame, xpath: string): ElementRef {
    if (this.refs.size > 5_000) this.refs.clear();
    const ref = `e${++this.refSeq}`;
    this.refs.set(ref, { frame, xpath });
    return ref;
  }

  /** Evaluates in a frame; navigation races (context destroyed, detached) yield null instead of throwing. */
  private async evalIn<T>(frame: Frame, expr: string): Promise<T | null> {
    try {
      return (await frame.evaluate(expr)) as T;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------ resolution

  async resolve(target: TargetDescriptor, options: ResolveOptions = {}): Promise<Resolution> {
    const deadline = Date.now() + (options.timeoutMs ?? 0);
    for (;;) {
      const res = await this.resolveOnce(target, options.templateValues ?? {});
      if (res.ok || Date.now() >= deadline) return res;
      await sleep(POLL_MS);
    }
  }

  private async resolveOnce(target: TargetDescriptor, templateValues: Record<string, string>): Promise<Resolution> {
    const ladder = await resolveLadder<Frame, string>(
      target,
      templateValues,
      async (wanted) => this.findFrame(wanted),
      (frame, strategy) => this.matchStrategy(frame, strategy),
    );
    if (!ladder.ok) return ladder;
    const frame = await this.findFrame(target.framePath ?? []);
    const info = frame ? await this.evalIn<DomElementInfo>(frame, domLibCall("describeXpath", { xpath: ladder.handle })) : null;
    if (!frame || !info) return { ok: false, reason: "not_found", attempts: ladder.attempts };
    const fingerprint: TargetFingerprint = {
      role: info.role || undefined,
      name: info.name || undefined,
      tag: info.tag,
      labelText: info.labelText || undefined,
      text: info.text || undefined,
      bbox: info.bbox,
    };
    return {
      ok: true,
      ref: this.newRef(frame, ladder.handle),
      strategyIndex: ladder.strategyIndex,
      strategyKind: ladder.strategyKind,
      attempts: ladder.attempts,
      fingerprint,
    };
  }

  private async findFrame(wanted: string[]): Promise<Frame | null> {
    if (wanted.length === 0) return this._page.mainFrame();
    for (const f of this._page.frames()) {
      if (!f.isDetached() && framePathMatches(wanted, frameSegments(f))) return f;
    }
    return null;
  }

  /** Candidate XPaths for one strategy, restricted to visible elements. */
  private async matchStrategy(frame: Frame, s: LocatorStrategy): Promise<string[]> {
    switch (s.kind) {
      case "role":
        return this.visibleXpaths(frame.getByRole(s.role as Parameters<Frame["getByRole"]>[0], { name: s.name, exact: s.exact }));
      case "text":
        return this.visibleXpaths(frame.getByText(s.text, { exact: s.exact }));
      case "css":
        return this.visibleXpaths(frame.locator(s.selector));
      case "xpath":
        return this.visibleXpaths(frame.locator(`xpath=${s.selector}`));
      case "label":
        return (
          (await this.evalIn<string[]>(
            frame,
            domLibCall("findByLabel", { labelText: s.labelText, relation: s.relation, controlRole: s.controlRole, exact: s.exact }),
          )) ?? []
        );
      case "structural":
        return (await this.evalIn<string[]>(frame, domLibCall("findStructural", { path: s.path }))) ?? [];
      case "visual":
        return [];
    }
  }

  private async visibleXpaths(locator: Locator): Promise<string[]> {
    try {
      const handles = await locator.elementHandles();
      const out: string[] = [];
      for (const h of handles.slice(0, 25)) {
        const xp = await h
          .evaluate((el: Element) => {
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            if (r.width <= 0 || r.height <= 0 || cs.visibility === "hidden" || cs.display === "none") return null;
            const parts: string[] = [];
            let n: Element | null = el;
            while (n) {
              let i = 1;
              let sib = n.previousElementSibling;
              while (sib) {
                if (sib.tagName === n.tagName) i++;
                sib = sib.previousElementSibling;
              }
              parts.unshift(`${n.tagName.toLowerCase()}[${i}]`);
              n = n.parentElement;
            }
            return `/${parts.join("/")}`;
          })
          .catch(() => null);
        if (xp) out.push(xp);
      }
      await Promise.all(handles.map((h) => h.dispose().catch(() => undefined)));
      return out;
    } catch {
      return [];
    }
  }

  private locatorFor(ref: ElementRef): Locator {
    const entry = this.refs.get(ref);
    if (!entry) throw new Error(`unknown or expired element ref '${ref}'`);
    if (entry.frame.isDetached()) throw new Error(`element ref '${ref}' belongs to a detached frame`);
    return entry.frame.locator(`xpath=${entry.xpath}`);
  }

  // ------------------------------------------------------------------ actions

  async act(action: SurfaceAction): Promise<ActionOutcome> {
    const t0 = Date.now();
    const timeout = this.actionTimeoutMs;
    try {
      switch (action.type) {
        case "navigate":
          await this._page.goto(action.url, { waitUntil: "domcontentloaded", timeout: Math.max(timeout, 30_000) });
          break;
        case "click":
          await this.locatorFor(action.ref).click({ timeout });
          break;
        case "type": {
          const loc = this.locatorFor(action.ref);
          if (action.clear) await loc.fill(action.text, { timeout });
          else await loc.pressSequentially(action.text, { timeout });
          break;
        }
        case "select":
          await this.locatorFor(action.ref).selectOption(action.option, { timeout });
          break;
        case "check":
          await this.locatorFor(action.ref).setChecked(action.checked, { timeout });
          break;
        case "press":
          if (action.ref) await this.locatorFor(action.ref).press(action.key, { timeout });
          else await this._page.keyboard.press(action.key);
          break;
      }
      await this.settle();
      return { ok: true, urlAfter: this._page.url(), durationMs: Date.now() - t0 };
    } catch (err) {
      return { ok: false, error: (err as Error).message.split("\n")[0], urlAfter: this._page.url(), durationMs: Date.now() - t0 };
    }
  }

  async extract(ref: ElementRef, read: ExtractRead): Promise<string> {
    const loc = this.locatorFor(ref);
    const timeout = this.actionTimeoutMs;
    switch (read.read) {
      case "text":
        return (await loc.innerText({ timeout })).replace(/\s+/g, " ").trim();
      case "value":
        return loc.inputValue({ timeout });
      case "attribute":
        return (await loc.getAttribute(read.attribute, { timeout })) ?? "";
    }
  }

  // ------------------------------------------------------------------ evidence

  /**
   * Captures the viewport (all frames). Before capture, opaque overlays are painted
   * over `maskRefs` and over any input or innermost text element containing one of
   * `maskValues`, in every frame; they are removed afterwards.
   */
  async screenshot(options: ScreenshotOptions = {}): Promise<Buffer> {
    const byFrame = new Map<Frame, string[]>();
    for (const ref of options.maskRefs ?? []) {
      const e = this.refs.get(ref);
      if (!e || e.frame.isDetached()) continue;
      byFrame.set(e.frame, [...(byFrame.get(e.frame) ?? []), e.xpath]);
    }
    const values = options.maskValues ?? [];
    const masking = byFrame.size > 0 || values.length > 0;
    const frames = this._page.frames().filter((f) => !f.isDetached());
    if (masking) {
      for (const f of frames) await this.evalIn(f, domLibCall("mask", { xpaths: byFrame.get(f) ?? [], values }));
    }
    try {
      return await this._page.screenshot({ path: options.path, fullPage: options.fullPage ?? false });
    } finally {
      if (masking) for (const f of frames) await this.evalIn(f, domLibCall("unmask"));
    }
  }

  /** Wait for the top document and every attached child frame to finish loading. */
  private async settle(): Promise<void> {
    await this._page.waitForLoadState("domcontentloaded").catch(() => undefined);
    await Promise.all(
      this._page.frames().map((f) => (f.isDetached() ? Promise.resolve() : f.waitForLoadState("domcontentloaded").catch(() => undefined))),
    );
  }

  async currentUrl(): Promise<string> {
    return this._page.url();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this._context.close().catch(() => undefined);
    if (this.ownedBrowser) await this.ownedBrowser.close().catch(() => undefined);
  }
}
