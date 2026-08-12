import type { AuthMe, RoleConfigInput } from "./api";

export const AGENT_PACK_SCHEMA = "deepsonar.agentpack/v1";
export const AGENT_PACK_MAX_BYTES = 256 * 1024;

export interface AgentPack {
  schema: typeof AGENT_PACK_SCHEMA;
  name: string;
  title: string;
  description: string;
  publisher: string;
  version: string;
  config: RoleConfigInput;
}

export function canInstallAgentPack(me: AuthMe | null): boolean {
  return Boolean(me?.actor && !me.actor.project_id && (!me.auth_required
    || me.actor.role === "admin"
    || me.actor.scopes.includes("admin")
    || me.actor.scopes.includes("agents:write")));
}

const DEFAULT_CONFIG: RoleConfigInput = {
  agent_cli: "claude-code",
  model: null,
  reasoning: null,
  env_keys: [],
  env_vars: {},
  modules: [],
  skills: [],
  commands: [],
  mcps: [],
  subagents: [],
  platform_tools: {},
  instructions_markdown: null,
  runtime_image_key: null,
  credentials: [],
  config_files: [],
};

const CONFIG_KEYS = new Set([
  "agent_cli", "model", "reasoning", "env_keys", "env_vars", "modules", "skills", "commands", "mcps",
  "subagents", "platform_tools", "instructions_markdown", "runtime_image_key", "credentials", "config_files",
]);
const SECRET_FIELD = /^(?:api_?key|access_token|api_token|auth_token|refresh_token|client_secret|private_key|secret|password|authorization|cookie|credential(?:s|_id)?)$/i;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_ENV_KEYS = new Set(["DEEPSONAR_JOB_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENAI_BASE_URL", "PATH", "HOME", "NODE_OPTIONS"]);
const SENSITIVE_ENV_NAME = /TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION|COOKIE|CREDENTIAL/i;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new Error(`${label} 必须是 1-${max} 个字符`);
  }
  return value.trim();
}

function rejectSecretFields(value: unknown, path = "config"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectSecretFields(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_FIELD.test(key)) throw new Error(`${path}.${key} 不得携带疑似长期密钥`);
    rejectSecretFields(nested, `${path}.${key}`);
  }
}

function nullableString(value: unknown, label: string, max = Number.POSITIVE_INFINITY): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > max) throw new Error(`${label} 必须是字符串或 null`);
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${label} 必须是字符串数组`);
  return value;
}

function recordArray(value: unknown, label: string): Record<string, unknown>[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} 必须是对象数组`);
  return value.map((item, index) => record(item, `${label}[${index}]`));
}

function booleanRecord(value: unknown, label: string): Record<string, boolean> {
  if (value === undefined) return {};
  const result = record(value, label);
  if (Object.values(result).some((item) => typeof item !== "boolean")) throw new Error(`${label} 的值必须是布尔值`);
  return result as Record<string, boolean>;
}

function validateEnvironment(envKeys: string[], envVars: Record<string, unknown>): Record<string, string> {
  if (envKeys.length > 50 || envKeys.some((key) => !ENV_NAME.test(key))) throw new Error("config.env_keys 包含非法环境变量名或数量超限");
  const entries = Object.entries(envVars);
  if (entries.length > 50) throw new Error("config.env_vars 数量超限");
  let total = 0;
  for (const [key, value] of entries) {
    if (!ENV_NAME.test(key)) throw new Error(`config.env_vars 包含非法变量名: ${key}`);
    if (RESERVED_ENV_KEYS.has(key) || key.startsWith("AGENTBOX_") || key.startsWith("DEEPSONAR_")) throw new Error(`config.env_vars 不得覆盖系统保留变量: ${key}`);
    if (SENSITIVE_ENV_NAME.test(key)) throw new Error("配置包不得携带疑似长期密钥的环境变量");
    if (typeof value !== "string" || value.length > 4096) throw new Error(`config.env_vars.${key} 必须是不超过 4096 字符的字符串`);
    total += key.length + value.length;
  }
  if (total > 64 * 1024) throw new Error("config.env_vars 总大小超限");
  return envVars as Record<string, string>;
}

