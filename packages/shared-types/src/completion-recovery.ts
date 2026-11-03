import { z } from "zod";

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

/** A strategy proposal, never an effect result, replay permission or new Job snapshot. */
export const CompletionRecoveryDecision = z.object({
  recovery_ref: z.string().uuid(),
  target_job_id: z.string().uuid(),
  target_attempt_id: z.string().uuid(),
  expected_recovery_revision: revision,
  expected_evidence_sha256: sha256,
  action: z.enum(["reconcile_effects", "stop"]),
  reason: z.string().trim().min(1).max(500).regex(/\S/u),
}).strict();
export type CompletionRecoveryDecision = z.infer<typeof CompletionRecoveryDecision>;

/** Frozen by the Scheduler in a directed Hub trigger, and backed by its durable wake. */
export const CompletionRecoveryGrant = z.object({
  recovery_ref: z.string().uuid(),
  target_job_id: z.string().uuid(),
  target_attempt_id: z.string().uuid(),
  project_id: z.string().uuid(),
  canvas_id: z.string().min(1).max(240),
  snapshot_sha256: sha256,
  recovery_revision: revision,
  evidence_sha256: sha256,
}).strict();
export type CompletionRecoveryGrant = z.infer<typeof CompletionRecoveryGrant>;

export const CompletionRecoveryProjection = z.object({
  v: z.literal(1),
  recovery_ref: z.string().uuid(),
  target_job_id: z.string().uuid(),
  target_attempt_id: z.string().uuid(),
  recovery_revision: revision,
  evidence_sha256: sha256,
  status: z.enum(["needed", "awaiting_completion", "completion_accepted", "stop_requested", "closed"]),
  code: z.string().min(1).max(120),
  receipt_ref: z.string().uuid(),
  first_observed_at: z.string().datetime(),
  deadline: z.string().datetime(),
  wake_limit: z.number().int().min(1).max(100),
  wakes_used: z.number().int().min(0),
  blocking: z.object({ unknown: z.number().int().min(0), pending: z.number().int().min(0) }).strict(),
  effects: z.array(z.object({
    effect_ref: z.string().uuid(),
    effect_kind: z.string().min(1).max(80),
    status: z.enum(["unknown", "effect_pending"]),
  }).strict()).max(8),
  truncated: z.boolean(),
  remaining: z.number().int().min(0),
}).strict();
export type CompletionRecoveryProjection = z.infer<typeof CompletionRecoveryProjection>;

/** Explicit whitelist: corrupt/oversized projections fail closed, raw effect JSON never escapes. */
export function projectCompletionRecovery(value: unknown): CompletionRecoveryProjection | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of ["v", "recovery_ref", "target_job_id", "target_attempt_id", "recovery_revision", "evidence_sha256",
    "status", "code", "receipt_ref", "first_observed_at", "deadline", "wake_limit", "wakes_used", "truncated", "remaining"] as const) output[key] = raw[key];
  const blocking = raw.blocking as Record<string, unknown> | undefined;
  output.blocking = { unknown: blocking?.unknown, pending: blocking?.pending };
  if (!Array.isArray(raw.effects) || raw.effects.length > 8) return undefined;
  output.effects = raw.effects.map(value => {
    const effect = value as Record<string, unknown> | null;
    return { effect_ref: effect?.effect_ref, effect_kind: effect?.effect_kind, status: effect?.status };
  });
  const parsed = CompletionRecoveryProjection.safeParse(output);
  return parsed.success ? parsed.data : undefined;
}
