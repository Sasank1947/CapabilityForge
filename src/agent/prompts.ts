import type { Observation, ObservedElement } from "../surface/types.js";
import type { DiscoveryGoal } from "./types.js";

function fieldLine(name: string, type: string, sensitivity: string, description: string): string {
  return `  - ${name}: ${type} (${sensitivity}) — ${description}`;
}

export function systemPrompt(goal: DiscoveryGoal): string {
  const inputs = Object.entries(goal.inputs)
    .map(([n, f]) => fieldLine(n, f.type, f.sensitivity, f.description))
    .join("\n");
  const secrets = Object.entries(goal.secrets)
    .map(([n, s]) => `  - ${n}: ${s.description} (ref ${s.ref}; you will never see the value)`)
    .join("\n");
  const outputs = Object.entries(goal.outputs)
    .map(([n, o]) => fieldLine(n, o.type, o.sensitivity, o.description))
    .join("\n");

  return [
    "You are discovering a reusable UI capability on a hostile legacy web app (framesets, nested tables, no test IDs).",
    "You see a compact numbered accessibility snapshot. Refs look like e12 and are valid only until the next navigation or new snapshot.",
    "",
    `CAPABILITY ID: ${goal.id}`,
    `TITLE: ${goal.title}`,
    `GOAL: ${goal.instruction}`,
    "",
    "DECLARED INPUTS — you MUST pass these as {\"param\":\"<name>\"}, never as a literal string:",
    inputs || "  (none)",
    "",
    "DECLARED SECRETS — you MUST pass these as {\"secret\":\"<name>\"}. Never invent, ask for, or type the raw value:",
    secrets || "  (none)",
    "",
    "DECLARED OUTPUTS — extract each by name before you declare_done:",
    outputs || "  (none)",
    "",
    "APP:",
    `  ${goal.app.vendor} ${goal.app.product} ${goal.app.versionRange} (${goal.app.surface})`,
    `  Entry route: ${goal.app.entryRoute}`,
    "",
    "Rules:",
    "- Every tool call needs a short rationale.",
    "- Prefer one tool call per turn.",
    "- Start by navigating to the entry route if you are not already there.",
    "- Stay on the app origin. Do not open external sites.",
    "- After a successful path, extract the declared outputs, then declare_done with visible evidence text (e.g. REGULAR SAVINGS).",
    "- If you are stuck on the same screen, request_human instead of looping.",
    "- Do not describe targets in prose for later replay; the recorder fingerprints the live control when you act.",
  ].join("\n");
}

function compactEl(el: ObservedElement): string {
  const bits = [`${el.ref}  ${el.role}`];
  if (el.name) bits.push(`name=${JSON.stringify(el.name)}`);
  if (el.labelText && el.labelText !== el.name) bits.push(`label=${JSON.stringify(el.labelText)}`);
  if (el.text && el.text !== el.name && el.text !== el.labelText) bits.push(`text=${JSON.stringify(el.text.slice(0, 80))}`);
  if (el.framePath.length) bits.push(`frame=${el.framePath.join("/")}`);
  if (el.states.disabled) bits.push("disabled");
  if (el.states.editable) bits.push("editable");
  if (el.bbox) bits.push(`bbox=${Math.round(el.bbox.x)},${Math.round(el.bbox.y)},${Math.round(el.bbox.width)}x${Math.round(el.bbox.height)}`);
  return bits.join("  ");
}

/** Numbered a11y snapshot. Secret field values are omitted (the surface already masks passwords). */
export function formatObservation(obs: Observation): string {
  const frames = obs.frames
    .map((f) => `  - [${f.path.join("/") || "top"}] ${f.url}${f.title ? ` title=${JSON.stringify(f.title)}` : ""}`)
    .join("\n");
  const els = obs.elements.length
    ? obs.elements.map((el) => `  ${compactEl(el)}`).join("\n")
    : "  (none — the accessibility tree is empty)";
  const texts = Object.entries(obs.textByFrame)
    .filter(([, t]) => t.trim())
    .map(([k, t]) => `  [${k || "top"}] ${t.replace(/\s+/g, " ").trim().slice(0, 240)}`)
    .join("\n");
  const note = obs.elements.length < 2 ? "\nNOTE: a11y tree is sparse. Prefer role/label cues; request_human if you cannot proceed." : "";
  return [
    `SCREEN url=${obs.url} title=${JSON.stringify(obs.title)} hash=${obs.snapshotHash}`,
    "frames:",
    frames || "  (none)",
    "visible text:",
    texts || "  (none)",
    `elements (${obs.elements.length}):`,
    els,
  ].join("\n") + note;
}

export const NUDGE_NO_TOOL =
  "You must call exactly one tool. Use declare_done when the goal is achieved, or request_human if you are stuck.";
