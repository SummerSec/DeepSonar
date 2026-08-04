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

/**
 * Credential metadata is public by design, but it is not an arbitrary JSON
 * extension point.  Keep this allowlist in the scheduler so API, transfer and
 * runtime consumers all apply the same projection.  Values are deliberately
 * validated by type/length/control characters only; model identifiers and
 * registry account names are user data and must not be filtered by token-like
 * heuristics.
 */
export type CredentialKind = "llm_provider" | "plane" | "git" | "oci_registry";
export type CredentialMetadataMode = "reject" | "drop";

export const CREDENTIAL_MODEL_CATALOG_MAX = 200;
export const CREDENTIAL_MODEL_ID_MAX_LENGTH = 200;
export const CREDENTIAL_METADATA_STRING_MAX_LENGTH = 500;

const SECRET_LIKE_METADATA_KEY = /(password|passwd|secret|token|api[_-]?key|authorization|cookie|private[_-]?key|access[_-]?key|credential|bearer)/i;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const LLM_METADATA_KEYS = new Set(["base_url", "allowed_model_ids", "model_concurrency", "max_concurrent"]);
const OCI_METADATA_KEYS = new Set(["registry", "username"]);

export class CredentialMetadataError extends Error {
  constructor(message: string, public readonly key?: string) {
    super(message);
    this.name = "CredentialMetadataError";
  }
}

/** Public metadata keys supported for a Credential kind/provider pair. */
export function credentialMetadataKeys(kind: string, provider: string): ReadonlySet<string> {
  if (kind === "llm_provider" && ["anthropic", "kimi", "openai", "openrouter"].includes(provider)) return LLM_METADATA_KEYS;
  if (kind === "oci_registry") return OCI_METADATA_KEYS;
  // Plane/Git credentials currently carry no provider-specific public fields.
  // Keeping the set explicit means future fields must be reviewed here first.
  return new Set<string>();
}

/** Provider/kind pairs accepted by Credential routes. */
export function isProviderAllowedForKind(kind: string, provider: string): boolean {
  if (kind === "llm_provider") return ["anthropic", "kimi", "openai", "openrouter"].includes(provider);
  if (kind === "plane") return provider === "plane";
  if (kind === "git") return provider === "git";
  // OCI provider is the registry host itself and is checked against the
  // configured registry allowlist by the route.
  return kind === "oci_registry";
}

function metadataRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new CredentialMetadataError("metadata 必须是对象");
  }
  return input as Record<string, unknown>;
}

function cleanMetadataString(value: unknown, key: string, maxLength = CREDENTIAL_METADATA_STRING_MAX_LENGTH): string {
  if (typeof value !== "string") throw new CredentialMetadataError(`metadata.${key} 必须是字符串`, key);
  const result = value.trim();
  if (!result) throw new CredentialMetadataError(`metadata.${key} 不能为空`, key);
  if (result.length > maxLength) throw new CredentialMetadataError(`metadata.${key} 超过长度限制`, key);
  if (CONTROL_CHARACTER.test(result)) throw new CredentialMetadataError(`metadata.${key} 含控制字符`, key);
  return result;
}

function normalizeBaseUrl(value: unknown): string {
  const raw = cleanMetadataString(value, "base_url");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new CredentialMetadataError("metadata.base_url 必须是有效 URL", "base_url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new CredentialMetadataError("metadata.base_url 只允许 http/https", "base_url");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new CredentialMetadataError("metadata.base_url 不得包含 userinfo、query 或 fragment", "base_url");
  }
  const pathname = parsed.pathname.replace(/\/+$/u, "");
  // URL#origin/host is normalized by the WHATWG parser and contains no query
  // or credentials.  Preserve a provider path (for example /coding/v1).
  return `${parsed.origin}${pathname}`;
}

function normalizeModelIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new CredentialMetadataError("metadata.allowed_model_ids 必须是数组", "allowed_model_ids");
  if (value.length > CREDENTIAL_MODEL_CATALOG_MAX) {
    throw new CredentialMetadataError("metadata.allowed_model_ids 数量超限", "allowed_model_ids");
  }
  const result: string[] = [];
  for (const item of value) {
    const model = cleanMetadataString(item, "allowed_model_ids", CREDENTIAL_MODEL_ID_MAX_LENGTH);
    if (!result.includes(model)) result.push(model);
  }
  return result;
}

function normalizeConcurrency(value: unknown, key: string, mode: CredentialMetadataMode): number {
  if (mode === "reject" && typeof value !== "number") {
    throw new CredentialMetadataError(`metadata.${key} 必须是 JSON number`, key);
  }
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 1000) {
    throw new CredentialMetadataError(`metadata.${key} 必须是 0..1000 的整数`, key);
  }
  return number;
}

