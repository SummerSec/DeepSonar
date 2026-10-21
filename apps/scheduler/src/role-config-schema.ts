import { AgentCliWriteSchema, PlatformToolName } from "@deepsonar/shared-types";
import { z } from "zod";

export const RoleConfigPutBody = z.object({
    agent_cli: AgentCliWriteSchema.default("claude-code"),
    dsh_task_mode: z.enum(["standard", "ptc"]).default("standard"),
    model: z.string().nullish(),
    /**
     * @deprecated #697 — RoleConfig 不再授权 model catalog passthrough。
     * 写入恒落 false；请用平台 env `DEEPSONAR_ALLOW_MODEL_CATALOG_PASSTHROUGH`
     * 或管理员级项目 Agent allowlist。
     */
    allow_model_catalog_passthrough: z.boolean().optional().default(false),
    context_window_tokens: z.unknown().optional(),
    env_keys: z.array(z.string()).default([]),
    env_vars: z.record(z.string(), z.string()).default({}),
    modules: z.array(z.string()).default([]),
    skills: z.array(z.record(z.string(), z.unknown())).default([]),
    commands: z.array(z.record(z.string(), z.unknown())).default([]),
    mcps: z.array(z.record(z.string(), z.unknown())).default([]),
    subagents: z.array(z.record(z.string(), z.unknown())).default([]),
    platform_tools: z.partialRecord(PlatformToolName, z.boolean()).default({}),
    instructions_markdown: z.string().max(100_000).nullish(),
    runtime_image_key: z.string().nullish(),
    /** Project-only numeric sandbox resource overrides; capability flags stay server-owned. */
    sandbox_limits: z.unknown().optional(),
    runtime_knobs: z.unknown().optional(),
    config_files: z.array(z.object({ path: z.string().min(1), content: z.string() })).default([]),
  }).strict(); // #690: reject credentials / pi_extensions and any unknown RoleConfig fields
