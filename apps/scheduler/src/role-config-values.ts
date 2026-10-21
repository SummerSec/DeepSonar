import { allowedPlatformTools, requiredPlatformTools } from "@deepsonar/shared-types";
import { z } from "zod";
import { RoleConfigPutBody } from "./role-config-schema.js";
import { parseContextWindowTokens } from "./provider-settings.js";
import { validateRuntimeKnobOverride } from "./runtime-knobs.js";
import { parseModuleSelector } from "@deepsonar/shared-types";
import { parseSandboxLimitsOverride, sandboxLimitsExceedPlatform, SANDBOX_LIMITS_EXCEED_PLATFORM } from "./domains/role-runtime-snapshot/sandbox-limits.js";
import { CONFIG_FILE_MAX_COUNT, CONFIG_FILE_MAX_BYTES, CONFIG_FILE_MAX_TOTAL, validateEnvVars, validateConfigFilePath, scanConfigContent } from "./role-config-validation.js";

export function validateRoleConfigValues(
  body: z.infer<typeof RoleConfigPutBody>, projectId: string | null,
  role: { name: string; kind: "role" | "hub" | "system" },
  policy: { sandboxLimits: Parameters<typeof sandboxLimitsExceedPlatform>[1]; isEnvKeyAllowed: (key: string) => boolean },
): { error: string | null; error_code?: string } {
    if (projectId && body.runtime_image_key != null) {
      return { error: "项目 RoleConfig 不接受 runtime_image_key；运行镜像由平台目录与 Job 快照决定" };
    }
    let sandboxLimits: ReturnType<typeof parseSandboxLimitsOverride>;
    try {
      sandboxLimits = parseSandboxLimitsOverride(body.sandbox_limits);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
    if (!projectId && Object.keys(sandboxLimits).length > 0) {
      return { error: "sandbox_limits numeric overrides are only allowed on project RoleConfigs" };
    }
    // #697 P0: project cannot raise any dimension above platform env defaults.
    if (projectId && sandboxLimitsExceedPlatform(sandboxLimits, policy.sandboxLimits)) {
      return {
        error: "sandbox_limits 任一维度不得超过平台默认（DEEPSONAR_SANDBOX_*）；更高配额请调平台 env / 镜像地板",
        error_code: SANDBOX_LIMITS_EXCEED_PLATFORM,
      };
    }
    const knobsErr = validateRuntimeKnobOverride(body.runtime_knobs);
    if (knobsErr) return { error: knobsErr };
    const envErr = validateEnvVars(body.env_vars);
    try {
      parseContextWindowTokens(body.context_window_tokens);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
    if (envErr) return { error: envErr };
    for (const key of body.env_keys) {
      if (!policy.isEnvKeyAllowed(key)) return { error: `env_key 不在白名单: ${key}` };
    }
    for (const selector of body.modules) {
      try {
        parseModuleSelector(selector);
      } catch (error) {
        return { error: `模块 selector 非法（${selector}）: ${error instanceof Error ? error.message : String(error)}` };
      }
    }
    const allowedTools = new Set<string>(allowedPlatformTools(role.name, role.kind));
    for (const tool of Object.keys(body.platform_tools)) {
      if (!allowedTools.has(tool)) return { error: `角色 ${role.name} 不支持平台工具: ${tool}` };
    }
    for (const tool of requiredPlatformTools(role.kind)) {
      if (body.platform_tools[tool] === false) return { error: `终态必需平台工具不可关闭: ${tool}` };
    }
    // #690: RoleConfig no longer accepts credentials / pi_extensions bindings.
    if (body.config_files.length > CONFIG_FILE_MAX_COUNT) {
      return { error: `配置文件数量超限（>${CONFIG_FILE_MAX_COUNT}）` };
    }
    let totalBytes = 0;
    for (const f of body.config_files) {
      const pathErrors = (body.agent_cli ? [body.agent_cli] : ["claude-code", "pi", "dsh"])
        .map((cli) => validateConfigFilePath(cli, f.path));
      const pathErr = pathErrors.some((error) => error === null) ? null : pathErrors[0];
      if (pathErr) return { error: `配置文件 ${f.path}: ${pathErr}` };
      const bytes = Buffer.byteLength(f.content, "utf8");
      if (bytes > CONFIG_FILE_MAX_BYTES) {
        return { error: `配置文件 ${f.path} 超过单文件大小限制` };
      }
      totalBytes += bytes;
      const secretHit = scanConfigContent(f.content);
      if (secretHit) {
        return { error: `配置文件 ${f.path} 命中密钥特征（${secretHit}），请改用 Credential` };
      }
    }
    if (totalBytes > CONFIG_FILE_MAX_TOTAL) return { error: `配置文件总大小超限` };
    return { error: null };
}
