import {
  CREDENTIAL_MODEL_ID_MAX_LENGTH,
  CREDENTIAL_MODEL_CATALOG_MAX,
  CredentialMetadataError,
  normalizeModelCatalog,
  projectCredentialMetadata,
  isProviderKnown,
  type CredentialHealthErrorCategory,
} from "./credentials.js";
import { claudeCliFingerprintHeaders } from "./claude-cli-fingerprint.js";
import { collectSecretValues, redactSecretAssignments } from "./credential-secret-projection.js";
import { decryptSecret, PROVIDER_ENV_MAP } from "./credentials.js";
import {
  extractBaseUrlFromSettings,
  extractInferenceProtocol,
  extractModelsFromSettings,
  splitPiModelRef,
  type InferenceWireProtocol,
} from "./provider-settings.js";

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
  /** 推理探测失败时上游错误正文中的 error.type / error.message（已脱敏、截断，#748）。 */
  upstream_error?: UpstreamErrorSummary;
  /** 模型级失败（402/403/配额）后补做的目录发现结果；仅在目录可达时出现，由路由回填 model_catalog_json。 */
  model_catalog?: string[];
  model_catalog_source_url?: string;
  model_catalog_fetched_at?: string;
};

export type UpstreamErrorSummary = {
  type?: string;
  message?: string;
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

/** Same rule as joinGatewayUpstreamUrl: Base URL ending in /v1 must not become /v1/v1/... (#624). */
function joinProbeUpstreamUrl(baseUrl: string, upstreamPath: string): string {
  const base = baseUrl.replace(/\/+$/u, "");
  const path = upstreamPath.replace(/^\/+/u, "");
  const baseVer = /\/(v\d+)$/iu.exec(base)?.[1];
  const pathVer = /^(v\d+)(?=\/|$)/iu.exec(path)?.[1];
  if (baseVer && pathVer && baseVer.toLowerCase() === pathVer.toLowerCase()) {
    const rest = path.slice(pathVer.length).replace(/^\/+/u, "");
    return `${base}${rest ? `/${rest}` : ""}`;
  }
  return `${base}/${path}`;
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

/**
 * 推理探测与模型目录发现共用的认证头。Anthropic Messages 额外携带与 Claude Code
 * 运行时同口径的客户端指纹（`user-agent: claude-cli/<pin> (external, cli)` + `x-app: cli`），
 * 让 new-api 类中转的客户端校验结论与真实沙箱 Job 一致（#736）。
 * 与 #321（OpenAI-responses 按 body `input[0]` 识别客户端）相关但独立。
 * 与 gateway.ts upstreamAuthHeaders 保持同一口径。
 */
export function authHeadersForProtocol(protocol: InferenceWireProtocol, secret: string): Record<string, string> {
  return protocol === "anthropic-messages"
    ? {
      Authorization: `Bearer ${secret}`,
      "x-api-key": secret,
      "anthropic-version": "2023-06-01",
      ...claudeCliFingerprintHeaders(),
    }
    : { Authorization: `Bearer ${secret}` };
}

/** Prefer wire protocol from settings; fall back to Credential.provider for catalog probes. */
function resolveProbeProtocol(cred: CredentialRequestInput): InferenceWireProtocol {
  try {
    return extractInferenceProtocol(cred.settings_config_json, cred.provider);
  } catch (error) {
    const message = error instanceof Error ? error.message : "不支持的推理协议";
    throw new CredentialProbeError(message, "configuration");
  }
}

function modelRequest(cred: CredentialRequestInput, secret: string): { urls: string[]; headers: Record<string, string> } {
  return {
    urls: modelUrls(resolveProbeBaseUrl(cred)),
    headers: authHeadersForProtocol(resolveProbeProtocol(cred), secret),
  };
}

/** vendor PoC（opensandbox-cli-control.poc.ts）的最小推理调用口径。 */
const INFERENCE_PROBE_MAX_TOKENS = 8;

/** Inference probes must cover slow OpenAI-compatible relays (#624 field: chat/completions >10s). */
const INFERENCE_PROBE_TIMEOUT_MS: Record<InferenceWireProtocol, number> = {
  "anthropic-messages": 20_000,
  "openai-completions": 30_000,
  "openai-responses": 25_000,
};

const INFERENCE_PROBE_PATH: Record<InferenceWireProtocol, string> = {
  "anthropic-messages": "/v1/messages",
  "openai-completions": "/v1/chat/completions",
  "openai-responses": "/v1/responses",
};

type InferenceProbeRequest = {
  url: string;
  model: string;
  headers: Record<string, string>;
  body: string;
  protocol: InferenceWireProtocol;
  timeoutMs: number;
};

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

function inferenceProbeBody(protocol: InferenceWireProtocol, model: string): string {
  if (protocol === "openai-responses") {
    return JSON.stringify({
      model,
      max_output_tokens: INFERENCE_PROBE_MAX_TOKENS,
      input: "ping",
    });
  }
  return JSON.stringify({
    model,
    max_tokens: INFERENCE_PROBE_MAX_TOKENS,
    messages: [{ role: "user", content: "ping" }],
  });
}

function inferenceProbeRequest(cred: CredentialRequestInput, secret: string): InferenceProbeRequest | null {
  const model = inferenceProbeModel(cred);
  if (!model) return null;
  const protocol = resolveProbeProtocol(cred);
  const base = safeSourceUrl(resolveProbeBaseUrl(cred));
  const path = INFERENCE_PROBE_PATH[protocol];
  return {
    url: joinProbeUpstreamUrl(base, path),
    model,
    headers: { "content-type": "application/json", ...authHeadersForProtocol(protocol, secret) },
    body: inferenceProbeBody(protocol, model),
    protocol,
    timeoutMs: INFERENCE_PROBE_TIMEOUT_MS[protocol],
  };
}

/**
 * 2xx 与 400 都证明这次请求通过了 Provider 认证：400 只说明 ping 的模型/参数
 * 被拒，凭据本身可用（与 vendor PoC 的 assertVendorUpstreamStatus 同口径）。
 */
function inferenceStatusAccepted(status: number): boolean {
  return (status >= 200 && status < 300) || status === 400;
}

type InferenceProbeOutcome = {
  status: number;
  url: string;
  protocol: InferenceWireProtocol;
  clientRejected: boolean;
  /** 失败响应正文的有界前缀（≤ ERROR_BODY_PREFIX_MAX_BYTES），只在进程内解析，不直接回显。 */
  errorBody: string;
};

async function requestInferenceProbe(
  request: InferenceProbeRequest,
  timeoutMs: number,
): Promise<InferenceProbeOutcome> {
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
    const pathHint = INFERENCE_PROBE_PATH[request.protocol];
    const detail = category === "timeout"
      ? `Provider 推理探测超时（${request.protocol} ${pathHint}）`
      : detailForCategory(category);
    throw new CredentialProbeError(detail, category);
  }
  const errorBody = inferenceStatusAccepted(response.status) ? "" : await readBodyPrefix(response);
  await cancelResponseBody(response);
  const clientRejected = response.status === 401 && UNAUTHORIZED_CLIENT_PATTERN.test(errorBody);
  return { status: response.status, url: request.url, protocol: request.protocol, clientRejected, errorBody };
}

/** 上游防滥用层的客户端识别拒绝文案（new-api 类中转，#321 / #736）。 */
const UNAUTHORIZED_CLIENT_PATTERN = /unauthorized client/iu;
const ERROR_BODY_PREFIX_MAX_BYTES = 4096;

/** 只读取错误正文的有界前缀用于分类与摘要（摘要须经 summarizeUpstreamError 脱敏）；读取失败按空串处理。 */
async function readBodyPrefix(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < ERROR_BODY_PREFIX_MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } catch {
    return "";
  } finally {
    try {
      await reader.cancel();
    } catch {
      // 清理失败不影响分类。
    }
  }
  const merged = new Uint8Array(Math.min(total, ERROR_BODY_PREFIX_MAX_BYTES));
  let offset = 0;
  for (const chunk of chunks) {
    const slice = chunk.subarray(0, merged.byteLength - offset);
    merged.set(slice, offset);
    offset += slice.byteLength;
    if (offset >= merged.byteLength) break;
  }
  return new TextDecoder().decode(merged);
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
  if (status === 402) return "quota_exhausted";
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
    model_unavailable: "当前模型不可用",
    quota_exhausted: "Provider 额度或预算已耗尽",
    rate_limited: "Provider 请求频率受限",
    timeout: "Provider 请求超时",
    network: "Provider 网络连接失败",
    upstream: "Provider 服务异常",
    invalid_response: "Provider 返回数据无法识别",
    unknown: "Provider 连接失败",
  };
  return labels[category];
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]+/gu;
const UPSTREAM_ERROR_TYPE_MAX_CHARS = 64;
const UPSTREAM_ERROR_MESSAGE_MAX_CHARS = 120;
/** credentials.health_detail 的库约束上限（≤300 且无控制字符）。 */
const HEALTH_DETAIL_MAX_CHARS = 300;
/** 402/403/429 正文中的额度 / 预算耗尽信号（OpenAI `insufficient_quota`、new-api `Budget pool quota` 等）。 */
const QUOTA_EXHAUSTED_PATTERN = /quota|budget|insufficient[_\s-]?(?:balance|credit|funds)|billing|余额|额度|配额|欠费/iu;
const MODEL_REFERENCE_PATTERN = /model|模型/iu;

