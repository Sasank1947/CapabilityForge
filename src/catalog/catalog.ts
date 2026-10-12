import { startCoreLink, type CoreLinkHandle } from "../../apps/corelink/server.js";
import { applyOverlay, findOverlay, loadOverlay } from "../artifact/overlay.js";
import {
  inputsJsonSchema,
  inputsValidator,
  outputsJsonSchema,
  type CapabilityArtifact,
  type TenantOverlay,
} from "../artifact/schema.js";
import { listArtifacts, loadArtifact } from "../artifact/store.js";
import type { EvidenceSink, NewRunEvent, RedactedPayload, RunEvent, RunManifest } from "../evidence/types.js";
import type { Grant, PolicyDecision, PolicyGate, PolicyRequest } from "../policy/types.js";
import { replay } from "../replay/engine.js";
import type { ReplayResult } from "../replay/result.js";
import { PlaywrightWebSurface } from "../surface/playwright-web.js";

export interface CatalogOptions {
  capabilitiesDir?: string;
  overlaysDir?: string;
  /** When set, matching overlays in `overlaysDir` are applied at load time. */
  tenant?: string;
  /** Explicit overlay file applied to the matching base artifact. */
  overlayPath?: string;
}

export interface CatalogTool {
  name: string;
  title: string;
  description: string;
  artifact: CapabilityArtifact;
  overlay?: TenantOverlay;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

export interface InvokeOptions {
  inputs: Record<string, unknown>;
  secrets?: Record<string, string>;
  baseUrl?: string;
  tenant?: string;
  headed?: boolean;
  grants?: Grant[];
  invocationId?: string;
}

class MemorySink implements EvidenceSink {
  readonly runId: string;
  readonly dir: string;
  private seq = 0;
  constructor(runId: string) {
    this.runId = runId;
    this.dir = `catalog://${runId}`;
  }
  append(event: NewRunEvent): RunEvent {
    return {
      runId: this.runId,
      seq: ++this.seq,
      at: new Date().toISOString(),
      ...event,
      payload: event.payload as RedactedPayload,
    };
  }
  async attach(): Promise<string> {
    return "";
  }
  async close(_manifest: Partial<RunManifest>): Promise<void> {}
}

/** Allow-all gate for catalog invocations. Irreversible steps still need an explicit grant. */
export function catalogPolicy(): PolicyGate {
  return {
    evaluate(request: PolicyRequest): PolicyDecision {
      if (request.risk === "irreversible") {
        const grant = request.grants.find(
          (g) =>
            g.kind === "approve_irreversible" &&
            g.invocationId === request.invocationId &&
            (g.capabilityId === undefined || g.capabilityId === request.capabilityId) &&
            (g.stepId === undefined || g.stepId === request.stepId),
        );
        if (!grant) {
          return {
            verdict: "escalate",
            ruleId: "grant",
            reason: "irreversible step requires an approve_irreversible grant",
            requiredGrant: "approve_irreversible",
          };
        }
        return { verdict: "allow", ruleId: "grant", reason: "irreversible grant present", grant };
      }
      return { verdict: "allow", ruleId: "action_allowlist", reason: "catalog default allow" };
    },
  };
}

export class CapabilityCatalog {
  readonly tools: CatalogTool[];
  readonly capabilitiesDir: string;
  readonly overlaysDir: string;
  readonly tenant?: string;

  private constructor(tools: CatalogTool[], opts: CatalogOptions) {
    this.tools = tools;
    this.capabilitiesDir = opts.capabilitiesDir ?? "capabilities";
    this.overlaysDir = opts.overlaysDir ?? "capabilities/overlays";
    this.tenant = opts.tenant;
  }

  static load(opts: CatalogOptions = {}): CapabilityCatalog {
    const capabilitiesDir = opts.capabilitiesDir ?? "capabilities";
    const overlaysDir = opts.overlaysDir ?? "capabilities/overlays";
    const explicit = opts.overlayPath ? loadOverlay(opts.overlayPath) : undefined;
    const tools: CatalogTool[] = [];

    for (const listing of listArtifacts(capabilitiesDir)) {
      if (listing.status !== "approved") continue;
      const base = loadArtifact(listing.path);
      const overlay =
        explicit && explicit.baseId === base.id
          ? explicit
          : opts.tenant
            ? findOverlay(overlaysDir, base.id, opts.tenant)
            : undefined;
      const artifact = overlay ? applyOverlay(base, overlay) : base;
      tools.push({
        name: artifact.id,
        title: artifact.title,
        description: artifact.description,
        artifact,
        overlay,
        inputSchema: inputsJsonSchema(artifact.inputs),
        outputSchema: outputsJsonSchema(artifact.outputs),
      });
    }

    return new CapabilityCatalog(tools, { ...opts, capabilitiesDir, overlaysDir });
  }

  get(name: string): CatalogTool | undefined {
    return this.tools.find((t) => t.name === name);
  }

  /**
   * Replay an approved capability. Starts an ephemeral CoreLink when `baseUrl` is omitted.
   * Overlay-rewritten routes are used as-is (no extra tenant prefix).
   */
  async invoke(name: string, opts: InvokeOptions): Promise<ReplayResult> {
    const tool = this.get(name);
    if (!tool) throw new Error(`unknown capability '${name}'`);

    const parsed = inputsValidator(tool.artifact.inputs).safeParse(opts.inputs);
    if (!parsed.success) {
      throw new Error(`invalid inputs for ${name}: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    }

    const tenant = opts.tenant ?? this.tenant;
    const secrets = { ...defaultSecrets(), ...opts.secrets };
    let owned: CoreLinkHandle | undefined;
    let baseUrl = opts.baseUrl;
    let routePrefix = "";
    if (!baseUrl) {
      owned = await startCoreLink({ port: 0, tenant: tenant === "b" ? "b" : "a" });
      baseUrl = owned.origin;
      routePrefix = tool.overlay ? "" : owned.prefix;
    }

    const invocationId = opts.invocationId ?? `catalog-${Date.now().toString(16)}`;
    const surface = await PlaywrightWebSurface.launch({
      headless: opts.headed !== true,
      actionTimeoutMs: 20_000,
    });
    try {
      return await replay({
        artifact: tool.artifact,
        surface,
        policy: catalogPolicy(),
        evidence: new MemorySink(invocationId),
        inputs: parsed.data,
        secrets,
        baseUrl,
        routePrefix,
        grants: opts.grants ?? [],
        invocationId,
        tenant,
        onEscalate: async () => "abort",
      });
    } finally {
      await surface.close();
      await owned?.close();
    }
  }
}

function defaultSecrets(): Record<string, string> {
  const out: Record<string, string> = {};
  if (process.env.CORELINK_USER) out.username = process.env.CORELINK_USER;
  if (process.env.CORELINK_PASSWORD) out.password = process.env.CORELINK_PASSWORD;
  return out;
}
