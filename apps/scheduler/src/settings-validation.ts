import { FindingProtocolConfig } from "@deepsonar/shared-types";
import { z } from "zod";
import { isProviderKnown, UNKNOWN_PROVIDER_ERROR } from "./credentials.js";
import { RUNTIME_KNOB_BOUNDS } from "./runtime-knobs.js";
export const LEFTOVER_RULE_ALIAS_KEYS = ["autoVerifySeverities", "hubWaitSeverities", "AUTO_VERIFY_SEVERITIES"] as const;
const RULE_CONCURRENCY_KEYS = new Set(["maxGlobalJobs", "maxJobsPerProject", "maxConcurrentProvisioning"]);
const RUNTIME_KNOB_RULE_KEYS = {
  stallSec: RUNTIME_KNOB_BOUNDS.stallSec,
  jobTokenMaxRequests: RUNTIME_KNOB_BOUNDS.jobTokenMaxRequests,
  auditTimeoutSec: RUNTIME_KNOB_BOUNDS.timeoutSec,
  verifyTimeoutSec: RUNTIME_KNOB_BOUNDS.timeoutSec,
  provisionTimeoutSec: RUNTIME_KNOB_BOUNDS.provisionTimeoutSec,
} as const;
const GLOBAL_ONLY_RULE_KEYS = new Set([
  "maxGlobalJobs",
  "maxJobsPerProject",
  "maxConcurrentProvisioning",
  "maxConcurrentByProvider",
  "maxConcurrentByAgentCli",
  "provisionTimeoutSec",
]);
const CLI_CONCURRENCY_KEYS = new Set(["claude-code", "pi", "dsh"]);
const RulesPatch = z.record(z.string(), z.unknown()).superRefine((rules, ctx) => {
  for (const key of LEFTOVER_RULE_ALIAS_KEYS) {
    if (Object.hasOwn(rules, key)) {
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: `${key} 已删除，验证范围只认 minVerifySeverity`,
      });
    }
  }
  if (Object.hasOwn(rules, "finding_protocol")) {
    ctx.addIssue({
      code: "custom",
      path: ["finding_protocol"],
      message: "finding_protocol 不是规则字段，请使用顶层 finding_protocol",
    });
  }
  for (const key of RULE_CONCURRENCY_KEYS) {
    if (!(key in rules)) continue;
    const value = rules[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 1000) {
      ctx.addIssue({ code: "custom", path: [key], message: `${key} 必须是 1-1000 的整数` });
    }
  }
  for (const [key, bound] of Object.entries(RUNTIME_KNOB_RULE_KEYS)) {
    if (!(key in rules)) continue;
    const value = rules[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < bound.min || value > bound.max) {
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: `${key} 必须是 ${bound.min}-${bound.max} 的整数${key === "jobTokenMaxRequests" || key === "stallSec" ? "（0 表示不限制）" : ""}`,
      });
    }
  }
  if (Object.hasOwn(rules, "maxNoProgressRounds")) {
    const value = rules.maxNoProgressRounds;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 5) {
      ctx.addIssue({
        code: "custom",
        path: ["maxNoProgressRounds"],
        message: "maxNoProgressRounds 必须是 0-5 的整数（0 表示关闭无进展刹车）",
      });
    }
  }
  if (Object.hasOwn(rules, "maxHubRounds")) {
    const value = rules.maxHubRounds;
    const unlimited = typeof value === "string" && /^unlimited$/i.test(value.trim());
    const finite =
      typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 10_000;
    if (!unlimited && !finite) {
      ctx.addIssue({
        code: "custom",
        path: ["maxHubRounds"],
        message: "maxHubRounds 必须是 0-10000 的整数或 unlimited（0 / unlimited 表示不限制轮次）",
      });
    }
  }
  if (Object.hasOwn(rules, "maxConcurrentJobs")) {
    const value = rules.maxConcurrentJobs;
    if (value !== null && (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 1000)) {
      ctx.addIssue({ code: "custom", path: ["maxConcurrentJobs"], message: "maxConcurrentJobs 必须是 0-1000 的整数或 null" });
    }
  }
  if (Object.hasOwn(rules, "maxConcurrentByAgentCli")) {
    const cliRules = rules.maxConcurrentByAgentCli;
    if (!cliRules || typeof cliRules !== "object" || Array.isArray(cliRules)) {
      ctx.addIssue({ code: "custom", path: ["maxConcurrentByAgentCli"], message: "Agent CLI 并发必须是对象" });
    } else {
      for (const [cli, value] of Object.entries(cliRules as Record<string, unknown>)) {
        if (!CLI_CONCURRENCY_KEYS.has(cli) || typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 1000) {
          ctx.addIssue({ code: "custom", path: ["maxConcurrentByAgentCli", cli], message: `${cli} 必须是 0-1000 的整数` });
        }
      }
    }
  }
  if (!Object.hasOwn(rules, "maxConcurrentByProvider")) return;
  const providerRules = rules.maxConcurrentByProvider;
  if (!providerRules || typeof providerRules !== "object" || Array.isArray(providerRules)) {
    ctx.addIssue({ code: "custom", path: ["maxConcurrentByProvider"], message: "Provider 并发必须是对象" });
    return;
  }
  for (const [provider, value] of Object.entries(providerRules as Record<string, unknown>)) {
    if (!isProviderKnown(provider) || typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 1000) {
      const knownProvider = isProviderKnown(provider);
      ctx.addIssue({
        code: "custom",
        path: knownProvider ? ["maxConcurrentByProvider", provider] : ["maxConcurrentByProvider"],
        message: knownProvider ? `${provider} 必须是 0-1000 的整数` : UNKNOWN_PROVIDER_ERROR,
      });
    }
  }
});

