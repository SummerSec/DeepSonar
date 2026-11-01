import { requireCapturedFindingQualitySource } from "./quality-source-capture.js";
import {
  compareAuthoritativeIdentity, digestIdentityValue, identitySnapshotDigest,
  PLATFORM_IDENTITY_FIELDS, STRONG_IDENTITY_MODULE_URL,
  STRONG_IDENTITY_EXTRACTOR_VERSION, STRONG_IDENTITY_NORMALIZATION_VERSION,
  STRONG_RELATION_RULE_VERSION,
} from "./identity.js";
import { IDENTITY_SOURCE_MODULE_URL, IDENTITY_SOURCE_AUTHORITY_BASIS } from "./identity-source-store.js";
import { IDENTITY_MAPPING_MODULE_URL, IDENTITY_MAPPING_HISTORY_LIMIT } from "./identity-mapping-store.js";
import { RELATION_PAIR_LIMIT, selectStrongRelationCandidates, STRONG_SELECTOR_MODULE_URL } from "./strong-candidate-selector.js";
import {
  qualityDigest, QualityContractError, QUALITY_CONTRACT_MODULE_URL,
  QUALITY_SOURCE_LIMIT, QUALITY_LABEL_LIMIT, QUALITY_TRACE_LIMIT,
  QUALITY_DECISION_LIMIT, QUALITY_INPUT_BYTES, QUALITY_METRIC_VERSION,
  QUALITY_POPULATION_VERSION, QUALITY_LABEL_MAPPING_VERSION, QUALITY_STRONG_CLASSES,
} from "./quality-contract.js";
import { assessQualityGate, computeQualityMetrics, QUALITY_METRICS_MODULE_URL } from "./quality-metrics.js";
import { QUALITY_STORE_MODULE_URL } from "./quality-store.js";
import { QUALITY_LEDGER_MODULE_URL } from "./quality-ledger.js";
import { QUALITY_STATE_STORE_MODULE_URL } from "./quality-state-store.js";
import { QUALITY_WORKER_MODULE_URL } from "./quality-worker.js";
import { QUALITY_API_MODULE_URL } from "./quality-api.js";
import { RELATION_READ_MODULE_URL } from "./relation-read.js";
import { RELATION_COMPUTATION_MODULE_URL } from "./relation-computation.js";

/** Actual source returned by the trusted Node load chain is captured before
 * evaluation. Node/runtime loader/preload are the platform TCB; signed immutable
 * deployment remains a separate authority. There is no caller hash/path or
 * later disk reread fallback. Native TS and transformed/compiled JS bind their
 * respective evaluator-input bytes and may intentionally have different hashes.
 */
export const QUALITY_ASSETS_MODULE_URL = import.meta.url;
const REQUIRED_MODULES = [
  "contract", "metrics", "identity", "identity_sources", "identity_mappings",
  "selector", "assets", "store", "ledger", "state", "worker", "api", "relation_read", "relation_computation",
] as const;

/** Host modules must join this internal manifest before bootstrap is allowed.
 * Incomplete integration is a hard error, never a partially trusted scope.
 */
function moduleOrigins(): Readonly<Record<string, string>> {
  return {
    contract: QUALITY_CONTRACT_MODULE_URL, metrics: QUALITY_METRICS_MODULE_URL,
    identity: STRONG_IDENTITY_MODULE_URL, identity_sources: IDENTITY_SOURCE_MODULE_URL,
    identity_mappings: IDENTITY_MAPPING_MODULE_URL, selector: STRONG_SELECTOR_MODULE_URL,
    assets: QUALITY_ASSETS_MODULE_URL, store: QUALITY_STORE_MODULE_URL, ledger: QUALITY_LEDGER_MODULE_URL,
    state: QUALITY_STATE_STORE_MODULE_URL, worker: QUALITY_WORKER_MODULE_URL, api: QUALITY_API_MODULE_URL,
    relation_read: RELATION_READ_MODULE_URL, relation_computation: RELATION_COMPUTATION_MODULE_URL,
  };
}

