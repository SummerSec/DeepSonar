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
import { extractBaseUrlFromSettings, extractModelsFromSettings, splitPiModelRef } from "./provider-settings.js";

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
  /** Scheduler-owned model catalog; only used to pick a probe model id. */
  model_catalog_json?: unknown;
};

type CredentialRequestInput = Pick<
  CredentialProbe,
  "provider" | "kind" | "public_metadata_json" | "settings_config_json" | "model_catalog_json"
>;

export type CredentialProbeResult = {
  ok: boolean;
  detail: string;
  category?: CredentialHealthErrorCategory;
  source_url?: string;
  fetched_at: string;
  /** Which probe path produced this verdict; inference is the authoritative one. */
  probe_path?: CredentialProbePath;
};

/** 推理路径能证明「凭据可运行 Job」；目录路径只是补充证据。 */
type CredentialProbePath = "inference" | "models";

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

function resolveProbeBaseUrl(cred: CredentialRequestInput): string {
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
  return baseUrl;
}

function authHeaders(provider: string, secret: string): Record<string, string> {
  return provider === "anthropic"
    ? { Authorization: `Bearer ${secret}`, "x-api-key": secret, "anthropic-version": "2023-06-01" }
    : { Authorization: `Bearer ${secret}` };
}

function modelRequest(cred: CredentialRequestInput, secret: string): { urls: string[]; headers: Record<string, string> } {
  return { urls: modelUrls(resolveProbeBaseUrl(cred)), headers: authHeaders(cred.provider, secret) };
}

/** vendor PoC（opensandbox-cli-control.poc.ts）的最小推理调用口径。 */
const INFERENCE_PROBE_MAX_TOKENS = 8;

type InferenceProbeRequest = { url: string; headers: Record<string, string>; body: string };

/**
 * 推理探测使用的模型 id：优先 settingsConfig 声明的模型（与真实 Job 同一来源），
 * 退化到已保存的模型目录。用 splitPiModelRef 剥掉 Pi 的 `provider/model` 前缀，
 * 与 Pi 启动路径保持同一口径。没有可用模型时不探测推理路径。
 */
function inferenceProbeModel(cred: CredentialRequestInput): string | null {
  const candidates = [
    ...extractModelsFromSettings(cred.settings_config_json).map((model) => splitPiModelRef(model).modelId),
    ...normalizeModelCatalog(cred.model_catalog_json),
  ];
  return candidates.find((model) => model.trim().length > 0 && model.trim().length <= CREDENTIAL_MODEL_ID_MAX_LENGTH)?.trim() ?? null;
}

function inferenceProbeRequest(cred: CredentialRequestInput, secret: string): InferenceProbeRequest | null {
  const model = inferenceProbeModel(cred);
  if (!model) return null;
  const base = safeSourceUrl(resolveProbeBaseUrl(cred));
  return {
    url: cred.provider === "anthropic" ? `${base}/v1/messages` : `${base}/v1/chat/completions`,
    headers: { "content-type": "application/json", ...authHeaders(cred.provider, secret) },
    body: JSON.stringify({
      model,
      max_tokens: INFERENCE_PROBE_MAX_TOKENS,
      messages: [{ role: "user", content: "ping" }],
    }),
  };
}

/**
 * 2xx 与 400 都证明这次请求通过了 Provider 认证：400 只说明 ping 的模型/参数
 * 被拒，凭据本身可用（与 vendor PoC 的 assertVendorUpstreamStatus 同口径）。
 */
function inferenceStatusAccepted(status: number): boolean {
  return (status >= 200 && status < 300) || status === 400;
}

async function requestInferenceProbe(
  request: InferenceProbeRequest,
  timeoutMs: number,
): Promise<{ status: number; url: string }> {
  // 与目录探测同一口径：URL 已由 safeSourceUrl + Provider 允许列表校验（见 inferenceProbeRequest）。
  const url = request.url;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const category: CredentialHealthErrorCategory = isAbortError(error) ? "timeout" : "network";
    throw new CredentialProbeError(detailForCategory(category), category);
  }
  await cancelResponseBody(response);
  return { status: response.status, url: request.url };
}

/**
 * 目录发现路径的 401/403/404/405 只说明该路径不可用（第三方中转常常只实现
 * completions），不构成「账号不能调用模型」的结论，因此归为 unknown。
 */
function discoveryCategoryForStatus(status: number): CredentialHealthErrorCategory {
  return status === 401 || status === 403 || status === 404 || status === 405
    ? "unknown"
    : categoryForStatus(status);
}

function discoveryDetail(status: number, category: CredentialHealthErrorCategory): string {
  return category === "unknown"
    ? `Provider 模型目录不可用（HTTP ${status}）；该路径失败不代表推理调用不可用`
    : detailForCategory(category, status);
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

async function summarizeCatalogResponse(
  result: CandidateRequestResult,
  inferenceMissing: { status: number } | null,
): Promise<CredentialProbeResult> {
  const sourceUrl = safeSourceUrl(result.url);
  const suffix = inferenceMissing ? `；推理路径未实现（HTTP ${inferenceMissing.status}）` : "";
  if (result.ok) {
    await cancelResponseBody(result.response);
    return {
      ok: true,
      detail: inferenceMissing
        ? `模型目录可达（HTTP ${result.response.status}）${suffix}`
        : `连接成功（HTTP ${result.response.status}）`,
      source_url: sourceUrl,
      fetched_at: now(),
      probe_path: "models",
    };
  }
  const category = discoveryCategoryForStatus(result.status);
  // 不读取或持久化上游正文；其中可能包含 URL、请求 ID 或意外回显的密钥。
  return {
    ok: false,
    detail: `${discoveryDetail(result.status, category)}${suffix}`,
    category,
    source_url: sourceUrl,
    fetched_at: now(),
    probe_path: "models",
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
      const category = discoveryCategoryForStatus(result.status);
      return catalogUnavailable(category, discoveryDetail(result.status, category), safeSourceUrl(result.url));
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
    // 先探测推理路径：它才是「这份凭据能不能跑 Job」的证据。目录路径只作补充，
    // 因此目录侧 401/403/404/405 不再升级为 readiness 的认证失败。
    const inference = inferenceProbeRequest(cred, secret);
    let inferenceMissing: { status: number } | null = null;
    if (inference) {
      const probed = await requestInferenceProbe(inference, 10_000);
      if (inferenceStatusAccepted(probed.status)) {
        return {
          ok: true,
          detail: `推理调用已被 Provider 接受（HTTP ${probed.status}）`,
          source_url: safeSourceUrl(probed.url),
          fetched_at: now(),
          probe_path: "inference",
        };
      }
      if (probed.status !== 404 && probed.status !== 405) {
        const category = categoryForStatus(probed.status);
        return {
          ok: false,
          detail: detailForCategory(category, probed.status),
          category,
          source_url: safeSourceUrl(probed.url),
          fetched_at: now(),
          probe_path: "inference",
        };
      }
      // 404/405 说明该推理路径不存在（供应商计划不同），交回目录路径复核。
      inferenceMissing = probed;
    }
    const result = await requestModelCandidate(modelRequest(cred, secret), 10_000);
    return await summarizeCatalogResponse(result, inferenceMissing);
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
