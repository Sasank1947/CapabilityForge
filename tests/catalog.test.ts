import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { CapabilityCatalog } from "../src/catalog/catalog.js";
import { invokeLookupMemberBalance } from "../src/catalog/demo.js";
import { createCatalogMcpServer } from "../src/catalog/server.js";

const secrets = { username: "teller01", password: "change-me-local-only" };

describe("MCP capability catalog", () => {
  it("exposes approved artifacts as typed tools", () => {
    const catalog = CapabilityCatalog.load();
    const lookup = catalog.get("corelink.lookup_member_balance");
    expect(lookup).toBeDefined();
    expect(lookup?.artifact.status).toBe("approved");
    expect(lookup?.inputSchema).toMatchObject({
      type: "object",
      required: ["memberId"],
      properties: { memberId: { type: "string" } },
    });
    expect(catalog.tools.every((t) => t.artifact.status === "approved")).toBe(true);
  });

  it("invokes corelink.lookup_member_balance in-process via MCP", async () => {
    const catalog = CapabilityCatalog.load();
    const server = createCatalogMcpServer(catalog, { secrets });
    const client = new Client({ name: "capabilityforge-demo", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name)).toContain("corelink.lookup_member_balance");
      const called = await client.callTool(
        { name: "corelink.lookup_member_balance", arguments: { memberId: "12345" } },
        undefined,
        { timeout: 90_000 },
      );
      expect(called.isError).not.toBe(true);
      const content = called.content as Array<{ type: string; text?: string }>;
      const text = content.find((c) => c.type === "text");
      expect(text?.text ?? "").toContain("1520.75");
      expect(called.structuredContent).toMatchObject({ status: "success", savingsBalance: 1520.75 });
    } finally {
      await client.close();
      await server.close();
    }
  }, 120_000);
});

describe("in-process demo invoke", () => {
  it("returns typed savingsBalance from invokeLookupMemberBalance", async () => {
    const result = await invokeLookupMemberBalance({ memberId: "12345" }, { secrets });
    expect(result.status, JSON.stringify(result)).toBe("success");
    if (result.status !== "success") return;
    expect(result.outputs.savingsBalance).toBe(1520.75);
    expect(result.capabilityId).toBe("corelink.lookup_member_balance");
  }, 90_000);
});
