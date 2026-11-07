import { ModelTokenBudget, type ModelDescriptor, type ModelTokenBudget as Budget } from "@deepsonar/shared-types";
import { resolveModelDescriptorCatalog } from "./descriptors.js";

function configuredLimit(value: unknown, minimum: number, field: string): number | null {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > 10_000_000) {
    throw new Error(`${field} must be a safe integer in ${minimum}..10000000, or null`);
  }
  return value;
}

/** Only the selected credential's observed model metadata can supply a declaration. */
export function resolveModelTokenBudget(input: {
  provider?: string | null;
  modelId?: string | null;
  catalogJson?: unknown;
  roleContextWindowTokens?: unknown;
  contextSource?: "job" | "role_config";
  credentialContextWindowTokens?: unknown;
  nativeContextWindow?: unknown;
  nativeMaxTokens?: unknown;
}): Budget {
  const catalog = input.provider ? resolveModelDescriptorCatalog({ provider: input.provider, catalogJson: input.catalogJson }) : [];
  const descriptor = catalog.find((row) => row.model_id === input.modelId);
  const declared = (key: "context_window" | "max_output_tokens"): number | null => {
    if (descriptor?.limit_source?.trust !== "provider_declared" || descriptor.limit_source[key].status !== "declared") return null;
    return descriptor[key];
  };
  // Validate every explicit input even when a higher-priority value shadows it.
  const role = configuredLimit(input.roleContextWindowTokens, 1024, "context_window_tokens");
  const credential = configuredLimit(input.credentialContextWindowTokens, 1024, "settings.context_window_tokens");
  if (input.nativeContextWindow === null || input.nativeMaxTokens === null) throw new Error("native model token limits cannot be null; omit unknown fields");
  const nativeContext = configuredLimit(input.nativeContextWindow, 1024, "model.contextWindow");
  const nativeOutput = configuredLimit(input.nativeMaxTokens, 1, "model.maxTokens");
  const contextConfigured = role ?? credential ?? nativeContext;
  const contextDeclared = declared("context_window"), outputDeclared = declared("max_output_tokens");
  const field = (configured: number | null, value: number | null, source: Budget["context_window_tokens"]["source"]) => ({
    configured, declared: value, effective: configured ?? value,
    source: configured != null ? source : value != null ? "provider_declared" as const : "cli_default" as const,
  });
  return ModelTokenBudget.parse({
    context_window_tokens: field(contextConfigured, contextDeclared, role != null ? input.contextSource ?? "role_config" : "credential_settings"),
    max_output_tokens: field(nativeOutput, outputDeclared, "credential_settings"),
    catalog_revision: descriptor?.catalog_revision ?? null,
  });
}

/** Selection is still restricted to configured ids; discovery never grants models. */
export function descriptorsWithClientBudgets(input: {
  descriptors: ModelDescriptor[];
  budgetForModel: (modelId: string) => Budget;
}): ModelDescriptor[] {
  return input.descriptors.map((descriptor) => {
    const budget = input.budgetForModel(descriptor.model_id);
    return { ...descriptor, context_window: budget.context_window_tokens.effective, max_output_tokens: budget.max_output_tokens.effective };
  });
}
