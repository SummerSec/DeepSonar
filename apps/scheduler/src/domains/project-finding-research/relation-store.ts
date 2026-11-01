/** Public Finding strong-relation boundary. Implementation is split by responsibility. */
export {
  registerIdentitySource,
  reviseIdentitySource,
  revokeIdentitySource,
  loadIdentitySource,
  validateIdentitySourceInput,
  sourceContentDigest,
  assertIdentitySourceAuthority,
  IDENTITY_SOURCE_ADMIN_SCOPE,
  IDENTITY_SOURCE_AUTHORITY_BASIS,
  type IdentityMappingActor,
  type IdentitySourceManifestInput,
  type IdentitySourceRecord,
} from "./identity-source-store.js";
export {
  registerIdentityMapping,
  remapIdentityMapping,
  revokeIdentityMapping,
  loadCurrentIdentitySnapshot,
  validateIdentityMappingInput,
  assertIdentityMappingAuthority,
  IDENTITY_MAPPING_HISTORY_LIMIT,
  type IdentityMappingInput,
  type IdentityMappingResult,
} from "./identity-mapping-store.js";
export { requestStrongRelationRebuild } from "./relation-work.js";
export {
  processStrongRelationBatch,
  loadFindingEnvelope,
  RELATION_BATCH_SIZE,
  RELATION_PROJECT_SCAN_SIZE,
  RELATION_PAIR_LIMIT,
} from "./relation-computation.js";
export {
  readStrongRelationPage,
  readCanvasStrongRelations,
  RELATION_RESULT_LIMIT,
  CANVAS_FINDING_LIMIT,
  CANVAS_RELATION_LIMIT,
  CANVAS_RESPONSE_BYTES,
  type StrongRelationPage,
  type CanvasStrongRelationPage,
} from "./relation-read.js";
export { StrongRelationStoreError, fail } from "./relation-errors.js";
