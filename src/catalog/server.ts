import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { inputsValidator } from "../artifact/schema.js";
import { CapabilityCatalog, type CatalogOptions, type InvokeOptions } from "./catalog.js";

export interface ServeMcpOptions extends CatalogOptions {
  secrets?: Record<string, string>;
}

export function createCatalogMcpServer(catalog: CapabilityCatalog, defaults: Partial<InvokeOptions> = {}): McpServer {
  const server = new McpServer(
    { name: "capabilityforge", version: "0.1.0" },
    {
      instructions:
        "Approved CapabilityForge artifacts as typed tools. Each call replays the capability against CoreLink.",
    },
  );

  for (const tool of catalog.tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: inputsValidator(tool.artifact.inputs),
      },
      async (args) => {
        const result = await catalog.invoke(tool.name, {
          ...defaults,
          inputs: args as Record<string, unknown>,
          secrets: defaults.secrets,
        });
        const text = JSON.stringify(result);
        const structured =
          result.status === "success" || result.status === "business_outcome"
            ? { status: result.status, ...(result.status === "business_outcome" ? { code: result.code } : {}), ...result.outputs }
            : { status: result.status, message: "message" in result ? result.message : result.status };
        return {
          content: [{ type: "text" as const, text }],
          structuredContent: structured,
          isError: result.status === "failure",
        };
      },
    );
  }

  return server;
}

/** stdio MCP server for `forge serve-mcp`. Writes nothing to stdout except protocol messages. */
export async function serveMcpStdio(opts: ServeMcpOptions = {}): Promise<void> {
  const catalog = CapabilityCatalog.load(opts);
  const server = createCatalogMcpServer(catalog, {
    tenant: opts.tenant,
    secrets: opts.secrets,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
