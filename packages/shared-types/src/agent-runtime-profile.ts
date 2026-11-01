import { z } from "zod";
import { PI_OBSERVATIONAL_MEMORY_ID, PiObservationalMemoryConfig } from "./pi-extensions.js";

/** Unified Scheduler-owned Agent Runtime Profile contract (#613). */
export const AGENT_RUNTIME_PROFILE_SCHEMA = "deepsonar.agent-runtime-profile/v1" as const;
export const AGENT_RUNTIME_PROFILE_UNSUPPORTED_CONFIG = "unsupported_config" as const;

const AgentCli = z.enum(["claude-code", "pi", "dsh"]);
const ReasoningEffort = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const Sha256 = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const RuntimeProfileProviderRef = z.object({
  credential_id: z.string().min(1).max(80),
  provider: z.string().trim().min(1).max(80),
}).strict();
export type RuntimeProfileProviderRef = z.infer<typeof RuntimeProfileProviderRef>;

export const RuntimeProfileExtensionRef = z.object({
  id: z.string().min(1).max(160),
  version: z.string().min(1).max(80),
  integrity: z.string().min(1).max(240),
}).strict();
export type RuntimeProfileExtensionRef = z.infer<typeof RuntimeProfileExtensionRef>;

export const RuntimeProfileSystemPromptRef = z.object({
  kind: z.literal("role_instructions"),
  sha256: Sha256,
  role_config_id: z.string().min(1).max(80).nullable(),
  role_config_version: z.number().int().min(1).nullable(),
}).strict();
export type RuntimeProfileSystemPromptRef = z.infer<typeof RuntimeProfileSystemPromptRef>;

export const RuntimeProfileEnvRef = z.object({
  name: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/),
  source: z.enum(["role_config", "provider_profile", "gateway"]),
}).strict();
export type RuntimeProfileEnvRef = z.infer<typeof RuntimeProfileEnvRef>;

const ClaudeNativeOptions = z.object({
  model_env: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/).nullable(),
  effort_level: ReasoningEffort.nullable(),
}).strict();

const PiNativeOptions = z.object({
  model: z.string().min(1).max(240).nullable(),
  provider: z.string().min(1).max(120).nullable(),
  extensions: z.array(z.string().min(1).max(160)).max(32),
  observational_memory: PiObservationalMemoryConfig.nullable(),
}).strict();

const DshNativeOptions = z.object({
  task_mode: z.enum(["standard", "ptc"]),
  provider: z.string().min(1).max(120).nullable(),
}).strict();

export const RuntimeProfileNativeOptions = z.object({
  claude_code: ClaudeNativeOptions.nullable(),
  pi: PiNativeOptions.nullable(),
  dsh: DshNativeOptions.nullable(),
}).strict();
export type RuntimeProfileNativeOptions = z.infer<typeof RuntimeProfileNativeOptions>;

export const RuntimeProfileResolutionOrder = z.tuple([
  z.literal("global"),
  z.literal("project"),
  z.literal("role"),
  z.literal("task"),
  z.literal("job"),
]);

const profileBody = {
  schema: z.literal(AGENT_RUNTIME_PROFILE_SCHEMA),
  profile_version: z.literal(1),
  agent_cli: AgentCli,
  provider_ref: RuntimeProfileProviderRef.nullable(),
  model_ref: z.string().min(1).max(240).nullable(),
  reasoning_effort: ReasoningEffort.nullable(),
  context_window_tokens: z.number().int().min(1024).max(10_000_000).nullable(),
  extensions: z.array(RuntimeProfileExtensionRef).max(32),
  system_prompt_ref: RuntimeProfileSystemPromptRef.nullable(),
  env_refs: z.array(RuntimeProfileEnvRef).max(128),
  native_options: RuntimeProfileNativeOptions,
  resolution_order: RuntimeProfileResolutionOrder,
  profile_fingerprint: Sha256,
} as const;

export const AgentRuntimeProfile = z.object(profileBody).strict().superRefine((profile, ctx) => {
  const pi = profile.native_options.pi;
  const memory = pi?.observational_memory;
  if (!pi || !memory) return;
  if (profile.agent_cli !== "pi") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["agent_cli"], message: "observational memory requires pi" });
  }
  if (profile.model_ref !== memory.source_model || pi.model !== memory.source_model || pi.provider !== memory.source_provider) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["native_options", "pi", "observational_memory"], message: "must match the frozen Job provider/model" });
  }
  const extension = profile.extensions.find((entry) => entry.id === PI_OBSERVATIONAL_MEMORY_ID);
  if (!pi.extensions.includes(PI_OBSERVATIONAL_MEMORY_ID)
    || extension?.version !== memory.version || extension?.integrity !== memory.integrity) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["extensions"], message: "observational memory requires its frozen extension identity" });
  }
});
export type AgentRuntimeProfile = z.infer<typeof AgentRuntimeProfile>;
export type FrozenAgentRuntimeProfile = AgentRuntimeProfile;

/** Safe task/Job overlay applied before the profile is frozen. Secrets and
 * provider credentials are intentionally excluded; those remain Scheduler-owned. */
export const RuntimeProfileOverridePayload = z.object({
  model_ref: z.string().trim().min(1).max(240).nullable().optional(),
  reasoning_effort: ReasoningEffort.nullable().optional(),
  context_window_tokens: z.number().int().min(1024).max(10_000_000).nullable().optional(),
}).strict();
export type RuntimeProfileOverridePayload = z.infer<typeof RuntimeProfileOverridePayload>;
