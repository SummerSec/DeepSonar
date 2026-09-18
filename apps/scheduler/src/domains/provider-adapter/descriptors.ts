import {
  DEFAULT_MODEL_CATALOG_HEALTH,
  MODEL_DESCRIPTOR_SCHEMA,
  ModelDescriptor,
  freezeModelDescriptor,
  selectModelDescriptors,
  type FrozenModelDescriptor,
  type ModelCatalogHealthStatus,
  type ModelDescriptor as Descriptor,
  type ModelSelectionRequirements,
} from "@deepsonar/shared-types";
import { normalizeModelCatalog } from "../../credentials.js";

export { selectModelDescriptors, freezeModelDescriptor };

/**
 * Lift legacy string model_catalog_json rows into structured descriptors.
 * Unknown capability fields stay conservative (tools/streaming true for LLM
 * catalogs; health defaults to verified only when explicitly marked).
 */
export function descriptorsFromStringCatalog(input: {
  provider: string;
  catalogJson: unknown;
  catalogRevision: string;
  compatibleAgentClis?: Array<"claude-code" | "pi" | "dsh">;
  healthStatus?: ModelCatalogHealthStatus;
  contextWindow?: number | null;
}): Descriptor[] {
  const models = normalizeModelCatalog(input.catalogJson);
  const health = input.healthStatus ?? "verified";
  const clis = input.compatibleAgentClis ?? (["claude-code", "pi", "dsh"] as const);
  const revision = input.catalogRevision.trim() || `legacy:${input.provider}`;
  return models.map((modelId) =>
    ModelDescriptor.parse({
      schema: MODEL_DESCRIPTOR_SCHEMA,
      provider: input.provider,
      model_id: modelId,
      display_name: modelId,
      context_window: input.contextWindow ?? null,
      max_output_tokens: null,
      supports_tools: true,
      supports_streaming: true,
      supports_structured_output: false,
      reasoning_efforts: [],
      input_modalities: ["text"],
      output_modalities: ["text"],
      cost: null,
      rate_limits: null,
      compatible_agent_clis: [...clis],
      health_status: health,
      catalog_revision: revision,
    }),
  );
}

export function validateModelDescriptor(value: unknown): Descriptor {
  return ModelDescriptor.parse(value);
}

/** Prefer structured descriptors; fall back to lifting string catalogs. */
export function resolveModelDescriptorCatalog(input: {
  provider: string;
  catalogJson: unknown;
  descriptorsJson?: unknown;
  catalogRevision?: string | null;
  compatibleAgentClis?: Array<"claude-code" | "pi" | "dsh">;
  healthStatus?: ModelCatalogHealthStatus;
  contextWindow?: number | null;
}): Descriptor[] {
  if (Array.isArray(input.descriptorsJson) && input.descriptorsJson.length > 0) {
    return input.descriptorsJson.map((row) => ModelDescriptor.parse(row));
  }
  return descriptorsFromStringCatalog({
    provider: input.provider,
    catalogJson: input.catalogJson,
    catalogRevision: input.catalogRevision?.trim() || `legacy:${input.provider}:string-catalog`,
    compatibleAgentClis: input.compatibleAgentClis,
    healthStatus: input.healthStatus,
    contextWindow: input.contextWindow,
  });
}

export function selectModelsForRequirements(
  catalog: readonly Descriptor[],
  requirements: ModelSelectionRequirements,
): Descriptor[] {
  return selectModelDescriptors(catalog, requirements);
}

export function findDescriptorForModel(
  catalog: readonly Descriptor[],
  modelId: string | null | undefined,
): Descriptor | null {
  const bare = typeof modelId === "string" ? modelId.trim() : "";
  if (!bare) return null;
  return catalog.find((row) => row.model_id === bare) ?? null;
}

export function freezeDescriptorOrNull(row: Descriptor | null): FrozenModelDescriptor | null {
  return row ? freezeModelDescriptor(row) : null;
}

export function defaultHealthWhenMissing(): ModelCatalogHealthStatus {
  return DEFAULT_MODEL_CATALOG_HEALTH;
}
