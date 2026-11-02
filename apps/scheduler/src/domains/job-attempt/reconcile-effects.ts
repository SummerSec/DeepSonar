// Effect reconciliation for platform upgrades (#845 defect 3).
//
// The upgrade gate blocks on `job_attempt_effects.status IN ('effect_pending','unknown')`.
// Those rows are produced by the kernel itself: a failed / cancelled / orphaned attempt
// leaves its concurrent effects `unknown`, so the set grows with every failed Job and a
// cross-schema upgrade eventually becomes impossible without hand-written SQL.
//
// This module owns the evidence rules ONLY. It answers one question per effect: is the
// real-world outcome provable from platform records?
//
//   - provable  -> an automatic settlement (applied / not applied), written by the caller
//                  in one idempotent transaction with audit fields;
//   - not provable -> keep `unknown` and report exactly which evidence is missing, so a
//                  human sees a handful of undecided rows instead of 400.
//
// Nothing here decides that an unknown effect "probably" happened. Approving the upgrade
// plan hash is not a per-effect decision: the unknown set changes between plan and apply.

export const RECONCILE_INPUT_SCHEMA = "deepsonar.effect-reconcile/v1";
export const RECONCILE_RESULT_SCHEMA = "deepsonar.effect-reconcile-result/v1";

/** Attempt statuses that prove the attempt will never write anything again. */
export const TERMINAL_ATTEMPT_STATUSES = ["succeeded", "failed", "cancelled", "timeout", "orphan"] as const;

export interface EffectEvidence {
  readonly id: string;
  readonly effectKind: string;
  /** `job_attempts.status` of the owning attempt. */
  readonly attemptStatus: string | null;
  /** `jobs.sandbox_id` (or the attempt's own sandbox id). */
  readonly sandboxId: string | null;
  /** `job_usage_ledger` rows attributed to this attempt/effect. */
  readonly usageRows: number;
  /** Id of the canvas node delivered by this effect, when the platform recorded one. */
  readonly canvasNodeId: string | null;
}

export type EffectSettlement =
  | { readonly outcome: "applied_run_terminated"; readonly attempt_status: string }
  | { readonly outcome: "applied_with_usage"; readonly usage_rows: number }
  | { readonly outcome: "applied_resource_absent" }
  | { readonly outcome: "not_applied" }
  | { readonly outcome: "delivered"; readonly canvas_node_id: string };

export type EffectClassification =
  | { readonly decision: "auto"; readonly rule: string; readonly settlement: EffectSettlement }
  | { readonly decision: "undecided"; readonly rule: string; readonly missing: readonly string[] };

const isTerminal = (status: string | null): boolean =>
  typeof status === "string" && (TERMINAL_ATTEMPT_STATUSES as readonly string[]).includes(status);

const hasText = (value: string | null): boolean => typeof value === "string" && value.trim().length > 0;

/**
 * Classify one unknown effect from platform evidence.
 *
 * Rules are deliberately per-effect-kind: a generic "attempt is terminal, so settle it"
 * rule would mark a `gateway_model_request` as applied without proof that the provider
 * was actually charged.
 */
export function classifyEffect(effect: EffectEvidence): EffectClassification {
  switch (effect.effectKind) {
    case "agent_run":
      return isTerminal(effect.attemptStatus)
        ? { decision: "auto", rule: "attempt_terminal", settlement: { outcome: "applied_run_terminated", attempt_status: effect.attemptStatus as string } }
        : { decision: "undecided", rule: "attempt_not_terminal", missing: ["terminal_attempt_status"] };
    case "gateway_model_request":
      return Number.isSafeInteger(effect.usageRows) && effect.usageRows > 0
        ? { decision: "auto", rule: "usage_ledger_recorded", settlement: { outcome: "applied_with_usage", usage_rows: effect.usageRows } }
        : { decision: "undecided", rule: "usage_ledger_missing", missing: ["job_usage_ledger_row"] };
    case "provision":
      // A recorded sandbox was created, so the effect reached the resource layer and the
      // resource is gone now; no sandbox id means it never got that far.
      return hasText(effect.sandboxId)
        ? { decision: "auto", rule: "sandbox_identity_recorded", settlement: { outcome: "applied_resource_absent" } }
        : { decision: "auto", rule: "sandbox_identity_absent", settlement: { outcome: "not_applied" } };
    case "canvas_delivery":
      return hasText(effect.canvasNodeId)
        ? { decision: "auto", rule: "canvas_node_present", settlement: { outcome: "delivered", canvas_node_id: effect.canvasNodeId as string } }
        : { decision: "undecided", rule: "canvas_node_missing", missing: ["canvas_node_row"] };
    default:
      return { decision: "undecided", rule: "unclassified_effect_kind", missing: [`evidence_rule_for:${effect.effectKind}`] };
  }
}

export interface ReconcileGroup {
  readonly effect_kind: string;
  readonly rule: string;
  readonly outcome: string;
  readonly count: number;
}

export interface ReconcileUndecided {
  readonly effect_id: string;
  readonly effect_kind: string;
  readonly missing: readonly string[];
}

export interface ReconcileSummary {
  readonly unknown_total: number;
  readonly auto_count: number;
  readonly undecided_count: number;
  readonly groups: readonly ReconcileGroup[];
  readonly undecided: readonly ReconcileUndecided[];
}

/**
 * Group a scan result so a human reads a few lines instead of hundreds of rows.
 * Only genuinely undecided effects are listed individually, each with the evidence it
 * lacks; automatic ones are aggregated by rule and outcome.
 */
export function summarizeEvidence(effects: readonly EffectEvidence[]): ReconcileSummary {
  const counts = new Map<string, ReconcileGroup>();
  const undecided: ReconcileUndecided[] = [];
  let auto = 0;
  for (const effect of effects) {
    const classification = classifyEffect(effect);
    if (classification.decision === "undecided") {
      undecided.push({ effect_id: effect.id, effect_kind: effect.effectKind, missing: classification.missing });
      continue;
    }
    auto += 1;
    const key = `${effect.effectKind}\u0000${classification.rule}\u0000${classification.settlement.outcome}`;
    const existing = counts.get(key);
    if (existing) counts.set(key, { ...existing, count: existing.count + 1 });
    else counts.set(key, { effect_kind: effect.effectKind, rule: classification.rule, outcome: classification.settlement.outcome, count: 1 });
  }
  return {
    unknown_total: effects.length,
    auto_count: auto,
    undecided_count: undecided.length,
    groups: [...counts.values()].sort((a, b) => a.effect_kind.localeCompare(b.effect_kind) || a.rule.localeCompare(b.rule)),
    undecided,
  };
}

/**
 * Idempotent settlement statement input for one auto-classified effect: the caller writes
 * these inside a transaction that also records the reconcile operation id for audit, and
 * only while the row is still `unknown` or `effect_pending` - a concurrent kernel
 * settlement always wins.
 */
export function settlementWrite(effect: EffectEvidence, settlement: EffectSettlement, operationId: string) {
  return {
    id: effect.id,
    effect_kind: effect.effectKind,
    settlement: {
      ...settlement,
      reconciled_by: "reconcile-effects",
      reconcile_operation_id: operationId,
    },
  };
}