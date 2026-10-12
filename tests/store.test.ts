import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LOOKUP_MEMBER_BALANCE, OPEN_SUB_ACCOUNT } from "../src/artifact/corelink.js";
import { computeContentHash, verifyContentHash } from "../src/artifact/hash.js";
import { parseArtifact } from "../src/artifact/schema.js";
import { ArtifactStoreError, listArtifacts, loadArtifact, saveArtifact } from "../src/artifact/store.js";

describe("hand-written CoreLink artifacts", () => {
  it("parseArtifact accepts lookup_member_balance and open_sub_account", () => {
    const lookup = parseArtifact(LOOKUP_MEMBER_BALANCE);
    const open = parseArtifact(OPEN_SUB_ACCOUNT);
    expect(lookup.id).toBe("corelink.lookup_member_balance");
    expect(open.id).toBe("corelink.open_sub_account");
    expect(open.steps.find((s) => s.id === "submit")?.risk).toBe("irreversible");
  });

  it("loads the committed capability JSON files with a matching contentHash", () => {
    const lookup = loadArtifact("capabilities/corelink.lookup_member_balance.json");
    const open = loadArtifact("capabilities/corelink.open_sub_account.json");
    expect(verifyContentHash(lookup)).toBe(true);
    expect(verifyContentHash(open)).toBe(true);
    expect(open.steps.find((s) => s.id === "submit")?.risk).toBe("irreversible");
  });
});

describe("artifact store", () => {
  it("saves with a content hash, lists, loads, and rejects a tampered hash", () => {
    const dir = mkdtempSync(join(tmpdir(), "cf-caps-"));
    const lookup = parseArtifact(LOOKUP_MEMBER_BALANCE);
    const path = join(dir, "corelink.lookup_member_balance.json");
    const saved = saveArtifact(lookup, path);
    expect(saved.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(verifyContentHash(saved)).toBe(true);
    expect(computeContentHash(saved)).toBe(saved.contentHash);

    const loaded = loadArtifact(path);
    expect(loaded.id).toBe(lookup.id);
    expect(loaded.steps).toHaveLength(lookup.steps.length);

    saveArtifact(parseArtifact(OPEN_SUB_ACCOUNT), join(dir, "corelink.open_sub_account.json"));
    const listed = listArtifacts(dir);
    expect(listed.map((a) => a.id)).toEqual(["corelink.lookup_member_balance", "corelink.open_sub_account"]);

    const tampered = JSON.parse(JSON.stringify(saved)) as typeof saved;
    tampered.contentHash = "sha256:" + "ab".repeat(32);
    const bad = join(dir, "tampered.json");
    writeFileSync(bad, `${JSON.stringify(tampered, null, 2)}\n`);
    expect(() => loadArtifact(bad)).toThrow(ArtifactStoreError);
    expect(listArtifacts(dir).map((a) => a.id)).not.toContain(undefined);
    expect(listArtifacts(dir).every((a) => a.id.startsWith("corelink."))).toBe(true);
  });
});
