import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export const ARTIFACT_SCHEMA_VERSION = "capabilityforge/v1" as const;

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export const Semver = z.string().regex(SEMVER_RE, "must be semver (e.g. 1.2.0)");

export const CapabilityId = z
  .string()
  .regex(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$/, "must be dotted lowercase, e.g. corelink.lookup_member_balance");

export const Identifier = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, "must be an identifier (letters, digits, underscore)");

export const StepId = z
  .string()
  .regex(/^[a-z][a-zA-Z0-9_-]*$/, "must start lowercase; letters, digits, '_' or '-'");

export const ContentHash = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const Sensitivity = z.enum(["public", "internal", "pii", "secret"]);
export type Sensitivity = z.infer<typeof Sensitivity>;

export const SurfaceKind = z.enum(["web", "legacy-web", "desktop"]);
export type SurfaceKind = z.infer<typeof SurfaceKind>;

export const RiskClass = z.enum(["safe", "reversible", "irreversible"]);
export type RiskClass = z.infer<typeof RiskClass>;

export const ArtifactStatus = z.enum(["draft", "approved", "deprecated"]);
export type ArtifactStatus = z.infer<typeof ArtifactStatus>;

/**
 * Strings marked as templates may contain `{{inputName}}` placeholders that are
 * substituted with invocation inputs at replay time.
 */
export const TemplateString = z.string().min(1);

export const SecretRefUri = z
  .string()
  .regex(/^(env|vault):\/\/[A-Za-z0-9_./-]+$/, "must be a secret reference like env://CORELINK_USER");

/** Where a runtime value comes from. Secrets are never inlined; they are resolved by reference at the last moment. */
export const ValueRef = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("literal"), value: z.string() }),
  z.object({ kind: z.literal("input"), name: Identifier }),
  z.object({ kind: z.literal("secret"), name: Identifier }),
]);
export type ValueRef = z.infer<typeof ValueRef>;

// ---------------------------------------------------------------------------
// Target descriptors: ranked, surface-neutral ways to find one control
// ---------------------------------------------------------------------------

export const LocatorStrategy = z.discriminatedUnion("kind", [
  /** Accessibility role + accessible name. Most stable on any surface with an a11y tree. */
  z.object({
    kind: z.literal("role"),
    role: z.string().min(1),
    name: TemplateString,
    exact: z.boolean().default(true),
  }),
  /** Control identified by the text of a nearby label (e.g. adjacent `<td>`), for markup without `<label for>`. */
  z.object({
    kind: z.literal("label"),
    labelText: TemplateString,
    relation: z.enum(["right-of", "below", "same-row", "labelled-by"]).default("right-of"),
    controlRole: z.string().optional(),
    exact: z.boolean().default(true),
  }),
  z.object({
    kind: z.literal("text"),
    text: TemplateString,
    exact: z.boolean().default(true),
  }),
  /** Structural path relative to the frame root, e.g. "table[2]/tr[3]/td[2]/input[1]". */
  z.object({ kind: z.literal("structural"), path: z.string().min(1) }),
  z.object({ kind: z.literal("css"), selector: z.string().min(1) }),
  z.object({ kind: z.literal("xpath"), selector: z.string().min(1) }),
  /** Human-readable visual anchor. Not executable by the DOM resolver; consumed by vision surfaces and reviewers. */
  z.object({
    kind: z.literal("visual"),
    anchorText: z.string().min(1),
    direction: z.enum(["left-of", "right-of", "above", "below", "inside"]),
    note: z.string().optional(),
  }),
]);
export type LocatorStrategy = z.infer<typeof LocatorStrategy>;
export type LocatorStrategyKind = LocatorStrategy["kind"];

export const BoundingBox = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});
export type BoundingBox = z.infer<typeof BoundingBox>;

/** Snapshot of what the element looked like at record time; used for drift scoring, never for resolution. */
export const TargetFingerprint = z.object({
  role: z.string().optional(),
  name: z.string().optional(),
  tag: z.string().optional(),
  labelText: z.string().optional(),
  text: z.string().optional(),
  bbox: BoundingBox.optional(),
});
export type TargetFingerprint = z.infer<typeof TargetFingerprint>;

