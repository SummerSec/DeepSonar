import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { resolveEffectiveModel } from "./provider-effective-model.js";

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
const LLM_METADATA_KEYS_NO_BASE_URL = new Set(["allowed_model_ids", "model_concurrency", "max_concurrent"]);
const OCI_METADATA_KEYS = new Set(["registry", "username"]);

export class CredentialMetadataError extends Error {
  constructor(message: string, public readonly key?: string) {
    super(message);
    this.name = "CredentialMetadataError";
  }
}

/** Provider failures are intentionally generic: provider is user-controlled
 * input and must not be copied into API error text or error metadata. */
export const UNKNOWN_PROVIDER_ERROR = "未知 provider（固定映射表外的 provider 不允许登记）";

/** Scheduler-owned Provider catalog. Keep capability flags beside the runtime
 * mapping so API/UI choices cannot drift from credential-test behavior. */
export const PROVIDER_CATALOG = [
  { provider: "anthropic", label: "Anthropic Messages", kind: "llm_provider", auth_methods: ["api_key"], compatible_agent_cli: ["claude-code", "open-code"], supports_base_url: true },
  { provider: "openai", label: "OpenAI Responses", kind: "llm_provider", auth_methods: ["api_key"], compatible_agent_cli: ["codex", "open-code"], supports_base_url: true },
  { provider: "plane", label: "Plane", kind: "plane", auth_methods: ["api_key"], compatible_agent_cli: [], supports_base_url: false },
  { provider: "git", label: "Git repository", kind: "git", auth_methods: ["api_key"], compatible_agent_cli: [], supports_base_url: false },
  { provider: "docker", label: "OCI Registry", kind: "oci_registry", auth_methods: ["api_key"], compatible_agent_cli: [], supports_base_url: false },
] as const;

export function providerCatalogEntry(kind: string, provider: string): (typeof PROVIDER_CATALOG)[number] | null {
  return PROVIDER_CATALOG.find((entry) => entry.kind === kind && entry.provider === provider) ?? null;
}

export function providerSupportsBaseUrl(kind: string, provider: string): boolean {
  return providerCatalogEntry(kind, provider)?.supports_base_url === true;
}

/** Public metadata keys supported for a Credential kind/provider pair. */
export function credentialMetadataKeys(kind: string, provider: string): ReadonlySet<string> {
  if (kind === "llm_provider" && providerCatalogEntry(kind, provider)) {
    return providerSupportsBaseUrl(kind, provider) ? LLM_METADATA_KEYS : LLM_METADATA_KEYS_NO_BASE_URL;
  }
  if (kind === "oci_registry") return OCI_METADATA_KEYS;
  // Plane/Git credentials currently carry no provider-specific public fields.
  // Keeping the set explicit means future fields must be reviewed here first.
  return new Set<string>();
}

