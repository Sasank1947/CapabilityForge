import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
function forge(...args: string[]): string {
  return execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { cwd: root, encoding: "utf8" });
}

describe("forge CLI", () => {
  it("lists every subcommand in --help", () => {
    const help = forge("--help");
    for (const cmd of ["app", "discover", "replay", "operator", "serve-mcp", "schema"]) {
      expect(help).toMatch(new RegExp(`^\\s+${cmd}\\b`, "m"));
    }
  });

  it("prints the artifact JSON Schema", () => {
    const schema = JSON.parse(forge("schema")) as { definitions?: Record<string, unknown> };
    expect(schema.definitions).toHaveProperty("CapabilityArtifact");
  });
});
