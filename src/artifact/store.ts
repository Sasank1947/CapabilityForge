import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { computeContentHash, verifyContentHash, withContentHash } from "./hash.js";
import { parseArtifact, type ArtifactStatus, type CapabilityArtifact } from "./schema.js";

export class ArtifactStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactStoreError";
  }
}

export interface ArtifactListing {
  id: string;
  version: string;
  status: ArtifactStatus;
  title: string;
  path: string;
  contentHash?: string;
}

function readJson(filePath: string): unknown {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (err) {
    throw new ArtifactStoreError(`cannot read artifact ${filePath}: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ArtifactStoreError(`invalid JSON in ${filePath}: ${(err as Error).message}`);
  }
}

/**
 * Load and validate a capability artifact. When `contentHash` is present it must
 * match `computeContentHash`; a mismatch is a hard error so a tampered file cannot
 * be replayed.
 */
export function loadArtifact(filePath: string): CapabilityArtifact {
  const parsed = parseArtifact(readJson(filePath));
  if (parsed.contentHash !== undefined && !verifyContentHash(parsed)) {
    throw new ArtifactStoreError(
      `contentHash mismatch in ${filePath}: stored ${parsed.contentHash}, computed ${computeContentHash(parsed)}`,
    );
  }
  return parsed;
}

/** Parse, attach a content hash, and write pretty JSON. Returns the hashed artifact. */
export function saveArtifact(artifact: CapabilityArtifact, filePath: string): CapabilityArtifact {
  const hashed = withContentHash(parseArtifact(artifact));
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(hashed, null, 2)}\n`);
  return hashed;
}

/** Capability JSON files in `dir` (non-recursive), sorted by id then version. */
export function listArtifacts(dir: string): ArtifactListing[] {
  const root = resolve(dir);
  if (!existsSync(root)) return [];
  const out: ArtifactListing[] = [];
  for (const name of readdirSync(root)) {
    if (!name.endsWith(".json")) continue;
    const path = join(root, name);
    try {
      const a = loadArtifact(path);
      out.push({
        id: a.id,
        version: a.version,
        status: a.status,
        title: a.title,
        path,
        contentHash: a.contentHash,
      });
    } catch {
      // Skip files that are not valid artifacts (or fail the hash check).
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id) || a.version.localeCompare(b.version) || basename(a.path).localeCompare(basename(b.path)));
}

/** Resolve a CLI argument that is either a file path or a capability id under `capabilitiesDir`. */
export function resolveArtifactPath(spec: string, capabilitiesDir = "capabilities"): string {
  if (existsSync(spec) || spec.endsWith(".json")) return spec;
  const byId = join(capabilitiesDir, `${spec}.json`);
  if (existsSync(byId)) return byId;
  return spec;
}