/** Provider/kind pairs accepted by Credential routes. */
export function isProviderAllowedForKind(kind: string, provider: string): boolean {
  if (kind === "llm_provider") return providerCatalogEntry(kind, provider) !== null;
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

function normalizeModelIds(value: unknown, mode: CredentialMetadataMode): string[] {
  if (!Array.isArray(value)) throw new CredentialMetadataError("metadata.allowed_model_ids 必须是数组", "allowed_model_ids");
  if (mode === "reject" && value.length > CREDENTIAL_MODEL_CATALOG_MAX) {
    throw new CredentialMetadataError("metadata.allowed_model_ids 数量超限", "allowed_model_ids");
  }
  const result: string[] = [];
  for (const item of value) {
    try {
      const model = cleanMetadataString(item, "allowed_model_ids", CREDENTIAL_MODEL_ID_MAX_LENGTH);
      if (!result.includes(model)) result.push(model);
      if (result.length >= CREDENTIAL_MODEL_CATALOG_MAX) break;
    } catch (error) {
      if (mode === "reject") throw error;
      // Legacy/drop projections retain valid model IDs while removing only
      // malformed items; an invalid item must not discard the whole allowlist.
    }
  }
  return result;
}

function normalizeConcurrency(value: unknown, key: string, mode: CredentialMetadataMode): number {
  if (mode === "reject" && typeof value !== "number") {
    throw new CredentialMetadataError(`metadata.${key} 必须是 JSON number`, key);
  }
  if (typeof value !== "number") {
    throw new CredentialMetadataError(`metadata.${key} 必须是 JSON number`, key);
  }
  const number = value;
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
        // Do not echo attacker-controlled key text in an API error: callers
        // should learn only that the server-owned allowlist was violated.
        throw new CredentialMetadataError("metadata key 不在服务器允许列表");
      }
      continue;
    }
    try {
      if (key === "base_url") {
        output.base_url = normalizeBaseUrl(value);
      } else if (key === "allowed_model_ids") {
        output.allowed_model_ids = normalizeModelIds(value, mode);
      } else if (key === "max_concurrent") {
        if (value !== null && value !== "") {
          try {
            output.max_concurrent = normalizeConcurrency(value, key, mode);
          } catch (error) {
            if (mode === "reject") throw error;
            // Drop malformed legacy values without coercing strings/booleans.
          }
        }
      } else if (key === "model_concurrency") {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw new CredentialMetadataError("metadata.model_concurrency 必须是对象", key);
        }
        const configured = value as Record<string, unknown>;
        if (Object.keys(configured).length > CREDENTIAL_MODEL_CATALOG_MAX) {
          throw new CredentialMetadataError("metadata.model_concurrency 数量超限", key);
        }
        const normalized: Record<string, number> = {};
        for (const [model, limit] of Object.entries(configured)) {
          try {
            const normalizedModel = cleanMetadataString(model, "model_concurrency", CREDENTIAL_MODEL_ID_MAX_LENGTH);
            normalized[normalizedModel] = normalizeConcurrency(limit, "model_concurrency", mode);
          } catch (error) {
            if (mode === "reject") throw error;
            // Drop only the malformed legacy entry, retaining valid limits.
          }
        }
        if (mode === "reject" || Object.keys(normalized).length > 0) {
          output.model_concurrency = normalized;
        }
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
      const filtered = Object.fromEntries(
        Object.entries(configured).filter(([model]) => allowedModels.has(model)),
      );
      if (Object.keys(filtered).length > 0) output.model_concurrency = filtered;
      else delete output.model_concurrency;
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

/**
 * Scheduler-owned model catalog capability. LLM providers currently expose a
 * governed catalog endpoint, so a non-empty successful catalog is required
 * before binding. Non-LLM credentials are explicitly out of that gate; this
 * helper keeps that exception visible instead of silently treating failures as
 * an empty/unknown catalog.
 */
export type CredentialModelCatalogCapability = "required" | "unsupported";

const MODEL_CATALOG_CAPABILITY: Record<string, CredentialModelCatalogCapability> = {
  anthropic: "required",
  openai: "required",
};

export function credentialModelCatalogCapability(kind: string, provider: string): CredentialModelCatalogCapability {
  if (kind !== "llm_provider") return "unsupported";
  return MODEL_CATALOG_CAPABILITY[provider] ?? "unsupported";
}

export interface CredentialConcurrencyPolicy {
  /** Credential 下所有模型共享的总并发；null 表示不单独限制。 */
  maxConcurrent: number | null;
  /** Credential 内单个已启用模型的并发；缺省模型按 1 处理。 */
  modelConcurrency: Record<string, number>;
}

function concurrencyLimit(value: unknown): number | null {
  if (typeof value !== "number") return null;
  const n = value;
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
  openai: { secretKeys: ["OPENAI_API_KEY"], baseUrlKey: "OPENAI_BASE_URL", defaultBaseUrl: "https://api.openai.com" },
  plane: { secretKeys: ["PLANE_API_TOKEN"] },
  git: { secretKeys: ["GIT_TOKEN"] },
};

export function isProviderKnown(provider: string): boolean {
  return Object.prototype.hasOwnProperty.call(PROVIDER_ENV_MAP, provider);
}

export const UNKNOWN_PROVIDER_SENTINEL = "unknown";

export interface CredentialProviderProjection {
  provider: string;
  provider_valid: boolean;
}

/**
 * Project only the provider errors emitted by older Scheduler versions.  A
 * persisted Job error is otherwise user/target data and must be returned
 * verbatim; broad token/provider replacement would destroy useful evidence.
 *
 * These templates are the exact server-owned messages that used to interpolate
 * an unknown provider before the public provider projection was introduced.
 */
export function projectCredentialProviderError(value: unknown): unknown {
  if (typeof value !== "string" || value === UNKNOWN_PROVIDER_ERROR) return value;

  const unknownProvider = (provider: string): boolean => !isProviderKnown(provider.trim());
  const unknownProviderMessage = /^未知 Credential provider: ([^\r\n]+)$/u.exec(value);
  if (unknownProviderMessage && unknownProvider(unknownProviderMessage[1])) return UNKNOWN_PROVIDER_ERROR;

  const legacyProviderMessage = /^未知 provider: ([^\r\n]+)$/u.exec(value);
  if (legacyProviderMessage && unknownProvider(legacyProviderMessage[1])) return UNKNOWN_PROVIDER_ERROR;

  const staleSnapshotMessage = /^Credential provider 已从 ([^\r\n]+) 变更为 ([^\r\n]+)，Job 快照已过期，请刷新 pending Job 或 retry$/u.exec(value);
  if (staleSnapshotMessage && (unknownProvider(staleSnapshotMessage[1]) || unknownProvider(staleSnapshotMessage[2]))) {
    return UNKNOWN_PROVIDER_ERROR;
  }

  const incompatibleCliMessage = /^agent_cli claude-code 仅兼容 anthropic，不能使用 provider ([^\r\n]+)$/u.exec(value);
  if (incompatibleCliMessage && unknownProvider(incompatibleCliMessage[1])) return UNKNOWN_PROVIDER_ERROR;

  return value;
}

/** Project the Scheduler-owned runtime evidence nested in a Job payload. */
export function projectJobPayload(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const payload = { ...(value as Record<string, unknown>) };
  const evidence = payload.runtime_evidence;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return payload;

  const runtimeEvidence = { ...(evidence as Record<string, unknown>) };
  const rawProvider = runtimeEvidence.credential_provider;
  if (rawProvider !== null && rawProvider !== undefined && rawProvider !== "") {
    const projection = projectCredentialProvider("llm_provider", rawProvider);
    runtimeEvidence.credential_provider = projection.provider;
    runtimeEvidence.credential_provider_valid = projection.provider_valid;
  }
  payload.runtime_evidence = runtimeEvidence;
  return payload;
}

/** Project only the top-level Scheduler-owned provider field in an event. */
export function projectJobEventPayload(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const payload = { ...(value as Record<string, unknown>) };
  const rawProvider = payload.credential_provider;
  if (rawProvider !== null && rawProvider !== undefined && rawProvider !== "") {
    const projection = projectCredentialProvider("llm_provider", rawProvider);
    payload.credential_provider = projection.provider;
    payload.credential_provider_valid = projection.provider_valid;
  }
  return payload;
}

/**
 * Project a persisted provider into an outward/runtime-safe value.  Fixed
 * kinds use the scheduler-owned provider map.  OCI credentials intentionally
 * use a registry host, so only an exact host in the configured registry
 * allowlist is considered safe to expose.  Legacy/unknown values become a
 * stable sentinel and never cross an API, transfer, metric, or runtime error
 * boundary.
 */
export function projectCredentialProvider(kind: unknown, provider: unknown): CredentialProviderProjection {
  const kindValue = typeof kind === "string" ? kind : "";
  const raw = typeof provider === "string" ? provider.trim() : "";
  const configuredRegistries = config.images.allowedRegistries
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const valid = kindValue === "oci_registry"
    // The UI's OCI credential kind uses the logical provider "docker" while
    // metadata.registry carries the governed host.  Older imports may instead
    // store the host in provider; accept either representation only when it is
    // a configured registry.
    ? raw === "docker" || configuredRegistries.includes(raw.toLowerCase())
    : isProviderKnown(raw) && isProviderAllowedForKind(kindValue, raw);
  return valid
    ? { provider: raw, provider_valid: true }
    : { provider: UNKNOWN_PROVIDER_SENTINEL, provider_valid: false };
}

/** 校验 Agent CLI 与 Credential Provider 的已知兼容关系。返回 null 表示兼容。 */
export function validateCredentialCompatibility(agentCli: string, provider: string): string | null {
  if (!isProviderKnown(provider)) return UNKNOWN_PROVIDER_ERROR;
  if (!["claude-code", "codex", "open-code"].includes(agentCli)) return "未知 agent_cli 不允许绑定 Credential";
  if (agentCli === "claude-code" && provider !== "anthropic") return `agent_cli claude-code 仅兼容 anthropic，不能使用 provider ${provider}`;
  if (agentCli === "codex" && provider !== "openai") return `agent_cli codex 仅兼容 openai，不能使用 provider ${provider}`;
  if (agentCli === "open-code" && provider !== "anthropic" && provider !== "openai") return `agent_cli open-code 仅兼容 anthropic/openai，不能使用 provider ${provider}`;
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
  settingsConfig?: unknown;
  credentialAgentCli?: string | null;
}

/** 校验 Credential 运行语义变更不会破坏既有 RoleConfig 或活动/待运行 Job。 */
export function validateCredentialRuntimeMutation(input: {
  provider: string;
  projectId: string | null;
  metadata: unknown;
  settingsConfig?: unknown;
  credentialAgentCli?: string | null;
  consumers: CredentialRuntimeConsumer[];
}): string | null {
  if (!isProviderKnown(input.provider)) return UNKNOWN_PROVIDER_ERROR;
  const allowed = allowedModelIds(input.metadata);
  for (const consumer of input.consumers) {
    if (input.credentialAgentCli && input.credentialAgentCli !== consumer.agentCli) {
      return `${consumer.source} 使用 ${consumer.agentCli}，不能绑定 ${input.credentialAgentCli} 配置文件`;
    }
    const compatibilityError = validateCredentialCompatibility(consumer.agentCli, input.provider);
    if (compatibilityError) return `${consumer.source} 不兼容：${compatibilityError}`;
    if (input.projectId && consumer.projectId !== input.projectId) {
      return `${consumer.source} 属于${consumer.projectId ? `项目 ${consumer.projectId}` : "全局配置"}，不能使用项目 ${input.projectId} 的 Credential`;
    }
    const effectiveModel = resolveEffectiveModel({
      roleModel: consumer.model,
      agentCli: consumer.agentCli,
      settingsConfig: input.settingsConfig,
    });
    if (allowed.length > 0 && !effectiveModel) {
      return `${consumer.source} 的 Credential 配置文件未声明模型且 RoleConfig 未提供覆盖，不能使用已启用模型白名单的 Credential`;
    }
    if (effectiveModel && allowed.length > 0 && !allowed.includes(effectiveModel)) {
      return `${consumer.source} 的模型 ${effectiveModel} 不在 Credential allowed_model_ids 白名单`;
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
    settingsConfig: input.settingsConfig,
    credentialAgentCli: input.credentialAgentCli,
    consumers: [{
      source: input.source,
      agentCli: input.agentCli,
      model: input.model,
      projectId: input.roleConfigProjectId,
    }],
  });
}
