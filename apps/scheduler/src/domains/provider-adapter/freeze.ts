import {
  FROZEN_PROVIDER_MODEL_SNAPSHOT_SCHEMA,
  FrozenProviderModelSnapshot,
  type FrozenModelDescriptor,
  type FrozenProviderModelSnapshot as FrozenSnap,
} from "@deepsonar/shared-types";
import { findProviderAdapter } from "./catalog.js";
import {
  findDescriptorForModel,
  freezeDescriptorOrNull,
  resolveModelDescriptorCatalog,
} from "./descriptors.js";

export function freezeProviderModelSnapshot(input: {
  provider: string | null | undefined;
  cliModelId: string | null | undefined;
  upstreamModelId: string | null | undefined;
  catalogJson?: unknown;
  descriptorsJson?: unknown;
  catalogRevision?: string | null;
  contextWindow?: number | null;
  compatibleAgentClis?: Array<"claude-code" | "pi" | "dsh">;
  /** Explicit project/platform passthrough opt-in; default false. */
  passthrough?: boolean;
}): FrozenSnap | null {
  const provider = typeof input.provider === "string" ? input.provider.trim() : "";
  if (!provider) return null;
  const adapter = findProviderAdapter(provider);
  if (!adapter || adapter.kind !== "llm_provider") return null;

  const passthrough = input.passthrough === true;
  const revision =
    (typeof input.catalogRevision === "string" && input.catalogRevision.trim()) ||
    `job-freeze:${provider}:${adapter.adapter_version}`;

  const catalog = resolveModelDescriptorCatalog({
    provider,
    catalogJson: input.catalogJson,
    descriptorsJson: input.descriptorsJson,
    catalogRevision: revision,
    compatibleAgentClis: input.compatibleAgentClis,
    healthStatus: passthrough ? "passthrough_allowed" : "verified",
    contextWindow: input.contextWindow ?? null,
  });

  const upstream =
    (typeof input.upstreamModelId === "string" && input.upstreamModelId.trim()) ||
    (typeof input.cliModelId === "string" && input.cliModelId.trim()) ||
    null;
  const matched = findDescriptorForModel(catalog, upstream);
  let modelDescriptor: FrozenModelDescriptor | null = freezeDescriptorOrNull(matched);

  // Passthrough / empty catalog: still record a minimal descriptor when we have an ID.
  if (!modelDescriptor && upstream && passthrough) {
    modelDescriptor = freezeDescriptorOrNull(
      resolveModelDescriptorCatalog({
        provider,
        catalogJson: [upstream],
        catalogRevision: revision,
        compatibleAgentClis: input.compatibleAgentClis,
        healthStatus: "passthrough_allowed",
        contextWindow: input.contextWindow ?? null,
      })[0] ?? null,
    );
  }

  return FrozenProviderModelSnapshot.parse({
    schema: FROZEN_PROVIDER_MODEL_SNAPSHOT_SCHEMA,
    adapter_id: adapter.adapter_id,
    adapter_version: adapter.adapter_version,
    provider,
    route_style: adapter.gateway.route_style,
    cli_model_id: typeof input.cliModelId === "string" && input.cliModelId.trim() ? input.cliModelId.trim() : null,
    upstream_model_id: upstream,
    model_descriptor: modelDescriptor,
    catalog_revision: modelDescriptor?.catalog_revision ?? (catalog[0]?.catalog_revision ?? revision),
    passthrough,
  });
}
