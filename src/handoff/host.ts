import type { CapabilityArtifact, Step } from "../artifact/schema.js";
import type { EvidenceSink } from "../evidence/types.js";
import type { PolicyGate } from "../policy/types.js";
import { Redactor } from "../policy/redact.js";
import type { EscalateDecision, EscalateInfo } from "../replay/engine.js";
import { type EvalContext } from "../replay/conditions.js";
import { PlaywrightWebSurface } from "../surface/playwright-web.js";
import type { Observation, Surface } from "../surface/types.js";
import { SessionController } from "./controller.js";
import { startOperatorConsole, type OperatorConsole } from "./console.js";
import { HumanActionRecorder, focusLiveSession } from "./recorder.js";
import { findResumeStep } from "./resume.js";
import { ControlState, type InterventionReason, type NewIntervention } from "./types.js";

export interface HandoffHostOptions {
  runId: string;
  source: "discovery" | "replay";
  surface: Surface;
  artifact: CapabilityArtifact;
  evidence?: EvidenceSink;
  policy?: PolicyGate;
  redactor?: Redactor;
  invocationId: string;
  host?: string;
  port?: number;
  inputs?: Record<string, unknown>;
  secrets?: Record<string, string>;
}

export interface HandoffHost {
  controller: SessionController;
  console: OperatorConsole;
  escalate(info: EscalateInfo): Promise<EscalateDecision>;
  close(): Promise<void>;
}

export function reasonFromEscalate(info: EscalateInfo): InterventionReason {
  if (info.policy?.verdict === "escalate" && info.policy.requiredGrant === "approve_irreversible") {
    return "irreversible_step_requires_approval";
  }
  if (info.policy) return "policy_escalation";
  if (info.screenStateId) return "artifact_escalate_handler";
  if (info.reason.includes("recovery")) return "recovery_exhausted";
  return "unknown_screen_state";
}

export async function startHandoffHost(opts: HandoffHostOptions): Promise<HandoffHost> {
  const controller = new SessionController({
    runId: opts.runId,
    source: opts.source,
    automation: opts.source === "discovery" ? "agent" : "replay",
    evidence: opts.evidence,
  });
  const console = await startOperatorConsole({
    controller,
    host: opts.host,
    port: opts.port,
  });
  const page = opts.surface instanceof PlaywrightWebSurface ? opts.surface.page : undefined;
  const recorder = page
    ? new HumanActionRecorder({
        page,
        evidence: opts.evidence,
        redactor: opts.redactor ?? Redactor.forRun(opts.artifact, { inputs: opts.inputs, secrets: opts.secrets }),
        policy: opts.policy,
        invocationId: opts.invocationId,
        capabilityId: opts.artifact.id,
      })
    : undefined;

  const unsub = controller.onChange(() => {
    if (!recorder) return;
    if (controller.state === ControlState.HUMAN && !recorder.isRunning) {
      void (async () => {
        if (page) await focusLiveSession(page);
        await recorder.start();
      })();
    }
    if (controller.state !== ControlState.HUMAN && recorder.isRunning) recorder.stop();
  });

  return {
    controller,
    console,
    async escalate(info: EscalateInfo): Promise<EscalateDecision> {
      const step = info.stepId ? opts.artifact.steps.find((s) => s.id === info.stepId) : undefined;
      const url = await opts.surface.currentUrl().catch(() => "");
      const screenshotPath = await captureScreenshot(opts);
      const iv = controller.requestIntervention(toIntervention(opts, info, step, url, screenshotPath));
      process.stderr.write(
        `Intervention ${iv.id} opened (${iv.reason}). Operator console: ${console.url}\n`,
      );
      const resolved = await controller.waitForResolution(iv.id);
      const outcome = resolved.resolution?.outcome;
      if (outcome === "aborted" || controller.state === ControlState.ABORTED) return "abort";
      if (outcome === "approved") {
        controller.markResumed();
        return "resume";
      }

      const obs = await opts.surface.observe();
      const match = await findResumeStep({
        steps: opts.artifact.steps,
        ctx: evalCtx(opts, obs),
        fromStepId: info.stepId ?? undefined,
      });
      if (!match) {
        if (controller.state === ControlState.RESUMING) controller.markResumed();
        return {
          action: "fail",
          expected: "a step whose preconditions match the screen after handoff",
          observed: `url=${obs.url} title=${obs.title}`,
        };
      }
      if (controller.state === ControlState.RESUMING) controller.markResumed();
      return { action: "resume_from", stepId: match.stepId };
    },
    async close() {
      unsub();
      recorder?.stop();
      if (controller.state === ControlState.AGENT) controller.complete();
      else if (controller.state !== ControlState.ABORTED && controller.state !== ControlState.COMPLETED) {
        controller.abort(undefined, "system", "handoff host closed");
      }
      await console.close();
    },
  };
}

function toIntervention(
  opts: HandoffHostOptions,
  info: EscalateInfo,
  step: Step | undefined,
  url: string,
  screenshotPath?: string,
): NewIntervention {
  return {
    capabilityId: opts.artifact.id,
    stepId: info.stepId ?? undefined,
    stepIntent: step?.intent,
    reason: reasonFromEscalate(info),
    message: info.reason,
    screenStateId: info.screenStateId,
    url,
    screenshotPath,
  };
}

async function captureScreenshot(opts: HandoffHostOptions): Promise<string | undefined> {
  if (!opts.evidence) return undefined;
  try {
    const maskValues = [
      ...Object.values(opts.secrets ?? {}),
      ...Object.values(opts.inputs ?? {}).filter((v): v is string => typeof v === "string"),
    ].filter((v) => v.length > 0);
    const buf = await opts.surface.screenshot({ maskValues });
    return opts.evidence.attach("handoff.png", buf);
  } catch {
    return undefined;
  }
}

function evalCtx(opts: HandoffHostOptions, observation: Observation): EvalContext {
  const templateValues: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.inputs ?? {})) {
    if (v !== undefined && v !== null) templateValues[k] = String(v);
  }
  return {
    surface: opts.surface,
    observation,
    templateValues,
    resolveValue: (ref) => {
      if (ref.kind === "literal") return ref.value;
      if (ref.kind === "input") return String(opts.inputs?.[ref.name] ?? "");
      return opts.secrets?.[ref.name] ?? "";
    },
  };
}
