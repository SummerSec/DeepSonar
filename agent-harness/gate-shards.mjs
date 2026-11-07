// #972/#992：ci.yml 的有界并行 gate；运行时与 SDK 是独立失败域。
// 纯静态数据 + fail-closed 校验，无外部依赖，CI 与本地 node --test 均可加载。

export const GATE_SHARDS = Object.freeze([
  "gate-contract",
  "gate-runtime",
  "gate-db-core",
  "gate-db-domain",
  "gate-e2e",
]);

export const GATE_SHARD_RESULT_VARS = Object.freeze({
  "gate-contract": "GATE_CONTRACT",
  "gate-runtime": "GATE_RUNTIME",
  "gate-db-core": "GATE_DB_CORE",
  "gate-db-domain": "GATE_DB_DOMAIN",
  "gate-e2e": "GATE_E2E",
});

// 原 gate 中每一个 pnpm ci:* 脚本（按出现顺序列全）及其归属分片。
export const GATE_SUITE_INVENTORY = Object.freeze([
  Object.freeze({ suite: "pnpm ci:images", shard: "gate-runtime" }),
  Object.freeze({ suite: "pnpm ci:unit:runtime-images", shard: "gate-runtime" }),
  Object.freeze({ suite: "pnpm ci:unit:runtime-cleanup", shard: "gate-runtime" }),
  Object.freeze({ suite: "pnpm ci:unit:image-admission", shard: "gate-runtime" }),
  Object.freeze({ suite: "pnpm ci:unit:runtime-image-record", shard: "gate-runtime" }),
  Object.freeze({ suite: "pnpm ci:unit:runtime-registry", shard: "gate-runtime" }),
  Object.freeze({ suite: "pnpm ci:integration:runtime-image-promotions", shard: "gate-db-core" }),
  Object.freeze({ suite: "pnpm ci:integration:request-budget-sdk", shard: "gate-runtime" }),
  Object.freeze({ suite: "pnpm ci:integration:provider-headers-sdk", shard: "gate-runtime" }),
  Object.freeze({ suite: "pnpm ci:unit:platform-upgrade-preflight", shard: "gate-contract" }),
  Object.freeze({ suite: "pnpm ci:unit:platform-upgrade-maintenance", shard: "gate-contract" }),
  Object.freeze({ suite: "pnpm ci:integration:platform-upgrade", shard: "gate-db-core" }),
  Object.freeze({ suite: "pnpm ci:unit:startup-gate", shard: "gate-contract" }),
  Object.freeze({ suite: "pnpm ci:unit:capability-pack", shard: "gate-contract" }),
  Object.freeze({ suite: "pnpm ci:unit:project-knowledge", shard: "gate-contract" }),
  Object.freeze({ suite: "pnpm ci:integration:project-knowledge", shard: "gate-db-core" }),
  Object.freeze({ suite: "pnpm ci:unit:job-lifecycle", shard: "gate-contract" }),
  Object.freeze({ suite: "pnpm ci:integration:job-lifecycle", shard: "gate-db-core" }),
  Object.freeze({ suite: "pnpm ci:unit:recovery", shard: "gate-contract" }),
  Object.freeze({ suite: "pnpm ci:unit:completion-recovery", shard: "gate-contract" }),
  Object.freeze({ suite: "pnpm ci:integration:completion-recovery", shard: "gate-db-core" }),
  Object.freeze({ suite: "pnpm ci:unit:device-broker", shard: "gate-contract" }),
  Object.freeze({ suite: "pnpm ci:unit:device-lease", shard: "gate-contract" }),
  Object.freeze({ suite: "pnpm ci:integration:device-lease", shard: "gate-db-core" }),
  Object.freeze({ suite: "pnpm ci:integration:recovery", shard: "gate-db-core" }),
  Object.freeze({ suite: "pnpm ci:unit:scheduler-characterization", shard: "gate-contract" }),
  Object.freeze({ suite: "pnpm ci:unit:bounded-contexts", shard: "gate-db-core" }),
  Object.freeze({ suite: "pnpm ci:unit:ci-test-hook", shard: "gate-contract" }),
  Object.freeze({ suite: "pnpm ci:unit:file-size", shard: "gate-contract" }),
  Object.freeze({ suite: "pnpm ci:unit:web-report-download", shard: "gate-contract" }),
  Object.freeze({ suite: "pnpm ci:unit:web-quick-start", shard: "gate-contract" }),
  Object.freeze({ suite: "pnpm ci:unit:web-facts", shard: "gate-contract" }),
  Object.freeze({ suite: "pnpm ci:unit:web-session-viewer", shard: "gate-contract" }),
  Object.freeze({ suite: "pnpm ci:unit:report-download-openapi", shard: "gate-contract" }),
  Object.freeze({ suite: "pnpm ci:integration:report-download", shard: "gate-db-domain" }),
  Object.freeze({ suite: "pnpm ci:integration:finding-report", shard: "gate-db-domain" }),
  Object.freeze({ suite: "pnpm ci:unit:finding-protocol", shard: "gate-contract" }),
  Object.freeze({ suite: "pnpm ci:unit:finding-offline-evaluation", shard: "gate-contract" }),
  Object.freeze({ suite: "pnpm ci:unit:finding-research", shard: "gate-contract" }),
  Object.freeze({ suite: "pnpm ci:unit:finding-quality", shard: "gate-contract" }),
  Object.freeze({ suite: "pnpm ci:integration:finding-protocol", shard: "gate-db-domain" }),
  Object.freeze({ suite: "pnpm ci:unit:finding-candidates-web", shard: "gate-contract" }),
  Object.freeze({ suite: "pnpm ci:unit:finding-lexical-web", shard: "gate-contract" }),
  Object.freeze({ suite: "pnpm ci:integration:finding-research", shard: "gate-db-domain" }),
  Object.freeze({ suite: "pnpm ci:integration:finding-quality", shard: "gate-db-domain" }),
  Object.freeze({ suite: "pnpm ci:unit:shared-assets", shard: "gate-contract" }),
  Object.freeze({ suite: "pnpm ci:integration:shared-assets", shard: "gate-db-domain" }),
  Object.freeze({ suite: "pnpm ci:integration:shared-assets-volume", shard: "gate-db-domain" }),
  Object.freeze({ suite: "pnpm ci:unit:migrations", shard: "gate-db-core" }),
  Object.freeze({ suite: "pnpm ci:unit:role-colors", shard: "gate-contract" }),
  Object.freeze({ suite: "pnpm ci:integration:role-colors", shard: "gate-db-core" }),
  Object.freeze({ suite: "pnpm ci:integration:dispatch-limits", shard: "gate-db-core" }),
  Object.freeze({ suite: "pnpm ci:integration:event-ingestion", shard: "gate-db-core" }),
  Object.freeze({ suite: "pnpm ci:integration:event-authorization", shard: "gate-db-core" }),
  Object.freeze({ suite: "pnpm ci:unit:plan-protocol", shard: "gate-contract" }),
  Object.freeze({ suite: "pnpm ci:integration:plan-protocol", shard: "gate-db-core" }),
  Object.freeze({ suite: "pnpm ci:unit:plan-replay", shard: "gate-contract" }),
  Object.freeze({ suite: "pnpm ci:integration:plan-replay", shard: "gate-db-core" }),
  Object.freeze({ suite: "pnpm ci:integration:hub-runtime-image", shard: "gate-db-core" }),
  Object.freeze({ suite: "pnpm ci:unit:event-rate-limit", shard: "gate-contract" }),
  Object.freeze({ suite: "pnpm ci:unit:login-rate-limit", shard: "gate-contract" }),
  Object.freeze({ suite: "pnpm ci:unit:deploy-ps1", shard: "gate-contract" }),
  Object.freeze({ suite: "pnpm ci:unit:control-plane-platforms", shard: "gate-contract" }),
  Object.freeze({ suite: "pnpm ci:integration:event-rate-limit", shard: "gate-db-core" }),
  Object.freeze({ suite: "pnpm ci:unit:graph-references", shard: "gate-contract" }),
  Object.freeze({ suite: "pnpm ci:integration:graph-references", shard: "gate-db-core" }),
  Object.freeze({ suite: "pnpm ci:unit:compose-tasks", shard: "gate-contract" }),
  Object.freeze({ suite: "pnpm ci:unit:task-intent", shard: "gate-contract" }),
  Object.freeze({ suite: "pnpm ci:integration:task-intent", shard: "gate-db-core" }),
  Object.freeze({ suite: "pnpm ci:unit:searchable-selects", shard: "gate-contract" }),
  Object.freeze({ suite: "pnpm ci:integration:compose-tasks", shard: "gate-db-core" }),
  Object.freeze({ suite: "pnpm ci:integration:canvas-lifecycle", shard: "gate-db-core" }),
  Object.freeze({ suite: "pnpm ci:integration:dashboard-overview", shard: "gate-db-core" }),
  Object.freeze({ suite: "pnpm ci:unit:verify-eligibility", shard: "gate-contract" }),
  Object.freeze({ suite: "pnpm ci:unit:canvas-facts", shard: "gate-contract" }),
  Object.freeze({ suite: "pnpm ci:integration:canvas-facts", shard: "gate-db-core" }),
  Object.freeze({ suite: "pnpm ci:unit:executor-real", shard: "gate-runtime" }),
  Object.freeze({ suite: "pnpm ci:unit:credential-compatibility", shard: "gate-runtime" }),
  Object.freeze({ suite: "pnpm ci:integration:credential-delete", shard: "gate-db-core" }),
  Object.freeze({ suite: "pnpm ci:integration:transfer-export", shard: "gate-db-core" }),
  Object.freeze({ suite: "pnpm ci:integration:credential-catalog", shard: "gate-db-core" }),
  Object.freeze({ suite: "pnpm ci:integration:role-config", shard: "gate-db-core" }),
  Object.freeze({ suite: "pnpm ci:unit:runtime-sandbox", shard: "gate-runtime" }),
  Object.freeze({ suite: "pnpm ci:integration:platform-api", shard: "gate-db-domain" }),
  Object.freeze({ suite: "pnpm ci:unit:authz", shard: "gate-contract" }),
  Object.freeze({ suite: "pnpm ci:integration:authz-boundaries", shard: "gate-db-domain" }),
  Object.freeze({ suite: "pnpm ci:integration:users-auth", shard: "gate-db-domain" }),
  Object.freeze({ suite: "pnpm ci:integration:login-rate-limit", shard: "gate-db-domain" }),
  Object.freeze({ suite: "pnpm ci:integration:convergence-recovery", shard: "gate-db-domain" }),
  Object.freeze({ suite: "pnpm ci:integration:verify-eligibility", shard: "gate-db-domain" }),
  Object.freeze({ suite: "pnpm ci:smoke:runtime-policy", shard: "gate-e2e" }),
  Object.freeze({ suite: "pnpm ci:smoke:convergence", shard: "gate-e2e" }),
]);

export function verifyGateShardResults({ results, docsOnly } = {}) {
  if (!results || typeof results !== "object") {
    throw new Error("gate shard results must be an object");
  }
  const allowed = docsOnly ? "skipped" : "success";
  for (const shard of Object.keys(results)) {
    if (!GATE_SHARDS.includes(shard)) {
      throw new Error("unknown gate shard: " + shard);
    }
  }
  for (const shard of GATE_SHARDS) {
    const result = results[shard];
    if (typeof result !== "string" || result.length === 0) {
      throw new Error("missing result for gate shard: " + shard);
    }
    if (result !== allowed) {
      throw new Error("unexpected result for gate shard " + shard + ": " + result);
    }
  }
  return { ok: true, shards: GATE_SHARDS };
}
