import { z } from "zod";

/** Governed language-server capability modules (#604). Distinct from Capability Pack skill envelopes. */
export const LANGUAGE_SERVER_CAPABILITY_SCHEMA = "deepsonar.language-server-capability/v1" as const;

export const LANGUAGE_SERVER_OPERATIONS = [
  "definition",
  "references",
  "hover",
  "document_symbol",
  "workspace_symbol",
  "diagnostics",
] as const;
export type LanguageServerOperation = (typeof LANGUAGE_SERVER_OPERATIONS)[number];
export const LanguageServerOperation = z.enum(LANGUAGE_SERVER_OPERATIONS);

export const LanguageServerCapabilityId = z
  .string()
  .min(3)
  .max(160)
  .regex(/^[a-z][a-z0-9_.-]*$/);
export type LanguageServerCapabilityId = z.infer<typeof LanguageServerCapabilityId>;

export const LanguageServerLimits = z
  .object({
    max_calls_per_job: z.number().int().min(1).max(10_000),
    timeout_ms: z.number().int().min(100).max(600_000),
    max_response_bytes: z.number().int().min(1_024).max(16_777_216),
    cpu: z.number().min(0.1).max(64).optional(),
    memory_mib: z.number().int().min(64).max(131_072).optional(),
  })
  .strict();
export type LanguageServerLimits = z.infer<typeof LanguageServerLimits>;

export const LanguageServerCapabilityManifest = z
  .object({
    schema: z.literal(LANGUAGE_SERVER_CAPABILITY_SCHEMA),
    id: LanguageServerCapabilityId,
    version: z.string().min(1).max(40),
    languages: z.array(z.string().min(1).max(32)).min(1).max(16),
    server: z.string().min(1).max(80),
    /** Image pin label; concrete binary version is bound to the runtime image. */
    server_version: z.string().min(1).max(80),
    compatible_images: z.array(z.string().min(1).max(80)).min(1).max(32),
    executable: z.string().min(1).max(200),
    operations: z.array(LanguageServerOperation).min(1).max(16),
    requires: z.array(z.string().min(1).max(120)).max(16),
    read_only: z.literal(true),
    network: z.literal("disabled"),
    limits: LanguageServerLimits,
    manual_paths: z.array(z.string().min(1).max(240)).max(16),
    summary: z.string().min(8).max(400),
  })
  .strict();
export type LanguageServerCapabilityManifest = z.infer<typeof LanguageServerCapabilityManifest>;

/** Frozen into `jobs.agent_snapshot_json` when Hub/Scheduler admits a language-server capability. */
export const FrozenLanguageServerCapability = z
  .object({
    schema: z.literal(LANGUAGE_SERVER_CAPABILITY_SCHEMA),
    id: LanguageServerCapabilityId,
    version: z.string().min(1).max(40),
    server: z.string().min(1).max(80),
    server_version: z.string().min(1).max(80),
    image_key: z.string().min(1).max(80),
    config_fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    operations: z.array(LanguageServerOperation).min(1).max(16),
    limits: LanguageServerLimits,
    read_only: z.literal(true),
    network: z.literal("disabled"),
  })
  .strict();
export type FrozenLanguageServerCapability = z.infer<typeof FrozenLanguageServerCapability>;

/** Structured reject code for language-server admission (#604). Never silent-fallback to raw shell. */
export const LANGUAGE_SERVER_UNAVAILABLE_CODE = "capability_unavailable" as const;

export const LanguageServerUnavailableReason = z.enum([
  "unregistered",
  "incompatible_image",
  "missing_precondition",
  "install_forbidden",
  "budget_exceeded",
  "path_outside_workspace",
  "timeout",
  "truncated",
]);
export type LanguageServerUnavailableReason = z.infer<typeof LanguageServerUnavailableReason>;

export const LanguageServerFileRange = z
  .object({
    path: z.string().min(1).max(1024),
    start_line: z.number().int().min(0).max(10_000_000),
    start_character: z.number().int().min(0).max(100_000),
    end_line: z.number().int().min(0).max(10_000_000),
    end_character: z.number().int().min(0).max(100_000),
  })
  .strict();
export type LanguageServerFileRange = z.infer<typeof LanguageServerFileRange>;

/**
 * LSP query evidence (#604). Navigation/diagnostics context only — never a Finding.
 * `is_finding` is always false so downstream cannot promote these rows as vulns.
 */
export const LanguageServerQueryResult = z
  .object({
    schema: z.literal("deepsonar.language-server-result/v1"),
    is_finding: z.literal(false),
    job_id: z.string().min(1).max(80),
    workspace: z.string().min(1).max(1024),
    revision: z.string().min(1).max(200),
    server: z.string().min(1).max(80),
    server_version: z.string().min(1).max(80),
    capability_id: LanguageServerCapabilityId,
    request_type: LanguageServerOperation,
    file_ranges: z.array(LanguageServerFileRange).max(500),
    compile_commands_fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable(),
    truncated: z.boolean(),
    truncation_notes: z.array(z.string().min(1).max(400)).max(16),
    inconclusive: z.boolean(),
    unavailable_code: z.literal(LANGUAGE_SERVER_UNAVAILABLE_CODE).nullable(),
    unavailable_reason: LanguageServerUnavailableReason.nullable(),
    evidence_ref: z.string().min(1).max(240),
    result: z.unknown(),
  })
  .strict();
export type LanguageServerQueryResult = z.infer<typeof LanguageServerQueryResult>;
