/**
 * Model Gateway（§6.3）：沙箱不持有长期 Provider Key。
 *
 *   Sandbox ──DEEPSONAR_JOB_TOKEN（短期/单 Job/限模型/限额度）──▶ Gateway ──解密 Credential──▶ 上游
 *
 * - Token 只在执行器内铸造，明文仅注入本 Job 的沙箱 env；库中只存 sha256 + 前缀
 * - 入站认 Authorization Bearer、Anthropic `x-api-key` / `anthropic-api-key`（Pi anthropic-messages 默认不发 Bearer）
 * - 每次请求回查：token 有效 + job 仍在活跃状态（容器残留也调不动）+ 模型/额度限制
 * - 转发：/gateway/<上游路径> → credential.base_url + 路径，按 provider 注入真实认证头
 * - 用量：请求数必计；token 数从非流式 JSON usage 与 SSE usage 片段尽力解析
 * - 红线：上游明文 Key 不出本进程；请求/响应体不落库（usage 除外）
 */
import { once } from "node:events";
import { ensureGatewayRequestBudget, inspectGatewayRequestBudget, GatewayRequestBudgetError } from "./gateway-request-policy.js";
import { finiteRequestCap, readHistoricalRequestBudget, resolveRequestBudget } from "./gateway-request-budget.js";
import { persistNoEffectReceipt, readNoEffectReceipt, type GatewayNoEffectReason } from "./gateway-admission-receipt.js";
import { createGatewayResponseGuard } from "./gateway-response-guard.js";
import { assertGatewayRecoveryAllowed } from "./gateway-recovery-admission.js";
import { assertGatewayProviderBinding, GatewayProviderBindingError } from "./gateway-provider-binding.js";
import { gatewayEndToEndHeaders, appendGatewayHeaders, requestGatewayHttp } from "./gateway-transparent-http.js";
import { assertGatewayOutputBudget, assertGatewayUnambiguousPolicyJson, gatewayObservationBytes, transparentGatewayUrl } from "./gateway-transparent-policy.js";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { audit, recordSystemAudit } from "./audit.js";
import { config } from "./config.js";
import { jobTokenQuotaExhausted } from "./runtime-knobs.js";
import {
  decryptSecret,
  projectCredentialProvider,
  PROVIDER_ENV_MAP,
  UNKNOWN_PROVIDER_ERROR,
} from "./credentials.js";
import { sql } from "./db.js";
import { revokeJobTokensInTransaction } from "./gateway-token-revocation.js";
import { inc } from "./metrics.js";
import { DatabaseConflictExhaustedError, withDatabaseConflictRetry } from "./db-conflict-retry.js";
import { appendOtlpEnvelope } from "./evidence.js";
import { extractBaseUrlFromSettings } from "./provider-settings.js";
import { hasInvalidProviderHeaders, providerCustomHeadersFromSettings } from "./provider-custom-headers.js";
import {
  modelCatalogMatchForRequest,
} from "./provider-effective-model.js";
import { claudeCliFingerprintHeaders } from "./claude-cli-fingerprint.js";
import {
  assertGatewayRequestModelAllowed,
  gatewayRequestModelFromBody,
  GatewayFrozenModelMismatchError,
} from "./domains/provider-adapter/index.js";
import { beginEffect, markEffectUnknown, settleEffect } from "./domains/job-attempt/index.js";
import { readMainTokenAllowance, readWorkloadTokenAllowance } from "./domains/event-ingestion/model-token-allowance.js";
import { admitGatewayRepair, RepairTokenBudgetError } from "./domains/event-ingestion/repair-token-budget.js";
import { createRepairUsageScanner } from "./gateway-repair-usage.js";
import {
  assertObservationalMemoryProvider,
  assertObservationalMemoryFrozenJobModel,
  assertObservationalMemoryRequestScope,
  GATEWAY_WORKLOADS,
  GatewayWorkloadPolicyError,
  isKnownObservationalMemoryPreRequestFailure,
  resolveObservationalMemoryBudget,
  resolveObservationalMemoryGatewayScope,
  type GatewayWorkload,
} from "./gateway-om-budget.js";
import { observationalMemoryConfig, parseFrozenPiExtensions } from "./pi-extensions.js";

const JOB_ACTIVE = ["pending", "claimed", "provisioning", "running", "waiting_human"];
const JOB_TOKEN_RE = /^deepsonarjob_([0-9a-f]{8})_[A-Za-z0-9_-]{16,}$/;
export { GATEWAY_WORKLOADS } from "./gateway-om-budget.js";
export type { GatewayWorkload } from "./gateway-om-budget.js";

function gatewayWorkload(value: unknown): GatewayWorkload {
  if ((GATEWAY_WORKLOADS as readonly unknown[]).includes(value)) return value as GatewayWorkload;
  throw new Error("unknown_gateway_workload");
}

function headerString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0].trim() : "";
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 沙箱入站 Job token：Claude Code 发 Bearer；Pi anthropic-messages 把 api_key 放进 x-api-key。
 * 多个来源同时出现时必须字面相等，冲突 fail closed。
 */
export function extractInboundJobToken(headers: {
  authorization?: string | string[];
  "x-api-key"?: string | string[];
  "anthropic-api-key"?: string | string[];
}): string | null {
  const authorization = headerString(headers.authorization);
  const bearer = /^Bearer\s+/iu.test(authorization) ? authorization.replace(/^Bearer\s+/iu, "").trim() : "";
  const unique = [...new Set(
    [bearer, headerString(headers["x-api-key"]), headerString(headers["anthropic-api-key"])].filter(Boolean),
  )];
  if (unique.length !== 1) return null;
  const token = unique[0]!;
  return JOB_TOKEN_RE.test(token) ? token : null;
}

/** 模型网关允许进入业务层的最大请求体；超出后才由 Fastify 返回 413。 */
export const MODEL_GATEWAY_BODY_LIMIT = 16 * 1024 * 1024;

/** 上游只在响应尚未交给客户端前重试，最多执行三次 fetch。 */
export const GATEWAY_MAX_ATTEMPTS = 3;
export const GATEWAY_RETRY_BASE_DELAY_MS = 100;
export const GATEWAY_RETRY_MAX_DELAY_MS = 2_000;

const RETRYABLE_GATEWAY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

export type GatewayRetryReason = "timeout" | "network" | "http";

export interface GatewayRetryRequest {
  url: string;
  init: RequestInit;
  upstreamTimeoutMs: number;
  /** Job 的绝对截止时间；null 表示 Job 尚未开始，使用 Gateway 自身超时。 */
  jobDeadlineMs?: number | null;
}

export interface GatewayRetryResult {
  response: Response;
  attempts: number;
  retryReasons: GatewayRetryReason[];
  exhaustedReason?: GatewayRetryReason;
}

export interface GatewayRetryOptions {
  fetchFn?: typeof fetch;
  sleep?: (delayMs: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  createTimeoutSignal?: (timeoutMs: number) => AbortSignal;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
}

/** 网络/超时耗尽时使用稳定错误类型，响应内容不包含上游异常文本。 */
export class GatewayUpstreamUnreachableError extends Error {
  readonly attempts: number;
  readonly retryReasons: GatewayRetryReason[];
  readonly reason: GatewayRetryReason;

  constructor(reason: GatewayRetryReason, attempts: number, retryReasons: GatewayRetryReason[], cause?: unknown) {
    super("上游不可达", cause === undefined ? undefined : { cause });
    this.name = "GatewayUpstreamUnreachableError";
    this.reason = reason;
    this.attempts = attempts;
    this.retryReasons = retryReasons;
  }
}

/** 只允许有限、明确的上游瞬态错误进入重试路径。 */
export function isRetryableGatewayStatus(status: number): boolean {
  return RETRYABLE_GATEWAY_STATUSES.has(status);
}

/** 从 Job 的 started_at/timeout_sec 计算绝对截止时间。 */
export function gatewayJobDeadlineMs(
  startedAt: Date | string | number | null | undefined,
  timeoutSec: number | null | undefined,
): number | null {
  const startedMs = startedAt instanceof Date
    ? startedAt.getTime()
    : typeof startedAt === "number"
      ? startedAt
      : typeof startedAt === "string"
        ? Date.parse(startedAt)
        : Number.NaN;
  if (!Number.isFinite(startedMs) || !Number.isFinite(timeoutSec) || (timeoutSec as number) <= 0) return null;
  return startedMs + (timeoutSec as number) * 1000;
}

/** 计算单次 fetch 可用的超时；Job 剩余时间优先于 Gateway 上限。 */
export function gatewayAttemptTimeoutMs(
  upstreamTimeoutMs: number,
  jobDeadlineMs: number | null | undefined,
  nowMs: number,
): number {
  if (!Number.isFinite(upstreamTimeoutMs) || upstreamTimeoutMs <= 0) return 0;
  const gatewayLimit = Math.max(1, Math.floor(upstreamTimeoutMs));
  if (jobDeadlineMs == null) return gatewayLimit;
  const remaining = jobDeadlineMs - nowMs;
  if (!Number.isFinite(remaining) || remaining <= 0) return 0;
  return Math.min(gatewayLimit, Math.max(1, Math.floor(remaining)));
}

/** 指数退避并加入乘法 jitter；retryNumber 从 1（第一次重试前）开始。 */
export function gatewayRetryDelayMs(
  retryNumber: number,
  random: () => number = Math.random,
  baseDelayMs = GATEWAY_RETRY_BASE_DELAY_MS,
  maxDelayMs = GATEWAY_RETRY_MAX_DELAY_MS,
): number {
  const exponent = Math.max(0, Math.floor(retryNumber) - 1);
  const base = Math.max(1, Math.floor(baseDelayMs));
  const ceiling = Math.max(base, Math.floor(maxDelayMs));
  const exponential = Math.min(ceiling, base * 2 ** exponent);
  const randomValue = random();
  const sample = Number.isFinite(randomValue) ? Math.min(1, Math.max(0, randomValue)) : 0.5;
  return Math.max(1, Math.min(ceiling, Math.round(exponential * (0.5 + sample))));
}

function isGatewayTimeoutError(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" &&
      (["AbortError", "TimeoutError"].includes((error as { name?: unknown }).name as string) ||
        (error as { code?: unknown }).code === "ABORT_ERR"),
  );
}

async function sleepGateway(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

async function cancelGatewayResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // 释放失败不应阻止下一次独立上游尝试。
  }
}

/**
 * 执行 Gateway 上游请求的有界重试。
 * 该函数只处理 fetch/响应头阶段；调用方拿到 Response 后才可开始写客户端响应，
 * 因而 SSE 或普通响应体读取失败都不会重新进入这里。
 */
