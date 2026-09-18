import type { FrozenProviderModelSnapshot } from "@deepsonar/shared-types";
import { findProviderAdapter } from "./catalog.js";

/** Local strip of `cli-default:` — keep this domain free of runtime-sandbox imports. */
function bareUpstreamModelId(upstreamModel: string | null | undefined): string | null {
  const raw = typeof upstreamModel === "string" ? upstreamModel.trim() : "";
  if (!raw) return null;
  if (raw.startsWith("cli-default:")) {
    const bare = raw.slice("cli-default:".length).trim();
    return bare || null;
  }
  return raw;
}

export const GATEWAY_FROZEN_MODEL_MISMATCH = "GATEWAY_FROZEN_MODEL_MISMATCH" as const;

export class GatewayFrozenModelMismatchError extends Error {
  readonly code = GATEWAY_FROZEN_MODEL_MISMATCH;
  readonly requestModel: string;
  readonly allowed: string[];

  constructor(message: string, requestModel: string, allowed: string[]) {
    super(message);
    this.name = "GatewayFrozenModelMismatchError";
    this.requestModel = requestModel;
    this.allowed = allowed;
  }
}

function frozenProviderModelFromSnapshot(snapshot: unknown): FrozenProviderModelSnapshot | null {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const record = snapshot as { provider_model?: unknown };
  const value = record.provider_model;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as FrozenProviderModelSnapshot;
}

function allowedModelsFromFreeze(freeze: FrozenProviderModelSnapshot): string[] {
  const allowed = new Set<string>();
  for (const value of [freeze.cli_model_id, freeze.upstream_model_id, freeze.model_descriptor?.model_id]) {
    if (typeof value === "string" && value.trim()) {
      allowed.add(value.trim());
      const bare = bareUpstreamModelId(value);
      if (bare) allowed.add(bare);
    }
  }
  return [...allowed];
}

/**
 * Gateway may only forward models allowed by the Job-frozen provider_model
 * snapshot when the adapter declares enforce_frozen_model (#614).
 * Missing freeze / empty allowed set soft-allows (legacy snapshots).
 */
export function assertGatewayRequestModelAllowed(input: {
  requestModel: string | null | undefined;
  agentSnapshot: unknown;
}): void {
  const freeze = frozenProviderModelFromSnapshot(input.agentSnapshot);
  if (!freeze) return;
  const adapter = findProviderAdapter(freeze.provider);
  if (!adapter?.gateway.enforce_frozen_model) return;
  if (freeze.passthrough) return;

  const request = typeof input.requestModel === "string" ? input.requestModel.trim() : "";
  if (!request) return;

  const allowed = allowedModelsFromFreeze(freeze);
  if (allowed.length === 0) return;

  const bare = bareUpstreamModelId(request) ?? request;
  if (allowed.includes(request) || allowed.includes(bare)) return;

  throw new GatewayFrozenModelMismatchError(
    `Gateway 拒绝未冻结模型 ${request}；Job 仅允许：${allowed.slice(0, 12).join("、")}`,
    request,
    allowed,
  );
}

/** Extract request model from a Gateway JSON body when present. */
export function gatewayRequestModelFromBody(rawBody: unknown): string | null {
  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) return null;
  const model = (rawBody as { model?: unknown }).model;
  return typeof model === "string" && model.trim() ? model.trim() : null;
}
