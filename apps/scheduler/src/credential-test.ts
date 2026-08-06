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

export type CredentialProbeResult = {
  ok: boolean;
  detail: string;
  category?: CredentialHealthErrorCategory;
  source_url?: string;
  fetched_at: string;
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

function modelsUrl(root: string): string {
  const normalized = safeSourceUrl(root);
  if (/\/v\d+$/iu.test(normalized)) return `${normalized}/models`;
  return `${normalized}/v1/models`;
}

function modelRequest(cred: CredentialProbe, secret: string): { url: string; headers: Record<string, string> } {
  const mapping = PROVIDER_ENV_MAP[cred.provider];
  if (!isProviderKnown(cred.provider) || !mapping) throw new CredentialProbeError("Provider 未在服务器允许列表", "configuration");
  const metadata = projectCredentialMetadata(cred.kind ?? "llm_provider", cred.provider, cred.public_metadata_json);
  const fromSettings = extractBaseUrlFromSettings(cred.settings_config_json);
  const baseUrl = typeof metadata.base_url === "string" && metadata.base_url.trim()
    ? metadata.base_url.trim()
    : (fromSettings || mapping.defaultBaseUrl || "");
  if (cred.provider === "openrouter") {
    return { url: "https://openrouter.ai/api/v1/models", headers: { Authorization: `Bearer ${secret}` } };
  }
  if (!baseUrl && cred.provider !== "openai") {
    throw new CredentialProbeError("Credential 缺少 Provider URL 配置（请在 metadata.base_url 或 settingsConfig 中填写）", "configuration");
  }
  const url = modelsUrl(baseUrl || "https://api.openai.com");
  return {
    url,
    headers: cred.provider === "anthropic" || cred.provider === "kimi"
      ? { "x-api-key": secret, Authorization: `Bearer ${secret}`, "anthropic-version": "2023-06-01" }
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

/** Release an upstream body on every status-only probe path. */
async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best-effort cleanup must never mask the fixed health result.
  }
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

async function summarizeResponse(url: string, response: Response): Promise<CredentialProbeResult> {
  const sourceUrl = safeSourceUrl(url);
  if (response.ok) {
    await cancelResponseBody(response);
    return {
      ok: true,
      detail: `连接成功（HTTP ${response.status}）`,
      source_url: sourceUrl,
      fetched_at: now(),
    };
  }
  await cancelResponseBody(response);
  const category = categoryForStatus(response.status);
  // Never read or persist upstream body text: it routinely contains URLs,
  // request IDs, or accidental key echoes.  The status/category is enough.
  return {
    ok: false,
    detail: detailForCategory(category, response.status),
    category,
    source_url: sourceUrl,
    fetched_at: now(),
  };
}

/** 从 Provider 的只读 models 接口发现可用模型 ID；不回传响应正文或凭据。 */
export async function listCredentialModels(cred: CredentialProbe): Promise<{
  models: string[];
  source_url: string;
  fetched_at: string;
}> {
  if (!['anthropic', 'kimi', 'openai', 'openrouter'].includes(cred.provider)) {
    throw new CredentialProbeError("该 Provider 暂不支持模型目录", "configuration");
  }
  let secret: string;
  try {
    secret = decryptSecret(cred);
  } catch {
    throw new CredentialProbeError("Credential 解密失败", "configuration");
  }
  const request = modelRequest(cred, secret);
  const sourceUrl = safeSourceUrl(request.url);
  let response: Response;
  try {
    response = await fetch(sourceUrl, { headers: request.headers, signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    const category: CredentialHealthErrorCategory = isAbortError(error)
      ? "timeout"
      : "network";
    throw new CredentialProbeError(detailForCategory(category), category);
  }
  if (!response.ok) {
    await cancelResponseBody(response);
    const category = categoryForStatus(response.status);
    throw new CredentialProbeError(detailForCategory(category, response.status), category);
  }

  const payload = await readJsonBounded(response) as { data?: unknown; models?: unknown };
  const rows = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : [];
  const models = normalizeModelCatalog(rows.map((row) => {
    if (typeof row === "string") return row;
    if (row && typeof row === "object" && typeof (row as { id?: unknown }).id === "string") {
      return String((row as { id: string }).id);
    }
    return "";
  }));
  if (models.length === 0) throw new CredentialProbeError(detailForCategory("invalid_response"), "invalid_response");
  // normalizeModelCatalog enforces the same bounded limits used by the DB;
  // retain the constants in this module as an explicit contract guard.
  return {
    models: models.slice(0, CREDENTIAL_MODEL_CATALOG_MAX).map((model) => model.slice(0, CREDENTIAL_MODEL_ID_MAX_LENGTH)),
    source_url: sourceUrl,
    fetched_at: now(),
  };
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
    if (!['anthropic', 'kimi', 'openai', 'openrouter'].includes(cred.provider)) {
      return {
        ok: false,
        detail: "该 Provider 暂不支持连接测试",
        category: "configuration",
        fetched_at: now(),
      };
    }
    const request = modelRequest(cred, secret);
    const response = await fetch(safeSourceUrl(request.url), {
      headers: request.headers,
      signal: AbortSignal.timeout(10_000),
    });
    return await summarizeResponse(request.url, response);
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