function cleanText(value: string, max: number): string {
  const flattened = value.replace(CONTROL_CHARACTERS, " ").replace(/\s+/gu, " ").trim();
  return flattened.length > max ? `${flattened.slice(0, max - 1)}…` : flattened;
}

/** 上游错误文本可能回显 Authorization、带查询串的 URL 或 key 本身；落库/回传前一律脱敏。 */
function redactUpstreamText(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret.length < 4) continue;
    redacted = redacted.split(secret).join("[REDACTED]");
    for (let prefixLength = Math.min(secret.length - 1, redacted.length); prefixLength >= 4; prefixLength -= 1) {
      const prefix = secret.slice(0, prefixLength);
      if (redacted.endsWith(prefix)) {
        redacted = `${redacted.slice(0, -prefixLength)}[REDACTED]`;
        break;
      }
    }
  }
  return redactSecretAssignments(redacted)
    .replace(/\b(Bearer|Basic)\s+[^\s"',;)]+/giu, "$1 [REDACTED]")
    .replace(/\b(?:sk|ak|pk|rk)-[A-Za-z0-9_-]{6,}/gu, "[REDACTED]")
    .replace(/(https?:\/\/)[^@\s/?#"'<>]+@/giu, "$1")
    .replace(/(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/giu, "$1");
}

function stringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  if (typeof field === "string" && field.trim()) return field;
  if (typeof field === "number" && Number.isFinite(field)) return String(field);
  return undefined;
}

/** 截断后的 JSON 前缀无法 JSON.parse；按字段名做尽力提取。 */
function jsonStringFieldFallback(body: string, key: string): string | undefined {
  const match = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`, "u").exec(body);
  if (!match?.[1]) return undefined;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return match[1];
  }
}

/**
 * 从推理失败正文的有界前缀（readBodyPrefix）提取 error.type / error.message：兼容
 * OpenAI / Anthropic / new-api 的 `{error:{type,message}}`、`{error:"..."}`、顶层
 * `{type,message}` 与纯文本正文。结果已脱敏并截断，可直接写入 health_detail。
 */
export function summarizeUpstreamError(body: string, secrets: readonly string[] = []): UpstreamErrorSummary | undefined {
  const text = body.trim();
  if (!text) return undefined;
  let type: string | undefined;
  let message: string | undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    parsed = undefined;
  }
  if (parsed && typeof parsed === "object") {
    const error = (parsed as Record<string, unknown>).error;
    if (error && typeof error === "object") {
      type = stringField(error, "type") ?? stringField(error, "code");
      message = stringField(error, "message");
    } else if (typeof error === "string" && error.trim()) {
      message = error;
    }
    type ??= stringField(parsed, "type") ?? stringField(parsed, "code");
    message ??= stringField(parsed, "message") ?? stringField(parsed, "detail");
  } else if (text.startsWith("{")) {
    type = jsonStringFieldFallback(text, "type") ?? jsonStringFieldFallback(text, "code");
    message = jsonStringFieldFallback(text, "message");
  } else if (!text.startsWith("<")) {
    // HTML 错误页没有可读摘要；其余纯文本按 message 处理。
    message = text;
  }
  const safeType = type
    ? cleanText(redactUpstreamText(type, secrets), UPSTREAM_ERROR_TYPE_MAX_CHARS)
    : "";
  const safeMessage = message
    ? cleanText(redactUpstreamText(message, secrets), UPSTREAM_ERROR_MESSAGE_MAX_CHARS)
    : "";
  if (!safeType && !safeMessage) return undefined;
  return {
    ...(/^[\w.:-]+$/u.test(safeType) ? { type: safeType } : {}),
    ...(safeMessage ? { message: safeMessage } : {}),
  };
}

/**
 * 推理失败的类别：402 或正文带额度信号 → quota_exhausted；403 且正文指向模型 →
 * model_unavailable；其余沿用状态码映射（#748）。
 */
function inferenceFailureCategory(
  status: number,
  upstream: UpstreamErrorSummary | undefined,
  model: string,
): CredentialHealthErrorCategory {
  const text = `${upstream?.type ?? ""} ${upstream?.message ?? ""}`;
  if (status === 402 || ((status === 403 || status === 429) && QUOTA_EXHAUSTED_PATTERN.test(text))) {
    return "quota_exhausted";
  }
  if (status === 403 && (text.toLowerCase().includes(model.toLowerCase()) || MODEL_REFERENCE_PATTERN.test(text))) {
    return "model_unavailable";
  }
  return categoryForStatus(status);
}

/** 402/403 与额度类失败属于「这把 key 对这个模型不可用」，值得补一次目录发现。 */
function isModelLevelFailure(status: number, category: CredentialHealthErrorCategory): boolean {
  return status === 402 || status === 403 || category === "quota_exhausted";
}

function formatModelList(models: readonly string[], budget: number): string {
  let output = "";
  for (let index = 0; index < models.length; index += 1) {
    const next = output ? `${output}、${models[index]}` : models[index];
    const rest = models.length - index - 1;
    const suffix = rest > 0 ? ` 等 ${models.length} 个` : "";
    if (next.length + suffix.length > budget) {
      return output ? `${output} 等 ${models.length} 个` : `共 ${models.length} 个`;
    }
    output = next;
  }
  return output;
}

function catalogHint(model: string, catalog: ModelCatalogDiscovery, budget: number): string {
  if (!catalog.available) return `；模型目录发现失败（${catalog.category ?? "unknown"}）`;
  if (catalog.models.length === 0) return "；模型目录为空";
  if (catalog.models.includes(model)) return `；当前模型 ${model} 在可用目录中（共 ${catalog.models.length} 个）`;
  const prefix = `；当前模型 ${model} 不可用，可用：`;
  return `${prefix}${formatModelList(catalog.models, Math.max(0, budget - prefix.length))}`;
}

async function summarizeInferenceFailure(
  cred: CredentialRequestInput,
  secret: string,
  model: string,
  probed: InferenceProbeOutcome,
): Promise<CredentialProbeResult> {
  const upstream = summarizeUpstreamError(probed.errorBody, [secret, ...collectSecretValues(cred.settings_config_json)]);
  let category = inferenceFailureCategory(probed.status, upstream, model);
  const clientHint = probed.clientRejected
    ? "；上游返回 unauthorized client：按客户端指纹拒绝，不一定是凭据无效（见 #736 / #321）"
    : "";
  // 客户端指纹拒绝已有固定提示，不再重复上游原文。
  const upstreamText = upstream && !probed.clientRejected
    ? `；上游${upstream.type ? ` ${upstream.type}` : ""}：${upstream.message ?? upstream.type ?? ""}`
    : "";
  const catalog = isModelLevelFailure(probed.status, category)
    ? await discoverModelCatalogWithSecret(cred, secret, 10_000)
    : null;
  if (category === "authorization" && catalog?.available && catalog.models.length > 0 && !catalog.models.includes(model)) {
    category = "model_unavailable";
  }
  const head = `Provider 推理探测失败（${probed.protocol}，${category}，HTTP ${probed.status}${clientHint}）${upstreamText}`;
  const detail = catalog ? `${head}${catalogHint(model, catalog, HEALTH_DETAIL_MAX_CHARS - head.length)}` : head;
  return {
    ok: false,
    detail: cleanText(detail, HEALTH_DETAIL_MAX_CHARS),
    category,
    source_url: safeSourceUrl(probed.url),
    fetched_at: now(),
    probe_path: "inference",
    ...(upstream ? { upstream_error: upstream } : {}),
    ...(catalog?.available && catalog.fetched_at
      ? {
        model_catalog: catalog.models,
        ...(catalog.source_url ? { model_catalog_source_url: catalog.source_url } : {}),
        model_catalog_fetched_at: catalog.fetched_at,
      }
      : {}),
  };
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
  timeoutMs = 15_000,
): Promise<ModelCatalogDiscovery> {
  if (!["anthropic", "openai"].includes(cred.provider)) {
    return catalogUnavailable("configuration", "该 Provider 暂不支持模型目录");
  }
  try {
    const result = await requestModelCandidate(modelRequest(cred, secret), timeoutMs);
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
 * Credential connection test.  The returned detail is platform-generated; the
 * only upstream text it carries is the inference error's error.type /
 * error.message, redacted and truncated by summarizeUpstreamError (#748).
 * Raw bodies, URL query strings and credentials never leave process.
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
      const probed = await requestInferenceProbe(inference, inference.timeoutMs);
      if (inferenceStatusAccepted(probed.status)) {
        return {
          ok: true,
          detail: `推理调用已被 Provider 接受（${probed.protocol}，HTTP ${probed.status}）`,
          source_url: safeSourceUrl(probed.url),
          fetched_at: now(),
          probe_path: "inference",
        };
      }
      if (probed.status !== 404 && probed.status !== 405) {
        return await summarizeInferenceFailure(cred, secret, inference.model, probed);
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
