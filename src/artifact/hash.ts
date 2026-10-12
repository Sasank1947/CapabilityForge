import { createHash } from "node:crypto";
import type { CapabilityArtifact } from "./schema.js";

/** Deterministic JSON: object keys sorted, `undefined` members dropped, array order preserved. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("cannot hash non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? "null" : stableStringify(v))).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

/**
 * Hashes the parsed (defaults-applied) artifact. `status` is excluded so approving
 * or deprecating an artifact does not change its identity; `contentHash` is excluded
 * because it is the output.
 */
export function computeContentHash(artifact: CapabilityArtifact): string {
  const { contentHash: _hash, status: _status, ...content } = artifact;
  return `sha256:${sha256Hex(stableStringify(content))}`;
}

export function withContentHash(artifact: CapabilityArtifact): CapabilityArtifact {
  return { ...artifact, contentHash: computeContentHash(artifact) };
}

export function verifyContentHash(artifact: CapabilityArtifact): boolean {
  return artifact.contentHash !== undefined && artifact.contentHash === computeContentHash(artifact);
}
