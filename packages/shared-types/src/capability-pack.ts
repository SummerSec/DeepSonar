import { z } from "zod";

export const CAPABILITY_PACK_SCHEMA = "deepsonar.capability-pack/v1" as const;

export const CapabilityPackScope = z.enum(["builtin", "global", "project", "task", "session"]);
export type CapabilityPackScope = z.infer<typeof CapabilityPackScope>;

export const CapabilityPackId = z
  .string()
  .min(3)
  .max(160)
  .regex(/^[a-z][a-z0-9_.-]*$/);
export type CapabilityPackId = z.infer<typeof CapabilityPackId>;

export const CapabilityPackVersion = z.string().min(1).max(40).regex(/^[0-9A-Za-z][0-9A-Za-z.+-]*$/);
export type CapabilityPackVersion = z.infer<typeof CapabilityPackVersion>;

export const CapabilityPackDigest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export type CapabilityPackDigest = z.infer<typeof CapabilityPackDigest>;

export const CapabilityPackInput = z.object({
  name: z.string().min(1).max(80),
  schema: z.string().min(1).max(200),
  required: z.boolean(),
}).strict();
export type CapabilityPackInput = z.infer<typeof CapabilityPackInput>;

export const CapabilityPackOutput = z.object({
  name: z.string().min(1).max(80),
  artifact_schema: z.string().min(1).max(200),
}).strict();
export type CapabilityPackOutput = z.infer<typeof CapabilityPackOutput>;

export const CapabilityPackPermissions = z.object({
  platform_tools: z.array(z.string().min(1).max(80)).max(32),
  allow_egress: z.boolean(),
}).strict();
export type CapabilityPackPermissions = z.infer<typeof CapabilityPackPermissions>;

export const CapabilityPackBudget = z.object({
  max_attempts: z.number().int().min(1).max(20),
  max_tokens: z.number().int().min(1).max(2_000_000).optional(),
}).strict();
export type CapabilityPackBudget = z.infer<typeof CapabilityPackBudget>;

export const CapabilityPackFailurePolicy = z.object({
  correctable: z.boolean(),
  replay: z.enum(["same_session", "none"]),
}).strict();
export type CapabilityPackFailurePolicy = z.infer<typeof CapabilityPackFailurePolicy>;

const capabilityPackBody = {
  schema: z.literal(CAPABILITY_PACK_SCHEMA),
  id: CapabilityPackId,
  version: CapabilityPackVersion,
  scope: CapabilityPackScope,
  summary: z.string().min(8).max(400),
  capabilities: z.array(z.string().min(1).max(80)).min(1).max(32),
  inputs: z.array(CapabilityPackInput).max(20),
  outputs: z.array(CapabilityPackOutput).max(20),
  permissions: CapabilityPackPermissions,
  budget: CapabilityPackBudget,
  failure_policy: CapabilityPackFailurePolicy,
  evaluator: z.string().min(1).max(120).optional(),
} as const;

/** Draft submitted for lint / validate / preview. Host computes digest. */
export const CapabilityPackDraft = z.object(capabilityPackBody).strict();
export type CapabilityPackDraft = z.infer<typeof CapabilityPackDraft>;

/** Frozen machine contract. SKILL.md stays human-readable; this is the only kernel contract. */
export const CapabilityPackManifest = z.object({
  ...capabilityPackBody,
  digest: CapabilityPackDigest,
}).strict();
export type CapabilityPackManifest = z.infer<typeof CapabilityPackManifest>;

export const CapabilityPackSummary = z.object({
  id: CapabilityPackId,
  version: CapabilityPackVersion,
  digest: CapabilityPackDigest,
  scope: CapabilityPackScope,
  summary: z.string().min(8).max(400),
  source_kind: z.enum(["builtin", "skill_module", "role_config"]),
}).strict();
export type CapabilityPackSummary = z.infer<typeof CapabilityPackSummary>;

export const ListCapabilitiesPayload = z.object({
  scope: CapabilityPackScope.optional(),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).max(1_000_000).optional(),
}).strict();
export type ListCapabilitiesPayload = z.infer<typeof ListCapabilitiesPayload>;

export const SearchCapabilitiesPayload = z.object({
  query: z.string().trim().min(1).max(200),
  scope: CapabilityPackScope.optional(),
  limit: z.number().int().min(1).max(50).optional(),
}).strict();
export type SearchCapabilitiesPayload = z.infer<typeof SearchCapabilitiesPayload>;

export const DescribeCapabilityPayload = z.object({
  id: CapabilityPackId,
  version: CapabilityPackVersion.optional(),
  digest: CapabilityPackDigest.optional(),
}).strict();
export type DescribeCapabilityPayload = z.infer<typeof DescribeCapabilityPayload>;

export const ValidateCompositionPayload = z.object({
  pack_manifest: CapabilityPackDraft,
  selectors: z.array(z.string().min(1).max(1024)).max(32).optional(),
}).strict();
export type ValidateCompositionPayload = z.infer<typeof ValidateCompositionPayload>;

export const PreviewMaterializationPayload = ValidateCompositionPayload;
export type PreviewMaterializationPayload = ValidateCompositionPayload;

const CAPABILITY_DISCOVERY_TOOLS = [
  "list_capabilities",
  "search_capabilities",
  "describe_capability",
  "validate_composition",
  "preview_materialization",
] as const;
export type CapabilityDiscoveryToolName = (typeof CAPABILITY_DISCOVERY_TOOLS)[number];
export const CAPABILITY_DISCOVERY_TOOLS_LIST: readonly CapabilityDiscoveryToolName[] = CAPABILITY_DISCOVERY_TOOLS;
