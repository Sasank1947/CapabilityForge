import { z } from "zod";
import { ContentHash, FailureKind, type LocatorStrategyKind } from "../artifact/schema.js";

export { FailureKind };

const LOCATOR_KINDS = ["role", "label", "text", "structural", "css", "xpath", "visual"] as const satisfies readonly LocatorStrategyKind[];

/** Which locator strategy resolved a step's target. A hit at index > 0 is a drift signal. */
export const StrategyHit = z.object({
  stepId: z.string(),
  strategyIndex: z.number().int().nonnegative(),
  strategyKind: z.enum(LOCATOR_KINDS),
  fallback: z.boolean(),
  /** Match counts for each strategy tried before (and including) the hit. */
  attempts: z.array(z.object({ strategyIndex: z.number().int(), strategyKind: z.enum(LOCATOR_KINDS), matches: z.number().int() })),
  /** Set when an overlay-prepended strategy hit; indices then refer to the merged list. */
  fromOverlay: z.boolean().default(false),
});
export type StrategyHit = z.infer<typeof StrategyHit>;

export const RecoveryRecord = z.object({
  screenStateId: z.string(),
  duringStepId: z.string(),
  attempt: z.number().int().min(1),
  resume: z.enum(["retryStep", "restartFrom"]),
  resumedAtStepId: z.string().optional(),
  ok: z.boolean(),
  at: z.string().datetime({ offset: true }),
  note: z.string().optional(),
});
export type RecoveryRecord = z.infer<typeof RecoveryRecord>;

const ResultBase = z.object({
  runId: z.string(),
  capabilityId: z.string(),
  capabilityVersion: z.string(),
  contentHash: ContentHash.optional(),
  tenant: z.string().optional(),
  startedAt: z.string().datetime({ offset: true }),
  finishedAt: z.string().datetime({ offset: true }),
  durationMs: z.number().nonnegative(),
  /** Recovered conditions, reported even on success. */
  recoveries: z.array(RecoveryRecord).default([]),
  strategyHits: z.array(StrategyHit).default([]),
  evidenceDir: z.string().optional(),
});

const OutputValues = z.record(z.union([z.string(), z.number(), z.boolean(), z.null()]));

export const SuccessResult = ResultBase.extend({
  status: z.literal("success"),
  outputs: OutputValues,
});

export const BusinessOutcomeResult = ResultBase.extend({
  status: z.literal("business_outcome"),
  code: z.string(),
  message: z.string(),
  screenStateId: z.string(),
  stepId: z.string(),
  outputs: OutputValues.default({}),
});

export const FailureResult = ResultBase.extend({
  status: z.literal("failure"),
  kind: FailureKind,
  /** Null when the failure happened before any step ran (e.g. invalid input). */
  stepId: z.string().nullable(),
  message: z.string(),
  expected: z.string(),
  observed: z.string(),
  screenStateId: z.string().optional(),
  url: z.string().optional(),
  evidencePaths: z.array(z.string()).default([]),
});

export const EscalatedResult = ResultBase.extend({
  status: z.literal("escalated"),
  interventionId: z.string(),
  reason: z.string(),
  stepId: z.string().nullable(),
});

export const ReplayResult = z.discriminatedUnion("status", [
  SuccessResult,
  BusinessOutcomeResult,
  FailureResult,
  EscalatedResult,
]);

export type SuccessResult = z.infer<typeof SuccessResult>;
export type BusinessOutcomeResult = z.infer<typeof BusinessOutcomeResult>;
export type FailureResult = z.infer<typeof FailureResult>;
export type EscalatedResult = z.infer<typeof EscalatedResult>;
export type ReplayResult = z.infer<typeof ReplayResult>;
export type ReplayStatus = ReplayResult["status"];

export interface DriftReport {
  stepsResolved: number;
  fallbackSteps: { stepId: string; strategyIndex: number; strategyKind: LocatorStrategyKind }[];
  driftScore: number;
}

export function driftReport(hits: StrategyHit[]): DriftReport {
  const fallbackSteps = hits
    .filter((h) => h.fallback)
    .map((h) => ({ stepId: h.stepId, strategyIndex: h.strategyIndex, strategyKind: h.strategyKind }));
  return {
    stepsResolved: hits.length,
    fallbackSteps,
    driftScore: hits.length === 0 ? 0 : fallbackSteps.length / hits.length,
  };
}
