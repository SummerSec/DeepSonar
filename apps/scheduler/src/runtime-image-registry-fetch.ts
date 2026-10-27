/**
 * 官方运行时镜像清单的抓取层（#761）。
 *
 * 清单由 `https://github.com/<repo>/releases/latest/download/...` 提供，该链路会
 * 302 到 `release-assets.githubusercontent.com`。在部分网络下首次连接会超过 10s，
 * 而旧实现每次请求只有一次 10s 硬超时、没有重试，于是表现为间歇性
 * `remote registry request timed out`。
 *
 * 本模块只负责「取字节」，规则保持可审计：
 * - **有界重试**：仅对瞬时错误（超时 / 连接重置 / 429 / 5xx）重试；鉴权、主机、
 *   重定向、载荷与体积错误立即失败，不做无意义重试。
 * - **双通道**：无 token 时先走公开 download 链路，最终失败再回退 api.github.com
 *   的 release asset。未鉴权的 api.github.com 限额 60 次/小时，本用途每小时 1 次。
 * - **信任边界不变**：主机 allowlist 原样保留，重定向到 release-assets/objects 时
 *   一律丢弃 Authorization。
 */

/** 公开通道：`releases/latest/download/<asset>`（302 到 release-assets）。 */
export const OFFICIAL_RUNTIME_IMAGE_REGISTRY_URL =
  "https://github.com/SummerSec/DeepSonar/releases/latest/download/runtime-image-registry.json";

/** 备选通道：api.github.com 的 latest release 元数据（未鉴权亦可读公开仓库）。 */
export const OFFICIAL_RUNTIME_IMAGE_REGISTRY_RELEASE_API_URL =
  "https://api.github.com/repos/SummerSec/DeepSonar/releases/latest";

/** 清单资产名，token 通道与备选通道都按该名字挑选资产。 */
export const RUNTIME_IMAGE_REGISTRY_ASSET_NAME = "runtime-image-registry.json";

const OFFICIAL_RUNTIME_IMAGE_REGISTRY_HOSTS = new Set([
  "github.com",
  "api.github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
]);

/** 只有固定信任边界内的主机才可能收到 Authorization。 */
const OFFICIAL_RUNTIME_IMAGE_REGISTRY_AUTH_HOSTS = new Set(["github.com", "api.github.com"]);

export const RUNTIME_IMAGE_REGISTRY_MAX_BYTES = 1024 * 1024;

/** 单次请求的硬超时；重试由调用方按 attempts 决定。 */
export const DEFAULT_REGISTRY_FETCH_TIMEOUT_MS = 10_000;
export const DEFAULT_REGISTRY_FETCH_ATTEMPTS = 3;
export const MAX_REGISTRY_FETCH_ATTEMPTS = 5;
const DEFAULT_RETRY_BACKOFF_MS = [300, 900];

/** 值得重试的 HTTP 状态：限流与网关/上游瞬时错误。 */
const RETRYABLE_HTTP_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** 值得重试的传输层错误文本。 */
const RETRYABLE_ERROR_TEXT =
  /timeout|timed out|aborted due to timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|EHOSTUNREACH|ENETUNREACH|socket hang up|fetch failed/i;

export type FetchGithubResourceOptions = {
  /** 单次请求超时，默认 10s；测试可注入更小值。 */
  timeoutMs?: number;
};

export type RegistryFetchRetryOptions = FetchGithubResourceOptions & {
  attempts?: number;
  backoffMs?: readonly number[];
  /** 测试注入 sleep，避免真实等待。 */
  sleep?: (ms: number) => Promise<void>;
};

/** 把 attempts 夹到 [1, 5]，非法值回落默认，避免运维误配放大请求量。 */
export function boundedRegistryFetchAttempts(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_REGISTRY_FETCH_ATTEMPTS;
  const floored = Math.floor(parsed);
  if (floored < 1) return 1;
  return Math.min(floored, MAX_REGISTRY_FETCH_ATTEMPTS);
}