/**
 * Frame names (or URL path patterns when unnamed) from the top document down.
 * An empty array means the top-level document.
 */
export const FramePath = z.array(z.string().min(1)).default([]);

export const TargetDescriptor = z.object({
  description: z.string().min(1),
  framePath: FramePath,
  /** Strategies are tried in order; the first that yields an acceptable match wins. */
  strategies: z.array(LocatorStrategy).min(1),
  cardinality: z.enum(["exactlyOne", "atLeastOne"]).default("exactlyOne"),
  fingerprint: TargetFingerprint.optional(),
});
export type TargetDescriptor = z.infer<typeof TargetDescriptor>;

// ---------------------------------------------------------------------------
// Conditions: preconditions, postconditions, checkpoints and screen-state detectors
// ---------------------------------------------------------------------------

export type Condition =
  | { kind: "visible"; target: TargetDescriptor }
  | { kind: "hidden"; target: TargetDescriptor }
  | { kind: "textPresent"; text: string; framePath?: string[]; exact?: boolean }
  | { kind: "textAbsent"; text: string; framePath?: string[]; exact?: boolean }
  | { kind: "urlMatches"; pattern: string }
  | { kind: "titleMatches"; pattern: string }
  | { kind: "valueEquals"; target: TargetDescriptor; value: ValueRef }
  | { kind: "all"; conditions: Condition[] }
  | { kind: "any"; conditions: Condition[] }
  | { kind: "not"; condition: Condition };

type ConditionInput =
  | { kind: "visible"; target: z.input<typeof TargetDescriptor> }
  | { kind: "hidden"; target: z.input<typeof TargetDescriptor> }
  | { kind: "textPresent"; text: string; framePath?: string[]; exact?: boolean }
  | { kind: "textAbsent"; text: string; framePath?: string[]; exact?: boolean }
  | { kind: "urlMatches"; pattern: string }
  | { kind: "titleMatches"; pattern: string }
  | { kind: "valueEquals"; target: z.input<typeof TargetDescriptor>; value: ValueRef }
  | { kind: "all"; conditions: ConditionInput[] }
  | { kind: "any"; conditions: ConditionInput[] }
  | { kind: "not"; condition: ConditionInput };

/** `urlMatches` / `titleMatches` patterns are regular expressions (source only, no slashes). */
export const Condition: z.ZodType<Condition, z.ZodTypeDef, ConditionInput> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("visible"), target: TargetDescriptor }),
    z.object({ kind: z.literal("hidden"), target: TargetDescriptor }),
    z.object({
      kind: z.literal("textPresent"),
      text: TemplateString,
      framePath: z.array(z.string()).optional(),
      exact: z.boolean().optional(),
    }),
    z.object({
      kind: z.literal("textAbsent"),
      text: TemplateString,
      framePath: z.array(z.string()).optional(),
      exact: z.boolean().optional(),
    }),
    z.object({ kind: z.literal("urlMatches"), pattern: z.string().min(1) }),
    z.object({ kind: z.literal("titleMatches"), pattern: z.string().min(1) }),
    z.object({ kind: z.literal("valueEquals"), target: TargetDescriptor, value: ValueRef }),
    z.object({ kind: z.literal("all"), conditions: z.array(Condition).min(1) }),
    z.object({ kind: z.literal("any"), conditions: z.array(Condition).min(1) }),
    z.object({ kind: z.literal("not"), condition: Condition }),
  ]),
);

// ---------------------------------------------------------------------------
// Inputs and outputs
// ---------------------------------------------------------------------------

export const FieldType = z.enum(["string", "integer", "number", "boolean"]);
export type FieldType = z.infer<typeof FieldType>;

export const InputField = z.object({
  type: FieldType,
  description: z.string().min(1),
  sensitivity: Sensitivity,
  required: z.boolean().default(true),
  pattern: z.string().optional(),
  enum: z.array(z.string()).optional(),
  minLength: z.number().int().nonnegative().optional(),
  maxLength: z.number().int().positive().optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  example: z.union([z.string(), z.number(), z.boolean()]).optional(),
});
export type InputField = z.infer<typeof InputField>;

