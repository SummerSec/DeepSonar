// Test-only frozen Job fixture. No real provider or credential is used.
export const OM_PROVIDER = "__deepsonar_observational_memory";
export const MODEL = "om-rpc-model";
export const OBSERVATION = "OM_PRIVATE_OBSERVATION_CANARY";
export const REFLECTION = "OM_PRIVATE_REFLECTION_CANARY";
export const FROZEN_CONFIG = Object.freeze({
  schema: "deepsonar.pi-observational-memory/v1", package: "pi-observational-memory", version: "3.1.4",
  integrity: "sha512-jgQbFyLMs4wWhkf6F0voOgzMwtIXsb8+ks0MsPKpPxkdpyMX5E/el6Mk/vJ40m8GlKwBIsCKjL1r7Z2U8dCtmA==",
  source_provider: "offline-fixture", source_model: MODEL,
  model: { provider: OM_PROVIDER, id: MODEL, thinking: "off" },
  observeAfterTokens: 1, reflectAfterTokens: 1, observerChunkMaxTokens: 256,
  compactAfterTokens: 1000000, compactAfterTokensMode: "calibrated", compactAfterTokensRatio: 0.68,
  observationsPoolMaxTokens: 20000, observationsPoolTargetTokens: 10000,
  agentMaxTurns: 4, agentMaxTokens: 256,
  passive: false, showWorkerNotifications: false, debugLog: false,
});