export async function fetchGatewayUpstream(
  request: GatewayRetryRequest,
  options: GatewayRetryOptions = {},
): Promise<GatewayRetryResult> {
  const fetchFn = options.fetchFn ?? fetch;
  const sleep = options.sleep ?? sleepGateway;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const createTimeoutSignal = options.createTimeoutSignal ?? AbortSignal.timeout;
  const maxAttempts = Number.isSafeInteger(options.maxAttempts) && (options.maxAttempts as number) > 0
    ? Math.min(GATEWAY_MAX_ATTEMPTS, options.maxAttempts as number)
    : GATEWAY_MAX_ATTEMPTS;
  const retryReasons: GatewayRetryReason[] = [];

  for (let attempts = 1; attempts <= maxAttempts; attempts += 1) {
    const timeoutMs = gatewayAttemptTimeoutMs(request.upstreamTimeoutMs, request.jobDeadlineMs, now());
    if (timeoutMs <= 0) {
      throw new GatewayUpstreamUnreachableError("timeout", attempts - 1, retryReasons);
    }

    let response: Response;
    try {
      response = await fetchFn(request.url, {
        ...request.init,
        signal: createTimeoutSignal(timeoutMs),
      });
    } catch (error) {
      const reason: GatewayRetryReason = isGatewayTimeoutError(error) ? "timeout" : "network";
      if (attempts >= maxAttempts) {
        throw new GatewayUpstreamUnreachableError(reason, attempts, retryReasons, error);
      }
      const remainingMs = request.jobDeadlineMs == null ? Number.POSITIVE_INFINITY : request.jobDeadlineMs - now();
      const delayMs = gatewayRetryDelayMs(retryReasons.length + 1, random, options.retryBaseDelayMs, options.retryMaxDelayMs);
      if (remainingMs <= delayMs) {
        throw new GatewayUpstreamUnreachableError(reason, attempts, retryReasons, error);
      }
      retryReasons.push(reason);
      await sleep(delayMs);
      continue;
    }

    if (!isRetryableGatewayStatus(response.status)) {
      return { response, attempts, retryReasons };
    }
    if (attempts >= maxAttempts) {
      return { response, attempts, retryReasons, exhaustedReason: "http" };
    }

    const remainingMs = request.jobDeadlineMs == null ? Number.POSITIVE_INFINITY : request.jobDeadlineMs - now();
    const delayMs = gatewayRetryDelayMs(retryReasons.length + 1, random, options.retryBaseDelayMs, options.retryMaxDelayMs);
    if (remainingMs <= delayMs) {
      return { response, attempts, retryReasons, exhaustedReason: "http" };
    }
    await cancelGatewayResponseBody(response);
    retryReasons.push("http");
    await sleep(delayMs);
  }

  throw new GatewayUpstreamUnreachableError("network", maxAttempts, retryReasons);
}

export function hashJobToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** 铸造短期 Job Token（executor 在 job 启动时调用；明文只在此处返回一次） */
export async function mintJobToken(input: {
  jobId: string;
  projectId: string;
  credentialId: string;
  allowedModels?: string[];
  maxRequests?: number;
  maxTokens?: number | null;
  ttlSec?: number;
  workload?: GatewayWorkload;
}): Promise<{ plaintext: string; id: string }> {
  const prefix = randomBytes(4).toString("hex");
  const secret = randomBytes(24).toString("base64url");
  const plaintext = `deepsonarjob_${prefix}_${secret}`;
  const ttl = input.ttlSec ?? config.gateway.tokenTtlSec;
  const workload = input.workload ?? "main";
  if (!(GATEWAY_WORKLOADS as readonly unknown[]).includes(workload)) throw new RangeError("unsupported workload");
  let maxRequests = input.maxRequests ?? config.gateway.maxRequests;
  let maxTokens = input.maxTokens ?? 0;
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 0 || maxRequests > 1_000_000) {
    throw new RangeError("maxRequests must be an integer between 0 (unlimited) and 1000000");
  }
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 0) {
    throw new RangeError("maxTokens must be a nonnegative safe integer (0 is unlimited)");
  }
  return sql.begin(async (tx) => {
  let requestTotalLimit = 0;
  let workloadMaxTokens: number | null = null;
  let allowedModels = input.allowedModels ?? [];
  let expectedProvider: string | null = null;
  let expectedModel: string | null = null;
  let expectedRoute: string | null = null;

  // OM scope is derived from immutable Job state and the Credential row.
  // Mint arguments cannot enlarge the model, route, or workload budget.
  const [job] = await tx`
    SELECT project_id, agent_snapshot_json, status
    FROM jobs
    WHERE id = ${input.jobId}
    FOR UPDATE`;
  if (!job) throw new Error("JOB_NOT_FOUND");
  if (String(job.project_id) !== input.projectId) throw new Error("JOB_PROJECT_SCOPE_MISMATCH");
  if (!JOB_ACTIVE.includes(String(job.status))) throw new Error("JOB_INACTIVE");
  const snapshot = job.agent_snapshot_json && typeof job.agent_snapshot_json === "object" && !Array.isArray(job.agent_snapshot_json)
    ? job.agent_snapshot_json as Record<string, unknown>
    : {};
  // Frozen scope precedes mutable credential lookup, preserving scoped rejection
  // without disclosing whether an unrelated credential exists or is active.
  if (typeof snapshot.credential_id === "string" && snapshot.credential_id !== input.credentialId) {
    throw new Error("JOB_CREDENTIAL_SCOPE_MISMATCH");
  }
  const [boundCredential] = await tx`SELECT * FROM credentials WHERE id = ${input.credentialId}`;
  if (!boundCredential || boundCredential.status !== "active") throw new Error("JOB_CREDENTIAL_INACTIVE");
  assertGatewayProviderBinding(snapshot.gateway_provider_binding, {
    id: boundCredential.id, provider: boundCredential.provider, agent_cli: boundCredential.agent_cli,
    settings_config_json: boundCredential.settings_config_json, public_metadata_json: boundCredential.public_metadata_json,
  });
  const frozen = parseFrozenPiExtensions(snapshot.pi_extensions);
  const observationalMemory = observationalMemoryConfig(frozen);
  if (observationalMemory) {
    if (snapshot.agent_cli !== "pi") {
      throw new Error("PI_OM_AGENT_CLI_SCOPE_MISMATCH");
    }
    const frozenCredentialId = typeof snapshot.credential_id === "string" ? snapshot.credential_id : "";
    if (!frozenCredentialId || frozenCredentialId !== input.credentialId) {
      throw new Error("JOB_CREDENTIAL_SCOPE_MISMATCH");
    }
    assertObservationalMemoryFrozenJobModel({
      workload: "observational_memory",
      frozenJobModel: snapshot.model,
      sourceModel: observationalMemory.source_model,
    });
    const frozenKnobs = snapshot.runtime_knobs && typeof snapshot.runtime_knobs === "object" && !Array.isArray(snapshot.runtime_knobs)
      ? snapshot.runtime_knobs as Record<string, unknown>
      : {};
    const plan = resolveObservationalMemoryBudget({
      config: observationalMemory,
      jobTokenMaxRequests: frozenKnobs.job_token_max_requests,
    });
    requestTotalLimit = plan.total_requests;
    maxRequests = workload === "main" ? plan.main_requests : plan.background_requests;
    if (workload === "observational_memory") {
      const scope = resolveObservationalMemoryGatewayScope({
        config: observationalMemory,
        settingsConfig: snapshot.settings_config_json,
        configFiles: snapshot.config_files,
      });
      const [credential] = await tx`SELECT kind, provider, status FROM credentials WHERE id = ${input.credentialId}`;
      if (!credential || credential.status !== "active") throw new Error("PI_OM_CREDENTIAL_INACTIVE");
      const projection = projectCredentialProvider(String(credential.kind), String(credential.provider));
      if (!projection.provider_valid) throw new Error(UNKNOWN_PROVIDER_ERROR);
      const frozenCredentialProvider = typeof snapshot.credential_provider === "string"
        ? snapshot.credential_provider.trim()
        : "";
      if (!frozenCredentialProvider || frozenCredentialProvider !== projection.provider) {
        throw new Error("JOB_CREDENTIAL_PROVIDER_SCOPE_MISMATCH");
      }
      expectedProvider = projection.provider;
      expectedModel = scope.model;
      expectedRoute = scope.route;
      allowedModels = [scope.model];
      workloadMaxTokens = plan.background_max_tokens;
      maxTokens = 0;
    }
  } else if (workload === "observational_memory") {
    throw new Error("PI_OM_NOT_IN_FROZEN_SNAPSHOT");
  }

  // Every generation inherits the tightest persisted finite request ceiling.
  // Revocation/expiry does not erase a Job's lifetime usage or policy history.
  const policy = await ensureGatewayRequestBudget(tx as unknown as typeof sql, input.jobId, snapshot);
  requestTotalLimit = finiteRequestCap([requestTotalLimit, policy.total_requests]);
  maxRequests = finiteRequestCap([maxRequests, workload === "main" ? policy.main_requests : policy.background_requests]);

  const [row] = await tx`
    INSERT INTO job_tokens ${sql({
      job_id: input.jobId,
      project_id: input.projectId,
      credential_id: input.credentialId,
      token_prefix: prefix,
      token_hash: hashJobToken(plaintext),
      allowed_models: allowedModels as never,
      max_requests: maxRequests,
      max_tokens: maxTokens === 0 ? null : maxTokens,
      workload,
      request_total_limit: requestTotalLimit,
      workload_max_tokens: workloadMaxTokens,
      expected_provider: expectedProvider,
      expected_model: expectedModel,
      expected_route: expectedRoute,
      expires_at: new Date(Date.now() + ttl * 1000),
    })}
    RETURNING id`;
  // 铸造记录（无 HTTP 上下文，直接写行；actor = system）
  await tx`
    INSERT INTO audit_logs ${sql({
      actor_type: "system",
      actor_id: "executor",
      action: "job_token.mint",
      project_id: input.projectId,
      resource_type: "job_token",
      resource_id: row.id as string,
      after_json: sql.json({
        job_id: input.jobId,
        credential_id: input.credentialId,
        allowed_models: allowedModels,
        max_requests: maxRequests,
        workload,
        request_total_limit: requestTotalLimit,
        workload_max_tokens: workloadMaxTokens,
        expected_provider: expectedProvider,
        expected_model: expectedModel,
        expected_route: expectedRoute,
      } as never),
      result: "ok",
    })}`;
  return { plaintext, id: row.id as string };
  });
}

/** Job 终态吊销（succeeded/failed/cancelled/timeout/orphan 全部调用点走这里） */
export async function revokeJobTokens(jobId: string, reason: string): Promise<void> {
  // SAFETY: the revoker uses only tagged queries and json; TransactionSql
  // implements both. The shared executor type also includes pool-only methods.
  await sql.begin((tx) => revokeJobTokensInTransaction(tx as unknown as typeof sql, jobId, reason));
}

/**
 * #918: protocol defaults the Gateway trusts for a provider. Kept separate from the final
 * auth carriers so a CLI's own protocol headers can override the defaults while nothing
 * can override authentication.
 */