/**
 * 抓取一个 GitHub 资源（带手动重定向与凭据丢弃）。
 *
 * 保持既有语义：只允许 allowlist 主机；重定向最多 5 跳；跨到 release-assets /
 * objects 后不再携带 Authorization；响应体与声明长度都受 1 MiB 上限约束。
 */
export async function fetchGithubResource(
  target: URL,
  accept: string,
  token?: string,
  options: FetchGithubResourceOptions = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REGISTRY_FETCH_TIMEOUT_MS;
  let authorization = token ? `Bearer ${token}` : undefined;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    if (target.protocol !== "https:" || !OFFICIAL_RUNTIME_IMAGE_REGISTRY_HOSTS.has(target.hostname)) {
      throw new Error("official registry host rejected");
    }
    const headers: Record<string, string> = { accept, "user-agent": "DeepSonar-Scheduler/1" };
    // Never carry the GitHub token to release-assets/objects or an arbitrary
    // redirect target. Only the fixed github.com/api.github.com trust boundary
    // may receive Authorization.
    if (authorization && OFFICIAL_RUNTIME_IMAGE_REGISTRY_AUTH_HOSTS.has(target.hostname)) {
      headers.authorization = authorization;
    }
    const response = await fetch(target, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers,
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirects >= 5) throw new Error("official registry redirect rejected");
      const next = new URL(location, target);
      // A redirect to release-assets/objects is allowed for GitHub release
      // assets, but the token is deliberately dropped on the next request.
      if (next.protocol !== "https:" || !OFFICIAL_RUNTIME_IMAGE_REGISTRY_HOSTS.has(next.hostname)) {
        throw new Error("official registry redirect host rejected");
      }
      target = next;
      authorization = undefined;
      continue;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const finalUrl = new URL(response.url || target.toString());
    if (finalUrl.protocol !== "https:" || !OFFICIAL_RUNTIME_IMAGE_REGISTRY_HOSTS.has(finalUrl.hostname)) {
      throw new Error("official registry final host rejected");
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > RUNTIME_IMAGE_REGISTRY_MAX_BYTES) {
      throw new Error(`official registry exceeds ${RUNTIME_IMAGE_REGISTRY_MAX_BYTES} bytes`);
    }
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > RUNTIME_IMAGE_REGISTRY_MAX_BYTES) {
      throw new Error(`official registry exceeds ${RUNTIME_IMAGE_REGISTRY_MAX_BYTES} bytes`);
    }
    return text;
  }
  throw new Error("official registry redirect rejected");
}

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    chain.push(current);
    if (current instanceof Error && "cause" in current) {
      current = (current as { cause?: unknown }).cause;
      continue;
    }
    if (typeof current === "object" && current !== null && "cause" in current) {
      current = (current as { cause?: unknown }).cause;
      continue;
    }
    break;
  }
  return chain;
}

/**
 * 是否值得重试。
 *
 * 明确**不重试**：`HTTP 401/403/404`、主机/重定向/载荷/体积类错误——这些重试也
 * 不会成功，只会放大请求量并掩盖真实故障。
 */
export function isRetryableRegistryFetchError(error: unknown): boolean {
  for (const candidate of errorChain(error)) {
    if (candidate instanceof Error) {
      const code = (candidate as { code?: unknown }).code;
      if (candidate.name === "TimeoutError" || candidate.name === "AbortError") return true;
      if (typeof code === "string" && RETRYABLE_ERROR_TEXT.test(code)) return true;
      const message = candidate.message ?? "";
      const httpStatus = /^HTTP (\d{3})$/i.exec(message);
      if (httpStatus) return RETRYABLE_HTTP_STATUS.has(Number(httpStatus[1]));
      if (RETRYABLE_ERROR_TEXT.test(message)) return true;
      continue;
    }
    if (typeof candidate === "object" && candidate !== null) {
      const code = (candidate as { code?: unknown }).code;
      if (typeof code === "string" && RETRYABLE_ERROR_TEXT.test(code)) return true;
    }
  }
  return false;
}

/**
 * 带重试的抓取：最多 attempts 次，指数退避 + 抖动。
 *
 * 退避上限 900ms，3 次尝试最坏约 31s，仍落在一次同步周期内；抖动用避免多副本
 * 同时重试造成尖峰。
 */
