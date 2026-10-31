import { z } from "zod";

/** Unified Extension / Tool Materialization Registry contract (#615 phase 1). */
export const EXTENSION_MATERIALIZATION_SCHEMA = "deepsonar.extension-materialization/v1" as const;
export const EXTENSION_MATERIALIZATION_PACK_SCHEMA = "deepsonar.extension-materialization-pack/v1" as const;

/** Stable error code when component materialization fails or runtime install is refused. */
export const COMPONENT_MATERIALIZATION_FAILED = "component_materialization_failed" as const;

export const MaterializationComponentType = z.enum([
  "skill",
  "pi_extension",
  "tool_pack",
  "command",
  "cli_extension",
]);
export type MaterializationComponentType = z.infer<typeof MaterializationComponentType>;

export const MaterializationSourceKind = z.enum([
  "embedded",
  "image_preinstall",
  "registry_blob",
  "repository",
]);
export type MaterializationSourceKind = z.infer<typeof MaterializationSourceKind>;

export const MaterializationSecurityLevel = z.enum(["trusted", "reviewed", "experimental"]);
export type MaterializationSecurityLevel = z.infer<typeof MaterializationSecurityLevel>;

export const MaterializationMaintStatus = z.enum(["active", "deprecated", "retired"]);
export type MaterializationMaintStatus = z.infer<typeof MaterializationMaintStatus>;

export const MaterializationComponentId = z
  .string()
  .min(3)
  .max(160)
  .regex(/^[a-z][a-z0-9_.-]*$/);
export type MaterializationComponentId = z.infer<typeof MaterializationComponentId>;

const Sha256Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const Integrity = z.string().min(8).max(240);

/**
 * Platform registry row. New components = registry entry + (image pin or embedded blob).
 * Job create freezes selected rows; Job runtime must not npm/npx/pip/remote-install.
 */
export const MaterializationComponentManifest = z
  .object({
    schema: z.literal(EXTENSION_MATERIALIZATION_SCHEMA),
    component_id: MaterializationComponentId,
    type: MaterializationComponentType,
    source_kind: MaterializationSourceKind,
    /** Human / package source label (npm package, git URL template, image path, …). */
    source: z.string().min(1).max(400),
    version: z.string().min(1).max(80),
    /** Prefer sha256; npm integrity (sha512-…) also accepted for image-preinstalled packages. */
    digest: z.union([Sha256Digest, Integrity]),
    compatible_agent_clis: z.array(z.enum(["claude-code", "pi", "dsh"])).max(8),
    compatible_image_keys: z.array(z.string().min(1).max(80)).max(32),
    permissions: z.array(z.string().min(1).max(80)).max(16),
    /** When false, materialization must not perform network I/O. */
    allow_network: z.boolean(),
    dependencies: z.array(MaterializationComponentId).max(32),
    entry: z.string().min(1).max(240).nullable(),
    manuals_path: z.string().min(1).max(240).nullable(),
    runtime_limits: z
      .object({
        max_materialize_ms: z.number().int().min(100).max(600_000),
        max_bytes: z.number().int().min(1_024).max(268_435_456).optional(),
      })
      .strict(),
    security_level: MaterializationSecurityLevel,
    maintenance_status: MaterializationMaintStatus,
    summary: z.string().min(8).max(400),
  })
  .strict();
export type MaterializationComponentManifest = z.infer<typeof MaterializationComponentManifest>;

/** Frozen into `jobs.agent_snapshot_json` at Job create (#615). */
export const FrozenMaterializationComponent = z
  .object({
    schema: z.literal(EXTENSION_MATERIALIZATION_SCHEMA),
    component_id: MaterializationComponentId,
    type: MaterializationComponentType,
    source_kind: MaterializationSourceKind,
    source: z.string().min(1).max(400),
    version: z.string().min(1).max(80),
    digest: z.union([Sha256Digest, Integrity]),
    allow_network: z.boolean(),
    entry: z.string().min(1).max(240).nullable(),
    manuals_path: z.string().min(1).max(240).nullable(),
    image_key: z.string().min(1).max(80),
    agent_cli: z.enum(["claude-code", "pi", "dsh"]),
  })
  .strict();
export type FrozenMaterializationComponent = z.infer<typeof FrozenMaterializationComponent>;

export const FrozenMaterializationPack = z
  .object({
    schema: z.literal(EXTENSION_MATERIALIZATION_PACK_SCHEMA),
    components: z.array(FrozenMaterializationComponent).max(64),
    pack_fingerprint: Sha256Digest,
    image_key: z.string().min(1).max(80),
    agent_cli: z.enum(["claude-code", "pi", "dsh"]),
  })
  .strict();
export type FrozenMaterializationPack = z.infer<typeof FrozenMaterializationPack>;

export const ComponentMaterializationFailureReason = z.enum([
  "unregistered",
  "incompatible_cli",
  "incompatible_image",
  "integrity_mismatch",
  "runtime_install_forbidden",
  "network_required",
  "missing_entry",
  "deprecated",
  "validation_failed",
]);
export type ComponentMaterializationFailureReason = z.infer<typeof ComponentMaterializationFailureReason>;

/** Patterns that must never run inside a Job sandbox for component install (#615). */
export const FORBIDDEN_RUNTIME_INSTALL_PATTERNS: readonly RegExp[] = [
  /\bnpx\b/i,
  /\bnpm\s+(?:install|i|add|ci|exec)\b/i,
  /\byarn\s+(?:add|install)\b/i,
  /\bpnpm\s+(?:add|install)\b/i,
  /\bpip(?:3)?\s+install\b/i,
  /\buv\s+pip\s+install\b/i,
  /\bcurl\b.+\|\s*(?:ba)?sh\b/i,
  /\bwget\b.+\|\s*(?:ba)?sh\b/i,
  /\bskills\s+add\b/i,
];

export function isForbiddenRuntimeInstallCommand(command: string): boolean {
  const text = command.trim();
  if (!text) return false;
  return FORBIDDEN_RUNTIME_INSTALL_PATTERNS.some((pattern) => pattern.test(text));
}