export function upstreamProtocolHeaders(provider: string): Record<string, string> {
  if (provider !== "anthropic") return {};
  // #736: third-party Anthropic-compatible relays also fingerprint the Claude CLI.
  return { "anthropic-version": "2023-06-01", ...claudeCliFingerprintHeaders() };
}

/** Final authentication, always generated from the currently bound credential. */
export function upstreamFinalAuthHeaders(provider: string, secret: string): Record<string, string> {
  switch (provider) {
    case "anthropic":
      // 官方 Anthropic 认 x-api-key；第三方兼容代理（及本机 Claude Code）认 Bearer。
      return { authorization: `Bearer ${secret}`, "x-api-key": secret };
    case "openai":
      return { authorization: `Bearer ${secret}` };
    default:
      return {};
  }
}

/** 按 provider 注入真实认证头（与 credential-test.ts 行为一致） */
export function upstreamAuthHeaders(provider: string, secret: string): Record<string, string> {
  return { ...upstreamProtocolHeaders(provider), ...upstreamFinalAuthHeaders(provider, secret) };
}

/** 凭据 base_url 已带 /v1 时，不要把 Claude Code 的 /v1/messages 再拼成 /v1/v1/messages。 */
function observeGatewayTarget(target: string): string {
  if (/%(?![0-9a-f]{2})/iu.test(target)) throw new Error("invalid_target_escape");
  // Tokens are ASCII. Decode octets without rejecting legal non-UTF-8 URI bytes.
  return target.replace(/%([0-9a-f]{2})/giu, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

export function joinGatewayUpstreamUrl(baseUrl: string, upstreamPath: string, qs = ""): string {
  return transparentGatewayUrl(baseUrl, upstreamPath, qs);
}

/** 从 SSE 流片段/JSON 文本里尽力提取 usage（不累加精确账单，只用于额度熔断）。 */
export type UsageBreakdown = {
  input: number;
  output: number;
  total: number;
  cacheRead: number;
  cacheWrite: number;
};

const EMPTY_USAGE: UsageBreakdown = { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 };

function asUsageCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

function asUsageRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function extractBalancedObject(text: string, start: number): string | null {
  if (text[start] !== "{") return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escape) { escape = false; continue; }
      if (ch === "\\") { escape = true; continue; }
      if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") { inString = true; continue; }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function cacheReadFromUsage(usage: Record<string, unknown>): number {
  const top = asUsageCount(usage.cache_read_input_tokens)
    || asUsageCount(usage.cache_read_tokens)
    || asUsageCount(usage.cached_input_tokens)
    || asUsageCount(usage.cached_tokens);
  if (top > 0) return top;
  const details = asUsageRecord(usage.prompt_tokens_details) ?? asUsageRecord(usage.input_tokens_details);
  return details ? asUsageCount(details.cached_tokens) : 0;
}

function cacheWriteFromUsage(usage: Record<string, unknown>): number {
  const top = asUsageCount(usage.cache_creation_input_tokens)
    || asUsageCount(usage.cache_write_tokens)
    || asUsageCount(usage.cache_creation_tokens);
  const nested = asUsageRecord(usage.cache_creation);
  if (!nested) return top;
  const nestedSum = asUsageCount(nested.ephemeral_5m_input_tokens)
    + asUsageCount(nested.ephemeral_1h_input_tokens)
    + asUsageCount(nested.ephemeral_input_tokens);
  return nestedSum > 0 ? Math.max(top, nestedSum) : top;
}

function usageFromRecord(usage: Record<string, unknown>): UsageBreakdown {
  const input = asUsageCount(usage.input_tokens) || asUsageCount(usage.prompt_tokens);
  const output = asUsageCount(usage.output_tokens) || asUsageCount(usage.completion_tokens);
  return {
    input,
    output,
    total: input + output,
    cacheRead: cacheReadFromUsage(usage),
    cacheWrite: cacheWriteFromUsage(usage),
  };
}

function addUsage(target: UsageBreakdown, next: UsageBreakdown): void {
  target.input += next.input;
  target.output += next.output;
  target.total += next.total;
  target.cacheRead += next.cacheRead;
  target.cacheWrite += next.cacheWrite;
}

/** 残缺 JSON 的尽力而为兜底：只认同一层扁平字段，嵌套 cache_creation / *_details 必须走 JSON 解析。 */
function extractUsageByRegex(text: string): UsageBreakdown {
  const totals = { ...EMPTY_USAGE };
  for (const m of text.matchAll(/"usage"\s*:\s*\{([^}]*)/g)) {
    const body = m[1] ?? "";
    const input = Number(/"input_tokens"\s*:\s*(\d+)/.exec(body)?.[1] ?? /"prompt_tokens"\s*:\s*(\d+)/.exec(body)?.[1] ?? 0);
    const output = Number(/"output_tokens"\s*:\s*(\d+)/.exec(body)?.[1] ?? /"completion_tokens"\s*:\s*(\d+)/.exec(body)?.[1] ?? 0);
    const cacheRead = Number(/"cache_read_input_tokens"\s*:\s*(\d+)/.exec(body)?.[1] ?? /"cache_read_tokens"\s*:\s*(\d+)/.exec(body)?.[1] ?? 0);
    const cacheWrite = Number(/"cache_creation_input_tokens"\s*:\s*(\d+)/.exec(body)?.[1] ?? /"cache_write_tokens"\s*:\s*(\d+)/.exec(body)?.[1] ?? 0);
    if (input + output + cacheRead + cacheWrite <= 0) continue;
    addUsage(totals, { input, output, total: input + output, cacheRead, cacheWrite });
  }
  return totals;
}

function usageObjectStart(text: string, afterColon: number): number {
  let i = afterColon;
  while (i < text.length && /\s/u.test(text[i]!)) i += 1;
  return text[i] === "{" ? i : -1;
}

export function extractUsageBreakdown(text: string): UsageBreakdown {
  const totals = { ...EMPTY_USAGE };
  let parsed = false;
  for (const match of text.matchAll(/"usage"\s*:/g)) {
    const objectStart = usageObjectStart(text, match.index + match[0].length);
    if (objectStart < 0) continue;
    const raw = extractBalancedObject(text, objectStart);
    if (!raw) continue;
    try {
      const record = asUsageRecord(JSON.parse(raw) as unknown);
      if (!record) continue;
      const next = usageFromRecord(record);
      if (next.total <= 0 && next.cacheRead <= 0 && next.cacheWrite <= 0) continue;
      addUsage(totals, next);
      parsed = true;
    } catch {
      /* 残缺对象留给正则兜底 */
    }
  }
  if (parsed) return totals;
  return extractUsageByRegex(text);
}

/**
 * 按完整行扫描网关响应，保留跨 chunk 的尾巴，并按完整记录去重。
 * SSE/JSON 的 usage 记录在 chunk 边界重叠时只计一次，避免额度重复累加。
 */
export function createGatewayUsageScanner(): {
  push: (chunk: string | Uint8Array) => void;
  finish: () => UsageBreakdown;
} {
  let tail = "";
  const totals = { ...EMPTY_USAGE };
  const seen = new Set<string>();
  const observe = (line: string): void => {
    const record = extractUsageBreakdown(line);
    if (record.total <= 0 && record.cacheRead <= 0 && record.cacheWrite <= 0) return;
    const key = createHash("sha256").update(line).digest("hex");
    if (seen.has(key)) return;
    seen.add(key);
    addUsage(totals, record);
  };
  return {
    push(chunk) {
      tail += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      const lines = tail.split(/\r?\n/u);
      tail = lines.pop() ?? "";
      for (const line of lines) observe(line);
    },
    finish() {
      if (tail) observe(tail);
      return { ...totals };
    },
  };
}

type GatewayUsageLedgerInput = {
  jobId: string;
  projectId: string;
  attemptId: string;
  jobTokenId: string;
  effectId: string;
  requestNo: number;
  provider: string;
  model: string;
  modelCatalogMatch: boolean | null;
  upstreamReportingModel: string | null;
  usage: UsageBreakdown;
  status: "settled" | "unknown" | "not_reported";
  source: "gateway_response" | "gateway_stream" | "gateway_error";
  workload: GatewayWorkload;
};


/** Best-effort upstream model id from a non-stream JSON body or SSE data line. */
export function extractUpstreamReportingModel(text: string): string | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const model = (parsed as { model?: unknown }).model;
      if (typeof model === "string" && model.trim()) return model.trim().slice(0, 200);
    }
  } catch {
    /* SSE / partial */
  }
  const match = /"model"\s*:\s*"([^"\\]{1,200})"/.exec(text);
  return match?.[1]?.trim() || null;
}

async function appendUsageLedger(
  db: typeof sql,
  input: GatewayUsageLedgerInput,
): Promise<boolean> {
  const [row] = await db`
    INSERT INTO job_usage_ledger ${db({
      job_id: input.jobId,
      project_id: input.projectId,
      attempt_id: input.attemptId,
      job_token_id: input.jobTokenId,
      effect_id: input.effectId,
      request_no: input.requestNo,
      provider: input.provider.slice(0, 100),
      model: input.model.slice(0, 200),
      model_catalog_match: input.modelCatalogMatch,
      upstream_reporting_model: input.upstreamReportingModel ? input.upstreamReportingModel.slice(0, 200) : null,
      input_tokens: input.usage.input,
      output_tokens: input.usage.output,
      total_tokens: input.usage.total,
      cache_read_input_tokens: input.usage.cacheRead,
      cache_creation_input_tokens: input.usage.cacheWrite,
      adjustment_tokens: input.usage.total - input.usage.input - input.usage.output,
      settlement_status: input.status,
      source: input.source,
      workload: input.workload,
    })}
    ON CONFLICT (attempt_id, effect_id) DO NOTHING
    RETURNING id`;
  return Boolean(row);
}

async function trySettleGatewayUsage(
  input: GatewayUsageLedgerInput,
  effectStatus: "settled" | "unknown",
  error?: unknown,
): Promise<boolean> {
  try {
    await sql.begin(async (tx) => {
      // Serialize against admission and revocation. An already-started
      // request still owns a durable usage record after Job termination.
      await tx`SELECT id FROM jobs WHERE id = ${input.jobId} FOR UPDATE`;
      const ledgerInserted = await appendUsageLedger(tx as unknown as typeof sql, input);
      if (effectStatus === "unknown") {
        await markEffectUnknown(tx as unknown as typeof sql, input.attemptId, input.effectId, error ?? "模型请求结果无法确认");
      } else {
        await settleEffect(tx as unknown as typeof sql, input.attemptId, input.effectId, {
          status: "settled",
          outcome: {
            response_status: input.status,
            total_tokens: input.usage.total,
            source: input.source,
          },
        });
        if (ledgerInserted && input.usage.total > 0) {
          await tx`
            UPDATE job_tokens
               SET used_tokens = used_tokens + ${input.usage.total}
             WHERE id = ${input.jobTokenId}`;
        }
      }
    });
    return true;
  } catch (settlementError) {
    // 响应已经可能发送给 Worker，不能把账本写失败变成未处理异常；
    // 事务失败会留下未结算 effect，后续 OM 请求因此 fail closed，
    // 同时保留低基数指标和脱敏错误日志，不能假装账本已成功。
    inc("deepsonar_usage_ledger_write_failures_total", { source: input.source });
    console.error(`[gateway] 模型请求结算失败 effect=${input.effectId}:`, settlementError instanceof Error ? settlementError.message : String(settlementError));
    return false;
  }
}