export const Transform = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("trim") }),
  z.object({ kind: z.literal("regex"), pattern: z.string().min(1), group: z.number().int().nonnegative().default(1) }),
  /** Strips currency symbols and thousands separators before parsing; "(12.00)" parses as -12. */
  z.object({ kind: z.literal("parseNumber"), allowCurrency: z.boolean().default(true) }),
  z.object({ kind: z.literal("parseInteger") }),
  z.object({ kind: z.literal("parseBoolean"), truthy: z.array(z.string()).min(1) }),
  z.object({ kind: z.literal("parseDate"), format: z.string().min(1) }),
]);
export type Transform = z.infer<typeof Transform>;

export const Extraction = z.object({
  target: TargetDescriptor,
  read: z.enum(["text", "value", "attribute"]).default("text"),
  attribute: z.string().optional(),
  transforms: z.array(Transform).default([]),
});
export type Extraction = z.infer<typeof Extraction>;

export const OutputField = z.object({
  type: FieldType,
  description: z.string().min(1),
  sensitivity: Sensitivity,
  /** Absent when the output is only produced by a screen-state outcome handler. */
  extraction: Extraction.optional(),
});
export type OutputField = z.infer<typeof OutputField>;

export const SecretDecl = z.object({
  ref: SecretRefUri,
  description: z.string().min(1),
});
export type SecretDecl = z.infer<typeof SecretDecl>;

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

export const StepAction = z.discriminatedUnion("type", [
  /** Relative URLs resolve against the tenant's base URL supplied at runtime. */
  z.object({ type: z.literal("navigate"), url: TemplateString }),
  z.object({ type: z.literal("click") }),
  z.object({ type: z.literal("type"), value: ValueRef, clear: z.boolean().default(true) }),
  z.object({ type: z.literal("select"), value: ValueRef }),
  z.object({ type: z.literal("check"), checked: z.boolean() }),
  z.object({ type: z.literal("press"), key: z.string().min(1) }),
  /** Runs the extraction rules of the named outputs against the current screen. */
  z.object({ type: z.literal("extract"), outputs: z.array(Identifier).min(1) }),
]);
export type StepAction = z.infer<typeof StepAction>;
export type ActionType = StepAction["type"];
export const ACTION_TYPES = ["navigate", "click", "type", "select", "check", "press", "extract"] as const satisfies readonly ActionType[];

const TARGETED_ACTIONS: ReadonlySet<ActionType> = new Set(["click", "type", "select", "check"]);

export const RetryPolicy = z.object({
  maxAttempts: z.number().int().min(1).max(10),
  initialBackoffMs: z.number().int().nonnegative(),
  factor: z.number().min(1).default(2),
  maxBackoffMs: z.number().int().positive().default(10_000),
});
export type RetryPolicy = z.infer<typeof RetryPolicy>;

export const Step = z
  .object({
    id: StepId,
    intent: z.string().min(1),
    target: TargetDescriptor.optional(),
    action: StepAction,
    risk: RiskClass,
    preconditions: z.array(Condition).default([]),
    postcondition: Condition.optional(),
    timeoutMs: z.number().int().positive().max(120_000).default(10_000),
  })
  .superRefine((step, ctx) => {
    if (TARGETED_ACTIONS.has(step.action.type) && !step.target) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["target"], message: `action '${step.action.type}' requires a target` });
    }
    if (step.action.type === "navigate" && step.target) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["target"], message: "navigate must not have a target" });
    }
  });
export type Step = z.infer<typeof Step>;

// ---------------------------------------------------------------------------
// Screen states: named classifiers + handlers (business outcomes live here, not in the engine)
// ---------------------------------------------------------------------------

export const FailureKind = z.enum([
  "invalid_input",
  "target_not_found",
  "target_ambiguous",
  "precondition_timeout",
  "postcondition_failed",
  "checkpoint_failed",
  "extraction_failed",
  "unknown_screen_state",
  "app_error",
  "navigation_error",
  "policy_denied",
  "recovery_exhausted",
  "timeout",
  "aborted",
  "internal_error",
]);
export type FailureKind = z.infer<typeof FailureKind>;

