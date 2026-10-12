import type { Frame, Page } from "playwright";

export interface MaskOptions {
  /** Raw sensitive values (e.g. `Redactor.screenshotMaskValues()`); inputs and text containing them are covered. */
  values?: string[];
  /** CSS selectors to cover in every frame. */
  selectors?: string[];
  /** Cover every password input regardless of value. Default true. */
  maskPasswords?: boolean;
}

export interface MaskResult {
  /** Number of elements covered, summed over frames. */
  masked: number;
  /** Frames the mask could not be injected into (detached or navigating); their content is unmasked. */
  failedFrames: string[];
  remove(): Promise<void>;
}

interface BrowserMaskArgs {
  textNeedles: string[];
  digitNeedles: string[];
  selectors: string[];
  maskPasswords: boolean;
}

export const MASK_ATTRIBUTE = "data-cf-mask";

// In-page code is kept as plain JS source: transpilers (tsx keepNames) inject
// helpers into compiled functions that do not exist inside the page.
const INJECT_SCRIPT = `(args) => {
  const A = ${JSON.stringify(MASK_ATTRIBUTE)};
  const doc = document;
  if (!doc.documentElement) return 0;
  const hits = new Set();
  const matches = (s) => {
    if (!s) return false;
    const lower = s.toLowerCase();
    if (args.textNeedles.some((n) => lower.includes(n))) return true;
    if (args.digitNeedles.length === 0) return false;
    const digits = s.replace(/\\D/g, "");
    return args.digitNeedles.some((n) => digits.includes(n));
  };
  for (const sel of args.selectors) {
    try { doc.querySelectorAll(sel).forEach((el) => hits.add(el)); } catch (e) {}
  }
  doc.querySelectorAll("input, textarea, select").forEach((el) => {
    if (args.maskPasswords && el.type === "password") hits.add(el);
    else if (matches(el.value)) hits.add(el);
  });
  if (doc.body) {
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!matches(n.nodeValue)) continue;
      const el = n.parentElement;
      if (el && el.tagName !== "SCRIPT" && el.tagName !== "STYLE") hits.add(el.closest("select") || el);
    }
  }
  const style = doc.createElement("style");
  style.setAttribute(A, "style");
  style.textContent =
    "[" + A + '="el"]{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important;caret-color:transparent!important;background:#111!important}' +
    "[" + A + '="box"]{position:absolute!important;background:#111!important;z-index:2147483647!important;pointer-events:none!important;margin:0!important;border:0!important}';
  (doc.head || doc.documentElement).appendChild(style);
  /* Overlays cover what CSS alone cannot hide (images of text, canvas, author !important rules). */
  const host = doc.body && doc.body.tagName !== "FRAMESET" ? doc.body : null;
  for (const el of hits) {
    el.setAttribute(A, "el");
    if (!host) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const box = doc.createElement("div");
    box.setAttribute(A, "box");
    box.style.left = (r.left + window.scrollX - 1) + "px";
    box.style.top = (r.top + window.scrollY - 1) + "px";
    box.style.width = (r.width + 2) + "px";
    box.style.height = (r.height + 2) + "px";
    host.appendChild(box);
  }
  return hits.size;
}`;

const REMOVE_SCRIPT = `(() => {
  const A = ${JSON.stringify(MASK_ATTRIBUTE)};
  document.querySelectorAll("[" + A + "]").forEach((el) => {
    if (el.getAttribute(A) === "el") el.removeAttribute(A);
    else el.remove();
  });
})()`;

function framesOf(target: Page | Frame): Frame[] {
  if ("mainFrame" in target) return target.frames();
  const out: Frame[] = [];
  const walk = (f: Frame) => {
    out.push(f);
    f.childFrames().forEach(walk);
  };
  walk(target);
  return out;
}

function needles(values: string[]): Pick<BrowserMaskArgs, "textNeedles" | "digitNeedles"> {
  const text = new Set<string>();
  const digits = new Set<string>();
  for (const raw of values) {
    const v = raw.trim();
    if (!v) continue;
    if (/^[\d\s().+-]+$/.test(v) && v.replace(/\D/g, "").length >= 4) digits.add(v.replace(/\D/g, ""));
    else if (v.length >= 3) text.add(v.toLowerCase());
  }
  return { textNeedles: [...text], digitNeedles: [...digits] };
}

/**
 * Covers sensitive inputs, text and selectors in every frame of the page (or of
 * the frame subtree). Call `remove()` after the screenshot. Matching is substring
 * based and deliberately over-masks (a cell containing a value is covered whole).
 */
export async function applyScreenshotMask(target: Page | Frame, options: MaskOptions = {}): Promise<MaskResult> {
  const args: BrowserMaskArgs = {
    ...needles(options.values ?? []),
    selectors: options.selectors ?? [],
    maskPasswords: options.maskPasswords ?? true,
  };
  const script = `(${INJECT_SCRIPT})(${JSON.stringify(args)})`;
  const failedFrames: string[] = [];
  let masked = 0;
  await Promise.all(
    framesOf(target).map(async (f) => {
      try {
        masked += Number(await f.evaluate(script)) || 0;
      } catch {
        failedFrames.push(f.name() || f.url());
      }
    }),
  );
  return {
    masked,
    failedFrames,
    remove: async () => {
      await Promise.all(framesOf(target).map((f) => f.evaluate(REMOVE_SCRIPT).catch(() => undefined)));
    },
  };
}

/** Masks, runs `capture` (typically `page.screenshot()`), and always removes the mask. */
export async function withScreenshotMask<T>(
  target: Page | Frame,
  options: MaskOptions,
  capture: (mask: MaskResult) => Promise<T>,
): Promise<T> {
  const mask = await applyScreenshotMask(target, options);
  try {
    return await capture(mask);
  } finally {
    await mask.remove();
  }
}