/**
 * Close an OM reservation only when this transaction proves that the matching
 * request effect is still pending and has no competing usage row.  A settled
 * zero ledger is the durable known-no-effect record; request allocation is
 * intentionally not refunded.
 */
async function trySettleGatewayNoExternalUsage(input: GatewayUsageLedgerInput): Promise<boolean> {
  try {
    await sql.begin(async (tx) => {
      await tx`SELECT id FROM jobs WHERE id = ${input.jobId} FOR UPDATE`;
      const [effect] = await tx`
        SELECT job_id, effect_kind, status
        FROM job_attempt_effects
        WHERE attempt_id = ${input.attemptId} AND effect_id = ${input.effectId}
        FOR UPDATE`;
      if (!effect || String(effect.job_id) !== input.jobId || effect.effect_kind !== "gateway_model_request"
        || effect.status !== "effect_pending") {
        throw new Error("gateway no-effect settlement reservation mismatch");
      }
      const [existingLedger] = await tx`
        SELECT id
        FROM job_usage_ledger
        WHERE attempt_id = ${input.attemptId} AND effect_id = ${input.effectId}
        FOR UPDATE`;
      if (existingLedger) throw new Error("gateway no-effect settlement already has a ledger row");
      if (!await appendUsageLedger(tx as unknown as typeof sql, input)) {
        throw new Error("gateway no-effect settlement ledger insert was not durable");
      }
      const [zeroLedger] = await tx`
        SELECT job_id, project_id, attempt_id, job_token_id, effect_id, request_no,
               provider, model, input_tokens, output_tokens, total_tokens,
               cache_read_input_tokens, cache_creation_input_tokens, adjustment_tokens,
               settlement_status, source, workload
        FROM job_usage_ledger
        WHERE attempt_id = ${input.attemptId} AND effect_id = ${input.effectId}
        FOR UPDATE`;
      if (!zeroLedger || String(zeroLedger.job_id) !== input.jobId || String(zeroLedger.project_id) !== input.projectId
        || String(zeroLedger.attempt_id) !== input.attemptId || String(zeroLedger.job_token_id) !== input.jobTokenId
        || zeroLedger.effect_id !== input.effectId || Number(zeroLedger.request_no) !== input.requestNo
        || zeroLedger.provider !== input.provider || zeroLedger.model !== input.model
        || [zeroLedger.input_tokens, zeroLedger.output_tokens, zeroLedger.total_tokens,
          zeroLedger.cache_read_input_tokens, zeroLedger.cache_creation_input_tokens, zeroLedger.adjustment_tokens]
          .some((value) => Number(value) !== 0)
        || zeroLedger.settlement_status !== "settled" || zeroLedger.source !== "gateway_error"
        || zeroLedger.workload !== input.workload) {
        throw new Error("gateway no-effect settlement ledger contents were not zero and settled");
      }
      await settleEffect(tx as unknown as typeof sql, input.attemptId, input.effectId, {
        status: "settled",
        outcome: {
          result: "never_started",
          external_effect: false,
          response_status: "not_started",
          total_tokens: 0,
          source: input.source,
        },
      });
      const [settled] = await tx`
        SELECT status, settlement_json
        FROM job_attempt_effects
        WHERE attempt_id = ${input.attemptId} AND effect_id = ${input.effectId}`;
      const settlement = settled?.settlement_json as Record<string, unknown> | undefined;
      if (!settled || settled.status !== "settled" || settlement?.result !== "never_started"
        || settlement.external_effect !== false) {
        throw new Error("gateway no-effect settlement did not close the reservation");
      }
    });
    return true;
  } catch (settlementError) {
    inc("deepsonar_usage_ledger_write_failures_total", { source: input.source });
    console.error(`[gateway] known no-effect settlement failed effect=${input.effectId}:`,
      settlementError instanceof Error ? settlementError.message : "unknown settlement error");
    return false;
  }
}

function isReservedGatewayTransientShape(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const error = record.error && typeof record.error === "object" && !Array.isArray(record.error)
    ? record.error as Record<string, unknown>
    : record;
  return error.type === "gateway_transient" && error.effect_status === "not_started";
}

function isReservedGatewayTransientRecord(value: unknown): boolean {
  if (isReservedGatewayTransientShape(value)) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const error = record.error && typeof record.error === "object" && !Array.isArray(record.error)
    ? record.error as Record<string, unknown>
    : null;
  const message = typeof error?.message === "string" ? error.message.trim() : "";
  if (!message) return false;
  const body = message.replace(/^503(?:\s+|:\s*)/u, "");
  try {
    return isReservedGatewayTransientShape(JSON.parse(body) as unknown);
  } catch {
    return false;
  }
}

function isGatewayApiErrorFrame(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.type === "error") return true;
  const error = record.error;
  if (error === null || typeof error !== "object" || Array.isArray(error)) return false;
  const nested = error as Record<string, unknown>;
  return typeof nested.type === "string" || typeof nested.code === "string" || typeof nested.message === "string";
}

const MAX_GATEWAY_ERROR_FRAME_BYTES = 1_048_576;

function scanGatewaySseFrames(text: string, visit: (eventName: string, data: string) => boolean): boolean {
  let eventName = "";
  let data: string[] = [];
  let frameBytes = 0;
  const flush = (): boolean => {
    const currentEvent = eventName;
    const currentData = data;
    eventName = "";
    data = [];
    frameBytes = 0;
    if (currentEvent === "" && currentData.length === 0) return false;
    return visit(currentEvent, currentData.join("\n"));
  };
  for (const line of text.split(/\r\n|\n|\r/u)) {
    if (line === "") {
      if (flush()) return true;
      continue;
    }
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      const value = line.slice(5).replace(/^ /u, "");
      frameBytes += Buffer.byteLength(value, "utf8");
      if (frameBytes <= MAX_GATEWAY_ERROR_FRAME_BYTES) data.push(value);
    }
  }
  return flush();
}

/** Detect a structured provider API error event without scanning generated text. */
export function containsGatewayApiErrorFrame(body: string | Uint8Array, isSse = false): boolean {
  const text = typeof body === "string" ? body : Buffer.from(body).toString("utf8");
  if (!isSse) {
    try {
      return isGatewayApiErrorFrame(JSON.parse(text) as unknown);
    } catch {
      return false;
    }
  }
  return scanGatewaySseFrames(text, (eventName, payload) => {
    if (eventName === "error") return true;
    if (!payload || Buffer.byteLength(payload, "utf8") > MAX_GATEWAY_ERROR_FRAME_BYTES) return false;
    try {
      return isGatewayApiErrorFrame(JSON.parse(payload) as unknown);
    } catch {
      return false;
    }
  });
}

function isReservedGatewayFailureCarrier(message: string): boolean {
  if (message === "429 request quota exhausted" || message === "429 observational-memory token cap exhausted") return true;
  const match = /^(\d{3})(?:\s+|:\s*)([\s\S]*)$/u.exec(message);
  if (!match) return false;
  const status = Number(match[1]);
  if (status !== 429 && status !== 503) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[2]!);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const record = parsed as Record<string, unknown>;
  const detail = record.error && typeof record.error === "object" && !Array.isArray(record.error)
    ? record.error as Record<string, unknown>
    : record;
  const code = detail.type ?? detail.code ?? record.error_code;
  if (status === 503) return code === "gateway_transient" && detail.effect_status === "not_started";
  return code === "quota_exhausted" || code === "workload_token_cap_exhausted";
}

function isAnthropicRefusalFailureFrame(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const delta = record.type === "message_delta" && record.delta && typeof record.delta === "object"
    && !Array.isArray(record.delta) ? record.delta as Record<string, unknown> : null;
  const refusal = record.type === "message"
    ? record
    : delta?.stop_reason === "refusal" ? delta : null;
  if (!refusal || refusal.stop_reason !== "refusal") return false;
  const details = refusal.stop_details && typeof refusal.stop_details === "object" && !Array.isArray(refusal.stop_details)
    ? refusal.stop_details as Record<string, unknown>
    : null;
  return typeof details?.explanation === "string" && isReservedGatewayFailureCarrier(details.explanation);
}

/** Reject only the protocol-native Anthropic refusal field that Pi surfaces verbatim. */
export function containsAnthropicRefusalFailureCarrier(
  body: string | Uint8Array,
  isSse: boolean,
  upstreamPath: string,
): boolean {
  if (!/(?:^|\/)messages(?:\/|$)/u.test(upstreamPath.replace(/^\/+/, ""))) return false;
  const text = typeof body === "string" ? body : Buffer.from(body).toString("utf8");
  const inspect = (_eventName: string, payload: string): boolean => {
    if (!payload || Buffer.byteLength(payload, "utf8") > MAX_GATEWAY_ERROR_FRAME_BYTES) return false;
    try {
      return isAnthropicRefusalFailureFrame(JSON.parse(payload) as unknown);
    } catch {
      return false;
    }
  };
  if (isSse) return scanGatewaySseFrames(text, inspect);
  try {
    return isAnthropicRefusalFailureFrame(JSON.parse(text) as unknown);
  } catch {
    return false;
  }
}

/** Reject only an exact provider body that impersonates the Kernel transient envelope. */
export function containsReservedGatewayTransientEnvelope(body: string | Uint8Array, isSse = false): boolean {
  const text = typeof body === "string" ? body : Buffer.from(body).toString("utf8");
  if (isSse) {
    for (const line of text.split(/\r?\n/u)) {
      if (!line.startsWith("data:")) continue;
      try {
        if (isReservedGatewayTransientRecord(JSON.parse(line.slice(5).replace(/^ /u, "")) as unknown)) return true;
      } catch {
        // The strict protocol scanner owns malformed/partial SSE handling.
      }
    }
    return false;
  }
  try {
    return isReservedGatewayTransientRecord(JSON.parse(text) as unknown);
  } catch {
    return false;
  }
}

function deny(reply: FastifyReply, code: number, error: string, code2: string) {
  return reply.code(code).send({ error: { type: code2, message: error } });
}

type CredentialDenialSurface = "request_target" | "body" | "upstream_target" | "upstream_data" | "trailers";

/**
 * #1032：Job 凭据出现在业务数据里时的拒绝必须留下可审计记录，但不能把凭据带进审计。
 *
 * `audit()` 会持久化 request_id、IP 与最多 300 字符的原始 User-Agent；这三处都可能
 * 本身就携带着被拒绝的凭据，因此拒绝记录走系统审计（request 元数据一律为 null），
 * after 只写固定 surface 枚举与已核验的 UUID。不写请求体、错误原文、header 原文。
 */
