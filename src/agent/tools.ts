import { z } from "zod";
import type { DiscoveryGoal, TypedValue } from "./types.js";
import type { ToolSpec } from "./llm.js";

const Rationale = z.string().min(1).max(400);

const TypedValueSchema: z.ZodType<TypedValue> = z.union([
  z.string(),
  z.object({ param: z.string().min(1) }).strict(),
  z.object({ secret: z.string().min(1) }).strict(),
]);

export const ClickArgs = z.object({ rationale: Rationale, ref: z.string().min(1) });
export const TypeArgs = z.object({ rationale: Rationale, ref: z.string().min(1), value: TypedValueSchema });
export const SelectArgs = z.object({ rationale: Rationale, ref: z.string().min(1), value: TypedValueSchema });
export const NavigateArgs = z.object({ rationale: Rationale, url: z.string().min(1) });
export const ExtractArgs = z.object({
  rationale: Rationale,
  name: z.string().min(1),
  ref: z.string().min(1),
  read: z.enum(["text", "value"]).default("text"),
});
export const DeclareDoneArgs = z.object({
  rationale: Rationale,
  evidence: z.string().min(1),
});
export const RequestHumanArgs = z.object({
  rationale: Rationale,
  reason: z.string().min(1),
});

export type ClickArgs = z.infer<typeof ClickArgs>;
export type TypeArgs = z.infer<typeof TypeArgs>;
export type SelectArgs = z.infer<typeof SelectArgs>;
export type NavigateArgs = z.infer<typeof NavigateArgs>;
export type ExtractArgs = z.infer<typeof ExtractArgs>;
export type DeclareDoneArgs = z.infer<typeof DeclareDoneArgs>;
export type RequestHumanArgs = z.infer<typeof RequestHumanArgs>;

function typedValueSchema(goal: DiscoveryGoal): Record<string, unknown> {
  const params = Object.keys(goal.inputs);
  const secrets = Object.keys(goal.secrets);
  const variants: Record<string, unknown>[] = [
    {
      type: "string",
      description: "A constant that is NOT a declared input or secret. Prefer {param} / {secret}.",
    },
  ];
  if (params.length) {
    variants.push({
      type: "object",
      properties: { param: { type: "string", enum: params, description: "Declared input name" } },
      required: ["param"],
      additionalProperties: false,
    });
  }
  if (secrets.length) {
    variants.push({
      type: "object",
      properties: { secret: { type: "string", enum: secrets, description: "Declared secret name; the value is never shown to you" } },
      required: ["secret"],
      additionalProperties: false,
    });
  }
  return { description: "Use {\"param\":\"name\"} or {\"secret\":\"name\"} for declared values.", oneOf: variants };
}

const rationaleProp = {
  type: "string",
  minLength: 1,
  maxLength: 400,
  description: "One short sentence: why this action advances the goal.",
};

function obj(description: string, properties: Record<string, unknown>, required: string[]): ToolSpec["parameters"] {
  return { type: "object", description, properties, required, additionalProperties: false };
}

/** OpenAI function-calling tools. Every call requires `rationale`. */
export function toolSpecs(goal: DiscoveryGoal): ToolSpec[] {
  const outputNames = Object.keys(goal.outputs);
  const valueSchema = typedValueSchema(goal);
  return [
    {
      name: "click",
      description: "Click the control identified by ref from the latest snapshot.",
      parameters: obj("Click a control", { rationale: rationaleProp, ref: { type: "string", description: "Snapshot ref, e.g. e12" } }, [
        "rationale",
        "ref",
      ]),
    },
    {
      name: "type",
      description: "Type into the control. Declared inputs/secrets MUST use {param}/{secret} objects, never literals.",
      parameters: obj("Type a value", {
        rationale: rationaleProp,
        ref: { type: "string" },
        value: valueSchema,
      }, ["rationale", "ref", "value"]),
    },
    {
      name: "select",
      description: "Choose an option on a <select>. Same {param}/{secret} typing as type.",
      parameters: obj("Select an option", {
        rationale: rationaleProp,
        ref: { type: "string" },
        value: valueSchema,
      }, ["rationale", "ref", "value"]),
    },
    {
      name: "navigate",
      description: "Go to a same-origin URL (absolute or root-relative, e.g. /login).",
      parameters: obj("Navigate", { rationale: rationaleProp, url: { type: "string" } }, ["rationale", "url"]),
    },
    {
      name: "extract",
      description: "Read a named output from a control. Use a declared output name.",
      parameters: obj("Extract an output", {
        rationale: rationaleProp,
        name: outputNames.length ? { type: "string", enum: outputNames } : { type: "string" },
        ref: { type: "string" },
        read: { type: "string", enum: ["text", "value"], default: "text" },
      }, ["rationale", "name", "ref"]),
    },
    {
      name: "declare_done",
      description: "The goal is achieved. evidence is visible text that a replay can assert.",
      parameters: obj("Finish successfully", { rationale: rationaleProp, evidence: { type: "string" } }, ["rationale", "evidence"]),
    },
    {
      name: "request_human",
      description: "Stop and ask a human. Use when you are stuck or the next action is unsafe.",
      parameters: obj("Escalate", { rationale: rationaleProp, reason: { type: "string" } }, ["rationale", "reason"]),
    },
  ];
}

export function parseToolArgs(name: string, raw: Record<string, unknown>): { ok: true; args: unknown } | { ok: false; error: string } {
  const schema =
    name === "click"
      ? ClickArgs
      : name === "type"
        ? TypeArgs
        : name === "select"
          ? SelectArgs
          : name === "navigate"
            ? NavigateArgs
            : name === "extract"
              ? ExtractArgs
              : name === "declare_done"
                ? DeclareDoneArgs
                : name === "request_human"
                  ? RequestHumanArgs
                  : undefined;
  if (!schema) return { ok: false, error: `unknown tool '${name}'` };
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".") || "args"}: ${i.message}`).join("; ") };
  }
  return { ok: true, args: parsed.data };
}