export const ScreenStateHandler = z.discriminatedUnion("kind", [
  /** A legitimate business result returned to the caller (e.g. MEMBER_NOT_FOUND). */
  z.object({
    kind: z.literal("outcome"),
    code: z.string().regex(/^[A-Z][A-Z0-9_]*$/, "outcome codes are UPPER_SNAKE"),
    message: z.string().min(1),
    /** Outputs that can still be extracted on this screen (e.g. the validation message). */
    outputs: z.array(Identifier).default([]),
  }),
  /** Run recovery steps (possibly none, i.e. wait), then resume. Bounded by `retry`. */
  z.object({
    kind: z.literal("recover"),
    steps: z.array(Step).default([]),
    retry: RetryPolicy,
    resume: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("retryStep") }),
      z.object({ mode: z.literal("restartFrom"), stepId: StepId }),
    ]),
  }),
  z.object({ kind: z.literal("fail"), failureKind: FailureKind, message: z.string().min(1) }),
  z.object({ kind: z.literal("escalate"), reason: z.string().min(1) }),
]);
export type ScreenStateHandler = z.infer<typeof ScreenStateHandler>;

export const ScreenState = z.object({
  id: Identifier,
  description: z.string().min(1),
  detect: Condition,
  /** Higher priority classifiers are evaluated first; ties keep declaration order. */
  priority: z.number().int().default(0),
  /** Step ids during which this state can occur; omitted means any step. */
  appliesTo: z.array(StepId).optional(),
  handler: ScreenStateHandler,
});
export type ScreenState = z.infer<typeof ScreenState>;

// ---------------------------------------------------------------------------
// App identity and the artifact
// ---------------------------------------------------------------------------

export const AppFingerprint = z.object({
  titlePattern: z.string().optional(),
  versionText: z.string().optional(),
  landmarks: z.array(z.string().min(1)).default([]),
});
export type AppFingerprint = z.infer<typeof AppFingerprint>;

export const AppIdentity = z.object({
  vendor: z.string().min(1),
  product: z.string().min(1),
  /** npm-style semver range of product versions this artifact was validated against. */
  versionRange: z.string().min(1),
  surface: SurfaceKind,
  /** Route (relative to the tenant base URL) where every invocation starts. */
  entryRoute: z.string().startsWith("/"),
  fingerprint: AppFingerprint.default({}),
});
export type AppIdentity = z.infer<typeof AppIdentity>;

export const Provenance = z.object({
  source: z.enum(["discovery", "hand-written", "human-recorded"]),
  discoveryRunId: z.string().optional(),
  model: z.string().optional(),
  recordedAt: z.string().datetime({ offset: true }),
  recordedOnTenant: z.string().optional(),
  compilerVersion: z.string().optional(),
});
export type Provenance = z.infer<typeof Provenance>;

export const SuccessCheckpoint = z.object({
  description: z.string().min(1),
  condition: Condition,
});
export type SuccessCheckpoint = z.infer<typeof SuccessCheckpoint>;

const TEMPLATE_RE = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;

export function templatePlaceholders(s: string): string[] {
  return [...s.matchAll(TEMPLATE_RE)].map((m) => m[1]!);
}

function walkStrings(value: unknown, path: (string | number)[], visit: (s: string, path: (string | number)[]) => void): void {
  if (typeof value === "string") visit(value, path);
  else if (Array.isArray(value)) value.forEach((v, i) => walkStrings(v, [...path, i], visit));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) walkStrings(v, [...path, k], visit);
  }
}

function walkValueRefs(value: unknown, path: (string | number)[], visit: (ref: ValueRef, path: (string | number)[]) => void): void {
  if (Array.isArray(value)) value.forEach((v, i) => walkValueRefs(v, [...path, i], visit));
  else if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    if ((o.kind === "input" || o.kind === "secret") && typeof o.name === "string" && Object.keys(o).length === 2) {
      visit(o as ValueRef, path);
      return;
    }
    for (const [k, v] of Object.entries(o)) walkValueRefs(v, [...path, k], visit);
  }
}

