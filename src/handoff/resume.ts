import type { Condition } from "../artifact/schema.js";
import { evalCondition, type EvalContext } from "../replay/conditions.js";
import type { ResumeMatch } from "./types.js";

export interface ResumeStep {
  id: string;
  preconditions: Condition[];
  postcondition?: Condition;
}

export async function preconditionsHold(step: ResumeStep, ctx: EvalContext): Promise<boolean> {
  for (const pre of step.preconditions) {
    if (!(await evalCondition(pre, ctx))) return false;
  }
  return true;
}

async function alreadyDone(step: ResumeStep, ctx: EvalContext): Promise<boolean> {
  if (!step.postcondition) return false;
  return evalCondition(step.postcondition, ctx);
}

/**
 * After a human hands the session back, pick the first incomplete step whose
 * preconditions match the current screen.
 *
 * Walks forward from `fromStepId` first (the step that escalated). Steps whose
 * postcondition already holds are skipped. A wrap-around to earlier steps is
 * allowed only when those steps have real preconditions — empty preconditions
 * must not yank the run back to an unconstrained navigate/extract on a
 * different screen (e.g. login after session expiry is matched by URL, not by
 * an empty precondition list).
 */
export async function findResumeStep(opts: {
  steps: readonly ResumeStep[];
  ctx: EvalContext;
  fromStepId?: string;
}): Promise<ResumeMatch | null> {
  const steps = opts.steps;
  if (steps.length === 0) return null;
  const fromIndex = opts.fromStepId ? steps.findIndex((s) => s.id === opts.fromStepId) : 0;
  const start = fromIndex >= 0 ? fromIndex : 0;
  const skipped: string[] = [];

  for (let i = start; i < steps.length; i++) {
    const step = steps[i]!;
    if (!(await preconditionsHold(step, opts.ctx))) continue;
    if (await alreadyDone(step, opts.ctx)) {
      skipped.push(step.id);
      continue;
    }
    return { stepId: step.id, index: i, skippedStepIds: skipped };
  }

  for (let i = 0; i < start; i++) {
    const step = steps[i]!;
    if (step.preconditions.length === 0) continue;
    if (!(await preconditionsHold(step, opts.ctx))) continue;
    if (await alreadyDone(step, opts.ctx)) {
      skipped.push(step.id);
      continue;
    }
    return { stepId: step.id, index: i, skippedStepIds: skipped };
  }

  return null;
}