export function parseAgentPack(input: string): AgentPack {
  if (new TextEncoder().encode(input).byteLength > AGENT_PACK_MAX_BYTES) throw new Error("Agent 配置包超过 256 KiB");
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error("Agent 配置包不是合法 JSON");
  }
  const value = record(parsed, "Agent 配置包");
  if (value.schema !== AGENT_PACK_SCHEMA) throw new Error(`schema 必须为 ${AGENT_PACK_SCHEMA}`);
  const name = text(value.name, "name", 31);
  if (!/^[a-z][a-z0-9_]{0,30}$/.test(name)) throw new Error("name 必须以小写字母开头，且只能使用小写字母、数字和下划线");
  const rawConfig = record(value.config, "config");
  const unknownKeys = Object.keys(rawConfig).filter((key) => !CONFIG_KEYS.has(key));
  if (unknownKeys.length > 0) throw new Error(`config 包含未知字段: ${unknownKeys.join(", ")}`);
  if (rawConfig.credentials !== undefined && !Array.isArray(rawConfig.credentials)) throw new Error("config.credentials 必须是数组");
  if (rawConfig.config_files !== undefined && !Array.isArray(rawConfig.config_files)) throw new Error("config.config_files 必须是数组");
  const credentials = rawConfig.credentials ?? [];
  const configFiles = rawConfig.config_files ?? [];
  if (credentials.length > 0 || configFiles.length > 0) throw new Error("配置包不得携带凭据绑定或 Provider 配置文件");
  const safeConfig = { ...rawConfig };
  delete safeConfig.credentials;
  delete safeConfig.config_files;
  rejectSecretFields(safeConfig);
  const envKeys = stringArray(rawConfig.env_keys, "config.env_keys");
  const envVars = validateEnvironment(envKeys, record(rawConfig.env_vars ?? {}, "config.env_vars"));
  const agentCliValue = String(rawConfig.agent_cli ?? DEFAULT_CONFIG.agent_cli);
  if (!["claude-code", "open-code", "codex", "pi"].includes(agentCliValue)) throw new Error("config.agent_cli 不受支持");
  const agentCli = agentCliValue as RoleConfigInput["agent_cli"];
  const reasoning = rawConfig.reasoning ?? null;
  if (reasoning !== null && !["low", "medium", "high", "xhigh"].includes(String(reasoning))) throw new Error("config.reasoning 不受支持");
  const config: RoleConfigInput = {
    agent_cli: agentCli,
    model: nullableString(rawConfig.model, "config.model"),
    reasoning: reasoning as RoleConfigInput["reasoning"],
    env_keys: envKeys,
    env_vars: envVars,
    modules: stringArray(rawConfig.modules, "config.modules"),
    skills: recordArray(rawConfig.skills, "config.skills"),
    commands: recordArray(rawConfig.commands, "config.commands"),
    mcps: recordArray(rawConfig.mcps, "config.mcps"),
    subagents: recordArray(rawConfig.subagents, "config.subagents"),
    platform_tools: booleanRecord(rawConfig.platform_tools, "config.platform_tools"),
    instructions_markdown: nullableString(rawConfig.instructions_markdown, "config.instructions_markdown", 100_000),
    runtime_image_key: nullableString(rawConfig.runtime_image_key, "config.runtime_image_key"),
    credentials: [],
    config_files: [],
  };
  return {
    schema: AGENT_PACK_SCHEMA,
    name,
    title: text(value.title, "title", 120),
    description: text(value.description, "description", 2000),
    publisher: text(value.publisher, "publisher", 120),
    version: text(value.version, "version", 64),
    config,
  };
}

export const OFFICIAL_AGENT_PACKS: readonly AgentPack[] = [
  {
    schema: AGENT_PACK_SCHEMA,
    name: "surface_map",
    title: "探索 Agent 基线",
    description: "面向目标梳理、入口发现与事实增量回传的官方运行配置。",
    publisher: "DeepSonar",
    version: "1.0.0",
    config: {
      ...DEFAULT_CONFIG,
      instructions_markdown: "先建立目标边界与可复核事实，再把后续分析机会写入画布。不得把未经证据支持的判断写成结论。",
    },
  },
  {
    schema: AGENT_PACK_SCHEMA,
    name: "independent_review",
    title: "独立复核 Agent 基线",
    description: "用于独立审查既有事实、寻找反例并形成可验证复核证据。",
    publisher: "DeepSonar",
    version: "1.0.0",
    config: {
      ...DEFAULT_CONFIG,
      instructions_markdown: "独立复核输入事实与证据，优先寻找反例、边界条件和证据缺口；不要复述上游结论。",
    },
  },
] as const;
