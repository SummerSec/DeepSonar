export {
  BUILTIN_CAPABILITY_PACKS,
  builtinPackIdForRole,
  freezeTaskCapabilityPack,
  manifestFromRoleConfig,
  manifestFromSkillModule,
  repairFromMissingModule,
  roleCapabilityId,
  type CapabilityCatalogRecord,
  type FrozenCapabilityPack,
} from "./catalog.js";
export {
  buildCapabilityCatalog,
  describeCapability,
  handleCapabilityDiscovery,
  jobEnvelopeFromSnapshot,
  listCapabilities,
  loadCapabilityCatalog,
  previewMaterialization,
  searchCapabilities,
  validateComposition,
} from "./discovery.js";