function auditCredentialDenial(
  jt: { id?: unknown; job_id?: unknown; attempt_id?: unknown; project_id?: unknown },
  surface: CredentialDenialSurface,
): void {
  void recordSystemAudit({
    action: "gateway.credential_denied",
    projectId: typeof jt.project_id === "string" ? jt.project_id : null,
    resourceType: "job_token",
    resourceId: typeof jt.id === "string" ? jt.id : null,
    result: "denied",
    errorCode: "credential_in_business_data",
    after: {
      surface,
      job_id: typeof jt.job_id === "string" ? jt.job_id : null,
      attempt_id: typeof jt.attempt_id === "string" ? jt.attempt_id : null,
    },
  });
}

/** Only host-proven no-effect paths may emit this envelope; Pi's SDK may retain only error.message. */
function gatewayNotStartedError(message: string) {
  const error = { type: "gateway_transient", effect_status: "not_started", message };
  return { ...error, message: JSON.stringify(error) };
}

function databaseConflictMetricCode(error: unknown): string {
  if (!error || typeof error !== "object") return "unknown";
  const { code, cause } = error as { code?: unknown; cause?: unknown };
  if (code === "40P01" || code === "40001" || code === "55P03") return code;
  return cause ? databaseConflictMetricCode(cause) : "unknown";
}

type GatewayRequestAdmission = {
  requestNo: number;
  effectId: string;
  repairBudget: Awaited<ReturnType<typeof admitGatewayRepair>>;
  singleAttempt: boolean;
} | {
  denied: "job_inactive" | "quota_exhausted" | "workload_usage_unknown" | "workload_usage_pending" | "workload_token_cap_exhausted";
};

async function admitGatewayRequest(
  tx: typeof sql,
  input: {
    jobId: string;
    tokenId: string;
    workload: GatewayWorkload;
    attemptId: string;
    provider: string;
    model: string;
    upstreamPath: string;
    method: string;
    gatewayInputDigest: () => string;
    clientRequestId?: string;
    clientRetryOf?: string;
    onRepairBody: (remaining: number | null, budget: Awaited<ReturnType<typeof admitGatewayRepair>>) => void;
  },
): Promise<GatewayRequestAdmission> {
  const [job] = await tx`SELECT status, project_id, agent_snapshot_json FROM jobs WHERE id=${input.jobId} FOR UPDATE`;
  if (!job || !JOB_ACTIVE.includes(String(job.status))) {
    await tx`UPDATE job_tokens SET status='revoked', revoked_at=now(), revoke_reason=${`job_${String(job?.status ?? "missing")}`} WHERE job_id=${input.jobId} AND status='active'`;
    return { denied: "job_inactive" };
  }
  if (input.clientRequestId) {
    if (await readNoEffectReceipt(tx, { jobId: input.jobId, attemptId: input.attemptId, tokenId: input.tokenId,
      workload: input.workload, requestId: input.clientRequestId })) {
      throw new GatewayWorkloadPolicyError("duplicate_gateway_request_id", "A durable admission receipt already owns this identity");
    }
    const [existing] = await tx`SELECT effect_id FROM job_attempt_effects
      WHERE job_id=${input.jobId} AND attempt_id=${input.attemptId}
      AND resource_identity_json->>'job_token_id'=${input.tokenId}
      AND intent_json->>'gateway_request_id'=${input.clientRequestId}`;
    if (existing) throw new GatewayWorkloadPolicyError("duplicate_gateway_request_id", "Request identity was already used; reconcile instead of replaying");
  }
  const tokens = await tx`
    SELECT id, workload, used_requests, max_requests, request_total_limit,
           used_tokens, workload_max_tokens, status, credential_id, project_id,
           expires_at > clock_timestamp() AS unexpired
    FROM job_tokens
    WHERE job_id=${input.jobId}
    ORDER BY id
    FOR UPDATE`;
  const token = tokens.find((row) => String(row.id) === input.tokenId);
  if (!token || token.status !== "active" || !token.unexpired || token.workload !== input.workload) return { denied: "quota_exhausted" };
  const snapshot = job.agent_snapshot_json as Record<string, unknown>;
  const omConfig = observationalMemoryConfig(parseFrozenPiExtensions(snapshot?.pi_extensions));
  const omPlan = omConfig ? resolveObservationalMemoryBudget({
    config: omConfig,
    jobTokenMaxRequests: (snapshot.runtime_knobs as Record<string, unknown> | undefined)?.job_token_max_requests,
  }) : null;
  const omJob = omPlan !== null;
  if (input.workload === "observational_memory") {
    if (!omConfig || snapshot.agent_cli !== "pi") {
      throw new GatewayWorkloadPolicyError("PI_OM_NOT_IN_FROZEN_SNAPSHOT", "observational-memory is absent from the frozen Pi Job");
    }
    if (String(token.project_id) !== String(job.project_id) || token.credential_id !== snapshot.credential_id) {
      throw new GatewayWorkloadPolicyError("PI_OM_JOB_SCOPE_MISMATCH", "observational-memory token does not match its frozen Job scope");
    }
    assertObservationalMemoryFrozenJobModel({ workload: input.workload, frozenJobModel: snapshot.model, sourceModel: omConfig.source_model });
    const scope = resolveObservationalMemoryGatewayScope({ config: omConfig, settingsConfig: snapshot.settings_config_json, configFiles: snapshot.config_files });
    assertObservationalMemoryRequestScope({ workload: input.workload, requestModel: input.model, upstreamPath: input.upstreamPath,
      expectedModel: scope.model, expectedRoute: scope.route });
  }
  const quotaRowsValid = tokens.every((row) => {
    const usedRequests = Number(row.used_requests);
    const maxRequests = Number(row.max_requests);
    const requestTotalLimit = Number(row.request_total_limit);
    const usedTokens = Number(row.used_tokens);
    const workloadMaxTokens = row.workload_max_tokens == null ? null : Number(row.workload_max_tokens);
    return Number.isSafeInteger(usedRequests) && usedRequests >= 0
      && Number.isSafeInteger(maxRequests) && maxRequests >= 0 && maxRequests <= 1_000_000
      && Number.isSafeInteger(requestTotalLimit) && requestTotalLimit >= 0 && requestTotalLimit <= 1_000_000
      && Number.isSafeInteger(usedTokens) && usedTokens >= 0
      && (workloadMaxTokens === null || (Number.isSafeInteger(workloadMaxTokens) && workloadMaxTokens >= 0));
  });
  if (!quotaRowsValid) return { denied: omJob ? "workload_usage_unknown" : "quota_exhausted" };
  const requestPolicy = await inspectGatewayRequestBudget(tx, input.jobId, snapshot);
  let requests: ReturnType<typeof resolveRequestBudget>;
  try { requests = resolveRequestBudget(tokens, input.workload, requestPolicy); }
  catch { return { denied: omJob ? "workload_usage_unknown" : "quota_exhausted" }; }
  const { totalUsed, workloadLimit } = requests;
  let backgroundRemaining: number | null = null;
  let backgroundPending = false;
  if (input.workload === "observational_memory") {
    try {
      backgroundRemaining = await readWorkloadTokenAllowance(tx, input.jobId, input.workload);
    } catch (error) {
      if (error instanceof RepairTokenBudgetError && error.code === "JOB_TOKEN_USAGE_UNKNOWN") {
        return { denied: "workload_usage_unknown" };
      }
      if (error instanceof RepairTokenBudgetError && error.code === "JOB_TOKEN_USAGE_PENDING") {
        backgroundPending = true;
      }
      if (error instanceof RepairTokenBudgetError && error.code === "JOB_TOKEN_EXHAUSTED") {
        return { denied: "workload_token_cap_exhausted" };
      }
      if (!backgroundPending) throw error;
    }
  }
  if (requests.exhausted) return { denied: "quota_exhausted" };
  if (backgroundPending) return { denied: "workload_usage_pending" };

  const repairBudget = input.workload === "main"
    ? await admitGatewayRepair(tx, input.jobId, input.attemptId)
    : null;
  const totalRemaining = input.workload === "main"
    ? await readMainTokenAllowance(tx, input.jobId, snapshot, repairBudget)
    : backgroundRemaining;
  const remaining = totalRemaining === null ? repairBudget?.remaining_tokens ?? null
    : Math.min(totalRemaining, repairBudget?.remaining_tokens ?? totalRemaining);
  if (repairBudget) repairBudget.remaining_tokens = remaining;
  input.onRepairBody(remaining, repairBudget);
  if (input.clientRetryOf) {
    if (input.workload !== "main" || !input.clientRequestId) {
      throw new GatewayWorkloadPolicyError("gateway_recovery_scope_invalid", "Recovery requires a main-workload request identity");
    }
    await assertGatewayRecoveryAllowed(tx, { ...input, requestId: input.clientRequestId,
      retryOf: input.clientRetryOf, inputDigest: input.gatewayInputDigest() }, snapshot);
  }

  const [requestCounter] = await tx`
    UPDATE job_tokens
       SET used_requests = used_requests + 1
     WHERE id = ${input.tokenId} AND status = 'active'
       AND (max_requests <= 0 OR used_requests < max_requests)
       AND (request_total_limit <= 0 OR ${totalUsed} < request_total_limit)
    RETURNING used_requests`;
  if (!requestCounter) return { denied: "quota_exhausted" };
  const requestNo = Number(requestCounter.used_requests);
  const effectId = `gateway_model_request:${input.tokenId}:${requestNo}`;
  const effectStarted = await beginEffect(tx, input.attemptId, {
    effectId,
    kind: "gateway_model_request",
    inputDigest: input.gatewayInputDigest(),
    resourceIdentity: { job_token_id: input.tokenId, request_no: requestNo },
    intent: {
      provider: input.provider,
      model: input.model.slice(0, 200),
      method: input.method,
      upstream_path: input.upstreamPath,
      recovery_policy_version: 1,
      workload: input.workload,
      ...(input.clientRetryOf ? { gateway_retry_of: input.clientRetryOf } : {}),
      ...(input.clientRequestId ? { gateway_request_id: input.clientRequestId } : {}),
      ...(repairBudget ? { repair_receipt_ref: repairBudget.receipt_ref, repair_reserved_tokens: repairBudget.remaining_tokens } : {}),
    },
  });
  if (!effectStarted) throw new Error("Job Attempt is no longer active");
  return {
    requestNo,
    effectId,
    repairBudget,
    singleAttempt: input.workload === "observational_memory" || repairBudget !== null || totalRemaining !== null || (omJob && workloadLimit > 0),
  };
}

function recordGatewayRetryMetrics(
  provider: string,
  attempts: number,
  retryReasons: GatewayRetryReason[],
  exhaustedReason?: GatewayRetryReason,
): void {
  if (attempts > 0) inc("deepsonar_gateway_upstream_attempts_total", { provider }, attempts);
  for (const reason of retryReasons) inc("deepsonar_gateway_upstream_retries_total", { provider, reason });
  if (exhaustedReason) inc("deepsonar_gateway_upstream_exhausted_total", { provider, reason: exhaustedReason });
}

