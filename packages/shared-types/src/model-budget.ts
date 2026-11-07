import { z } from "zod";

/** Provider declarations are metadata, not measured upstream capacity. */
const DeclaredLimitField = z.object({
  field: z.enum(["context_length", "context_window", "contextWindow", "max_output_tokens", "maxTokens"]).nullable(),
  status: z.enum(["declared", "missing", "invalid"]),
}).strict();

export const ModelLimitSource = z.object({
  trust: z.literal("provider_declared"),
  endpoint: z.literal("models_endpoint"),
  context_window: DeclaredLimitField,
  max_output_tokens: DeclaredLimitField,
}).strict();
export type ModelLimitSource = z.infer<typeof ModelLimitSource>;

const BudgetSource = z.enum(["job", "role_config", "credential_settings", "provider_declared", "cli_default"]);
function budgetField(minimum: number) {
  const tokens = z.number().int().min(minimum).max(10_000_000).nullable();
  return z.object({
    configured: tokens,
    declared: tokens,
    effective: tokens,
    source: BudgetSource,
  }).strict().superRefine((field, ctx) => {
    const expected = field.source === "cli_default" ? null
      : field.source === "provider_declared" ? field.declared : field.configured;
    if (field.effective !== expected || (field.source !== "cli_default" && expected === null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "budget source must match effective tokens" });
    }
  });
}

/** Creation-time client budget; null effective means the CLI default is unknown. */
export const ModelTokenBudget = z.object({
  context_window_tokens: budgetField(1024),
  max_output_tokens: budgetField(1),
  catalog_revision: z.string().trim().min(1).max(120).nullable(),
}).strict();
export type ModelTokenBudget = z.infer<typeof ModelTokenBudget>;