function actualConfiguration() {
  return {
    identity_fields: [...PLATFORM_IDENTITY_FIELDS], strong_classes: [...QUALITY_STRONG_CLASSES],
    identity_authority_basis: IDENTITY_SOURCE_AUTHORITY_BASIS,
    independent_external_verification: false,
    node_version: process.versions.node,
    source_integrity_basis: "node_sync_load_returned_source_under_trusted_preload",
    source_limit: QUALITY_SOURCE_LIMIT, label_limit: QUALITY_LABEL_LIMIT,
    trace_limit: QUALITY_TRACE_LIMIT, decision_limit: QUALITY_DECISION_LIMIT,
    input_bytes: QUALITY_INPUT_BYTES, pair_limit: RELATION_PAIR_LIMIT,
    identity_mapping_history_limit: IDENTITY_MAPPING_HISTORY_LIMIT,
    extractor_version: STRONG_IDENTITY_EXTRACTOR_VERSION,
    normalization_version: STRONG_IDENTITY_NORMALIZATION_VERSION,
    strong_rule_version: STRONG_RELATION_RULE_VERSION,
    metric_version: QUALITY_METRIC_VERSION, population_version: QUALITY_POPULATION_VERSION,
    label_mapping_version: QUALITY_LABEL_MAPPING_VERSION,
  } as const;
}

function captureOrigin(origin: string): string {
  return requireCapturedFindingQualitySource(origin).source_digest;
}

export interface LoadedQualityAssets {
  readonly code_digest: string;
  readonly config_digest: string;
  readonly selector_digest: string;
  readonly normalization_digest: string;
  readonly strong_rule_digest: string;
  readonly extractor_version: string;
  readonly normalization_version: string;
  readonly strong_rule_version: typeof STRONG_RELATION_RULE_VERSION;
  readonly metric_version: typeof QUALITY_METRIC_VERSION;
  readonly population_version: typeof QUALITY_POPULATION_VERSION;
  readonly label_mapping_version: typeof QUALITY_LABEL_MAPPING_VERSION;
  readonly integrity_basis: "node_sync_load_returned_source_under_trusted_preload";
  readonly module_digests: Readonly<Record<string, string>>;
}
let loaded: LoadedQualityAssets | undefined;

/** Called once by Scheduler bootstrap after its governed module graph loads. */
export function bootFindingQualityAssets(): LoadedQualityAssets {
  if (loaded) return requireFindingQualityAssets();
  const origins = moduleOrigins();
  if (Object.keys(origins).length !== REQUIRED_MODULES.length
    || REQUIRED_MODULES.some((name) => !origins[name])) {
    throw new QualityContractError("QUALITY_ASSET_MANIFEST_INCOMPLETE");
  }
  const module_digests = Object.freeze(Object.fromEntries(REQUIRED_MODULES.map((name) => [name, captureOrigin(origins[name]!)])));
  const normalization_digest = qualityDigest({ origin: module_digests.identity,
    normalizer: digestIdentityValue.toString(), snapshot: identitySnapshotDigest.toString() });
  const strong_rule_digest = qualityDigest({ origin: module_digests.identity,
    comparison: compareAuthoritativeIdentity.toString(), fields: [...PLATFORM_IDENTITY_FIELDS] });
  const selector_digest = qualityDigest({ origin: module_digests.selector,
    selector: selectStrongRelationCandidates.toString(), pair_limit: RELATION_PAIR_LIMIT });
  const config = actualConfiguration();
  const snapshot: LoadedQualityAssets = Object.freeze({
    code_digest: qualityDigest({ module_digests, normalization_digest, strong_rule_digest, selector_digest,
      metrics: computeQualityMetrics.toString(), assessment: assessQualityGate.toString() }),
    config_digest: qualityDigest(config), selector_digest, normalization_digest, strong_rule_digest,
    extractor_version: config.extractor_version, normalization_version: config.normalization_version,
    strong_rule_version: config.strong_rule_version, metric_version: config.metric_version,
    population_version: config.population_version, label_mapping_version: config.label_mapping_version,
    integrity_basis: "node_sync_load_returned_source_under_trusted_preload", module_digests,
  });
  loaded = snapshot;
  return snapshot;
}

export function requireFindingQualityAssets(): LoadedQualityAssets {
  if (!loaded) throw new QualityContractError("QUALITY_ASSETS_NOT_BOOTSTRAPPED");
  const origins = moduleOrigins();
  for (const name of REQUIRED_MODULES) {
    if (captureOrigin(origins[name]!) !== loaded.module_digests[name]) throw new QualityContractError("QUALITY_LOADED_SOURCE_DRIFT");
  }
  if (qualityDigest(actualConfiguration()) !== loaded.config_digest) throw new QualityContractError("QUALITY_LOADED_CONFIG_DRIFT");
  return loaded;
}
