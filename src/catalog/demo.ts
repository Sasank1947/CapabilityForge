import type { ReplayResult } from "../replay/result.js";
import { CapabilityCatalog } from "./catalog.js";

/**
 * In-process demo: load the approved catalog and invoke `corelink.lookup_member_balance`.
 * Used by tests and as the reference call path for `forge serve-mcp`.
 */
export async function invokeLookupMemberBalance(
  inputs: Record<string, unknown> = { memberId: "12345" },
  extras: { tenant?: string; secrets?: Record<string, string> } = {},
): Promise<ReplayResult> {
  const catalog = CapabilityCatalog.load({ tenant: extras.tenant });
  return catalog.invoke("corelink.lookup_member_balance", {
    inputs,
    tenant: extras.tenant,
    secrets: extras.secrets,
  });
}
