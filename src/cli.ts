import "dotenv/config";
import { Command } from "commander";
import { startCoreLink, type CoreLinkHandle } from "../apps/corelink/server.js";
import { runDiscoveryCommand } from "./agent/run.js";
import { applyOverlay, loadOverlay } from "./artifact/overlay.js";
import { artifactJsonSchema, tenantOverlayJsonSchema } from "./artifact/schema.js";
import { listArtifacts, loadArtifact, resolveArtifactPath } from "./artifact/store.js";
import { serveMcpStdio } from "./catalog/server.js";
import type { EvidenceSink, NewRunEvent, RedactedPayload, RunEvent, RunManifest } from "./evidence/types.js";
import { SessionController, startHandoffHost, startOperatorConsole, LeasedSurface } from "./handoff/index.js";
import type { Grant, PolicyDecision, PolicyGate, PolicyRequest } from "./policy/types.js";
import { replay } from "./replay/engine.js";
import { PlaywrightWebSurface } from "./surface/playwright-web.js";

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

function parseKv(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const i = pair.indexOf("=");
    if (i < 0) throw new Error(`expected name=value, got '${pair}'`);
    out[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return out;
}

/** CLI-local allow-all gate. Irreversible steps still require `--approve irreversible`. */
function cliPolicy(): PolicyGate {
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
            reason: "irreversible step requires --approve irreversible",
            requiredGrant: "approve_irreversible",
          };
        }
        return { verdict: "allow", ruleId: "grant", reason: "irreversible grant present", grant };
      }
      return { verdict: "allow", ruleId: "action_allowlist", reason: "cli default allow" };
    },
  };
}

