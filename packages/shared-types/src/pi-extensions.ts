import { z } from "zod";

/** Image-fixed install root. Job stubs re-export from this prefix only. */
export const PI_EXTENSION_IMAGE_ROOT = "/opt/deepsonar/pi-extensions/node_modules";
export const PI_EXTENSION_WORKSPACE_DIR = ".pi/agent/extensions";
export const PI_EXTENSION_SANDBOX_PREFIX = `/workspace/.deepsonar-home/${PI_EXTENSION_WORKSPACE_DIR}/`;
export const PI_EXTENSION_ID_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
export const PI_EXTENSION_MAX_PER_ROLE = 8;
export const PI_OBSERVATIONAL_MEMORY_ID = "pi-observational-memory" as const;
export const PI_OBSERVATIONAL_MEMORY_PACKAGE = "pi-observational-memory" as const;
export const PI_OBSERVATIONAL_MEMORY_VERSION = "3.1.4" as const;
/**
 * The first runtime-image version supported by OM admission. This is an
 * extension-specific requirement, not the platform-wide runtime-image floor.
 */
export const PI_OBSERVATIONAL_MEMORY_MIN_RUNTIME_IMAGE_VERSION = "0.6.3" as const;
export const PI_OBSERVATIONAL_MEMORY_INTEGRITY = "sha512-jgQbFyLMs4wWhkf6F0voOgzMwtIXsb8+ks0MsPKpPxkdpyMX5E/el6Mk/vJ40m8GlKwBIsCKjL1r7Z2U8dCtmA==" as const;
export const PI_OBSERVATIONAL_MEMORY_ENTRY = "src/index.ts" as const;
export const PI_OBSERVATIONAL_MEMORY_PROVIDER = "__deepsonar_observational_memory" as const;
export const PI_OBSERVATIONAL_MEMORY_SETTINGS_KEY = "observational-memory" as const;
export const PI_OBSERVATIONAL_MEMORY_SCHEMA = "deepsonar.pi-observational-memory/v1" as const;
export const PI_OBSERVATIONAL_MEMORY_WRAPPER_PATH = "/opt/deepsonar/pi-extensions/deepsonar-observational-memory.ts" as const;

const SafeNonNegativeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const SafePositiveInteger = SafeNonNegativeInteger.min(1);
const PositiveInteger = SafePositiveInteger;
const ModelThinking = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export const PiObservationalMemoryRequestBudget = z.object({
  total_requests: SafePositiveInteger,
  main_requests: SafePositiveInteger,
  background_requests: SafePositiveInteger,
}).strict().superRefine((value, ctx) => {
  if (value.main_requests + value.background_requests > value.total_requests) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["background_requests"],
      message: "main_requests + background_requests must be <= total_requests",
    });
  }
});
export type PiObservationalMemoryRequestBudget = z.infer<typeof PiObservationalMemoryRequestBudget>;

export const PiObservationalMemoryBackgroundLimits = z.object({
  max_requests: SafeNonNegativeInteger,
  max_tokens: SafeNonNegativeInteger,
}).strict();
export type PiObservationalMemoryBackgroundLimits = z.infer<typeof PiObservationalMemoryBackgroundLimits>;

/**
 * Scheduler-frozen settings for the published pi-observational-memory 3.1.4
 * package. The source provider/model are retained for audit and replay; the
 * `model` provider is a runtime-only alias backed by the OM Gateway token.
 */
export const PiObservationalMemoryConfig = z.object({
  schema: z.literal(PI_OBSERVATIONAL_MEMORY_SCHEMA),
  package: z.literal(PI_OBSERVATIONAL_MEMORY_PACKAGE),
  version: z.literal(PI_OBSERVATIONAL_MEMORY_VERSION),
  integrity: z.literal(PI_OBSERVATIONAL_MEMORY_INTEGRITY),
  source_provider: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9._-]+$/),
  source_model: z.string().trim().min(1).max(240),
  model: z.object({
    provider: z.literal(PI_OBSERVATIONAL_MEMORY_PROVIDER),
    id: z.string().trim().min(1).max(240),
    thinking: ModelThinking,
  }).strict(),
  observeAfterTokens: PositiveInteger,
  reflectAfterTokens: PositiveInteger,
  observerChunkMaxTokens: PositiveInteger.nullable(),
  compactAfterTokens: PositiveInteger,
  compactAfterTokensMode: z.enum(["calibrated", "ratio"]),
  compactAfterTokensRatio: z.number().finite().gt(0).lt(1),
  observationsPoolMaxTokens: PositiveInteger,
  observationsPoolTargetTokens: PositiveInteger,
  agentMaxTurns: PositiveInteger,
  agentMaxTokens: PositiveInteger,
  passive: z.literal(false),
  showWorkerNotifications: z.literal(false),
  debugLog: z.literal(false),
  request_budget: PiObservationalMemoryRequestBudget.optional(),
  background_limits: PiObservationalMemoryBackgroundLimits.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.observationsPoolTargetTokens >= value.observationsPoolMaxTokens) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["observationsPoolTargetTokens"], message: "must be less than observationsPoolMaxTokens" });
  }
  if (value.model.id !== value.source_model) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["model", "id"], message: "must match source_model" });
  }
  if (value.request_budget && value.background_limits
    && value.background_limits.max_requests > value.request_budget.background_requests) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["background_limits", "max_requests"],
      message: "max_requests must be <= request_budget.background_requests",
    });
  }
});
export type PiObservationalMemoryConfig = z.infer<typeof PiObservationalMemoryConfig>;

