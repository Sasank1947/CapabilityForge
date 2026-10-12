/**
 * In-page helpers evaluated inside each frame. Kept as plain JavaScript source so the
 * TypeScript toolchain cannot inject helpers (e.g. esbuild's `__name`) that do not
 * exist in the page. The library never mutates the app's DOM except for the
 * temporary screenshot mask overlays, which it removes again.
 */
const LIB_SRC = String.raw`(() => {
  const norm = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  const INTERACTIVE = 'a[href], button, input:not([type="hidden"]), select, textarea, [onclick], [role="button"], [role="link"], [role="textbox"], [role="checkbox"], [role="combobox"], [tabindex]';
  const CONTROL = 'input:not([type="hidden"]), select, textarea, button, a[href], [onclick], [role]';
  const LABELISH = "td, th, label, span, font, b, strong, div, p, legend, dt, dd";

  function implicitRole(el) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.split(/\s+/)[0];
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return el.hasAttribute("href") ? "link" : "generic";
    if (tag === "button") return "button";
    if (tag === "select") return el.multiple || el.size > 1 ? "listbox" : "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      if (["button", "submit", "reset", "image"].includes(t)) return "button";
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "number") return "spinbutton";
      if (t === "range") return "slider";
      if (t === "hidden") return "";
      return "textbox";
    }
    if (tag === "td" || tag === "th") return el.closest("table") ? (tag === "th" ? "columnheader" : "cell") : "generic";
    if (tag === "tr") return "row";
    if (tag === "table") return "table";
    if (tag === "img") return "img";
    if (el.hasAttribute("onclick")) return "generic";
    return "generic";
  }

  function textOf(el) { return norm(el.innerText != null ? el.innerText : el.textContent); }

  function accName(el) {
    const al = el.getAttribute("aria-label");
    if (al && norm(al)) return norm(al);
    const lb = el.getAttribute("aria-labelledby");
    if (lb) {
      const t = lb.split(/\s+/).map((id) => el.ownerDocument.getElementById(id)).filter(Boolean).map(textOf).join(" ");
      if (norm(t)) return norm(t);
    }
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "select" || tag === "textarea") {
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (tag === "input" && ["button", "submit", "reset"].includes(type)) return norm(el.value || (type === "submit" ? "Submit" : type === "reset" ? "Reset" : ""));
      if (tag === "input" && type === "image") return norm(el.getAttribute("alt") || "");
      if (el.labels && el.labels.length) return norm(Array.from(el.labels).map(textOf).join(" "));
      return norm(el.getAttribute("title") || el.getAttribute("placeholder") || "");
    }
    if (tag === "img") return norm(el.getAttribute("alt") || "");
    if (tag === "a" || tag === "button" || el.hasAttribute("onclick") || el.getAttribute("role")) return textOf(el);
    return "";
  }

  function isVisible(el) {
    if (!el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = el.ownerDocument.defaultView.getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  }

  function cellOf(el) { return el.closest("td, th"); }

  /** Text of the nearest label-like neighbour: <label>, aria, or the previous table cell. */
  function labelTextFor(el) {
    if (el.labels && el.labels.length) return norm(Array.from(el.labels).map(textOf).join(" "));
    const cell = cellOf(el);
    if (cell) {
      let prev = cell.previousElementSibling;
      while (prev && !norm(textOf(prev))) prev = prev.previousElementSibling;
      if (prev) {
        const t = textOf(prev);
        if (t && t.length <= 60) return t;
      }
    }
    return "";
  }

  function xpathOf(el) {
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1) {
      let i = 1;
      let s = n.previousElementSibling;
      while (s) { if (s.tagName === n.tagName) i++; s = s.previousElementSibling; }
      parts.unshift(n.tagName.toLowerCase() + "[" + i + "]");
      n = n.parentElement;
    }
    return "/" + parts.join("/");
  }

  /** Structural path from <body>, with implicit <tbody> elided: "table[2]/tr[3]/td[2]/input[1]". */
  function structuralPath(el) {
    const parts = [];
    let n = el;
    const body = el.ownerDocument.body;
    while (n && n !== body && n.nodeType === 1) {
      const tag = n.tagName.toLowerCase();
      if (tag !== "tbody") {
        let i = 1;
        let s = n.previousElementSibling;
        while (s) { if (s.tagName === n.tagName) i++; s = s.previousElementSibling; }
        parts.unshift(tag + "[" + i + "]");
      }
      n = n.parentElement;
    }
    return parts.join("/");
  }

  function findStructural(path) {
    let cur = document.body;
    if (!cur) return [];
    for (const seg of path.split("/").filter(Boolean)) {
      const m = /^([a-zA-Z0-9]+)(?:\[(\d+)\])?$/.exec(seg);
      if (!m) return [];
      const tag = m[1].toUpperCase();
      const idx = m[2] ? Number(m[2]) : 1;
      let parent = cur;
      if (tag === "TR" && cur.tagName === "TABLE") {
        const tb = Array.from(cur.children).find((c) => c.tagName === "TBODY");
        if (tb) parent = tb;
      }
      const kids = Array.from(parent.children).filter((c) => c.tagName === tag);
      cur = kids[idx - 1];
      if (!cur) return [];
    }
    return [cur];
  }

  function matchesText(actual, wanted, exact) {
    const a = norm(actual);
    const w = norm(wanted);
    return exact ? a === w : a.toLowerCase().includes(w.toLowerCase());
  }

  /** Innermost elements whose own rendered text matches (parents of a matching child are dropped). */
  function innermostMatching(doc, wanted, exact) {
    const all = Array.from(doc.querySelectorAll(LABELISH)).filter((el) => matchesText(textOf(el), wanted, exact));
    return all.filter((el) => !all.some((o) => o !== el && el.contains(o)));
  }

  function controlsIn(container, controlRole) {
    const list = Array.from(container.querySelectorAll(CONTROL)).filter(isVisible);
    return controlRole ? list.filter((c) => implicitRole(c) === controlRole) : list;
  }

  /**
   * Label proximity for markup without <label for>: find the label element by text,
   * then the control (or, when there is none and no controlRole is required, the cell
   * itself) in the related cell.
   */
  function findByLabel(spec) {
    const doc = document;
    const out = new Set();
    const labels = innermostMatching(doc, spec.labelText, spec.exact !== false);
    for (const lab of labels) {
      if (spec.relation === "labelled-by" || lab.tagName === "LABEL") {
        const ctl = lab.tagName === "LABEL" ? lab.control : null;
        if (ctl && isVisible(ctl) && (!spec.controlRole || implicitRole(ctl) === spec.controlRole)) out.add(ctl);
        if (lab.id) {
          for (const c of doc.querySelectorAll('[aria-labelledby~="' + lab.id + '"]')) if (isVisible(c)) out.add(c);
        }
        if (spec.relation === "labelled-by") continue;
      }
      const cell = cellOf(lab) || lab;
      let related = [];
      if (spec.relation === "right-of") {
        let sib = cell.nextElementSibling;
        while (sib && !textOf(sib) && !sib.querySelector(CONTROL)) sib = sib.nextElementSibling;
        if (sib) related = [sib];
      } else if (spec.relation === "below") {
        const row = cell.parentElement;
        const col = Array.from(row ? row.children : []).indexOf(cell);
        const next = row ? row.nextElementSibling : null;
        if (next && col >= 0 && next.children[col]) related = [next.children[col]];
      } else if (spec.relation === "same-row") {
        const row = cell.closest("tr");
        if (row) related = Array.from(row.children).filter((c) => c !== cell);
      }
      for (const r of related) {
        const ctls = controlsIn(r, spec.controlRole);
        if (ctls.length) ctls.forEach((c) => out.add(c));
        else if (!spec.controlRole && isVisible(r)) out.add(r);
      }
    }
    return Array.from(out);
  }

  function describe(el) {
    const r = el.getBoundingClientRect();
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    const editable = (tag === "input" && !["button", "submit", "reset", "image", "checkbox", "radio"].includes(type)) || tag === "textarea" || tag === "select";
    let value;
    if (editable) value = type === "password" ? (el.value ? "••••" : "") : tag === "select" ? norm(el.selectedOptions && el.selectedOptions[0] ? el.selectedOptions[0].text : "") : el.value;
    const text = tag === "input" || tag === "select" || tag === "textarea" ? "" : textOf(el).slice(0, 200);
    return {
      role: implicitRole(el),
      name: accName(el),
      labelText: labelTextFor(el),
      text,
      value,
      tag,
      bbox: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
      states: { disabled: !!el.disabled, checked: type === "checkbox" || type === "radio" ? !!el.checked : undefined, focused: el.ownerDocument.activeElement === el, editable },
      xpath: xpathOf(el),
      structural: structuralPath(el),
    };
  }

  function observe(args) {
    const max = args && args.max ? args.max : 300;
    const els = [];
    for (const el of document.querySelectorAll(INTERACTIVE)) {
      if (els.length >= max) break;
      if (!isVisible(el)) continue;
      els.push(describe(el));
    }
    const body = document.body;
    const text = body && body.tagName !== "FRAMESET" ? norm(body.innerText) : "";
    return { title: document.title || "", text, elements: els };
  }

  function byXpath(xp) {
    return document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
  }

  const MASK_CLASS = "__cf_mask_overlay";
  function mask(args) {
    const targets = new Set();
    for (const xp of args.xpaths || []) { const el = byXpath(xp); if (el) targets.add(el); }
    const values = (args.values || []).map(norm).filter((v) => v.length >= 2);
    if (values.length) {
      for (const el of document.querySelectorAll("input, textarea")) {
        if (values.some((v) => norm(el.value).includes(v))) targets.add(el);
      }
      const leafs = Array.from(document.querySelectorAll(LABELISH + ", a, li, pre, h1, h2, h3, address"))
        .filter((el) => values.some((v) => textOf(el).includes(v)));
      for (const el of leafs) if (!leafs.some((o) => o !== el && el.contains(o))) targets.add(el);
    }
    const doc = document;
    const host = doc.body || doc.documentElement;
    let n = 0;
    for (const el of targets) {
      if (!isVisible(el)) continue;
      const r = el.getBoundingClientRect();
      const d = doc.createElement("div");
      d.className = MASK_CLASS;
      d.setAttribute("style", "position:absolute;z-index:2147483647;background:#000;pointer-events:none;" +
        "left:" + (r.left + doc.defaultView.scrollX - 1) + "px;top:" + (r.top + doc.defaultView.scrollY - 1) + "px;" +
        "width:" + (r.width + 2) + "px;height:" + (r.height + 2) + "px");
      host.appendChild(d);
      n++;
    }
    return n;
  }
  function unmask() {
    for (const d of document.querySelectorAll("." + MASK_CLASS)) d.remove();
    return true;
  }

  return {
    observe,
    findByLabel: (a) => findByLabel(a).filter(isVisible).map(xpathOf),
    findStructural: (a) => findStructural(a.path).filter(isVisible).map(xpathOf),
    describeXpath: (a) => { const el = byXpath(a.xpath); return el ? describe(el) : null; },
    mask,
    unmask,
  };
})()`;

export type DomLibFn = "observe" | "findByLabel" | "findStructural" | "describeXpath" | "mask" | "unmask";

/** Expression that runs one library function with JSON-serialised arguments. */
export function domLibCall(fn: DomLibFn, args: unknown = {}): string {
  return `(${LIB_SRC}).${fn}(${JSON.stringify(args)})`;
}

export interface DomElementInfo {
  role: string;
  name: string;
  labelText: string;
  text: string;
  value?: string;
  tag: string;
  bbox: { x: number; y: number; width: number; height: number };
  states: { disabled?: boolean; checked?: boolean; focused?: boolean; editable?: boolean };
  xpath: string;
  structural: string;
}

export interface DomFrameSnapshot {
  title: string;
  text: string;
  elements: DomElementInfo[];
}
