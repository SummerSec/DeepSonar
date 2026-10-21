import path from "node:path";
import { rejectNonCurrentAgentCli } from "@deepsonar/shared-types";

/** 系统保留环境变量：RoleConfig 与配置文件一律不得覆盖 */
export const RESERVED_ENV_KEYS = new Set([
  "DEEPSONAR_JOB_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "PATH",
  "HOME",
  "NODE_OPTIONS",
]);
const RESERVED_ENV_PREFIXES = ["AGENTBOX_", "DEEPSONAR_"];
const SENSITIVE_ENV_NAME = /TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION|COOKIE|CREDENTIAL/i;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_MAX_COUNT = 50;
const ENV_MAX_VALUE = 4096;
const ENV_MAX_TOTAL = 64 * 1024;

/** 校验非敏感 env_vars；返回错误消息或 null */
export function validateEnvVars(env: Record<string, string>): string | null {
  const entries = Object.entries(env);
  if (entries.length > ENV_MAX_COUNT) return `环境变量数量超限（>${ENV_MAX_COUNT}）`;
  let total = 0;
  for (const [k, v] of entries) {
    if (!ENV_NAME_RE.test(k)) return `非法环境变量名: ${k}`;
    if (RESERVED_ENV_KEYS.has(k) || RESERVED_ENV_PREFIXES.some((p) => k.startsWith(p))) {
      return `环境变量 ${k} 为系统保留，不允许配置`;
    }
    if (SENSITIVE_ENV_NAME.test(k)) return `环境变量 ${k} 疑似密钥，请改用 Credential`;
    if (typeof v !== "string") return `环境变量 ${k} 的值必须是字符串`;
    if (v.length > ENV_MAX_VALUE) return `环境变量 ${k} 值超长（>${ENV_MAX_VALUE}）`;
    total += k.length + v.length;
  }
  if (total > ENV_MAX_TOTAL) return `环境变量总大小超限（>${ENV_MAX_TOTAL}B）`;
  return null;
}

/** 各 CLI 允许上传的 Provider 配置文件固定相对路径 */
export const CONFIG_FILE_PATHS: Record<string, string> = {
  "claude-code": ".claude/settings.json",
  pi: ".pi/agent/models.json",
  dsh: ".dsh/settings.yaml",
};

export function validateConfigFilePath(agentCli: string, p: string): string | null {
  if (!p || p.length > 200) return "路径为空或超长";
  if (p.includes("\u0000")) return "路径含 NUL";
  if (p.includes("\\")) return "路径不允许反斜杠";
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return "不允许绝对路径";
  const norm = path.posix.normalize(p);
  if (norm !== p || norm.startsWith("..") || norm.includes("/../")) return "路径不允许 .. 或非规范形式";
  const leftover = rejectNonCurrentAgentCli(agentCli);
  if (leftover) return leftover;
  const allowed = CONFIG_FILE_PATHS[agentCli];
  if (!allowed) return `未知 agent_cli: ${agentCli}`;
  if (agentCli === "pi" && /^\.pi\/agent\/extensions\//u.test(norm)) {
    return "Pi 扩展只能通过 Hub 角色能力组合声明已注册扩展（pi_extension_ids），不能上传扩展源码";
  }
  if (norm !== allowed) return `该 CLI 首期只允许固定配置文件：${allowed}`;
  return null;
}

export const CONFIG_FILE_MAX_COUNT = 5;
export const CONFIG_FILE_MAX_BYTES = 64 * 1024;
export const CONFIG_FILE_MAX_TOTAL = 256 * 1024;

const SECRET_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /sk-[A-Za-z0-9_-]{20,}/, label: "疑似 API Key（sk-…）" },
  { re: /AKIA[0-9A-Z]{16}/, label: "疑似 AWS Access Key" },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, label: "疑似私钥" },
  {
    re: /(api[_-]?key|token|secret)["']?\s*[:=]\s*["'][A-Za-z0-9_\-/.+]{20,}["']/i,
    label: "疑似硬编码密钥字段",
  },
];

export function scanConfigContent(content: string): string | null {
  for (const { re, label } of SECRET_PATTERNS) {
    if (re.test(content)) return label;
  }
  return null;
}
