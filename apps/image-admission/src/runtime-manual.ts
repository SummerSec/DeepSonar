/** Re-export the shared offline manual contract so admission cannot drift from workers. */
export {
  RUNTIME_MANUAL_CONTRACT,
  RUNTIME_MANUAL_INDEX_PATH,
  RUNTIME_MANUAL_LABEL,
  RUNTIME_MANUAL_ROOT_PATH,
  RuntimeManualContractError,
  assertRuntimeManualLabel,
  validateRuntimeManualIndex,
  validateRuntimeManualMetadata,
  validateRuntimeManualPair,
  type RuntimeManualIndex,
  type RuntimeManualMetadata,
} from "@deepsonar/runtime-manual-contract";