const CapabilityArtifactBase = z.object({
  schemaVersion: z.literal(ARTIFACT_SCHEMA_VERSION),
  id: CapabilityId,
  version: Semver,
  /** sha256 over the canonical artifact excluding `contentHash` and `status`; see artifact/hash.ts. */
  contentHash: ContentHash.optional(),
  status: ArtifactStatus,
  title: z.string().min(1),
  /** Written for a calling agent: what it does, when to use it, what it returns. */
  description: z.string().min(1),
  provenance: Provenance,
  app: AppIdentity,
  inputs: z.record(Identifier, InputField),
  outputs: z.record(Identifier, OutputField),
  secrets: z.record(Identifier, SecretDecl).default({}),
  steps: z.array(Step).min(1),
  screenStates: z.array(ScreenState).default([]),
  successCheckpoint: SuccessCheckpoint,
});

export const CapabilityArtifact = CapabilityArtifactBase.superRefine((a, ctx) => {
  const issue = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });

  const stepIds = new Set<string>();
  a.steps.forEach((s, i) => {
    if (stepIds.has(s.id)) issue(["steps", i, "id"], `duplicate step id '${s.id}'`);
    stepIds.add(s.id);
  });

  const stateIds = new Set<string>();
  a.screenStates.forEach((st, i) => {
    if (stateIds.has(st.id)) issue(["screenStates", i, "id"], `duplicate screen state id '${st.id}'`);
    stateIds.add(st.id);
    st.appliesTo?.forEach((sid, j) => {
      if (!stepIds.has(sid)) issue(["screenStates", i, "appliesTo", j], `unknown step '${sid}'`);
    });
    const h = st.handler;
    if (h.kind === "recover" && h.resume.mode === "restartFrom" && !stepIds.has(h.resume.stepId)) {
      issue(["screenStates", i, "handler", "resume", "stepId"], `unknown step '${h.resume.stepId}'`);
    }
    if (h.kind === "outcome") {
      h.outputs.forEach((o, j) => {
        if (!a.outputs[o]) issue(["screenStates", i, "handler", "outputs", j], `unknown output '${o}'`);
      });
    }
  });

  const extracted = new Set<string>();
  a.steps.forEach((s, i) => {
    if (s.action.type !== "extract") return;
    s.action.outputs.forEach((o, j) => {
      const out = a.outputs[o];
      if (!out) issue(["steps", i, "action", "outputs", j], `unknown output '${o}'`);
      else if (!out.extraction) issue(["steps", i, "action", "outputs", j], `output '${o}' has no extraction rule`);
      extracted.add(o);
    });
  });
  for (const [name, out] of Object.entries(a.outputs)) {
    if (out.extraction && !extracted.has(name)) {
      issue(["outputs", name], `output '${name}' has an extraction rule but no extract step uses it`);
    }
  }

  walkValueRefs({ steps: a.steps, screenStates: a.screenStates }, [], (ref, path) => {
    if (ref.kind === "input" && !a.inputs[ref.name]) issue(path, `unknown input '${ref.name}'`);
    if (ref.kind === "secret" && !a.secrets[ref.name]) issue(path, `unknown secret '${ref.name}'`);
  });

  // Placeholders end up in locators and logs, so they may only reference non-secret inputs.
  walkStrings(
    { app: a.app, steps: a.steps, screenStates: a.screenStates, outputs: a.outputs, successCheckpoint: a.successCheckpoint },
    [],
    (s, path) => {
      for (const name of templatePlaceholders(s)) {
        const input = a.inputs[name];
        if (!input) issue(path, `template references unknown input '${name}'`);
        else if (input.sensitivity === "secret") issue(path, `template must not reference secret input '${name}'`);
      }
    },
  );
});

export type CapabilityArtifact = z.infer<typeof CapabilityArtifact>;
export type CapabilityArtifactInput = z.input<typeof CapabilityArtifact>;

// ---------------------------------------------------------------------------
// Tenant overlays: constrained patches over a base artifact
// ---------------------------------------------------------------------------

/**
 * Overlays may only re-point *how* things are found (labels, routes, locator hints)
 * and add interstitial handling. They cannot add, remove or reorder steps, nor change
 * inputs, outputs or risk, so a reviewed base artifact keeps its contract on every tenant.
 */
