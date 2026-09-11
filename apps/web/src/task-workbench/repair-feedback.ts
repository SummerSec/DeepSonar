/**
 * Frontend RepairFeedback projection (#449 / #446).
 * Backend durable RepairFeedback is not shipped yet; classify the data we already have.
 */

export const REPAIR_CATEGORIES = [
  "model_correctable",
  "transient_retryable",
  "unknown_external_effect",
  "permanent_failure",
] as const;

export type RepairCategory = (typeof REPAIR_CATEGORIES)[number];

export interface RepairFeedback {
  category: RepairCategory;
  stage: string | null;
  field_path: string | null;
  expected: string | null;
  observed: string | null;
  accepted_effects: string[];
  alternatives: string[];
  remaining_budget: string | null;
  next_step: string;
  source_error: string | null;
}

export const REPAIR_CATEGORY_META: Record<
  RepairCategory,
  { label: string; tone: string; confirmRequired: boolean; allowUnconditionalRetry: boolean }
> = {
  model_correctable: {
    label: "可交回模型修复",
    tone: "#38bdf8",
    confirmRequired: false,
    allowUnconditionalRetry: false,
  },
  transient_retryable: {
    label: "可安全重试",
    tone: "#e8bd70",
    confirmRequired: false,
    allowUnconditionalRetry: true,
  },
  unknown_external_effect: {
    label: "需要确认",
    tone: "#e8bd70",
    confirmRequired: true,
    allowUnconditionalRetry: false,
  },
  permanent_failure: {
    label: "需人工处理",
    tone: "#ed6a7f",
    confirmRequired: true,
    allowUnconditionalRetry: false,
  },
};

const MODEL_CORRECTABLE = /invalid_payload|unknown_field|invalid_node_ref|invalid_role|invalid_done|invalid_human|invalid_verification|invalid_progress|invalid_reference|schema|SNAPSHOT_STALE|INVALID_TASK_INTENT/i;
const TRANSIENT = /timeout|orphan|econnreset|etimedout|429|502|503|504|temporar|retry|unreachable|rate_limited/i;
const FIELD_PATH = /(?:field|path|at)\s+[`'"]?([A-Za-z_][\w.[\]]*)|[A-Za-z_][\w]*\[[0-9]+\](?:\.[A-Za-z_][\w]*)+/;

export function parseErrorCode(error: string | null | undefined): { code: string | null; message: string } {
  const raw = typeof error === "string" ? error.trim() : "";
  if (!raw) return { code: null, message: "" };
  const match = /^([A-Z][A-Z0-9_]{2,})[:：]\s*(.*)$/s.exec(raw);
  if (match) return { code: match[1], message: match[2].trim() || raw };
  return { code: null, message: raw };
}

export function extractFieldPath(error: string | null | undefined): string | null {
  const text = typeof error === "string" ? error : "";
  const match = FIELD_PATH.exec(text);
  return match?.[1] ?? match?.[0] ?? null;
}

export function classifyRepairCategory(input: {
  status?: string | null;
  error?: string | null;
  hasUnknownEffects?: boolean;
  hasEffectLedger?: boolean;
}): RepairCategory {
  if (input.hasUnknownEffects) return "unknown_external_effect";
  const status = (input.status ?? "").trim().toLowerCase();
  const { code, message } = parseErrorCode(input.error);
  const haystack = `${code ?? ""} ${message}`;
  if (MODEL_CORRECTABLE.test(haystack) || MODEL_CORRECTABLE.test(code ?? "")) return "model_correctable";
  const looksTransient = status === "timeout" || status === "orphan" || TRANSIENT.test(haystack);
  if (looksTransient) {
    return input.hasEffectLedger ? "transient_retryable" : "unknown_external_effect";
  }
  return "permanent_failure";
}

export function projectRepairFeedback(input: {
  status?: string | null;
  error?: string | null;
  stage?: string | null;
  unknownEffects?: readonly { effect_kind?: string; effect_id?: string; status?: string }[];
  acceptedEffects?: readonly { effect_kind?: string; effect_id?: string; status?: string }[];
  remainingBudget?: string | null;
  hasEffectLedger?: boolean;
}): RepairFeedback {
  const unknownEffects = input.unknownEffects ?? [];
  const hasUnknownEffects = unknownEffects.length > 0;
  const category = classifyRepairCategory({
    status: input.status,
    error: input.error,
    hasUnknownEffects,
    hasEffectLedger: input.hasEffectLedger,
  });
  const { code, message } = parseErrorCode(input.error);
  const observed = message || (hasUnknownEffects
    ? unknownEffects.map((effect) => `${effect.effect_kind ?? "effect"} · ${effect.status ?? "unknown"}`).join("；")
    : null);
  const accepted = (input.acceptedEffects ?? [])
    .filter((effect) => effect.status === "settled")
    .map((effect) => effect.effect_kind || effect.effect_id || "已接受效果");
  return {
    category,
    stage: input.stage ?? (input.status ? `job.${input.status}` : null),
    field_path: extractFieldPath(input.error),
    expected: expectedShape(category, code),
    observed: observed || null,
    accepted_effects: accepted,
    alternatives: alternativesFor(category),
    remaining_budget: input.remainingBudget ?? null,
    next_step: nextStepFor(category),
    source_error: input.error ?? null,
  };
}

export function repairAllowsUnconditionalRetry(feedback: RepairFeedback | null | undefined): boolean {
  return Boolean(feedback && REPAIR_CATEGORY_META[feedback.category].allowUnconditionalRetry);
}

function expectedShape(category: RepairCategory, code: string | null): string | null {
  if (category === "model_correctable") {
    return code ? `符合 ${code} 对应契约的输入` : "符合当前控制契约的结构化输入";
  }
  if (category === "unknown_external_effect") return "外部效果已确认或已显式忽略";
  return null;
}

function alternativesFor(category: RepairCategory): string[] {
  switch (category) {
    case "model_correctable":
      return ["把字段路径与期望形状发回同一会话", "按当前配置重冻后再提交"];
    case "transient_retryable":
      return ["使用同一 Job 安全重试", "等待瞬时故障恢复后再试"];
    case "unknown_external_effect":
      return ["先确认外部效果", "确认后再决定是否继续"];
    case "permanent_failure":
      return ["转人工判断", "补充要求后另开一轮"];
  }
}

function nextStepFor(category: RepairCategory): string {
  switch (category) {
    case "model_correctable":
      return "把出错字段、期望形状和当前观测发回模型，不要无上下文重放。";
    case "transient_retryable":
      return "可以按同一会话安全重试；次数用尽后再转人工。";
    case "unknown_external_effect":
      return "先确认未决外部效果。未确认前不能当作普通失败，也不能无条件重试。";
    case "permanent_failure":
      return "需要人工判断原因和影响，再决定是否换配置重跑。";
  }
}
