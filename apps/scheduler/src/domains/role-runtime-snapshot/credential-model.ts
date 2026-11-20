import { buildRepairFeedback } from "@deepsonar/shared-types";
import { extractModelsFromSettings, providerModelBudget } from "../../provider-settings.js";
import { ModelCatalogMismatchError } from "../../provider-effective-model.js";
import { resolveCredentialModelRef, type ResolvedProviderCredential } from "../provider-adapter/resolve-credential.js";
import { descriptorsWithClientBudgets, resolveModelTokenBudget } from "../provider-adapter/model-budget.js";
import { resolveModelDescriptorCatalog, selectModelsForRequirements } from "../provider-adapter/descriptors.js";
import { admitModelAgainstCatalog } from "../provider-adapter/model-catalog-admit.js";

/** Structured fail-closed when model is outside eligible catalog SSOT (#632). */
function throwModelCapabilityMismatch(selectedModel: string, eligibleModelIds: string[]): never {
  const admitted = admitModelAgainstCatalog({
    resolvedModel: selectedModel,
    catalogJson: eligibleModelIds.length > 0 ? eligibleModelIds : ["__empty_eligible__"],
    allowPassthrough: false,
    operation: "resolve_role_runtime_model_requirements",
    modelSourceHint: "hub",
    emphasizePassthrough: true,
  });
  if (!admitted.ok) {
    throw new ModelCatalogMismatchError(
      `模型 ${selectedModel} 不满足 Provider capability requirements / 不在账号已配置模型名单`,
      admitted.resolved,
      eligibleModelIds,
      {
        ...admitted.repair,
        message: `模型 ${selectedModel} 不满足 Provider capability requirements / 不在账号已配置模型名单`,
      },
      admitted.code,
    );
  }
  const repair = buildRepairFeedback({
    category: "model_correctable",
    code: "model_passthrough_disabled",
    operation: "resolve_role_runtime_model_requirements",
    path: "model_ref",
    message: `模型 ${selectedModel} 不满足 Provider capability requirements / 不在账号已配置模型名单`,
    expected: { kind: "catalog_model_id", sample: eligibleModelIds.slice(0, 12) },
    observed_shape: { resolved_model: selectedModel, eligible: false },
    next_action: "select_catalog_model_id_or_enable_emergency_passthrough",
  });
  throw new ModelCatalogMismatchError(repair.message, selectedModel, eligibleModelIds, repair, "model_passthrough_disabled");
}


