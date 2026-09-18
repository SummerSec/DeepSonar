import { z } from "zod";

/** Governed general CLI capability modules (#611). Distinct from Capability Pack skill envelopes and language-server modules. */
export const CLI_CAPABILITY_SCHEMA = "deepsonar.cli-capability/v1" as const;

export const CliCapabilityId = z
  .string()
  .min(3)
  .max(160)
  .regex(/^[a-z][a-z0-9_.-]*$/);
export type CliCapabilityId = z.infer<typeof CliCapabilityId>;

export const CliNetworkMode = z.enum(["disabled", "policy"]);
export type CliNetworkMode = z.infer<typeof CliNetworkMode>;

export const CliPermission = z.enum(["read_workspace", "write_workspace"]);
export type CliPermission = z.infer<typeof CliPermission>;

export const CliLimits = z
  .object({
    max_calls_per_job: z.number().int().min(1).max(10_000),
    timeout_ms: z.number().int().min(100).max(600_000),
    max_output_bytes: z.number().int().min(1_024).max(16_777_216),
  })
  .strict();
export type CliLimits = z.infer<typeof CliLimits>;

export const CliCapabilityManifest = z
  .object({
    schema: z.literal(CLI_CAPABILITY_SCHEMA),
    id: CliCapabilityId,
    version: z.string().min(1).max(40),
    /** Primary binary name Agents should invoke (e.g. rg, jq). */
    tool: z.string().min(1).max(80),
    /** Image pin label; concrete version is bound to the runtime image. */
    tool_version: z.string().min(1).max(80),
    binaries: z.array(z.string().min(1).max(80)).min(1).max(16),
    compatible_images: z.array(z.string().min(1).max(80)).max(32),
    /** False when registered but not yet shipped / pinned in compatible images. */
    default_available: z.boolean(),
    permissions: z.array(CliPermission).min(1).max(8),
    /** curl stays policy-controlled and is not in this pack; pack tools are disabled. */
    network: CliNetworkMode,
    limits: CliLimits,
    common_args: z.array(z.string().min(1).max(120)).max(32),
    evidence_types: z.array(z.string().min(1).max(80)).min(1).max(16),
    non_inferable_conclusions: z.array(z.string().min(1).max(400)).min(1).max(16),
    failure_policy: z.string().min(8).max(800),
    cleanup: z.string().min(8).max(800),
    manual_paths: z.array(z.string().min(1).max(240)).max(16),
    summary: z.string().min(8).max(400),
    example_invocation: z.string().min(1).max(400),
  })
  .strict();
export type CliCapabilityManifest = z.infer<typeof CliCapabilityManifest>;

/** Frozen into `jobs.agent_snapshot_json` when Hub/Scheduler admits a CLI capability. */
export const FrozenCliCapability = z
  .object({
    schema: z.literal(CLI_CAPABILITY_SCHEMA),
    id: CliCapabilityId,
    version: z.string().min(1).max(40),
    tool: z.string().min(1).max(80),
    tool_version: z.string().min(1).max(80),
    image_key: z.string().min(1).max(80),
    config_fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    binaries: z.array(z.string().min(1).max(80)).min(1).max(16),
    limits: CliLimits,
    network: CliNetworkMode,
    permissions: z.array(CliPermission).min(1).max(8),
  })
  .strict();
export type FrozenCliCapability = z.infer<typeof FrozenCliCapability>;

/** Pack-level freeze of the selected CLI capability set for a Job. */
export const FrozenCliCapabilityPack = z
  .object({
    schema: z.literal("deepsonar.cli-capability-pack/v1"),
    capabilities: z.array(FrozenCliCapability).max(32),
    pack_fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    image_key: z.string().min(1).max(80),
  })
  .strict();
export type FrozenCliCapabilityPack = z.infer<typeof FrozenCliCapabilityPack>;

/** Structured reject code for CLI admission (#611). Never silent-fallback to unregistered shell. */
export const CLI_UNAVAILABLE_CODE = "capability_unavailable" as const;

export const CliUnavailableReason = z.enum([
  "unregistered",
  "incompatible_image",
  "tool_missing",
  "install_forbidden",
  "budget_exceeded",
  "timeout",
  "truncated",
  "inconclusive",
]);
export type CliUnavailableReason = z.infer<typeof CliUnavailableReason>;

/**
 * CLI command evidence (#611). Observation / Fact input only — never a Finding.
 * `is_finding` is always false so downstream cannot promote CLI output as vulns.
 */
export const CliCapabilityResult = z
  .object({
    schema: z.literal("deepsonar.cli-capability-result/v1"),
    is_finding: z.literal(false),
    job_id: z.string().min(1).max(80),
    workspace: z.string().min(1).max(1024),
    capability_id: CliCapabilityId,
    tool: z.string().min(1).max(80),
    tool_version: z.string().min(1).max(80),
    argv: z.array(z.string().min(1).max(4_000)).max(64),
    exit_code: z.number().int().min(-1).max(255).nullable(),
    stdout_truncated: z.boolean(),
    stderr_truncated: z.boolean(),
    truncated: z.boolean(),
    truncation_notes: z.array(z.string().min(1).max(400)).max(16),
    inconclusive: z.boolean(),
    unavailable_code: z.literal(CLI_UNAVAILABLE_CODE).nullable(),
    unavailable_reason: CliUnavailableReason.nullable(),
    evidence_ref: z.string().min(1).max(240),
    result: z.unknown(),
  })
  .strict();
export type CliCapabilityResult = z.infer<typeof CliCapabilityResult>;
