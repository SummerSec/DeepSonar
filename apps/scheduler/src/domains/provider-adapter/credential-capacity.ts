import { credentialConcurrencyPolicy } from "../../credentials.js";
import { accumulateDispatchCounts, dispatchModelKey, queryActiveDispatchRows } from "../../dispatch-active-concurrency.js";
import type { sql } from "../../db.js";
import type { RoleRuntimeSnapshotTransaction } from "../role-runtime-snapshot/ports.js";

export type CredentialCapacity = {
  credential: { in_use: number; limit: number | null };
  model: { id: string | null; in_use: number; limit: number | null };
  provider: { in_use: number; limit: number | null };
  room_ratio: number;
  blocked_by: Array<"credential" | "model" | "provider">;
};

/** Read the same global occupancy and rules as claim. No reservation or writes. */
export async function readCredentialCapacities(
  db: RoleRuntimeSnapshotTransaction,
  candidates: Array<{ id: string; provider: string; public_metadata_json: unknown; model: string | null }>,
  existingJobId?: string | null,
): Promise<Map<string, CredentialCapacity>> {
  const query = db as typeof sql;
  // Resolve after module initialization: core constructs the snapshot application.
  const { globalRules } = await import("../../core.js");
  // Exclude self in the same SQL statement, including all three quota levels.
  const [rows, rules] = await Promise.all([
    queryActiveDispatchRows(query, { excludeJobId: existingJobId }), globalRules(query),
  ]);
  if (rows.some(row => !Number.isSafeInteger(Number(row.count)) || Number(row.count) < 0)) {
    throw new Error("provider_credential_occupancy_unknown");
  }
  const counts = accumulateDispatchCounts(rows);
  return new Map(candidates.map(row => {
    const policy = credentialConcurrencyPolicy(row.public_metadata_json);
    const credential = { in_use: counts.credential.get(row.id) ?? 0, limit: policy.maxConcurrent };
    const model = {
      id: row.model,
      in_use: row.model ? counts.model.get(dispatchModelKey(row.id, row.model)) ?? 0 : 0,
      limit: row.model ? policy.modelConcurrency[row.model] ?? null : null,
    };
    const provider = {
      in_use: counts.provider.get(row.provider) ?? 0,
      limit: rules.maxConcurrentByProvider[row.provider] ?? null,
    };
    const levels = { credential, model, provider };
    const blocked_by = (Object.keys(levels) as Array<keyof typeof levels>).filter(key => {
      const level = levels[key];
      return level.limit !== null && level.in_use >= level.limit;
    });
    const room_ratio = Math.min(...Object.values(levels).map(level => {
      if (level.limit === null) return 1;
      if (level.limit === 0) return 0;
      return Math.max(0, level.limit - level.in_use) / level.limit;
    }));
    return [row.id, { credential, model, provider, room_ratio, blocked_by }];
  }));
}
