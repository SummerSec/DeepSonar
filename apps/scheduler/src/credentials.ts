import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { config } from "./config.js";

/**
 * Provider Credential 加密（§6.2 存储要求）：
 * - AES-256-GCM；nonce 每次随机；密文/nonce/tag base64 落库
 * - 主密钥 32 字节，来自 DEEPSONAR_MASTER_KEY_FILE（优先）或 DEEPSONAR_MASTER_KEY（hex/base64）
 * - 明文永不进日志/快照/API 响应；fingerprint=sha256(明文)[:16] 只做识别
 * - 未配置主密钥时：加解密直接报错（加密功能不可用），不影响其余系统
 */

let cachedKey: Buffer | null | undefined;

function masterKey(): Buffer {
  if (cachedKey !== undefined) {
    if (!cachedKey) throw new Error("未配置主密钥（DEEPSONAR_MASTER_KEY_FILE），凭据功能不可用");
    return cachedKey;
  }
  let raw = "";
  if (config.credentials.masterKeyFile) {
    // 相对路径按 .env 同款候选解析（cwd 或仓库根）
    const p = config.credentials.masterKeyFile;
    const file = path.isAbsolute(p)
      ? p
      : [path.resolve(process.cwd(), p), path.resolve(process.cwd(), "../..", p)].find(existsSync);
    if (!file) throw new Error(`主密钥文件不存在: ${p}`);
    raw = readFileSync(file, "utf8").trim();
  } else if (config.credentials.masterKey) {
    raw = config.credentials.masterKey.trim();
  }
  if (!raw) {
    cachedKey = null;
    throw new Error("未配置主密钥（DEEPSONAR_MASTER_KEY_FILE），凭据功能不可用");
  }
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new Error("主密钥必须是 32 字节（64 hex 或 base64）");
  cachedKey = buf;
  return buf;
}

export interface Encrypted {
  ciphertext: string;
  nonce: string;
  auth_tag: string;
}

export function encryptSecret(plaintext: string): Encrypted {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), nonce);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ct.toString("base64"),
    nonce: nonce.toString("base64"),
    auth_tag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptSecret(e: Pick<Encrypted, "ciphertext" | "nonce" | "auth_tag">): string {
  const decipher = createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(e.nonce, "base64"));
  decipher.setAuthTag(Buffer.from(e.auth_tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(e.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export function fingerprintOf(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex").slice(0, 16);
}

export function last4Of(plaintext: string): string {
  return plaintext.slice(-4);
}

/** Credential 公共元数据中的模型白名单；空数组表示不额外限制。 */
export function allowedModelIds(metadata: unknown): string[] {
  const raw = (metadata as { allowed_model_ids?: unknown } | null)?.allowed_model_ids;
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean))];
}

export interface CredentialConcurrencyPolicy {
  /** Credential 下所有模型共享的总并发；null 表示不单独限制。 */
  maxConcurrent: number | null;
  /** Credential 内单个已启用模型的并发；缺省模型按 1 处理。 */
  modelConcurrency: Record<string, number>;
}

function concurrencyLimit(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 1000 ? n : null;
}

/**
 * Credential 运行配额。allowed_model_ids 一旦存在，每个模型都必须有独立上限；
 * 为兼容旧元数据，缺失的 model_concurrency 项按 1 处理。
 */
export function credentialConcurrencyPolicy(metadata: unknown): CredentialConcurrencyPolicy {
  const meta = (metadata ?? {}) as Record<string, unknown>;
  const allowed = allowedModelIds(meta);
  const rawModels = meta.model_concurrency;
  const configured = rawModels && typeof rawModels === "object" && !Array.isArray(rawModels)
    ? rawModels as Record<string, unknown>
    : {};
  const modelConcurrency: Record<string, number> = {};
  for (const model of allowed) {
    modelConcurrency[model] = concurrencyLimit(configured[model]) ?? 1;
  }
  return {
    maxConcurrent: concurrencyLimit(meta.max_concurrent),
    modelConcurrency,
  };
}

/**
 * 固定 Provider → 环境变量映射（§6.2：用户不能自由填写变量名，取代 env_keys）。
 * 值来自 Credential 解密结果；base_url 等非密钥项走 public_metadata_json。
 */