export function piObservationalMemorySettings(config: PiObservationalMemoryConfig): Record<string, unknown> {
  return {
    observeAfterTokens: config.observeAfterTokens,
    reflectAfterTokens: config.reflectAfterTokens,
    ...(config.observerChunkMaxTokens == null ? {} : { observerChunkMaxTokens: config.observerChunkMaxTokens }),
    compactAfterTokens: config.compactAfterTokens,
    compactAfterTokensMode: config.compactAfterTokensMode,
    compactAfterTokensRatio: config.compactAfterTokensRatio,
    observationsPoolMaxTokens: config.observationsPoolMaxTokens,
    observationsPoolTargetTokens: config.observationsPoolTargetTokens,
    agentMaxTurns: config.agentMaxTurns,
    agentMaxTokens: config.agentMaxTokens,
    // These are intentionally platform constants. They must not be sourced
    // from project settings or PI_OBSERVATIONAL_MEMORY_PASSIVE.
    passive: false,
    showWorkerNotifications: false,
    debugLog: false,
    model: { ...config.model },
  };
}

export const PiExtensionId = z.string().regex(PI_EXTENSION_ID_PATTERN);
export type PiExtensionId = z.infer<typeof PiExtensionId>;

export interface PiExtensionRegistration {
  id: PiExtensionId;
  package: string;
  version: string;
  integrity: string;
  license: string;
  capabilities: readonly string[];
  requires_egress: boolean;
  /** Needs the Scheduler Model Gateway, but not business network egress. */
  requires_gateway: boolean;
  compatible_image_keys: readonly string[];
  entry: string;
  /** Optional extension-specific minimum immutable runtime-image version. */
  min_runtime_image_version?: string;
}

/**
 * Platform allowlist. New extensions = registry row + image preinstall.
 * Hub/Job capability combo may only name these IDs (#690); start path stays `--no-extensions` + `-e`.
 */
export const PI_EXTENSION_REGISTRY = {
  "pi-web-access": {
    id: "pi-web-access",
    package: "pi-web-access",
    version: "0.29.0",
    integrity: "sha512-1l4sAWYkFhiBynJf/mXuxmCHxjhiAyWJ4rfQVFu8UPa0JQhCS9oXAmNXcL0Q1SfrO00plmb6L4IkypJ3n1Q4Kg==",
    license: "MIT",
    capabilities: ["web-search", "content-extract", "url-fetch"],
    requires_egress: true,
    requires_gateway: false,
    compatible_image_keys: ["deepsonar-audit", "deepsonar-kali-minimal"],
    entry: "index.ts",
  },
  "pi-observational-memory": {
    id: "pi-observational-memory",
    package: PI_OBSERVATIONAL_MEMORY_PACKAGE,
    version: PI_OBSERVATIONAL_MEMORY_VERSION,
    integrity: PI_OBSERVATIONAL_MEMORY_INTEGRITY,
    license: "MIT",
    capabilities: ["observational-memory", "context-compaction", "recall"],
    requires_egress: false,
    requires_gateway: true,
    compatible_image_keys: ["deepsonar-base", "deepsonar-audit", "deepsonar-kali-minimal"],
    entry: "src/index.ts",
    min_runtime_image_version: PI_OBSERVATIONAL_MEMORY_MIN_RUNTIME_IMAGE_VERSION,
  },
} as const satisfies Record<string, PiExtensionRegistration>;

export type RegisteredPiExtensionId = keyof typeof PI_EXTENSION_REGISTRY;

export function isRegisteredPiExtensionId(value: unknown): value is RegisteredPiExtensionId {
  return typeof value === "string" && Object.hasOwn(PI_EXTENSION_REGISTRY, value);
}

export function registeredPiExtension(id: string): PiExtensionRegistration | null {
  return isRegisteredPiExtensionId(id) ? PI_EXTENSION_REGISTRY[id] : null;
}

export function piExtensionImageEntryPath(ext: PiExtensionRegistration): string {
  return `${PI_EXTENSION_IMAGE_ROOT}/${ext.package}/${ext.entry}`;
}

export function piExtensionWorkspacePath(id: string): string {
  return `${PI_EXTENSION_WORKSPACE_DIR}/${id}.ts`;
}

export function piExtensionSandboxPath(id: string): string {
  return `${PI_EXTENSION_SANDBOX_PREFIX}${id}.ts`;
}

export function parsePiExtensionIds(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("pi_extensions 必须是字符串数组");
  if (value.length > PI_EXTENSION_MAX_PER_ROLE) {
    throw new Error(`pi_extensions 最多 ${PI_EXTENSION_MAX_PER_ROLE} 个`);
  }
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !PI_EXTENSION_ID_PATTERN.test(item)) {
      throw new Error(`非法 Pi 扩展 id: ${String(item)}`);
    }
    if (seen.has(item)) continue;
    seen.add(item);
    ids.push(item);
  }
  return ids;
}

/** Job capability / Hub write gate. Non-Pi CLIs may only store an empty list. */
export function validatePiExtensionIds(ids: unknown, agentCli: string): string | null {
  let parsed: string[];
  try {
    parsed = parsePiExtensionIds(ids);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (parsed.length > 0 && agentCli !== "pi") {
    return "仅 agent_cli=pi 可声明 Pi 扩展";
  }
  for (const id of parsed) {
    if (!isRegisteredPiExtensionId(id)) return `未注册的 Pi 扩展: ${id}`;
  }
  return null;
}