/** Shared by candidate capacity evaluation and final snapshot materialization. */
export function selectCredentialSnapshotModel(input: {
  credential: ResolvedProviderCredential;
  modelRef?: string | null;
  explicitModelRef?: string | null;
  fallbackModelRefs?: readonly string[];
  modelRequirements?: Record<string, unknown> | null;
  allowPassthrough?: boolean;
  contextWindowTokens?: unknown;
  contextSource?: "job" | "role_config";
}): string | null {
  const { credential } = input;
  const agentCli = credential.agent_cli!;
  const settingsConfig = credential.settings_config_json;
  const requestedModelRef = input.explicitModelRef;
  let selectedModel = input.modelRef ?? null;
  // Selection/admit SSOT: account-configured model ids from settings_config_json (#656/#679).
  // Parse by credential agent_cli dialect so RoleConfig.model is checked against that shape.
  const credentialAgentCli = typeof credential.agent_cli === "string" && credential.agent_cli.trim()
    ? credential.agent_cli.trim()
    : agentCli;
  const configuredModelIds = extractModelsFromSettings(settingsConfig, credentialAgentCli);
  const resolvedSelection = selectedModel ? resolveCredentialModelRef(settingsConfig, agentCli, selectedModel) : null;
  const budgetInputs: { roleContextWindowTokens: unknown; contextSource: "job" | "role_config" } = {
    roleContextWindowTokens: input.contextWindowTokens,
    contextSource: input.contextSource ?? "role_config",
  };
  const catalog = descriptorsWithClientBudgets({
    descriptors: resolveModelDescriptorCatalog({
      provider: String(credential.provider ?? ""),
      catalogJson: configuredModelIds,
      catalogRevision: typeof credential.model_catalog_fetched_at === "string"
        ? credential.model_catalog_fetched_at
        : `credential:${String(credential.id)}`,
      compatibleAgentClis: agentCli === "claude-code" || agentCli === "pi" || agentCli === "dsh" ? [agentCli] : undefined,
    }),
    budgetForModel: (model) => model === resolvedSelection
      ? providerModelBudget({ agentCli, model: selectedModel, settingsConfig,
          credentialProvider: String(credential.provider), catalogJson: credential.model_catalog_json, ...budgetInputs })
      // An unselected bare id may exist on multiple Pi routes. Its observed
      // declarations can filter candidates, but must not choose a native route.
      : resolveModelTokenBudget({ provider: String(credential.provider), modelId: model,
          catalogJson: credential.model_catalog_json, ...budgetInputs,
          credentialContextWindowTokens: settingsConfig && typeof settingsConfig === "object"
            ? (settingsConfig as Record<string, unknown>).context_window_tokens : null }),
  });
  // #697: RoleConfig.allow_model_catalog_passthrough no longer authorizes; only
  // platform env + admin project Agent allowlist (#679 deviation 1 item 3).
  const allowPassthrough = input.allowPassthrough === true;
  const requirements = input.modelRequirements && typeof input.modelRequirements === "object"
    ? input.modelRequirements
    : null;
  const requirementsRecord = requirements ?? {};
  const normalizedRequirements = {
    agent_cli: agentCli === "claude-code" || agentCli === "pi" || agentCli === "dsh" ? agentCli : undefined,
    min_context_window: typeof requirementsRecord.min_context_window === "number"
      ? requirementsRecord.min_context_window
      : typeof requirementsRecord.context_window_tokens === "number" ? requirementsRecord.context_window_tokens : undefined,
    require_tools: requirementsRecord.require_tools === true || requirementsRecord.supports_tools === true ? true : undefined,
    require_streaming: requirementsRecord.require_streaming === true || requirementsRecord.supports_streaming === true ? true : undefined,
    require_structured_output: requirementsRecord.require_structured_output === true || requirementsRecord.supports_structured_output === true ? true : undefined,
    reasoning_effort: typeof requirementsRecord.reasoning_effort === "string" ? requirementsRecord.reasoning_effort : undefined,
    max_input_cost_per_1m_usd: typeof requirementsRecord.max_input_cost_per_1m_usd === "number"
      ? requirementsRecord.max_input_cost_per_1m_usd
      : typeof requirementsRecord.max_input_cost_per_million === "number" ? requirementsRecord.max_input_cost_per_million : undefined,
    max_output_cost_per_1m_usd: typeof requirementsRecord.max_output_cost_per_1m_usd === "number"
      ? requirementsRecord.max_output_cost_per_1m_usd
      : typeof requirementsRecord.max_output_cost_per_million === "number" ? requirementsRecord.max_output_cost_per_million : undefined,
    allow_unverified: requirementsRecord.allow_unverified === true,
    allow_passthrough: allowPassthrough || requirementsRecord.allow_passthrough === true,
  } as never;
  const eligible = selectModelsForRequirements(catalog, normalizedRequirements);
  const eligibleIds = new Set(eligible.map((row) => row.model_id));
  const isEligibleModelRef = (ref: string) => {
    const id = resolveCredentialModelRef(settingsConfig, agentCli, ref);
    const descriptor = catalog.find((row) => row.model_id === id);
    if (!descriptor) return false;
    const budget = providerModelBudget({ agentCli, model: ref, settingsConfig,
      credentialProvider: String(credential.provider), catalogJson: credential.model_catalog_json, ...budgetInputs });
    return selectModelsForRequirements(descriptorsWithClientBudgets({ descriptors: [descriptor], budgetForModel: () => budget }), normalizedRequirements).length > 0;
  };
  const fallbackModelRef = () => (input.fallbackModelRefs ?? []).find(isEligibleModelRef);
  if (!selectedModel) selectedModel = fallbackModelRef() ?? null;
  if (!selectedModel && requirements && eligible.length > 0) selectedModel = eligible[0]!.model_id;
  // Prefer first account-configured model when RoleConfig/project default is empty (#679).
  if (!selectedModel && configuredModelIds.length > 0) selectedModel = configuredModelIds[0]!;
  if (selectedModel && catalog.length > 0 && !allowPassthrough && !isEligibleModelRef(selectedModel)) {
    if (requestedModelRef) {
      throwModelCapabilityMismatch(selectedModel, [...eligibleIds]);
    }
    const fallback = fallbackModelRef();
    if (fallback) selectedModel = fallback;
    else if (configuredModelIds.includes(selectedModel)) {
      // selectedModel is an account-configured id; capability filter may have excluded it —
      // keep it when no fallback exists (admit gate below still validates catalog membership).
    } else if (configuredModelIds.length > 0 && !requestedModelRef) {
      selectedModel = configuredModelIds[0]!;
    }
  }
  if (requirements && selectedModel && !allowPassthrough && !isEligibleModelRef(selectedModel)) {
    throwModelCapabilityMismatch(selectedModel, [...eligibleIds]);
  }
  return selectedModel;
}
