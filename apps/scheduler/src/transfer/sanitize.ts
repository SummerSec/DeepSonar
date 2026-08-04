/** 环境变量 / 文本 Secret 扫描（导出红线） */
import { validateModuleSelectors } from "@deepsonar/shared-types";

const SENSITIVE_KEY =
  /(password|passwd|secret|token|api[_-]?key|authorization|cookie|private[_-]?key|access[_-]?key|credential)/i;

export function isSensitiveEnvKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

/** 过滤 env_vars：敏感 key 不进普通数据包 */
export function filterEnvVars(env: Record<string, unknown> | null | undefined): {
  safe: Record<string, string>;
  redacted_keys: string[];
} {
  const safe: Record<string, string> = {};
  const redacted_keys: string[] = [];
  if (!env || typeof env !== "object") return { safe, redacted_keys };
  for (const [k, v] of Object.entries(env)) {
    if (v == null) continue;
    const s = String(v);
    if (isSensitiveEnvKey(k) || looksLikeSecretValue(s)) {
      redacted_keys.push(k);
      continue;
    }
    safe[k] = s;
  }
  return { safe, redacted_keys };
}

function looksLikeSecretValue(s: string): boolean {
  if (s.length >= 32 && /^[A-Za-z0-9_\-./+=]{32,}$/.test(s)) return true;
  if (/^sk-[A-Za-z0-9]{10,}/.test(s)) return true;
  if (/^Bearer\s+/i.test(s)) return true;
  return false;
}

/** 历史 snapshot 净化：去掉 sandbox / 运行态，credential 改逻辑引用 */
export function sanitizeAgentSnapshot(snap: unknown): Record<string, unknown> {
  if (!snap || typeof snap !== "object") return {};
  const s = { ...(snap as Record<string, unknown>) };
  if (s.module_selectors !== undefined) {
    s.module_selectors = validateModuleSelectors(s.module_selectors, "Job.module_selectors");
  }
  if (s.modules !== undefined) {
    s.modules = validateModuleSelectors(s.modules, "Job.modules");
  }
  delete s.sandbox_id;
  // credential 只保留可映射的逻辑字段
  if (s.credential_id) {
    s.credential_ref = {
      source_id: s.credential_id,
      name: s.credential_name ?? null,
      provider: s.credential_provider ?? null,
    };
  }
  delete s.credential_id;
  delete s.credential_name;
  if (s.env_vars && typeof s.env_vars === "object") {
    const { safe, redacted_keys } = filterEnvVars(s.env_vars as Record<string, unknown>);
    s.env_vars = safe;
    if (redacted_keys.length) s.env_vars_redacted = redacted_keys;
  }
  return s;
}

export const ACTIVE_JOB_STATUSES = [
  "pending",
  "claimed",
  "provisioning",
  "running",
  "waiting_human",
] as const;

export function archiveJobStatus(status: string): {
  status: string;
  original_status: string;
} {
  if ((ACTIVE_JOB_STATUSES as readonly string[]).includes(status)) {
    return { status: "cancelled", original_status: status };
  }
  return { status, original_status: status };
}