export const PROVIDER_ENV_MAP: Record<string, { secretKeys: string[]; baseUrlKey?: string; defaultBaseUrl?: string }> = {
  anthropic: {
    secretKeys: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
    baseUrlKey: "ANTHROPIC_BASE_URL",
    defaultBaseUrl: "https://api.anthropic.com",
  },
  kimi: {
    secretKeys: ["ANTHROPIC_AUTH_TOKEN"],
    baseUrlKey: "ANTHROPIC_BASE_URL",
    defaultBaseUrl: "https://api.kimi.com/coding",
  },
  openai: { secretKeys: ["OPENAI_API_KEY"], baseUrlKey: "OPENAI_BASE_URL", defaultBaseUrl: "https://api.openai.com" },
  openrouter: { secretKeys: ["OPENROUTER_API_KEY"] },
  plane: { secretKeys: ["PLANE_API_TOKEN"] },
  git: { secretKeys: ["GIT_TOKEN"] },
};

export function isProviderKnown(provider: string): boolean {
  return provider in PROVIDER_ENV_MAP;
}

/** 校验 Agent CLI 与 Credential Provider 的已知兼容关系。返回 null 表示兼容。 */
export function validateCredentialCompatibility(agentCli: string, provider: string): string | null {
  if (agentCli === "claude-code" && provider !== "anthropic" && provider !== "kimi") {
    return `agent_cli claude-code 仅兼容 anthropic/kimi，不能使用 provider ${provider}`;
  }
  return null;
}

export interface CredentialRuntimeConsumer {
  source: string;
  agentCli: string;
  model: string | null;
  projectId: string | null;
}

export interface CredentialRoleConfigBinding {
  source: string;
  purpose: string;
  agentCli: string;
  model: string | null;
  credentialProjectId: string | null;
  roleConfigProjectId: string | null;
  provider: string;
  metadata: unknown;
}

/** 校验 Credential 运行语义变更不会破坏既有 RoleConfig 或活动/待运行 Job。 */
export function validateCredentialRuntimeMutation(input: {
  provider: string;
  projectId: string | null;
  metadata: unknown;
  consumers: CredentialRuntimeConsumer[];
}): string | null {
  if (!isProviderKnown(input.provider)) return `未知 provider: ${input.provider}`;
  const allowed = allowedModelIds(input.metadata);
  for (const consumer of input.consumers) {
    const compatibilityError = validateCredentialCompatibility(consumer.agentCli, input.provider);
    if (compatibilityError) return `${consumer.source} 不兼容：${compatibilityError}`;
    if (input.projectId && consumer.projectId !== input.projectId) {
      return `${consumer.source} 属于${consumer.projectId ? `项目 ${consumer.projectId}` : "全局配置"}，不能使用项目 ${input.projectId} 的 Credential`;
    }
    if (allowed.length > 0 && !consumer.model) {
      return `${consumer.source} 未显式选择模型，不能绑定已启用模型白名单的 Credential`;
    }
    if (consumer.model && allowed.length > 0 && !allowed.includes(consumer.model)) {
      return `${consumer.source} 的模型 ${consumer.model} 不在 Credential allowed_model_ids 白名单`;
    }
  }
  return null;
}

/** Validate one imported/API RoleConfig binding against a Credential snapshot. */
export function validateCredentialRoleConfigBinding(input: CredentialRoleConfigBinding): string | null {
  if (input.credentialProjectId && input.credentialProjectId !== input.roleConfigProjectId) {
    if (!input.roleConfigProjectId) return `全局 RoleConfig 只能绑定全局 Credential（${input.source}）`;
    return `${input.source} 属于项目 ${input.credentialProjectId}，不能绑定到项目 ${input.roleConfigProjectId}`;
  }
  if (input.purpose !== "llm") return null;
  return validateCredentialRuntimeMutation({
    provider: input.provider,
    projectId: input.credentialProjectId,
    metadata: input.metadata,
    consumers: [{
      source: input.source,
      agentCli: input.agentCli,
      model: input.model,
      projectId: input.roleConfigProjectId,
    }],
  });
}