export const TenantOverlay = z.object({
  schemaVersion: z.literal(ARTIFACT_SCHEMA_VERSION),
  tenant: z.string().min(1),
  baseId: CapabilityId,
  /** Semver range of base artifact versions this overlay applies to. */
  baseVersionRange: z.string().min(1),
  appFingerprint: AppFingerprint.optional(),
  /** Route prefix rewrites applied to navigate URLs and urlMatches patterns, in order. */
  routes: z.array(z.object({ fromPrefix: z.string().startsWith("/"), toPrefix: z.string().startsWith("/") })).default([]),
  /** Exact label/text substitutions (base text -> tenant text) applied to strategies and text conditions. */
  labels: z.record(z.string().min(1), z.string().min(1)).default({}),
  /** Per-step locator hints. Prepended strategies are tried before the base strategies. */
  targets: z
    .record(
      StepId,
      z.object({
        prependStrategies: z.array(LocatorStrategy).default([]),
        framePath: z.array(z.string().min(1)).optional(),
      }),
    )
    .default({}),
  extraScreenStates: z.array(ScreenState).default([]),
});
export type TenantOverlay = z.infer<typeof TenantOverlay>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function parseArtifact(data: unknown): CapabilityArtifact {
  return CapabilityArtifact.parse(data);
}

export function safeParseArtifact(data: unknown) {
  return CapabilityArtifact.safeParse(data);
}

/** JSON Schema for the artifact format itself (for reviewers, editors and external tooling). */
export function artifactJsonSchema(): Record<string, unknown> {
  return zodToJsonSchema(CapabilityArtifactBase, {
    name: "CapabilityArtifact",
    $refStrategy: "root",
  }) as Record<string, unknown>;
}

export function tenantOverlayJsonSchema(): Record<string, unknown> {
  return zodToJsonSchema(TenantOverlay, { name: "TenantOverlay", $refStrategy: "root" }) as Record<string, unknown>;
}

/** JSON Schema for one capability's invocation inputs (used as the MCP tool input schema). */
export function inputsJsonSchema(inputs: Record<string, InputField>): Record<string, unknown> {
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  for (const [name, f] of Object.entries(inputs)) {
    const p: Record<string, unknown> = { type: f.type, description: f.description, "x-sensitivity": f.sensitivity };
    if (f.pattern !== undefined) p.pattern = f.pattern;
    if (f.enum !== undefined) p.enum = f.enum;
    if (f.minLength !== undefined) p.minLength = f.minLength;
    if (f.maxLength !== undefined) p.maxLength = f.maxLength;
    if (f.minimum !== undefined) p.minimum = f.minimum;
    if (f.maximum !== undefined) p.maximum = f.maximum;
    if (f.example !== undefined && f.sensitivity !== "secret") p.examples = [f.example];
    properties[name] = p;
    if (f.required) required.push(name);
  }
  return { type: "object", properties, required, additionalProperties: false };
}

export function outputsJsonSchema(outputs: Record<string, OutputField>): Record<string, unknown> {
  const properties: Record<string, Record<string, unknown>> = {};
  for (const [name, f] of Object.entries(outputs)) {
    properties[name] = { type: f.type, description: f.description, "x-sensitivity": f.sensitivity };
  }
  return { type: "object", properties, additionalProperties: false };
}

/** Zod validator for one capability's invocation inputs. */
export function inputsValidator(inputs: Record<string, InputField>): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [name, f] of Object.entries(inputs)) {
    let s: z.ZodTypeAny;
    if (f.type === "string") {
      let str = z.string();
      if (f.pattern !== undefined) str = str.regex(new RegExp(f.pattern));
      if (f.minLength !== undefined) str = str.min(f.minLength);
      if (f.maxLength !== undefined) str = str.max(f.maxLength);
      s = f.enum ? str.refine((v) => f.enum!.includes(v), { message: `must be one of ${f.enum.join(", ")}` }) : str;
    } else if (f.type === "boolean") {
      s = z.boolean();
    } else {
      let num = f.type === "integer" ? z.number().int() : z.number();
      if (f.minimum !== undefined) num = num.min(f.minimum);
      if (f.maximum !== undefined) num = num.max(f.maximum);
      s = num;
    }
    shape[name] = f.required ? s : s.optional();
  }
  return z.object(shape).strict();
}

export function irreversibleSteps(a: CapabilityArtifact): Step[] {
  return a.steps.filter((s) => s.risk === "irreversible");
}
