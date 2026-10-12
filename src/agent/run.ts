import { existsSync } from "node:fs";
import { startCoreLink, type CoreLinkHandle } from "../../apps/corelink/server.js";
import { compileTrace } from "../artifact/compiler.js";
import { saveArtifact } from "../artifact/store.js";
import type { CapabilityArtifact, InputField } from "../artifact/schema.js";
import { JsonlEvidenceSink } from "../evidence/sink.js";
import { loadPolicy, parsePolicy } from "../policy/config.js";
import { DefaultPolicyGate } from "../policy/gate.js";
import { Redactor } from "../policy/redact.js";
import type { Grant, PolicyGate } from "../policy/types.js";
import { PlaywrightWebSurface } from "../surface/playwright-web.js";
import { discover, type DiscoveryResult } from "./loop.js";
import { hasOpenAIKey, OpenAILlmClient, defaultModel, type LlmClient } from "./llm.js";
import { LOOKUP_BALANCE_GOAL, goalFromPreset, parseFieldSpec, specToInput, specToOutput } from "./presets.js";
import type { DiscoveryGoal } from "./types.js";

export interface DiscoverCliOptions {
  preset?: string;
  goal?: string;
  id?: string;
  title?: string;
  description?: string;
  inputs: Record<string, string>;
  params: string[];
  outputs: string[];
  out?: string;
  baseUrl?: string;
  headed?: boolean;
  approveIrreversible?: boolean;
  secrets: Record<string, string>;
  tenant?: string;
  policyPath?: string;
  maxSteps?: number;
  timeoutMs?: number;
  model?: string;
  version?: string;
  llm?: LlmClient;
}

export interface DiscoverCommandResult {
  status: DiscoveryResult["status"];
  stop: DiscoveryResult["stop"];
  runId: string;
  artifactPath?: string;
  artifactId?: string;
  steps: number;
  model?: string;
  evidenceDir?: string;
}

function mergeGoal(opts: DiscoverCliOptions): DiscoveryGoal {
  const base = opts.preset ? goalFromPreset(opts.preset) : structuredClone(LOOKUP_BALANCE_GOAL);
  if (!opts.preset && (opts.goal || opts.id)) {
    base.id = opts.id ?? base.id;
    base.instruction = opts.goal ?? base.instruction;
    base.title = opts.title ?? opts.goal ?? base.title;
    base.description = opts.description ?? base.description;
  } else {
    if (opts.id) base.id = opts.id;
    if (opts.goal) base.instruction = opts.goal;
    if (opts.title) base.title = opts.title;
    if (opts.description) base.description = opts.description;
  }
  if (opts.version) base.version = opts.version;
  for (const spec of opts.params) {
    const f = parseFieldSpec(spec);
    base.inputs[f.name] = specToInput(f);
  }
  for (const spec of opts.outputs) {
    const f = parseFieldSpec(spec);
    base.outputs[f.name] = specToOutput(f);
  }
  return base;
}

function defaultPolicy(): PolicyGate {
  const path = existsSync("policies/corelink.json") ? "policies/corelink.json" : undefined;
  if (path) return new DefaultPolicyGate(loadPolicy(path));
  return new DefaultPolicyGate(
    parsePolicy({
      allowedOrigins: ["http://127.0.0.1:*", "http://localhost:*"],
      allowedRoutes: ["/", "/**"],
      allowedActions: ["navigate", "click", "type", "select", "check", "press"],
      blockedTargets: [],
    }),
  );
}

export async function runDiscoveryCommand(opts: DiscoverCliOptions): Promise<DiscoverCommandResult> {
  if (!opts.llm && !hasOpenAIKey()) {
    throw new Error("OPENAI_API_KEY is not set. Add it to .env to run forge discover (replay and tests stay offline).");
  }
  const goal = mergeGoal(opts);
  const secrets = { ...opts.secrets };
  if (!secrets.username && process.env.CORELINK_USER) secrets.username = process.env.CORELINK_USER;
  if (!secrets.password && process.env.CORELINK_PASSWORD) secrets.password = process.env.CORELINK_PASSWORD;

  const missingInputs = Object.entries(goal.inputs)
    .filter(([, f]: [string, InputField]) => f.required !== false)
    .map(([n]) => n)
    .filter((n) => opts.inputs[n] === undefined);
  if (missingInputs.length) {
    throw new Error(`missing --input ${missingInputs.map((n) => `${n}=...`).join(" ")}`);
  }

  let owned: CoreLinkHandle | undefined;
  let baseUrl = opts.baseUrl;
  let routePrefix = "";
  if (!baseUrl) {
    owned = await startCoreLink({ port: 0, tenant: opts.tenant === "b" ? "b" : "a" });
    baseUrl = owned.origin;
    routePrefix = owned.prefix;
  }

  const invocationId = `discover-${Date.now().toString(16)}`;
  const grants: Grant[] = [];
  if (opts.approveIrreversible) {
    grants.push({
      kind: "approve_irreversible",
      invocationId,
      capabilityId: goal.id,
      grantedBy: "cli",
      grantedAt: new Date().toISOString(),
    });
  }

  const redactor = Redactor.forRun(
    { inputs: goal.inputs, outputs: goal.outputs as never, secrets: goal.secrets },
    { inputs: opts.inputs, secrets },
  );
  const evidence = new JsonlEvidenceSink({
    redactor,
    mode: "discovery",
    manifest: { goal: goal.instruction, capabilityId: goal.id, tenant: opts.tenant },
  });

  const policy = opts.policyPath ? new DefaultPolicyGate(loadPolicy(opts.policyPath)) : defaultPolicy();
  const llm = opts.llm ?? OpenAILlmClient.fromEnv(opts.model ?? defaultModel());
  const surface = await PlaywrightWebSurface.launch({
    headless: !opts.headed,
    actionTimeoutMs: 20_000,
  });

  try {
    const result = await discover({
      goal,
      surface,
      llm,
      policy,
      inputs: opts.inputs,
      secrets,
      baseUrl,
      routePrefix,
      evidence,
      redactor,
      grants,
      invocationId,
      model: opts.model,
      stop: {
        ...(opts.maxSteps !== undefined ? { maxSteps: opts.maxSteps } : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      },
    });

    let artifact: CapabilityArtifact | undefined;
    let artifactPath: string | undefined;
    if (result.status === "done") {
      artifact = compileTrace(result.trace, { recordedOnTenant: opts.tenant ?? "a" });
      artifactPath = opts.out ?? `capabilities/${artifact.id}.discovered.json`;
      saveArtifact(artifact, artifactPath);
      evidence.append({
        actor: "system",
        type: "artifact_written",
        payload: redactor.redact({ path: artifactPath, id: artifact.id, contentHash: artifact.contentHash ?? null }),
      });
    }

    await evidence.close({
      status: result.status,
      capabilityId: artifact?.id ?? goal.id,
      capabilityVersion: artifact?.version,
      tenant: opts.tenant,
    });

    return {
      status: result.status,
      stop: result.stop,
      runId: result.runId,
      artifactPath,
      artifactId: artifact?.id,
      steps: result.trace.steps.length,
      model: result.model,
      evidenceDir: evidence.dir,
    };
  } finally {
    await surface.close();
    await owned?.close();
  }
}