export async function fetchGithubResourceWithRetry(
  target: URL,
  accept: string,
  token: string | undefined,
  options: RegistryFetchRetryOptions = {},
): Promise<string> {
  const attempts = boundedRegistryFetchAttempts(options.attempts ?? DEFAULT_REGISTRY_FETCH_ATTEMPTS);
  const backoffMs = options.backoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchGithubResource(target, accept, token, { timeoutMs: options.timeoutMs });
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryableRegistryFetchError(error)) break;
      const base = backoffMs[Math.min(attempt - 1, backoffMs.length - 1)] ?? 0;
      await sleep(base + Math.floor(Math.random() * 200));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** 从 latest release 元数据里解析清单资产地址（host 必须是 api.github.com）。 */
export function registryAssetTarget(releaseText: string): URL {
  if (Buffer.byteLength(releaseText, "utf8") > RUNTIME_IMAGE_REGISTRY_MAX_BYTES) {
    throw new Error(`official registry exceeds ${RUNTIME_IMAGE_REGISTRY_MAX_BYTES} bytes`);
  }
  let release: unknown;
  try {
    release = JSON.parse(releaseText) as unknown;
  } catch {
    throw new Error("official release metadata invalid");
  }
  const assets = release && typeof release === "object" && Array.isArray((release as Record<string, unknown>).assets)
    ? (release as Record<string, unknown>).assets as unknown[]
    : [];
  const asset = assets.find((entry) => {
    if (!entry || typeof entry !== "object") return false;
    return (entry as Record<string, unknown>).name === RUNTIME_IMAGE_REGISTRY_ASSET_NAME;
  }) as Record<string, unknown> | undefined;
  const assetUrl = typeof asset?.url === "string" ? asset.url : typeof asset?.api_url === "string" ? asset.api_url : "";
  if (!assetUrl) throw new Error("official registry asset missing");
  const target = new URL(assetUrl);
  if (target.protocol !== "https:" || target.hostname !== "api.github.com") {
    throw new Error("official registry asset host rejected");
  }
  return target;
}

/**
 * 取官方清单原文。
 *
 * - 有 token：api.github.com 两跳（release 元数据 → asset API），凭据只在
 *   github.com / api.github.com 上发送。
 * - 无 token：公开 download 链路优先；最终失败后回退 api.github.com 的 asset，
 *   让「github.com 首跳抖动」不再直接变成同步失败。
 */
export async function fetchOfficialRegistryText(
  input: RegistryFetchRetryOptions & { token?: string } = {},
): Promise<string> {
  const token = input.token?.trim() ?? "";
  const attempts = boundedRegistryFetchAttempts(input.attempts ?? DEFAULT_REGISTRY_FETCH_ATTEMPTS);
  const shared = { attempts, timeoutMs: input.timeoutMs, backoffMs: input.backoffMs, sleep: input.sleep };
  if (token) {
    const releaseText = await fetchGithubResourceWithRetry(
      new URL(OFFICIAL_RUNTIME_IMAGE_REGISTRY_RELEASE_API_URL),
      "application/vnd.github+json",
      token,
      shared,
    );
    return fetchGithubResourceWithRetry(registryAssetTarget(releaseText), "application/octet-stream", token, shared);
  }
  try {
    return await fetchGithubResourceWithRetry(
      new URL(OFFICIAL_RUNTIME_IMAGE_REGISTRY_URL),
      "application/json",
      undefined,
      shared,
    );
  } catch (publicError) {
    const detail = publicError instanceof Error ? publicError.message : String(publicError);
    console.warn(`[runtime-images] public registry channel failed (${detail}); trying api.github.com release asset`);
    const releaseText = await fetchGithubResourceWithRetry(
      new URL(OFFICIAL_RUNTIME_IMAGE_REGISTRY_RELEASE_API_URL),
      "application/vnd.github+json",
      undefined,
      shared,
    );
    return fetchGithubResourceWithRetry(registryAssetTarget(releaseText), "application/octet-stream", undefined, shared);
  }
}