export function parseConcurrencyRulesPatch(input: unknown): Record<string, unknown> {
  return RulesPatch.parse(input);
}

export const GlobalRulesPatch = RulesPatch.superRefine((rules, ctx) => {
  if (Object.hasOwn(rules, "maxConcurrentJobs")) {
    ctx.addIssue({ code: "custom", path: ["maxConcurrentJobs"], message: "maxConcurrentJobs 只能在项目设置中配置" });
  }
});
export const ProjectRulesPatch = RulesPatch.superRefine((rules, ctx) => {
  for (const key of GLOBAL_ONLY_RULE_KEYS) {
    if (Object.hasOwn(rules, key)) {
      ctx.addIssue({ code: "custom", path: [key], message: `${key} 属于全局调度上限，不能在项目设置中修改` });
    }
  }
});

export const SettingsPatchBody = z.object({
  rules: ProjectRulesPatch.optional(),
  finding_protocol: FindingProtocolConfig.nullable().optional(),
  /** 真实设备接入（#495）项目级 opt-in；null = 清除（默认关）。 */
  device_access_enabled: z.boolean().nullable().optional(),
  /** 项目启用的 Agent CLI 白名单（组合积木）；Hub 只能从中提案。 */
  enabled_agent_clis: z.array(z.enum(["claude-code", "pi", "dsh"])).min(1).optional(),
  /** 项目启用的 Provider Credential 白名单。 */
  enabled_credential_ids: z.array(z.string().uuid()).optional(),
  /** Hub 省略时的软缺省 CLI（必须 ∈ 白名单）。 */
  default_agent_cli: z.enum(["claude-code", "pi", "dsh"]).nullable().optional(),
  /** Hub 省略时的软缺省 Provider（必须 ∈ 白名单）。 */
  default_credential_id: z.string().uuid().nullable().optional(),
  /** Hub/Scheduler soft default model paired with default_credential_id. */
  default_model_ref: z.string().trim().min(1).max(200).regex(/^\S+$/u).nullable().optional(),
  /** Ordered model fallback list paired with default_credential_id. */
  fallback_model_refs: z.array(z.string().trim().min(1).max(200).regex(/^\S+$/u)).max(16).optional(),
  /** Project opt-in for aliases outside the observed Provider catalog. */
  allow_model_catalog_passthrough: z.boolean().optional(),
});

export const GlobalSettingsPatchBody = z.object({
  rules: GlobalRulesPatch.optional(),
  finding_protocol: FindingProtocolConfig.nullable().optional(),
}).refine((body) => body.rules !== undefined || body.finding_protocol !== undefined, {
  message: "at least one global setting is required",
});
