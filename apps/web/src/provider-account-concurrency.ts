import type { ProviderCredential } from "./api";
import { CREDENTIAL_CONCURRENCY_MAX, CREDENTIAL_CONCURRENCY_MIN, parseCredentialConcurrency } from "./credential-config-settings";

export type ModelConcurrencyDraftRow = { model: string; limit: string };

/** Format 占用/上限 for account cards (e.g. `2/4` or `0/不限`). */
export function formatActiveConcurrencyQuota(
  credential: Pick<ProviderCredential, "active_concurrency" | "public_metadata_json">,
): string {
  const ac = credential.active_concurrency;
  const metaMax = credential.public_metadata_json?.max_concurrent;
  const max = ac?.max_concurrent ?? (typeof metaMax === "number" ? metaMax : null);
  const inUse = ac?.in_use ?? 0;
  return `${inUse}/${max == null ? "不限" : max}`;
}

export function modelConcurrencyDraftFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): ModelConcurrencyDraftRow[] {
  const raw = metadata?.model_concurrency;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  return Object.entries(raw as Record<string, unknown>).map(([model, limit]) => ({
    model,
    limit: typeof limit === "number" ? String(limit) : "",
  }));
}

/** Validate and materialize model_concurrency for metadata write. Empty → delete key. */
export function parseModelConcurrencyDraft(
  rows: readonly ModelConcurrencyDraftRow[],
  allowedModels: readonly string[],
): Record<string, number> | null {
  const allowed = new Set(allowedModels);
  const out: Record<string, number> = {};
  for (const row of rows) {
    const model = row.model.trim();
    if (!model) continue;
    if (!allowed.has(model)) {
      throw new Error(`模型并发键必须来自该账号已配置模型清单：${model}`);
    }
    if (Object.prototype.hasOwnProperty.call(out, model)) {
      throw new Error(`模型并发键重复：${model}`);
    }
    const limit = parseCredentialConcurrency(row.limit);
    if (limit == null) {
      throw new Error(`模型 ${model} 的并发限制不能为空`);
    }
    if (limit < CREDENTIAL_CONCURRENCY_MIN || limit > CREDENTIAL_CONCURRENCY_MAX) {
      throw new Error(`模型并发必须是 ${CREDENTIAL_CONCURRENCY_MIN}–${CREDENTIAL_CONCURRENCY_MAX} 的整数`);
    }
    out[model] = limit;
  }
  return Object.keys(out).length > 0 ? out : null;
}
