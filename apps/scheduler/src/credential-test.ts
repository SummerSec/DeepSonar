import {
  CREDENTIAL_MODEL_ID_MAX_LENGTH,
  CREDENTIAL_MODEL_CATALOG_MAX,
  CredentialMetadataError,
  normalizeModelCatalog,
  projectCredentialMetadata,
  isProviderKnown,
  type CredentialHealthErrorCategory,
} from "./credentials.js";
import { decryptSecret, PROVIDER_ENV_MAP } from "./credentials.js";
import { extractBaseUrlFromSettings } from "./provider-settings.js";

/** Provider response bytes accepted by model discovery (before JSON parsing). */
export const CREDENTIAL_PROVIDER_RESPONSE_MAX_BYTES = 256 * 1024;

type CredentialProbe = {
  provider: string;
  kind?: string;
  ciphertext: string;
  nonce: string;
  auth_tag: string;
  public_metadata_json: unknown;
  /** CC Switch settingsConfig; used when public_metadata lacks base_url. */
  settings_config_json?: unknown;
};

type CredentialRequestInput = Pick<
  CredentialProbe,
  "provider" | "kind" | "public_metadata_json" | "settings_config_json"
>;

export type CredentialProbeResult = {
  ok: boolean;
  detail: string;
  category?: CredentialHealthErrorCategory;
  source_url?: string;
  fetched_at: string;
};

/** Optional Provider /models catalog. Probe failure never throws for network/HTTP/empty responses. */
export type ModelCatalogDiscovery = {
  models: string[];
  source_url?: string;
  fetched_at: string | null;
  available: boolean;
  category?: CredentialHealthErrorCategory;
  detail?: string;
};

export class CredentialProbeError extends Error {
  constructor(
    message: string,
    public readonly category: CredentialHealthErrorCategory,
  ) {
    super(message);
    this.name = "CredentialProbeError";
  }
}

function now(): string {
  return new Date().toISOString();
}

function safeSourceUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error("unsafe URL");
    }
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/u, "")}`;
  } catch {
    throw new CredentialProbeError("Provider URL 配置无效", "configuration");
  }
}

const ANTHROPIC_COMPAT_SUFFIXES = [
  "/api/claudecode",
  "/apps/anthropic",
  "/api/anthropic",
  "/api/coding",
  "/claudecode",
  "/anthropic",
  "/step_plan",
  "/coding",
  "/claude",
] as const;

function modelUrls(root: string): string[] {
  const normalized = safeSourceUrl(root);
  const candidates = /\/v\d+$/iu.test(normalized)
    ? [`${normalized}/models`, `${normalized}/v1/models`]
    : [`${normalized}/v1/models`];
  const lower = normalized.toLowerCase();
  const suffix = ANTHROPIC_COMPAT_SUFFIXES.find((candidate) => lower.endsWith(candidate));
  if (suffix) {
    const compatibilityRoot = normalized.slice(0, -suffix.length).replace(/\/+$/u, "");
    candidates.push(`${compatibilityRoot}/v1/models`, `${compatibilityRoot}/models`);
  }
  return [...new Set(candidates.map(safeSourceUrl))];
}

function modelRequest(cred: CredentialRequestInput, secret: string): { urls: string[]; headers: Record<string, string> } {
  const mapping = PROVIDER_ENV_MAP[cred.provider];
  if (!isProviderKnown(cred.provider) || !mapping) throw new CredentialProbeError("Provider 未在服务器允许列表", "configuration");
  const metadata = projectCredentialMetadata(cred.kind ?? "llm_provider", cred.provider, cred.public_metadata_json);
  const fromSettings = extractBaseUrlFromSettings(cred.settings_config_json);
  const baseUrl = typeof metadata.base_url === "string" && metadata.base_url.trim()
    ? metadata.base_url.trim()
    : (fromSettings || mapping.defaultBaseUrl || "");
  if (!baseUrl) {
    throw new CredentialProbeError("Credential 缺少 Provider URL 配置（请在 metadata.base_url 或 settingsConfig 中填写）", "configuration");
  }
  return {
    urls: modelUrls(baseUrl),
    headers: cred.provider === "anthropic"
      ? { Authorization: `Bearer ${secret}`, "x-api-key": secret, "anthropic-version": "2023-06-01" }
      : { Authorization: `Bearer ${secret}` },
  };
}

function categoryForStatus(status: number): CredentialHealthErrorCategory {
  if (status === 401) return "authentication";
  if (status === 403) return "authorization";
  if (status === 408 || status === 504) return "timeout";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "upstream";
  return "unknown";
}

function detailForCategory(category: CredentialHealthErrorCategory, status?: number): string {
  if (status !== undefined) return `Provider 连接失败（${category}，HTTP ${status}）`;
  const labels: Record<CredentialHealthErrorCategory, string> = {
    configuration: "Provider 配置无效",
    authentication: "Provider 身份验证失败",
    authorization: "Provider 权限不足",
    rate_limited: "Provider 请求频率受限",
    timeout: "Provider 请求超时",
    network: "Provider 网络连接失败",
    upstream: "Provider 服务异常",
    invalid_response: "Provider 返回数据无法识别",
    unknown: "Provider 连接失败",
  };
  return labels[category];
}

function responseTooLarge(response: Response): boolean {
  const rawLength = response.headers.get("content-length");
  if (rawLength === null || !/^\d+$/u.test(rawLength.trim())) return false;
  try {
    return BigInt(rawLength.trim()) > BigInt(CREDENTIAL_PROVIDER_RESPONSE_MAX_BYTES);
  } catch {
    return true;
  }
}

function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" &&
    ((error as { name?: unknown }).name === "AbortError" ||
      (error as { name?: unknown }).name === "TimeoutError" ||
      (error as { code?: unknown }).code === "ABORT_ERR"));
}

/** 在不读取正文的路径释放上游响应体。 */
async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // 清理失败不得掩盖固定的健康检查结果。
  }
}

type CandidateRequestSuccess = { ok: true; url: string; response: Response };
type CandidateRequestFailure = { ok: false; url: string; status: number };
type CandidateRequestResult = CandidateRequestSuccess | CandidateRequestFailure;

/** 仅在 404/405 时按顺序尝试下一候选，其他失败立即返回。 */
async function requestModelCandidate(
  request: { urls: string[]; headers: Record<string, string> },
  timeoutMs: number,
): Promise<CandidateRequestResult> {
  let lastMissing: CandidateRequestFailure | undefined;
  for (const url of request.urls) {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: request.headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const category: CredentialHealthErrorCategory = isAbortError(error) ? "timeout" : "network";
      throw new CredentialProbeError(detailForCategory(category), category);
    }
    if (response.ok) return { ok: true, url, response };

    await cancelResponseBody(response);
    const failure: CandidateRequestFailure = { ok: false, url, status: response.status };
    if (response.status !== 404 && response.status !== 405) return failure;
    lastMissing = failure;
  }
  // modelUrls 始终至少产生一个候选；此处保留显式配置错误以防未来调用约束变化。
  if (!lastMissing) throw new CredentialProbeError("Provider URL 配置无效", "configuration");
  return lastMissing;
}

/** Read a bounded JSON body without ever buffering an untrusted response in full. */
async function readJsonBounded(response: Response): Promise<unknown> {
  if (responseTooLarge(response)) {
    await cancelResponseBody(response);
    throw new CredentialProbeError("Provider 返回数据过大", "invalid_response");
  }
  const body = response.body;
  if (!body) throw new CredentialProbeError("Provider 返回数据无法识别", "invalid_response");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > CREDENTIAL_PROVIDER_RESPONSE_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new CredentialProbeError("Provider 返回数据过大", "invalid_response");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof CredentialProbeError) throw error;
    if (isAbortError(error)) throw new CredentialProbeError("Provider 请求超时", "timeout");
    throw new CredentialProbeError("Provider 返回数据无法识别", "invalid_response");
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8")) as unknown;
  } catch {
    throw new CredentialProbeError(detailForCategory("invalid_response"), "invalid_response");
  }
}

function modelRows(payload: unknown): unknown[] {
  if (!payload || typeof payload !== "object") return [];
  if ("data" in payload && Array.isArray(payload.data)) return payload.data;
  if ("models" in payload && Array.isArray(payload.models)) return payload.models;
  return [];
}

function modelId(row: unknown): string {
  if (typeof row === "string") return row;
  if (row && typeof row === "object" && "id" in row && typeof row.id === "string") return row.id;
  return "";
}

async function summarizeResponse(result: CandidateRequestResult): Promise<CredentialProbeResult> {
  const sourceUrl = safeSourceUrl(result.url);
  if (result.ok) {
    await cancelResponseBody(result.response);
    return {
      ok: true,
      detail: `连接成功（HTTP ${result.response.status}）`,
      source_url: sourceUrl,
      fetched_at: now(),
    };
  }
  const category = categoryForStatus(result.status);
  // 不读取或持久化上游正文；其中可能包含 URL、请求 ID 或意外回显的密钥。
  return {
    ok: false,
    detail: detailForCategory(category, result.status),
    category,
    source_url: sourceUrl,
    fetched_at: now(),
  };
}

function assertModelCatalogSupported(provider: string): void {
  if (!['anthropic', 'openai'].includes(provider)) {
    throw new CredentialProbeError("该 Provider 暂不支持模型目录", "configuration");
  }
}

function catalogUnavailable(
  category: CredentialHealthErrorCategory,
  detail: string,
  sourceUrl?: string,
): ModelCatalogDiscovery {
  return {
    models: [],
    fetched_at: null,
    available: false,
    category,
    detail,
    ...(sourceUrl ? { source_url: sourceUrl } : {}),
  };
}

async function discoverModelCatalogWithSecret(
  cred: CredentialRequestInput,
  secret: string,
): Promise<ModelCatalogDiscovery> {
  if (!["anthropic", "openai"].includes(cred.provider)) {
    return catalogUnavailable("configuration", "该 Provider 暂不支持模型目录");
  }
  try {
    const result = await requestModelCandidate(modelRequest(cred, secret), 15_000);
    if (!result.ok) {
      const category = categoryForStatus(result.status);
      return catalogUnavailable(category, detailForCategory(category, result.status), safeSourceUrl(result.url));
    }
    const payload = await readJsonBounded(result.response);
    const models = normalizeModelCatalog(modelRows(payload).map(modelId))
      .slice(0, CREDENTIAL_MODEL_CATALOG_MAX)
      .map((model) => model.slice(0, CREDENTIAL_MODEL_ID_MAX_LENGTH));
    return {
      models,
      source_url: safeSourceUrl(result.url),
      fetched_at: now(),
      available: true,
    };
  } catch (error) {
    if (error instanceof CredentialProbeError) {
      return catalogUnavailable(error.category, error.message);
    }
    const category: CredentialHealthErrorCategory = isAbortError(error)
      ? "timeout"
      : error instanceof CredentialMetadataError
        ? "configuration"
        : "network";
    return catalogUnavailable(category, detailForCategory(category));
  }
}

function requireCatalogSecret(cred: CredentialProbe): string {
  assertModelCatalogSupported(cred.provider);
  try {
    return decryptSecret(cred);
  } catch {
    throw new CredentialProbeError("Credential 解密失败", "configuration");
  }
}

/** 从 Provider 的只读 models 接口发现可用模型 ID；探测失败软降级为空目录，不回传响应正文或凭据。 */
export async function discoverModelCatalog(cred: CredentialProbe): Promise<ModelCatalogDiscovery> {
  return discoverModelCatalogWithSecret(cred, requireCatalogSecret(cred));
}

export async function listCredentialModels(cred: CredentialProbe): Promise<ModelCatalogDiscovery> {
  return discoverModelCatalog(cred);
}

/** Probe an unsaved credential without writing its secret or model catalog. */
export async function listCredentialModelsPreview(
  cred: Omit<CredentialProbe, "ciphertext" | "nonce" | "auth_tag">,
  secret: string,
): Promise<ModelCatalogDiscovery> {
  if (!secret.trim()) throw new CredentialProbeError("Credential 缺少 API Key", "configuration");
  assertModelCatalogSupported(cred.provider);
  return discoverModelCatalogWithSecret(cred, secret);
}

/**
 * Credential connection test.  The returned detail is platform-generated;
 * upstream body text, URL query strings and credentials never leave process.
 */
export async function testCredential(cred: CredentialProbe): Promise<CredentialProbeResult> {
  const mapping = PROVIDER_ENV_MAP[cred.provider];
  if (!isProviderKnown(cred.provider) || !mapping) {
    return { ok: false, detail: detailForCategory("configuration"), category: "configuration", fetched_at: now() };
  }

  let secret: string;
  try {
    secret = decryptSecret(cred);
  } catch {
    return { ok: false, detail: detailForCategory("configuration"), category: "configuration", fetched_at: now() };
  }

  try {
    if (!['anthropic', 'openai'].includes(cred.provider)) {
      return {
        ok: false,
        detail: "该 Provider 暂不支持连接测试",
        category: "configuration",
        fetched_at: now(),
      };
    }
    const result = await requestModelCandidate(modelRequest(cred, secret), 10_000);
    return await summarizeResponse(result);
  } catch (error) {
    if (error instanceof CredentialProbeError) {
      return { ok: false, detail: error.message, category: error.category, fetched_at: now() };
    }
    const category: CredentialHealthErrorCategory = isAbortError(error)
      ? "timeout"
      : error instanceof CredentialMetadataError
        ? "configuration"
        : "network";
    return { ok: false, detail: detailForCategory(category), category, fetched_at: now() };
  }
}