class CliEvidence implements EvidenceSink {
  readonly runId: string;
  readonly dir: string;
  private seq = 0;
  constructor(runId: string) {
    this.runId = runId;
    this.dir = `cli://${runId}`;
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

function buildProgram(): Command {
  const program = new Command();
  program
    .name("forge")
    .description("CapabilityForge: discover UI flows with an LLM, compile them into capability artifacts, replay them deterministically.")
    .version("0.1.0");

  program
    .command("app")
    .description("Serve the CoreLink Teller mock app (hostile legacy core-banking UI)")
    .option("-p, --port <n>", "listen port", "4100")
    .option("-t, --tenant <id>", "tenant a (CoreLink) or b (MeridianCU)", "a")
    .option("--seed <n>", "synthetic data seed", "1")
    .action(async (opts: { port: string; tenant: string; seed: string }) => {
      const tenant = opts.tenant === "b" ? "b" : "a";
      const handle = await startCoreLink({ port: Number(opts.port), tenant, seed: Number(opts.seed) });
      console.log(`CoreLink mock (tenant ${handle.tenant}) listening at ${handle.url}`);
      const stop = () => {
        void handle.close().then(() => process.exit(0));
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      await new Promise(() => undefined);
    });

  program
    .command("discover")
    .description("Run the LLM discovery agent on a goal and compile the run into a capability artifact")
    .option("--preset <name>", "built-in goal (lookup-balance)")
    .option("--goal <text>", "natural-language goal (overrides preset instruction)")
    .option("--id <id>", "capability id, e.g. corelink.lookup_member_balance")
    .option("--title <title>", "artifact title")
    .option("--description <text>", "artifact description")
    .option("-i, --input <kv>", "runtime input as name=value (repeatable)", collect, [])
    .option("--param <spec>", "declare input name:type:sensitivity[:description]", collect, [])
    .option("--output <spec>", "declare output name:type:sensitivity[:description]", collect, [])
    .option("--out <path>", "write compiled artifact JSON (default capabilities/<id>.discovered.json)")
    .option("--base-url <url>", "already-running CoreLink origin (starts an ephemeral app when omitted)")
    .option("--headed", "launch Chromium headed", false)
    .option("--approve-irreversible", "grant irreversible actions for this discovery run", false)
    .option("--secret <kv>", "secret as name=value (repeatable); defaults come from env:// refs", collect, [])
    .option("--tenant <id>", "recorded on the artifact")
    .option("--policy <path>", "policy JSON (default policies/corelink.json)")
    .option("--max-steps <n>", "stop after this many actions", "40")
    .option("--timeout-ms <n>", "wall-clock timeout", "180000")
    .option("--model <name>", "OpenAI model (default OPENAI_MODEL or gpt-4.1)")
    .option("--version <semver>", "artifact version", "0.1.0")
    .action(
      async (opts: {
        preset?: string;
        goal?: string;
        id?: string;
        title?: string;
        description?: string;
        input: string[];
        param: string[];
        output: string[];
        out?: string;
        baseUrl?: string;
        headed?: boolean;
        approveIrreversible?: boolean;
        secret: string[];
        tenant?: string;
        policy?: string;
        maxSteps: string;
        timeoutMs: string;
        model?: string;
        version?: string;
      }) => {
        try {
          const result = await runDiscoveryCommand({
            preset: opts.preset,
            goal: opts.goal,
            id: opts.id,
            title: opts.title,
            description: opts.description,
            inputs: parseKv(opts.input),
            params: opts.param,
            outputs: opts.output,
            out: opts.out,
            baseUrl: opts.baseUrl,
            headed: opts.headed,
            approveIrreversible: opts.approveIrreversible,
            secrets: parseKv(opts.secret),
            tenant: opts.tenant,
            policyPath: opts.policy,
            maxSteps: Number(opts.maxSteps),
            timeoutMs: Number(opts.timeoutMs),
            model: opts.model,
            version: opts.version,
          });
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
          if (result.status !== "done") process.exitCode = 1;
        } catch (err) {
          console.error(`forge discover: ${(err as Error).message}`);
          process.exitCode = 2;
        }
      },
    );

  program
    .command("replay")
    .description("Replay a capability artifact deterministically with input parameters")
    .argument("<artifact>", "path to a capability JSON file, or a capability id under capabilities/")
    .option("-i, --input <kv>", "input as name=value (repeatable)", collect, [])
    .option("--base-url <url>", "already-running CoreLink origin (starts an ephemeral app when omitted)")
    .option("--headed", "launch Chromium headed (for handoff / debugging)", false)
    .option("--operator", "start the operator console and wait on escalation", false)
    .option("--operator-port <n>", "operator console port", "4200")
    .option("--approve-irreversible", "grant irreversible steps for this invocation", false)
    .option("--fault <spec>", "inject X-Fault on every request (e.g. slow_load:2000)")
    .option("--secret <kv>", "secret as name=value (repeatable); defaults come from env:// refs", collect, [])
    .option("--tenant <id>", "recorded on the result")
    .option("--overlay <path>", "tenant overlay JSON to apply before replay")
    .action(
      async (artifactSpec: string, opts: { input: string[]; baseUrl?: string; headed?: boolean; operator?: boolean; operatorPort?: string; approveIrreversible?: boolean; fault?: string; secret: string[]; tenant?: string; overlay?: string }) => {
        const path = resolveArtifactPath(artifactSpec);
        let artifact = loadArtifact(path);
        if (opts.overlay) artifact = applyOverlay(artifact, loadOverlay(opts.overlay));
        const inputs = parseKv(opts.input);
        const secrets = parseKv(opts.secret);
        if (!secrets.username && process.env.CORELINK_USER) secrets.username = process.env.CORELINK_USER;
        if (!secrets.password && process.env.CORELINK_PASSWORD) secrets.password = process.env.CORELINK_PASSWORD;

        let owned: CoreLinkHandle | undefined;
        let baseUrl = opts.baseUrl;
        let routePrefix = "";
        if (!baseUrl) {
          owned = await startCoreLink({ port: 0, tenant: opts.tenant === "b" ? "b" : "a" });
          baseUrl = owned.origin;
          routePrefix = opts.overlay ? "" : owned.prefix;
        }

        const invocationId = `cli-${Date.now().toString(16)}`;
        const grants: Grant[] = [];
        if (opts.approveIrreversible) {
          grants.push({
            kind: "approve_irreversible",
            invocationId,
            capabilityId: artifact.id,
            grantedBy: "cli",
            grantedAt: new Date().toISOString(),
          });
        }

        const useOperator = Boolean(opts.operator || opts.headed);
        const surface = await PlaywrightWebSurface.launch({
          headless: !useOperator,
          extraHTTPHeaders: opts.fault ? { "X-Fault": opts.fault } : undefined,
          actionTimeoutMs: 20_000,
        });
        const evidence = new CliEvidence(invocationId);
        const policy = cliPolicy();
        const handoff = useOperator
          ? await startHandoffHost({
              runId: invocationId,
              source: "replay",
              surface,
              artifact,
              evidence,
              policy,
              invocationId,
              port: Number(opts.operatorPort ?? 4200),
              inputs,
              secrets,
            }).catch(() =>
              startHandoffHost({
                runId: invocationId,
                source: "replay",
                surface,
                artifact,
                evidence,
                policy,
                invocationId,
                port: 0,
                inputs,
                secrets,
              }),
            )
          : undefined;
        if (handoff) process.stderr.write(`Operator console: ${handoff.console.url}\n`);
        const gated = handoff ? new LeasedSurface(surface, handoff.controller, "replay") : surface;
        try {
          const result = await replay({
            artifact,
            surface: gated,
            policy,
            evidence,
            inputs,
            secrets,
            baseUrl,
            routePrefix,
            grants,
            invocationId,
            tenant: opts.tenant,
            onEscalate: handoff ? (info) => handoff.escalate(info) : async () => "abort",
          });
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
          if (result.status === "failure") process.exitCode = 1;
          if (result.status === "escalated") process.exitCode = 3;
        } finally {
          await handoff?.close();
          await surface.close();
          await owned?.close();
        }
      },
    );

  program
    .command("operator")
    .description("Start the operator console for human interventions")
    .option("-p, --port <n>", "listen port", "4200")
    .action(async (opts: { port: string }) => {
      const controller = new SessionController({
        runId: `operator-${Date.now().toString(16)}`,
        source: "replay",
      });
      const consoleHandle = await startOperatorConsole({ controller, port: Number(opts.port) });
      console.log(`Operator console listening at ${consoleHandle.url}`);
      console.log("A live replay attaches the same UI when you run: forge replay <artifact> --headed");
      console.log("Remote CDP/noVNC, operator auth, and a distributed audit trail are not built.");
      const stop = () => {
        void consoleHandle.close().then(() => process.exit(0));
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      await new Promise(() => undefined);
    });

  program
    .command("serve-mcp")
    .description("Expose approved capability artifacts as typed MCP tools")
    .option("--tenant <id>", "tenant a or b for invocations (auto-applies a matching overlay)")
    .option("--overlay <path>", "apply this overlay to the matching approved artifact")
    .action(async (opts: { tenant?: string; overlay?: string }) => {
      await serveMcpStdio({
        capabilitiesDir: "capabilities",
        overlaysDir: "capabilities/overlays",
        tenant: opts.tenant,
        overlayPath: opts.overlay,
      });
    });

  program
    .command("schema")
    .description("Print the JSON Schema of the capability artifact (or tenant overlay) format")
    .option("--overlay", "print the tenant overlay schema instead")
    .action((opts: { overlay?: boolean }) => {
      const schema = opts.overlay ? tenantOverlayJsonSchema() : artifactJsonSchema();
      process.stdout.write(`${JSON.stringify(schema, null, 2)}\n`);
    });

  program
    .command("capabilities")
    .description("List capability artifacts in ./capabilities")
    .action(() => {
      const listed = listArtifacts("capabilities");
      process.stdout.write(`${JSON.stringify(listed, null, 2)}\n`);
    });

  return program;
}

await buildProgram().parseAsync(process.argv);