/** 注册 /gateway/* 代理路由（自身鉴权，不走平台 authHook） */
export function registerGateway(app: FastifyInstance): void {
  // Encapsulation keeps raw-body parsing local to this proxy, never platform APIs.
  void app.register(async (app) => {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: MODEL_GATEWAY_BODY_LIMIT },
    (_req, body, done) => done(null, body));
  app.route({
    method: ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"],
    exposeHeadRoute: false,
    url: "/gateway/*",
    bodyLimit: MODEL_GATEWAY_BODY_LIMIT,
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const authNames = new Set(["authorization", "x-api-key", "anthropic-api-key"]);
      const seenAuth = new Set<string>();
      for (let index = 0; index < req.raw.rawHeaders.length; index += 2) {
        const name = req.raw.rawHeaders[index]!.toLowerCase();
        if (!authNames.has(name)) continue;
        if (seenAuth.has(name)) return deny(reply, 400, "Duplicate authentication carrier", "invalid_token");
        seenAuth.add(name);
      }
      const token = extractInboundJobToken(req.headers);
      const m = token?.match(JOB_TOKEN_RE) ?? null;
      if (!token || !m) return deny(reply, 401, "缺少或非法 DEEPSONAR_JOB_TOKEN", "invalid_token");

      const [jt] = await sql`
        SELECT jt.*, j.status AS job_status, j.started_at, j.timeout_sec,j.execution_deadline_at,
               j.agent_snapshot_json,
               a.id AS attempt_id, a.attempt_no
        FROM job_tokens jt JOIN jobs j ON j.id = jt.job_id
        LEFT JOIN job_attempts a ON a.job_id = j.id AND a.status = 'active'
        WHERE jt.token_prefix = ${m[1]}`;
      if (!jt) return deny(reply, 401, "token 不存在", "invalid_token");
      const a = Buffer.from(jt.token_hash as string, "utf8");
      const b = Buffer.from(hashJobToken(token), "utf8");
      if (a.length !== b.length || !timingSafeEqual(a, b)) return deny(reply, 401, "token 校验失败", "invalid_token");
      if ((jt.status as string) !== "active") return deny(reply, 401, `token 已 ${jt.status}`, "token_inactive");
      if (new Date(jt.expires_at as string).getTime() < Date.now()) {
        await sql`UPDATE job_tokens SET status = 'expired' WHERE id = ${jt.id} AND status = 'active'`;
        return deny(reply, 401, "token 已过期", "token_expired");
      }
      // 容器残留防护：job 不在活跃状态，token 立即不可用（并顺手吊销）
      if (!JOB_ACTIVE.includes(jt.job_status as string)) {
        await revokeJobTokens(jt.job_id as string, `job_${jt.job_status}`);
        void auditGateway(req, {
          action: "gateway.denied",
          projectId: jt.project_id as string,
          resourceId: jt.id as string,
          result: "denied",
          errorCode: "job_inactive",
          after: { job_status: jt.job_status },
        });
        return deny(reply, 401, "job 已结束，token 不可用", "job_inactive");
      }
      const clientRequestId = headerString(req.headers["x-deepsonar-request-id"]);
      const clientRetryOf = headerString(req.headers["x-deepsonar-retry-of"]);
      if (clientRetryOf && (!clientRequestId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(clientRetryOf))) {
        return deny(reply, 400, "Invalid recovery request identity", "invalid_gateway_request_id");
      }
      if (clientRequestId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(clientRequestId)) {
        return deny(reply, 400, "Invalid request identity", "invalid_gateway_request_id");
      }
      const saveAdmissionReceipt = async (reason: GatewayNoEffectReason): Promise<boolean> => {
        if (!clientRequestId || !jt.attempt_id || !["main", "observational_memory"].includes(String(jt.workload))) return false;
        return persistNoEffectReceipt(sql, { jobId: String(jt.job_id), attemptId: String(jt.attempt_id),
          tokenId: String(jt.id), workload: gatewayWorkload(jt.workload), requestId: clientRequestId, reason });
      };
      let decodedTarget = req.url;
      try { decodedTarget = observeGatewayTarget(req.url); }
      catch { return deny(reply, 400, "Invalid request target encoding", "invalid_request_target"); }
      if (req.url.includes(token) || decodedTarget.includes(token)) {
        auditCredentialDenial(jt, "request_target");
        return deny(reply, 400, "Job credential in request target", "credential_in_business_data");
      }
      if (req.url === "/gateway/_allowance") {
        const [credential] = await sql`SELECT * FROM credentials WHERE id = ${jt.credential_id}`;
        if (!credential || credential.status !== "active") return deny(reply, 502, "Bound credential is unavailable", "credential_inactive");
        try {
          assertGatewayProviderBinding((jt.agent_snapshot_json as Record<string, unknown>)?.gateway_provider_binding, {
            id: credential.id, provider: credential.provider, agent_cli: credential.agent_cli,
            settings_config_json: credential.settings_config_json, public_metadata_json: credential.public_metadata_json,
          });
        } catch (error) {
          if (error instanceof GatewayProviderBindingError) return deny(reply, 409,
            "Provider configuration is no longer bound to this Job; regenerate its configuration", error.code);
          return deny(reply, 502, "Invalid provider configuration", "invalid_provider_headers");
        }
        if (req.method !== "GET" || !jt.attempt_id || !["main", "observational_memory"].includes(String(jt.workload))) {
          return deny(reply, 403, "Allowance query requires an active workload", "workload_scope_mismatch");
        }
        reply.header("cache-control", "no-store");
        try {
          return await sql.begin(async (tx) => {
            // Advisory request-generation policy, never a reservation. Admission
            // rechecks the same budget under this Job lock before any external call.
            const db = tx as unknown as typeof sql;
            const [job] = await db`SELECT status, agent_snapshot_json FROM jobs WHERE id=${jt.job_id} FOR UPDATE`;
            if (!job || !JOB_ACTIVE.includes(String(job.status))) throw new RepairTokenBudgetError("REPAIR_JOB_INACTIVE", "Job is no longer active");
            const workload = gatewayWorkload(jt.workload);
            const requestPolicy = await inspectGatewayRequestBudget(db, String(jt.job_id), job.agent_snapshot_json);
            const requests = await readHistoricalRequestBudget(db, String(jt.job_id), workload, requestPolicy);
            if (requests.exhausted) {
              throw new RepairTokenBudgetError("JOB_REQUEST_EXHAUSTED", "Job request allowance exhausted");
            }
            const repair = workload === "main" ? await admitGatewayRepair(db, String(jt.job_id), String(jt.attempt_id)) : null;
            const total = workload === "observational_memory"
              ? await readWorkloadTokenAllowance(db, String(jt.job_id), workload, repair)
              : await readMainTokenAllowance(db, String(jt.job_id), job.agent_snapshot_json, repair);
            const remaining = total === null ? repair?.remaining_tokens ?? null : Math.min(total, repair?.remaining_tokens ?? total);
            return { remaining_tokens: remaining, policy_required: repair !== null || remaining !== null };
          });
        } catch (error) {
          if (error instanceof GatewayRequestBudgetError) return deny(reply, 409, error.message, error.code);
          if (error instanceof RepairTokenBudgetError) return deny(reply, error.code.endsWith("EXHAUSTED") ? 429 : 409,
            error.message, error.code);
          throw error;
        }
      }
      const receiptPath = /^\/gateway\/_settlement\/([0-9a-f-]{36})$/u.exec(req.url);
      if (req.url.startsWith("/gateway/_settlement/")) {
        if (req.method !== "GET" || !receiptPath) return deny(reply, 400, "Invalid settlement query", "invalid_settlement_query");
        const [receipt] = await sql`SELECT e.status, e.settlement_json, l.settlement_status, l.source
          FROM job_attempt_effects e LEFT JOIN job_usage_ledger l ON l.attempt_id=e.attempt_id AND l.effect_id=e.effect_id
          WHERE e.job_id=${jt.job_id} AND e.attempt_id=${jt.attempt_id ?? null}
          AND e.resource_identity_json->>'job_token_id'=${String(jt.id)}
          AND e.intent_json->>'gateway_request_id'=${receiptPath[1]!}
          AND e.intent_json->>'workload'=${String(jt.workload)}`;
        reply.header("cache-control", "no-store");
        if (!receipt) {
          const noEffect = jt.attempt_id && await readNoEffectReceipt(sql, { jobId: String(jt.job_id),
            attemptId: String(jt.attempt_id), tokenId: String(jt.id), workload: gatewayWorkload(jt.workload), requestId: receiptPath[1]! });
          return noEffect || reply.code(404).send({ status: "not_found" });
        }
        if (receipt.status === "settled" && receipt.settlement_status === "settled") {
          if (receipt.source === "gateway_error" && receipt.settlement_json?.external_effect === false) {
            return { status: "not_started", reason: "gateway_transient" };
          }
          return { status: "settled" };
        }
        return { status: receipt.status === "effect_pending" && !receipt.settlement_status ? "pending" : "unknown" };
      }
      if (jt.workload !== "observational_memory" && jobTokenQuotaExhausted(jt.used_requests as number, jt.max_requests as number)) {
        await saveAdmissionReceipt("quota_exhausted");
        void auditGateway(req, {
          action: "gateway.denied",
          projectId: jt.project_id as string,
          resourceId: jt.id as string,
          result: "denied",
          errorCode: "quota_exhausted",
          after: { used_requests: jt.used_requests, max_requests: jt.max_requests },
        });
        return deny(reply, 429, "请求数额度用尽", "quota_exhausted");
      }

      let outboundBuf: Buffer | null = Buffer.isBuffer(req.body) ? req.body : null;
      // Fastify intentionally skips GET/HEAD parsing; preserve legal bodies there too.
      if (!outboundBuf && (req.headers["content-length"] || req.headers["transfer-encoding"])) {
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req.raw) {
          const bytes = Buffer.from(chunk); size += bytes.length;
          if (size > MODEL_GATEWAY_BODY_LIMIT) return deny(reply, 413, "Request body too large", "body_limit");
          chunks.push(bytes);
        }
        outboundBuf = Buffer.concat(chunks);
      }
      let rawBody: unknown = outboundBuf;
      let observedRequest: Buffer | null = outboundBuf;
      if (outboundBuf?.length) {
        try { observedRequest = gatewayObservationBytes(outboundBuf, headerString(req.headers["content-encoding"])); }
        catch { observedRequest = null; }
      }
      if (observedRequest?.includes(token)) {
        auditCredentialDenial(jt, "body");
        return deny(reply, 400, "Job credential in body", "credential_in_business_data");
      }
      if (observedRequest) {
        try { assertGatewayUnambiguousPolicyJson(observedRequest); }
        catch { return deny(reply, 400, "Ambiguous model or budget members", "ambiguous_policy_json"); }
      }
      if (outboundBuf?.length) {
        try { if (observedRequest) rawBody = JSON.parse(observedRequest.toString("utf8")); }
        catch { /* Opaque input is admitted or refused by authorization, never rewritten. */ }
      }
      let workload: GatewayWorkload;
      try {
        workload = gatewayWorkload(jt.workload);
      } catch {
        return deny(reply, 403, "token workload 不受支持", "unknown_workload");
      }
      const upstreamPath = req.url.slice("/gateway/".length).split("?")[0]!;
      if (workload === "observational_memory" && !clientRequestId) {
        return deny(reply, 403, "OM requires a settlement request identity", "missing_gateway_request_id");
      }
      if (workload === "observational_memory" && req.method !== "POST") {
        return deny(reply, 403, "observational-memory requires a JSON model POST", "FROZEN_WORKLOAD_PROTOCOL_MISMATCH");
      }
      const requestModel = gatewayRequestModelFromBody(rawBody);
      try {
        assertObservationalMemoryRequestScope({
          workload,
          requestModel,
          upstreamPath,
          expectedModel: jt.expected_model,
          expectedRoute: jt.expected_route,
        });
      } catch (error) {
        if (error instanceof GatewayWorkloadPolicyError) {
          return deny(reply, 403, error.message, error.code);
        }
        throw error;
      }
      const otlp = upstreamPath.match(/^otel\/v1\/(logs|metrics|traces)$/);
      if (req.method === "POST" && otlp) {
        try {
          await appendOtlpEnvelope(
            jt.job_id as string,
            otlp[1] as "logs" | "metrics" | "traces",
            String(req.headers["content-type"] ?? "application/json"),
            rawBody ?? Buffer.alloc(0),
          );
          inc("deepsonar_otlp_requests_total", { signal: otlp[1]! });
          return reply
            .code(200)
            .header("content-type", String(req.headers["content-type"] ?? "application/json"))
            .send(Buffer.isBuffer(rawBody) ? Buffer.alloc(0) : {});
        } catch (error) {
          return deny(reply, 413, error instanceof Error ? error.message : String(error), "otlp_rejected");
        }
      }
      // An opaque upload cannot prove a frozen model authorization. Unrestricted
      // jobs still admit non-JSON bodies; this is a refusal, never a body conversion.
      const frozenModel = jt.agent_snapshot_json?.provider_model;
      if (outboundBuf?.length && frozenModel && !frozenModel.passthrough && !gatewayRequestModelFromBody(rawBody)) {
        return deny(reply, 403, "Cannot authorize a model in this request representation", "frozen_model_mismatch");
      }
      if (workload !== "observational_memory") {
        try {
          assertGatewayRequestModelAllowed({
            requestModel,
            agentSnapshot: jt.agent_snapshot_json,
          });
        } catch (error) {
          if (error instanceof GatewayFrozenModelMismatchError) {
            return reply.code(403).send({
              error: { type: "frozen_model_mismatch", message: error.message },
              error_code: "frozen_model_mismatch",
              repair: error.repair,
            });
          }
          throw error;
        }
      }
      const outboundBody = rawBody;

      // 解密 Credential（明文不出本进程）
      const [cred] = await sql`SELECT * FROM credentials WHERE id = ${jt.credential_id}`;
      if (!cred || (cred.status as string) !== "active") {
        return deny(reply, 502, "绑定的凭据不可用", "credential_inactive");
      }
      try {
        assertGatewayProviderBinding((jt.agent_snapshot_json as Record<string, unknown>)?.gateway_provider_binding, {
          id: cred.id, provider: cred.provider, agent_cli: cred.agent_cli,
          settings_config_json: cred.settings_config_json, public_metadata_json: cred.public_metadata_json,
        });
      } catch (error) {
        if (error instanceof GatewayProviderBindingError) return deny(reply, 409,
          "Provider configuration is no longer bound to this Job; regenerate its configuration", error.code);
        return deny(reply, 502, "Invalid provider configuration", "invalid_provider_headers");
      }
      const providerProjection = projectCredentialProvider(cred.kind, cred.provider);
      if (!providerProjection.provider_valid) {
        return deny(reply, 502, UNKNOWN_PROVIDER_ERROR, "unknown_provider");
      }
      const safeProvider = providerProjection.provider;
      try {
        assertObservationalMemoryProvider({
          workload,
          actualProvider: safeProvider,
          expectedProvider: jt.expected_provider,
        });
      } catch (error) {
        if (error instanceof GatewayWorkloadPolicyError) {
          return deny(reply, 403, error.message, error.code);
        }
        throw error;
      }
      const secret = decryptSecret(cred as never);
      const meta = (cred.public_metadata_json ?? {}) as { base_url?: string };
      const settingsBaseUrl = extractBaseUrlFromSettings(cred.settings_config_json);
      const baseUrl =
        meta.base_url ?? settingsBaseUrl ?? PROVIDER_ENV_MAP[safeProvider]?.defaultBaseUrl ?? "https://api.anthropic.com";
      const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
      let url: string;
      let headers: string[];
      let requestTrailers: string[];
      try {
        url = joinGatewayUpstreamUrl(baseUrl, upstreamPath, qs);
        let observedTarget = url;
        try { observedTarget = observeGatewayTarget(url); }
        catch { return deny(reply, 400, "Invalid upstream target encoding", "invalid_request_target"); }
        if (url.includes(token) || observedTarget.includes(token)) {
          auditCredentialDenial(jt, "upstream_target");
          return deny(reply, 400, "Job credential in upstream target", "credential_in_business_data");
        }
        const frozenSnapshot = (jt.agent_snapshot_json ?? {}) as Record<string, unknown>;
        const om = workload === "observational_memory"
          ? observationalMemoryConfig(parseFrozenPiExtensions(frozenSnapshot.pi_extensions)) : null;
        const frozenProvider = om?.source_provider ?? (typeof frozenSnapshot.pi_provider === "string" ? frozenSnapshot.pi_provider : undefined);
        const configured = providerCustomHeadersFromSettings(frozenSnapshot.settings_config_json, baseUrl,
          requestModel ? { purpose: "inference", model: requestModel, ...(frozenProvider ? { provider: frozenProvider } : {}) }
            : { purpose: "catalog" });
        if (hasInvalidProviderHeaders(configured)) return deny(reply, 502, "Invalid provider header configuration", "invalid_provider_headers");
        if ((outboundBuf?.includes(token) ?? false) || req.raw.rawHeaders.some((value, i) => i % 2 === 1
          && value.includes(token) && !["authorization", "x-api-key", "anthropic-api-key", "proxy-authorization"].includes(req.raw.rawHeaders[i - 1]!.toLowerCase()))) {
          auditCredentialDenial(jt, "upstream_data");
          return deny(reply, 400, "Job credential in business data", "credential_in_business_data");
        }
        const connection: string[] = [];
        for (let i = 0; i < req.raw.rawHeaders.length; i += 2) {
          if (req.raw.rawHeaders[i]!.toLowerCase() === "connection") connection.push(req.raw.rawHeaders[i]!, req.raw.rawHeaders[i + 1]!);
        }
        // Fastify's injected IncomingMessage omits rawTrailers when none exist.
        const inboundTrailers = req.raw.rawTrailers ?? [];
        if (inboundTrailers.some(value => value.includes(token))) {
          auditCredentialDenial(jt, "trailers");
          return deny(reply, 400, "Job credential in trailers", "credential_in_business_data");
        }
        requestTrailers = gatewayEndToEndHeaders([...connection, ...inboundTrailers], { request: true });
        headers = appendGatewayHeaders({ ...upstreamProtocolHeaders(safeProvider), ...configured.headers }, req.raw.rawHeaders,
          upstreamFinalAuthHeaders(safeProvider, secret));
      } catch { return deny(reply, 400, "Invalid proxy target or HTTP headers", "invalid_gateway_request"); }

      const gatewayAttemptId = typeof jt.attempt_id === "string" ? jt.attempt_id : null;
      if (!gatewayAttemptId) return deny(reply, 409, "Job 缺少活动 Attempt，拒绝无账本模型请求", "attempt_state_missing");
      const model = outboundBody && typeof outboundBody === "object" && !Array.isArray(outboundBody)
        ? String((outboundBody as { model?: unknown }).model ?? "")
        : "";
      // Empty catalog soft-degrades to null (unknown); non-empty → boolean match on request model.
      const modelCatalogMatch = modelCatalogMatchForRequest(model, cred.model_catalog_json);
      let upstreamReportingModel: string | null = null;
      let responseSample = "";
      const noteResponseChunk = (chunk: string | Uint8Array): void => {
        if (upstreamReportingModel || responseSample.length >= 65_536) return;
        const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        responseSample = (responseSample + text).slice(0, 65_536);
        upstreamReportingModel = extractUpstreamReportingModel(responseSample);
      };
      // 转发（流式直通；请求数先计，token 数响应后补记）。请求序号
      // 来自同一行的原子更新，重试/并发请求不会复用 effect_id。
      // #871 A：admission 事务在向上游发出请求之前完成，回滚后计数器与 effect
      // 一起消失，因此死锁/序列化失败可以安全重试；耗尽时返回稳定错误码，而不是
      // 让 agent 把它当成模型失败。
      const requestIntent = await withDatabaseConflictRetry(async () => sql.begin(async (tx) => {
        return admitGatewayRequest(tx as unknown as typeof sql, {
          jobId: String(jt.job_id),
          tokenId: String(jt.id),
          workload,
          attemptId: gatewayAttemptId,
          provider: safeProvider,
          model,
          upstreamPath,
          method: req.method,
          // Repair output may be bounded by onRepairBody.  Hash the final
          // outbound bytes so the effect records the request actually sent.
          clientRequestId: clientRequestId || undefined,
          clientRetryOf: clientRetryOf || undefined,
          gatewayInputDigest: () => createHash("sha256").update(outboundBuf ?? Buffer.alloc(0)).digest("hex"),
          onRepairBody: (remaining, repairBudget) => {
            if (repairBudget || remaining !== null) {
              assertGatewayOutputBudget(outboundBody, upstreamPath, remaining);
            }
          },
        });
      }), {
        onConflict: (error, attempt) => {
          const code = databaseConflictMetricCode(error);
          inc("deepsonar_gateway_db_conflict_retries_total", { workload, code });
          app.log.warn({ attempt, code, job_id: jt.job_id },
            "gateway admission retried after a recoverable database conflict");
        },
      }).catch(error => {
        if (error instanceof RepairTokenBudgetError || error instanceof GatewayWorkloadPolicyError || error instanceof GatewayRequestBudgetError) return error;
        if (error instanceof DatabaseConflictExhaustedError) return error;
        throw error;
      });
      if (requestIntent instanceof DatabaseConflictExhaustedError) {
        const code = databaseConflictMetricCode(requestIntent.cause);
        inc("deepsonar_gateway_db_conflict_exhausted_total", { workload, code });
        app.log.warn({ code, workload, attempts: requestIntent.attempts, job_id: jt.job_id, attempt_id: gatewayAttemptId },
          "gateway admission exhausted its bounded database conflict retries");
        // The admission transaction rolled back its counter and effect; no upstream request started.
        await saveAdmissionReceipt("gateway_transient");
        const message = "数据库锁冲突在有限重试后仍未恢复，请稍后重试；该请求未向上游发出";
        return reply.code(503).send({
          error: workload === "observational_memory" ? gatewayNotStartedError(message) : { type: "database_conflict", message },
          error_code: "database_conflict",
          retryable: true,
          attempts: requestIntent.attempts,
        });
      }
      if (requestIntent instanceof GatewayRequestBudgetError) {
        // This request never acquired an effect. A policy rejection is a hard
        // failure, not the quota/transient receipt that permits OM degradation.
        await saveAdmissionReceipt(requestIntent.code === "GATEWAY_REQUEST_BUDGET_HISTORY_MISSING"
          ? "request_policy_history_missing" : "request_policy_invalid");
        return deny(reply, 409, requestIntent.message, requestIntent.code);
      }
      if (requestIntent instanceof GatewayWorkloadPolicyError) return deny(reply, 403, requestIntent.message, requestIntent.code);
      if (requestIntent instanceof RepairTokenBudgetError) {
        return reply.code(409).send({ error: { type: requestIntent.code, message: requestIntent.message },
          repair_token_budget: requestIntent.budget, retryable: false });
      }
      if ("denied" in requestIntent) {
        if (requestIntent.denied === "job_inactive") return deny(reply, 401, "job is no longer active", "job_inactive");
        if (requestIntent.denied === "workload_usage_unknown") return deny(reply, 409, "observational-memory usage requires reconciliation", "workload_usage_unknown");
        if (requestIntent.denied === "workload_usage_pending") return deny(reply, 409, "observational-memory allowance is reserved by an unsettled request", "workload_usage_pending");
        if (requestIntent.denied === "workload_token_cap_exhausted") {
          await saveAdmissionReceipt("workload_token_cap_exhausted");
          return deny(reply, 429, "observational-memory token cap exhausted", "workload_token_cap_exhausted");
        }
        await saveAdmissionReceipt("quota_exhausted");
        return deny(reply, 429, "request quota exhausted", "quota_exhausted");
      }
      const { requestNo, effectId: gatewayEffectId } = requestIntent;
      const jobDeadlineMs = jt.execution_deadline_at ? new Date(jt.execution_deadline_at).getTime() : gatewayJobDeadlineMs(
        jt.started_at as Date | string | number | null,
        jt.timeout_sec as number | null,
      );
      const controller = new AbortController();
      const abortClient = () => { if (!reply.raw.writableFinished) controller.abort(); };
      reply.raw.once("close", abortClient);
      const timeout = Math.max(1, Math.min(config.gateway.upstreamTimeoutMs, jobDeadlineMs === null ? Infinity : jobDeadlineMs - Date.now()));
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)]);
      let upstream: Awaited<ReturnType<typeof requestGatewayHttp>>;
      try {
        upstream = await requestGatewayHttp({ url, method: req.method, headers, body: outboundBuf, trailers: requestTrailers, signal });
      } catch (error) {
        reply.raw.off("close", abortClient);
        if (isKnownObservationalMemoryPreRequestFailure(error)) {
          const settled = await trySettleGatewayNoExternalUsage({
            jobId: String(jt.job_id),
            projectId: String(jt.project_id),
            attemptId: gatewayAttemptId,
            jobTokenId: String(jt.id),
            effectId: gatewayEffectId,
            requestNo,
            provider: safeProvider,
            model,
            modelCatalogMatch,
            upstreamReportingModel: null,
            usage: { ...EMPTY_USAGE },
            status: "settled",
            source: "gateway_error",
            workload,
          });
          if (settled) {
            return reply.code(503).send({
              error: gatewayNotStartedError("upstream unavailable before request start"),
            });
          }
          return deny(reply, 409, "Model usage requires reconciliation", workload === "main" ? "JOB_TOKEN_USAGE_UNKNOWN" : "workload_usage_unknown");
        }
        await trySettleGatewayUsage({
          jobId: String(jt.job_id),
          projectId: String(jt.project_id),
          attemptId: gatewayAttemptId,
          jobTokenId: String(jt.id),
          effectId: gatewayEffectId,
          requestNo,
          provider: safeProvider,
          model,
          modelCatalogMatch,
          upstreamReportingModel: null,
          usage: { ...EMPTY_USAGE },
          status: "unknown",
          source: "gateway_error",
          workload,
        }, "unknown", error);
        reply.raw.off("close", abortClient);
        recordGatewayRetryMetrics(safeProvider, 1, [], signal.aborted ? "timeout" : "network");
        inc("deepsonar_provider_errors_total", { provider: safeProvider });
        if (workload === "observational_memory") return deny(reply, 409, "observational-memory usage requires reconciliation", "workload_usage_unknown");
        return deny(reply, 502, "上游不可达", "upstream_unreachable");
      }
      recordGatewayRetryMetrics(safeProvider, 1, []);
      inc("deepsonar_model_requests_total", { provider: safeProvider });
      const status = upstream.statusCode ?? 502;
      if (status >= 500) inc("deepsonar_provider_errors_total", { provider: safeProvider });
      const isSse = String(upstream.headers["content-type"] ?? "").includes("text/event-stream");
      const scanner = createRepairUsageScanner(upstreamPath, isSse);
      const hasEntity = req.method !== "HEAD" && status !== 204 && status !== 304;
      const compressed = hasEntity && Boolean(upstream.headers["content-encoding"] && upstream.headers["content-encoding"] !== "identity");
      const observation: Buffer[] = []; let observationBytes = 0;
      let interrupted = false;
      let secretTail = Buffer.alloc(0);
      const secretBytes = Buffer.from(secret);
      const safeWrite = async (bytes: Buffer, final = false): Promise<void> => {
        const pending = Buffer.concat([secretTail, bytes]);
        if (secretBytes.length && pending.includes(secretBytes)) throw new Error("upstream_credential_echo");
        let held = 0;
        if (!final) for (let n = Math.min(secretBytes.length - 1, pending.length); n > 0; n--) {
          if (pending.subarray(pending.length - n).equals(secretBytes.subarray(0, n))) { held = n; break; }
        }
        const end = pending.length - held;
        if (end && !reply.raw.write(pending.subarray(0, end))) await once(reply.raw, "drain", { signal });
        secretTail = Buffer.from(pending.subarray(end));
      };
      let responseGuard: ReturnType<typeof createGatewayResponseGuard> | undefined;
      reply.hijack();
      try {
        responseGuard = createGatewayResponseGuard(secret, hasEntity ? headerString(upstream.headers["content-encoding"]) : undefined);
        if (secret && (upstream.statusMessage?.includes(secret) || upstream.rawHeaders.some(value => value.includes(secret)))) throw new Error("upstream_credential_echo");
        reply.raw.writeHead(status, upstream.statusMessage, gatewayEndToEndHeaders(upstream.rawHeaders));
        reply.raw.flushHeaders();
        for await (const chunk of upstream) {
          const bytes = Buffer.from(chunk);
          await responseGuard.inspect(bytes);
          await safeWrite(bytes);
          if (compressed || workload === "observational_memory") {
            observationBytes += bytes.length;
            if (observationBytes <= MODEL_GATEWAY_BODY_LIMIT) observation.push(bytes);
          }
          if (!compressed) { scanner.push(bytes); noteResponseChunk(bytes); }
        }
        if (compressed && observationBytes <= MODEL_GATEWAY_BODY_LIMIT) {
          try {
            const decoded = gatewayObservationBytes(Buffer.concat(observation), headerString(upstream.headers["content-encoding"]));
            scanner.push(decoded); noteResponseChunk(decoded);
          } catch { /* Unknown usage cannot authorize another bounded request. */ }
        }
        await responseGuard.finish();
        await safeWrite(Buffer.alloc(0), true);
        if (upstream.rawTrailers.length) {
          if (secret && upstream.rawTrailers.some(value => value.includes(secret))) throw new Error("upstream_credential_echo");
          const connection: string[] = [];
          for (let i = 0; i < upstream.rawHeaders.length; i += 2) {
            if (upstream.rawHeaders[i]!.toLowerCase() === "connection") connection.push(upstream.rawHeaders[i]!, upstream.rawHeaders[i + 1]!);
          }
          const flat = gatewayEndToEndHeaders([...connection, ...upstream.rawTrailers]);
          const trailers: [string, string][] = [];
          for (let i = 0; i < flat.length; i += 2) trailers.push([flat[i]!, flat[i + 1]!]);
          reply.raw.addTrailers(trailers);
        }
      } catch {
        interrupted = true;
        controller.abort();
        upstream.destroy();
      }
      responseGuard?.destroy();
      const trusted = scanner.finish();
      let protocolFailure = false;
      if (workload === "observational_memory") {
        try {
          if (observationBytes > MODEL_GATEWAY_BODY_LIMIT) protocolFailure = true;
          else {
            const observed = gatewayObservationBytes(Buffer.concat(observation), headerString(upstream.headers["content-encoding"]));
            protocolFailure = containsGatewayApiErrorFrame(observed, isSse)
              || containsAnthropicRefusalFailureCarrier(observed, isSse, upstreamPath)
              || containsReservedGatewayTransientEnvelope(observed, isSse);
          }
        } catch { protocolFailure = true; }
      }
      const unknown = protocolFailure || interrupted || status < 200 || status >= 300 || (workload === "observational_memory" && !trusted);
      const usage = trusted ?? { ...EMPTY_USAGE };
      await trySettleGatewayUsage({
        jobId: String(jt.job_id), projectId: String(jt.project_id), attemptId: gatewayAttemptId,
        jobTokenId: String(jt.id), effectId: gatewayEffectId, requestNo, provider: safeProvider,
        model, modelCatalogMatch, upstreamReportingModel, usage,
        status: unknown ? "unknown" : trusted ? "settled" : "not_reported",
        source: isSse ? "gateway_stream" : "gateway_response", workload,
      }, unknown ? "unknown" : "settled", unknown ? "模型请求完整用量无法确认" : undefined);
      if (usage.total > 0 && !unknown) inc("deepsonar_model_tokens_total", { provider: safeProvider }, usage.total);
      reply.raw.off("close", abortClient);
      if (interrupted) reply.raw.destroy(); else reply.raw.end();

    },
  });
  });
}

/** 审计辅助：网关拒绝/异常也进审计（无 req.actor，actor 记 anonymous + job_token 资源） */
async function auditGateway(
  req: FastifyRequest,
  entry: {
    action: string;
    projectId?: string | null;
    resourceId?: string | null;
    result?: "ok" | "denied" | "error";
    errorCode?: string | null;
    after?: unknown;
  },
): Promise<void> {
  await audit(req, {
    action: entry.action,
    projectId: entry.projectId ?? null,
    resourceType: "job_token",
    resourceId: entry.resourceId ?? null,
    result: entry.result,
    errorCode: entry.errorCode,
    after: entry.after,
  });
}
