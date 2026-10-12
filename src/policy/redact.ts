import { createHmac } from "node:crypto";
import type { CapabilityArtifact, Sensitivity } from "../artifact/schema.js";
import type { JsonValue, RedactedPayload } from "../evidence/types.js";

export type MaskClass = "pii" | "secret";

export interface SensitiveValue {
  value: string | number;
  sensitivity: Sensitivity;
  /** Field or detector name shown in the mask, e.g. "memberId". Must not itself be sensitive. */
  label: string;
}

export interface RedactorOptions {
  /** Field-name sensitivity (artifact inputs/outputs). Values under these keys are masked wholesale. */
  fields?: Record<string, { sensitivity: Sensitivity }>;
  /** Concrete runtime values to scrub wherever they appear. */
  values?: SensitiveValue[];
  /** Key for the correlation hash; defaults to a fixed key so masks correlate across runs. */
  hashKey?: string;
}

const DEFAULT_HASH_KEY = "capabilityforge/redact/v1";
const MAX_DEPTH = 32;

/** Already-masked spans; every pass skips them so redaction is idempotent and masks never get re-masked. */
const MASK_TOKEN = /\[(?:PII:[A-Za-z0-9_.-]+#[0-9a-f]{4}|SECRET)\]/g;

const SECRET_KEY =
  /password|passcode|passwd|passphrase|^pwd$|^pin$|secret|token|api[_-]?key|authori[sz]ation|^cookie$|set-cookie|sessid|session[_-]?id|credential|private[_-]?key/i;
const PII_KEY =
  /^(?:ssn|social_?security(?:_?number)?|tin|dob|date_?of_?birth|e?mail(?:_?address)?|phone(?:_?number)?|card_?number|pan|account_?number|acct_?(?:no|num|number)|routing_?number)$/i;
/** Keys inside an action whose value is the typed/selected literal. */
const ACTION_VALUE_KEYS = new Set(["text", "option", "value"]);

export function luhnValid(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface ValueMatcher {
  re: RegExp;
  cls: MaskClass;
  label: string;
  /** Normalized full value; the hash is always over the full value so partial forms correlate with it. */
  norm: string;
}

interface Detector {
  re: RegExp;
  replace: (m: RegExpExecArray, mask: (cls: MaskClass, label: string, value: string) => string) => string;
}

function digitsOf(s: string): string {
  return s.replace(/\D/g, "");
}

/** Bounded so "12345" does not match inside "112345" or "12,345.67". */
function numberBounded(body: string): RegExp {
  return new RegExp(`(?<!\\d)(?<!\\d[.,])${body}(?!\\d)(?![.,]\\d)`, "g");
}

function isNumericLike(s: string): boolean {
  return /^[\d\s().+-]+$/.test(s) && digitsOf(s).length >= 4;
}

function normalize(s: string): string {
  return isNumericLike(s) ? digitsOf(s) : s.trim().toLowerCase();
}

/**
 * Builds per-run redaction from sensitivity tags plus concrete values, and adds
 * pattern detectors for data the artifact did not declare. Detector limits:
 * free-text secrets without a key ("my password is x") and unformatted numbers
 * without a context word are only caught when they are registered values.
 */
export class Redactor {
  private readonly fields = new Map<string, MaskClass>();
  private readonly matchers: ValueMatcher[] = [];
  private readonly rawValues = new Set<string>();
  private readonly hashKey: string;
  private readonly detectors: Detector[];

  constructor(options: RedactorOptions = {}) {
    this.hashKey = options.hashKey ?? DEFAULT_HASH_KEY;
    for (const [name, f] of Object.entries(options.fields ?? {})) {
      if (f.sensitivity === "pii" || f.sensitivity === "secret") this.fields.set(name, f.sensitivity);
    }
    for (const v of options.values ?? []) this.addValue(v.value, v.sensitivity, v.label);
    this.detectors = buildDetectors();
  }

  /**
   * Redactor for one invocation: inputs/outputs tagged pii/secret are masked by
   * key, and their concrete values (plus resolved secrets) are scrubbed anywhere.
   */
  static forRun(
    artifact: Pick<CapabilityArtifact, "inputs" | "outputs"> & Partial<Pick<CapabilityArtifact, "secrets">>,
    runtime: { inputs?: Record<string, unknown>; secrets?: Record<string, string> } = {},
    options: Omit<RedactorOptions, "fields"> = {},
  ): Redactor {
    const fields: Record<string, { sensitivity: Sensitivity }> = { ...artifact.inputs, ...artifact.outputs };
    for (const name of Object.keys(artifact.secrets ?? {})) fields[name] = { sensitivity: "secret" };
    const r = new Redactor({ ...options, fields });
    for (const [name, value] of Object.entries(runtime.inputs ?? {})) {
      const s = artifact.inputs[name]?.sensitivity;
      if (s && (typeof value === "string" || typeof value === "number")) r.addValue(value, s, name);
    }
    for (const [name, value] of Object.entries(runtime.secrets ?? {})) r.addValue(value, "secret", name);
    return r;
  }

  /** Registers a value learned at runtime (e.g. an extracted pii output). public/internal are ignored. */
  addValue(value: string | number, sensitivity: Sensitivity, label: string): this {
    if (sensitivity !== "pii" && sensitivity !== "secret") return this;
    const raw = String(value).trim();
    const cls: MaskClass = sensitivity;
    const safeLabel = label.replace(/[^A-Za-z0-9_.-]/g, "_") || "value";
    if (isNumericLike(raw)) {
      const digits = digitsOf(raw);
      this.rawValues.add(raw);
      // Separators are optional between digits so "900-12-3456", "900 12 3456" and "900123456" all match.
      const body = digits.split("").join("[\\s.-]?");
      this.matchers.push({ re: numberBounded(body), cls, label: safeLabel, norm: digits });
      if (digits.length >= 7) {
        const last4 = digits.slice(-4);
        this.rawValues.add(last4);
        this.matchers.push({ re: numberBounded(last4), cls, label: `${safeLabel}.last4`, norm: digits });
      }
    } else {
      if (raw.length < (cls === "secret" ? 4 : 3)) return this;
      this.rawValues.add(raw);
      const forms = new Set([raw, encodeURIComponent(raw), encodeURIComponent(raw).replace(/%20/g, "+")]);
      const alt = [...forms].sort((a, b) => b.length - a.length).map(escapeRe).join("|");
      // Secrets match anywhere (they may be embedded in encoded bodies); pii only on word boundaries.
      const re =
        cls === "secret" ? new RegExp(`(?:${alt})`, "gi") : new RegExp(`(?<![A-Za-z0-9])(?:${alt})(?![A-Za-z0-9])`, "gi");
      this.matchers.push({ re, cls, label: safeLabel, norm: raw.toLowerCase() });
    }
    // Longest first, so a full value is masked before any of its partial forms.
    this.matchers.sort((a, b) => b.re.source.length - a.re.source.length);
    return this;
  }

  /** Raw sensitive strings for screenshot masking (`Surface.screenshot({ maskValues })`, `maskSensitive`). */
  screenshotMaskValues(): string[] {
    return [...this.rawValues];
  }

  /** "[SECRET]", or "[PII:<label>#<4 hex>]" where the 16-bit keyed hash correlates occurrences without being reversible to one value. */
  mask(cls: MaskClass, label: string, value: string): string {
    return this.maskNorm(cls, label.replace(/[^A-Za-z0-9_.-]/g, "_"), normalize(value));
  }

  redactString(text: string): string {
    let out = text;
    for (const d of this.detectors.slice(0, SECRET_DETECTORS)) out = this.applyDetector(out, d);
    for (const m of this.matchers) {
      out = outsideMasks(out, (seg) => seg.replace(m.re, () => this.maskNorm(m.cls, m.label, m.norm)));
    }
    for (const d of this.detectors.slice(SECRET_DETECTORS)) out = this.applyDetector(out, d);
    return out;
  }

  /** Deep-redacts keys and values. The only way to obtain a `RedactedPayload`. */
  redact(payload: object): RedactedPayload {
    const v = this.redactValue(payload, undefined, 0, new WeakSet());
    const obj = v !== null && typeof v === "object" && !Array.isArray(v) ? v : { value: v };
    return obj as unknown as RedactedPayload;
  }

  /** Deep-redacts any value into JSON (non-JSON values are converted, cycles cut). */
  redactJson(value: unknown): JsonValue {
    return this.redactValue(value, undefined, 0, new WeakSet()) ?? null;
  }

  private maskNorm(cls: MaskClass, label: string, norm: string): string {
    if (cls === "secret") return "[SECRET]";
    const h = createHmac("sha256", this.hashKey).update(norm).digest("hex").slice(0, 4);
    return `[PII:${label}#${h}]`;
  }

  private applyDetector(text: string, d: Detector): string {
    return outsideMasks(text, (seg) => {
      const re = new RegExp(d.re.source, d.re.flags);
      let result = "";
      let last = 0;
      for (let m = re.exec(seg); m; m = re.exec(seg)) {
        if (m[0] === "") {
          re.lastIndex++;
          continue;
        }
        result += seg.slice(last, m.index) + d.replace(m, (c, l, v) => this.mask(c, l, v));
        last = m.index + m[0].length;
      }
      return result + seg.slice(last);
    });
  }

  private keyClass(key: string): { cls: MaskClass; label: string } | undefined {
    const tagged = this.fields.get(key);
    if (tagged) return { cls: tagged, label: key };
    if (SECRET_KEY.test(key)) return { cls: "secret", label: key };
    if (PII_KEY.test(key)) return { cls: "pii", label: key };
    return undefined;
  }

  private exactMatch(value: string): ValueMatcher | undefined {
    const norm = normalize(value);
    return this.matchers.find((m) => m.norm === norm && !m.label.endsWith(".last4"));
  }

  /** Masks a whole primitive: exact registered values keep their own label, otherwise the forced class applies. */
  private maskWhole(value: string, forced: { cls: MaskClass; label: string }): string {
    if (value === "") return value;
    if (forced.cls === "secret") return "[SECRET]";
    const exact = this.exactMatch(value);
    return exact ? this.maskNorm(exact.cls, exact.label, exact.norm) : this.mask("pii", forced.label, value);
  }

  /** The literal of an action flagged `sensitive` (typed/selected value): registered pii keeps its label, anything else is a secret. */
  private maskSensitiveLiteral(value: string): string {
    if (value === "") return value;
    const exact = this.exactMatch(value);
    return exact ? this.maskNorm(exact.cls, exact.label, exact.norm) : "[SECRET]";
  }

  private redactValue(
    value: unknown,
    forced: { cls: MaskClass; label: string } | undefined,
    depth: number,
    seen: WeakSet<object>,
  ): JsonValue | undefined {
    if (value === null) return null;
    switch (typeof value) {
      case "undefined":
      case "function":
      case "symbol":
        return undefined;
      case "boolean":
        return forced ? this.maskWhole(String(value), forced) : value;
      case "number":
      case "bigint": {
        if (forced) return this.maskWhole(String(value), forced);
        if (typeof value === "number" && !Number.isFinite(value)) return String(value);
        const s = String(value);
        const redacted = this.redactString(s);
        if (redacted !== s) return redacted;
        return typeof value === "bigint" ? s : value;
      }
      case "string":
        return forced ? this.maskWhole(value, forced) : this.redactString(value);
    }

    const obj = value as object;
    if (depth >= MAX_DEPTH) return "[MaxDepth]";
    if (seen.has(obj)) return "[Circular]";
    seen.add(obj);
    try {
      if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? null : obj.toISOString();
      if (obj instanceof Uint8Array) return `[binary ${obj.byteLength} bytes]`;
      if (obj instanceof Error) {
        return this.redactValue({ name: obj.name, message: obj.message, stack: obj.stack }, forced, depth + 1, seen);
      }
      if (obj instanceof URL) return this.redactValue(obj.href, forced, depth + 1, seen);
      const items = Array.isArray(obj) ? obj : obj instanceof Set ? [...obj] : undefined;
      if (items) return items.map((v) => this.redactValue(v, forced, depth + 1, seen) ?? null);

      const entries: [string, unknown][] = obj instanceof Map ? [...obj].map(([k, v]) => [String(k), v]) : Object.entries(obj);
      const sensitiveAction = (obj as { sensitive?: unknown }).sensitive === true;
      const out: { [key: string]: JsonValue } = {};
      for (const [key, v] of entries) {
        const f = forced ?? this.keyClass(key);
        let r: JsonValue | undefined;
        if (f?.cls === "secret" && v !== undefined && v !== null && v !== "") r = "[SECRET]";
        else if (!f && sensitiveAction && ACTION_VALUE_KEYS.has(key) && typeof v === "string") r = this.maskSensitiveLiteral(v);
        else r = this.redactValue(v, f, depth + 1, seen);
        if (r !== undefined) out[this.redactString(key)] = r;
      }
      return out;
    } finally {
      seen.delete(obj);
    }
  }
}

function outsideMasks(text: string, fn: (segment: string) => string): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(MASK_TOKEN)) {
    out += fn(text.slice(last, m.index)) + m[0];
    last = m.index! + m[0].length;
  }
  return out + fn(text.slice(last));
}

/** Number of leading detectors that run before exact-value scrubbing (credentials first). */
const SECRET_DETECTORS = 4;

function buildDetectors(): Detector[] {
  const secret = (): string => "[SECRET]";
  return [
    // JWTs
    { re: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, replace: secret },
    // Authorization schemes
    { re: /\b(Bearer|Basic|Token)\s+[A-Za-z0-9\-._~+/]{8,}=*/gi, replace: (m) => `${m[1]} [SECRET]` },
    // Provider API keys: OpenAI/Stripe style, AWS, GitHub, Slack
    {
      re: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
      replace: secret,
    },
    // key=value / key: value / "key":"value" where the key names a credential
    {
      re: /([\w-]*(?:password|passcode|passwd|passphrase|pwd|secret|token|api[_-]?key|authori[sz]ation|sessid|session[_-]?id|cookie))(["']?\s*[:=]\s*["']?)([^\s"'&,;]+)/gi,
      replace: (m) => `${m[1]}${m[2]}[SECRET]`,
    },
    // Emails
    { re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, replace: (m, mask) => mask("pii", "email", m[0]) },
    // SSN, formatted (synthetic 9xx and 000 areas included on purpose: test data uses them)
    { re: /(?<![\d-])\d{3}[- ]\d{2}[- ]\d{4}(?![\d-])/g, replace: (m, mask) => mask("pii", "ssn", m[0]) },
    // SSN already masked by the app ("***-**-3456"): the last 4 are still partial PII
    { re: /[*xX•#]{3}-[*xX•#]{2}-(\d{4})(?!\d)/g, replace: (m, mask) => mask("pii", "ssn.last4", m[1]!) },
    // SSN / TIN, unformatted, only with a context word
    {
      re: /\b(ssn|social\s+security(?:\s+(?:number|no\.?))?|tin|taxpayer\s+id)(\b[^0-9\n]{0,20}?)(\d{9})(?!\d)/gi,
      replace: (m, mask) => `${m[1]}${m[2]}${mask("pii", "ssn", m[3]!)}`,
    },
    // Card numbers (Luhn-checked); non-Luhn runs are left for the account detector
    {
      re: /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g,
      replace: (m, mask) => (luhnValid(digitsOf(m[0])) ? mask("pii", "card", m[0]) : m[0]),
    },
    // Account / member numbers, only with a context word
    {
      re: /\b(account|acct|member|mbr|routing|share|loan|card)(\s*(?:no\.?|number|num|nbr|#|id))?(\s*[:#=]?\s*)(\d[\d -]{3,18}\d)(?!\d)/gi,
      replace: (m, mask) => `${m[1]}${m[2] ?? ""}${m[3]}${mask("pii", "account", m[4]!)}`,
    },
    // US phone numbers (separators required, so plain digit runs and amounts are not touched)
    {
      re: /(?<![\d-])(?:\+?1[\s.-]?)?(?:\(\d{3}\)\s?|\d{3}[\s.-])\d{3}[\s.-]\d{4}(?![\d-])/g,
      replace: (m, mask) => mask("pii", "phone", m[0]),
    },
  ];
}