/**
 * Normalize new/API metadata (`mode=reject`) or project old rows/transfers
 * (`mode=drop`).  Drop mode is intentionally lossy: unknown or malformed
 * legacy values are removed rather than copied to another plaintext field.
 */
export function sanitizeCredentialMetadata(
  input: unknown,
  options: { kind: string; provider: string; mode?: CredentialMetadataMode },
): Record<string, unknown> {
  const mode = options.mode ?? "reject";
  const record = metadataRecord(input);
  const allowed = credentialMetadataKeys(options.kind, options.provider);
  const output: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(record)) {
    if (SECRET_LIKE_METADATA_KEY.test(key) || !allowed.has(key)) {
      if (mode === "reject") {
        throw new CredentialMetadataError(`metadata key 不在服务器允许列表: ${key}`, key);
      }
      continue;
    }
    try {
      if (key === "base_url") {
        output.base_url = normalizeBaseUrl(value);
      } else if (key === "allowed_model_ids") {
        output.allowed_model_ids = normalizeModelIds(value);
      } else if (key === "max_concurrent") {
        if (value !== null && value !== "") output.max_concurrent = normalizeConcurrency(value, key, mode);
      } else if (key === "model_concurrency") {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw new CredentialMetadataError("metadata.model_concurrency 必须是对象", key);
        }
        const configured = value as Record<string, unknown>;
        if (Object.keys(configured).length > CREDENTIAL_MODEL_CATALOG_MAX) {
          throw new CredentialMetadataError("metadata.model_concurrency 数量超限", key);
        }
        output.model_concurrency = Object.fromEntries(
          Object.entries(configured).map(([model, limit]) => [
            cleanMetadataString(model, "model_concurrency", CREDENTIAL_MODEL_ID_MAX_LENGTH),
            normalizeConcurrency(limit, "model_concurrency", mode),
          ]),
        );
      } else if (key === "registry") {
        const registry = cleanMetadataString(value, key).toLowerCase();
        if (registry.includes("://") || registry.includes("@") || registry.includes("?") || registry.includes("#")) {
          throw new CredentialMetadataError("metadata.registry 不得包含 scheme、userinfo、query 或 fragment", key);
        }
        if (!/^[a-z0-9][a-z0-9._:-]*(?:\/[a-z0-9._-]+)*$/iu.test(registry)) {
          throw new CredentialMetadataError("metadata.registry 格式非法", key);
        }
        output.registry = registry.replace(/\/+$/u, "");
      } else if (key === "username") {
        output.username = cleanMetadataString(value, key, 200);
      }
    } catch (error) {
      if (mode === "reject") throw error;
      // Existing rows are sanitized by dropping malformed fields, never by
      // preserving their original value.
    }
  }

  // model_concurrency is meaningful only for the explicit model allowlist.
  if (Array.isArray(output.allowed_model_ids)) {
    const allowedModels = new Set(output.allowed_model_ids as string[]);
    const configured = output.model_concurrency as Record<string, number> | undefined;
    if (configured) {
      output.model_concurrency = Object.fromEntries(
        Object.entries(configured).filter(([model]) => allowedModels.has(model)),
      );
    }
  } else {
    delete output.model_concurrency;
  }
  return output;
}

/** Safe projection for DB rows/transfers; never throws for legacy garbage. */
export function projectCredentialMetadata(kind: string, provider: string, input: unknown): Record<string, unknown> {
  try {
    return sanitizeCredentialMetadata(input ?? {}, { kind, provider, mode: "drop" });
  } catch {
    return {};
  }
}

/** Bound and normalize model IDs persisted from a Provider response. */
export function normalizeModelCatalog(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const output: string[] = [];
  for (const value of input) {
    if (typeof value !== "string") continue;
    const model = value.trim();
    if (!model || model.length > CREDENTIAL_MODEL_ID_MAX_LENGTH || CONTROL_CHARACTER.test(model)) continue;
    if (!output.includes(model)) output.push(model);
    if (output.length >= CREDENTIAL_MODEL_CATALOG_MAX) break;
  }
  return output.sort((left, right) => left.localeCompare(right));
}

export type CredentialHealthStatus = "unknown" | "ok" | "error";
export type CredentialHealthErrorCategory =
  | "configuration"
  | "authentication"
  | "authorization"
  | "rate_limited"
  | "timeout"
  | "network"
  | "upstream"
  | "invalid_response"
  | "unknown";

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
