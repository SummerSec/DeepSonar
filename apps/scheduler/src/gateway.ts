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
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { audit } from "./audit.js";
import { config } from "./config.js";
import { jobTokenQuotaExhausted } from "./runtime-knobs.js";
import {
  decryptSecret,
  projectCredentialProvider,
  PROVIDER_ENV_MAP,
  UNKNOWN_PROVIDER_ERROR,
} from "./credentials.js";
import { sql } from "./db.js";
import { inc } from "./metrics.js";
import { appendOtlpEnvelope } from "./evidence.js";
import { extractBaseUrlFromSettings } from "./provider-settings.js";
import {
  bareUpstreamModelId,
  modelCatalogMatchForRequest,
} from "./provider-effective-model.js";
import { claudeCliFingerprintHeaders } from "./claude-cli-fingerprint.js";
import {
  assertGatewayRequestModelAllowed,
  gatewayRequestModelFromBody,
  GatewayFrozenModelMismatchError,
} from "./domains/provider-adapter/index.js";
import { beginEffect, markEffectUnknown, settleEffect } from "./domains/job-attempt/index.js";
import { admitGatewayRepair, boundRepairOutput, readJobTokenAllowance, RepairTokenBudgetError } from "./domains/event-ingestion/repair-token-budget.js";
import { createRepairUsageScanner } from "./gateway-repair-usage.js";
import {
  assertObservationalMemoryProvider,
  assertObservationalMemoryFrozenJobModel,
  assertObservationalMemoryRequestScope,
  GATEWAY_WORKLOADS,
  GatewayWorkloadPolicyError,
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

/** Claude Code CLI selectors that must not be forwarded to a compatible upstream. */
const CLAUDE_CLI_MODEL_ALIASES = new Set(["fable", "sonnet", "opus", "haiku"]);

/**
 * 出站 model：CLI 别名改写成 Job 冻结的 upstream_model；已是上游 ID 或没有冻结值则保持原值。
 */
export function rewriteGatewayOutboundModel(input: {
  requestModel?: string | null;
  upstreamModel?: string | null;
}): string {
  const request = input.requestModel?.trim() ?? "";
  if (!request || !CLAUDE_CLI_MODEL_ALIASES.has(request.toLowerCase())) return request;
  const upstream = input.upstreamModel?.trim() ?? "";
  return upstream || request;
}

function frozenSnapshotUpstreamModel(snapshot: unknown): string | null {
  const record = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
    ? snapshot as { upstream_model?: unknown }
    : null;
  const upstream = typeof record?.upstream_model === "string" ? record.upstream_model.trim() : "";
  return bareUpstreamModelId(upstream);
}

/**
 * 转发路径：非数组对象且 model 是 Claude CLI 别名时，改写成快照顶层 upstream_model。
 * 已是上游 ID、快照缺失/空、或 body 不是带 model 的对象时保持原值（可同对象引用）。
 */
export function applyGatewayOutboundModelRewrite(rawBody: unknown, agentSnapshot: unknown): unknown {
  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) return rawBody;
  const currentModel = typeof (rawBody as { model?: unknown }).model === "string"
    ? (rawBody as { model: string }).model
    : "";
  const outboundModel = rewriteGatewayOutboundModel({
    requestModel: currentModel,
    upstreamModel: frozenSnapshotUpstreamModel(agentSnapshot),
  });
  if (outboundModel && outboundModel !== currentModel) {
    return { ...(rawBody as Record<string, unknown>), model: outboundModel };
  }
  return rawBody;
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

  constructor(reason: GatewayRetryReason, attempts: number, retryReasons: GatewayRetryReason[]) {
    super("上游不可达");
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
        throw new GatewayUpstreamUnreachableError(reason, attempts, retryReasons);
      }
      const remainingMs = request.jobDeadlineMs == null ? Number.POSITIVE_INFINITY : request.jobDeadlineMs - now();
      const delayMs = gatewayRetryDelayMs(retryReasons.length + 1, random, options.retryBaseDelayMs, options.retryMaxDelayMs);
      if (remainingMs <= delayMs) {
        throw new GatewayUpstreamUnreachableError(reason, attempts, retryReasons);
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
  const revoked = await sql.begin(async (tx) => {
    await tx`SELECT id FROM jobs WHERE id = ${jobId} FOR UPDATE`;
    return tx`
      UPDATE job_tokens SET status = 'revoked', revoked_at = now(), revoke_reason = ${reason}
      WHERE job_id = ${jobId} AND status = 'active'
      RETURNING id, project_id`;
  });
  for (const r of revoked) {
    await sql`
      INSERT INTO audit_logs ${sql({
        actor_type: "system",
        actor_id: "scheduler",
        action: "job_token.revoke",
        project_id: r.project_id as string,
        resource_type: "job_token",
        resource_id: r.id as string,
        after_json: sql.json({ job_id: jobId, reason } as never),
        result: "ok",
      })}`;
  }
}

/** 按 provider 注入真实认证头（与 credential-test.ts 行为一致） */
export function upstreamAuthHeaders(provider: string, secret: string): Record<string, string> {
  switch (provider) {
    case "anthropic":
      // 官方 Anthropic 认 x-api-key；第三方兼容代理（及本机 Claude Code）认 Bearer。
      // #736：附带 Claude CLI 指纹（user-agent/x-app）。真实 Job 的 CLI 请求头会在
      // 下方透传逻辑中覆盖这两项；缺少透传头时网关自发的 anthropic 请求仍保持同口径。
      return {
        authorization: `Bearer ${secret}`,
        "x-api-key": secret,
        "anthropic-version": "2023-06-01",
        ...claudeCliFingerprintHeaders(),
      };
    case "openai":
      return { authorization: `Bearer ${secret}` };
    default:
      return {};
  }
}

/** 凭据 base_url 已带 /v1 时，不要把 Claude Code 的 /v1/messages 再拼成 /v1/v1/messages。 */
export function joinGatewayUpstreamUrl(baseUrl: string, upstreamPath: string, qs = ""): string {
  const base = baseUrl.replace(/\/+$/u, "");
  const path = upstreamPath.replace(/^\/+/u, "");
  const baseVer = /\/(v\d+)$/iu.exec(base)?.[1];
  const pathVer = /^(v\d+)(?=\/|$)/iu.exec(path)?.[1];
  if (baseVer && pathVer && baseVer.toLowerCase() === pathVer.toLowerCase()) {
    const rest = path.slice(pathVer.length).replace(/^\/+/u, "");
    return `${base}${rest ? `/${rest}` : ""}${qs}`;
  }
  return `${base}/${path}${qs}`;
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

function deny(reply: FastifyReply, code: number, error: string, code2: string) {
  return reply.code(code).send({ error: { type: code2, message: error } });
}

type GatewayRequestAdmission = {
  requestNo: number;
  effectId: string;
  repairBudget: Awaited<ReturnType<typeof admitGatewayRepair>>;
  singleAttempt: boolean;
} | {
  denied: "job_inactive" | "quota_exhausted" | "workload_usage_unknown" | "workload_usage_pending" | "workload_token_cap_exhausted";
};

/** Repair token accounting is Job-wide for legacy Jobs.  OM Jobs keep the
 * existing repair cap on the main workload only, so background usage cannot
 * consume the main repair reserve. */
async function readWorkloadTokenAllowance(
  db: typeof sql,
  jobId: string,
  workload: GatewayWorkload,
  budget?: Awaited<ReturnType<typeof admitGatewayRepair>> | null,
): Promise<number | null> {
  const [totalLimit] = await db`
    SELECT MIN(NULLIF(COALESCE(workload_max_tokens, max_tokens), 0)) AS cap
    FROM job_tokens
    WHERE job_id = ${jobId} AND workload = ${workload}`;
  const [usage] = await db`
    SELECT COALESCE(SUM(l.total_tokens) FILTER (WHERE l.settlement_status='settled'),0) AS total,
           COUNT(*) FILTER (WHERE e.status='effect_pending' AND l.id IS NULL) AS pending,
           COUNT(*) FILTER (WHERE (e.status <> 'settled' OR l.settlement_status IS DISTINCT FROM 'settled')
             AND NOT (e.status='effect_pending' AND l.id IS NULL)) AS unresolved
    FROM job_attempt_effects e
    LEFT JOIN job_usage_ledger l ON l.attempt_id=e.attempt_id AND l.effect_id=e.effect_id
    WHERE e.job_id=${jobId} AND e.effect_kind='gateway_model_request'
      AND COALESCE(l.workload, e.intent_json->>'workload', 'main') = ${workload}`;
  const total = Number(usage.total), cap = Number(totalLimit.cap), unresolved = Number(usage.unresolved);
  const pending = Number(usage.pending);
  if (unresolved < 0 || !Number.isSafeInteger(unresolved)
    || pending < 0 || !Number.isSafeInteger(pending)
    || (unresolved > 0 && (workload === "observational_memory" || totalLimit.cap != null))
    || total < 0 || !Number.isSafeInteger(total)
    || (totalLimit.cap != null && (cap < 0 || !Number.isSafeInteger(cap)))) {
    throw new RepairTokenBudgetError("JOB_TOKEN_USAGE_UNKNOWN", "Job token usage requires reconciliation", budget ?? undefined);
  }
  if (pending > 0 && (workload === "observational_memory" || totalLimit.cap != null)) {
    throw new RepairTokenBudgetError("JOB_TOKEN_USAGE_PENDING", "Job token allowance is reserved by an unsettled request", budget ?? undefined);
  }
  if (totalLimit?.cap == null) return null;
  if (total >= cap) throw new RepairTokenBudgetError("JOB_TOKEN_EXHAUSTED", "Job token allowance exhausted", budget ?? undefined);
  return cap - total;
}

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
    onRepairBody: (remaining: number | null, budget: Awaited<ReturnType<typeof admitGatewayRepair>>) => void;
  },
): Promise<GatewayRequestAdmission> {
  const [job] = await tx`SELECT status, project_id, agent_snapshot_json FROM jobs WHERE id=${input.jobId} FOR UPDATE`;
  if (!job || !JOB_ACTIVE.includes(String(job.status))) {
    await tx`UPDATE job_tokens SET status='revoked', revoked_at=now(), revoke_reason=${`job_${String(job?.status ?? "missing")}`} WHERE job_id=${input.jobId} AND status='active'`;
    return { denied: "job_inactive" };
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
  const finiteTotalLimits = tokens
    .map((row) => Number(row.request_total_limit))
    .filter((limit) => limit > 0);
  const totalLimit = omPlan?.total_requests ?? (finiteTotalLimits.length > 0 ? Math.min(...finiteTotalLimits) : 0);
  const totalUsed = tokens.reduce((sum, row) => sum + Number(row.used_requests), 0);
  const workloadUsed = tokens
    .filter((row) => row.workload === input.workload)
    .reduce((sum, row) => sum + Number(row.used_requests), 0);
  if (!Number.isSafeInteger(totalUsed) || !Number.isSafeInteger(workloadUsed)) {
    return { denied: omJob ? "workload_usage_unknown" : "quota_exhausted" };
  }
  const workloadTokens = tokens.filter((row) => row.workload === input.workload);
  const finiteWorkloadLimits = workloadTokens
    .map((row) => Number(row.max_requests ?? 0))
    .filter((limit) => Number.isSafeInteger(limit) && limit > 0);
  const workloadLimit = omPlan
    ? input.workload === "main" ? omPlan.main_requests : omPlan.background_requests
    : finiteWorkloadLimits.length > 0 ? Math.min(...finiteWorkloadLimits) : 0;
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
  if (totalLimit > 0 && totalUsed >= totalLimit) return { denied: "quota_exhausted" };
  if (omJob && workloadLimit > 0 && workloadUsed >= workloadLimit) return { denied: "quota_exhausted" };
  if (backgroundPending) return { denied: "workload_usage_pending" };

  const repairBudget = input.workload === "main"
    ? await admitGatewayRepair(tx, input.jobId, input.attemptId)
    : null;
  const totalRemaining = input.workload === "main" && omJob
    ? await readWorkloadTokenAllowance(tx, input.jobId, "main", repairBudget)
    : input.workload === "main"
      ? await readJobTokenAllowance(tx, input.jobId, repairBudget ?? undefined)
      : backgroundRemaining;
  const remaining = totalRemaining === null ? repairBudget?.remaining_tokens ?? null
    : Math.min(totalRemaining, repairBudget?.remaining_tokens ?? totalRemaining);
  if (repairBudget) repairBudget.remaining_tokens = remaining;
  input.onRepairBody(remaining, repairBudget);

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
      workload: input.workload,
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
  app.addContentTypeParser(
    ["application/x-protobuf", "application/protobuf"],
    { parseAs: "buffer", bodyLimit: 2 * 1024 * 1024 },
    (_req, body, done) => done(null, body),
  );
  app.route({
    method: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    url: "/gateway/*",
    bodyLimit: MODEL_GATEWAY_BODY_LIMIT,
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const token = extractInboundJobToken(req.headers);
      const m = token?.match(JOB_TOKEN_RE) ?? null;
      if (!token || !m) return deny(reply, 401, "缺少或非法 DEEPSONAR_JOB_TOKEN", "invalid_token");

      const [jt] = await sql`
        SELECT jt.*, j.status AS job_status, j.started_at, j.timeout_sec,
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
      if (jt.workload !== "observational_memory" && jobTokenQuotaExhausted(jt.used_requests as number, jt.max_requests as number)) {
        await sql`UPDATE job_tokens SET status = 'exhausted' WHERE id = ${jt.id} AND status = 'active'`;
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

      // 模型限制（仅对带 model 字段的请求体生效；fastify 已解析 JSON，重序列化转发）
      const rawBody = req.body as unknown;
      let workload: GatewayWorkload;
      try {
        workload = gatewayWorkload(jt.workload);
      } catch {
        return deny(reply, 403, "token workload 不受支持", "unknown_workload");
      }
      const upstreamPath = (req.params as { "*": string })["*"];
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
      const outboundBody = workload === "observational_memory"
        ? rawBody
        : applyGatewayOutboundModelRewrite(rawBody, jt.agent_snapshot_json);
      let outboundBuf =
        outboundBody == null
          ? null
          : Buffer.isBuffer(outboundBody)
            ? outboundBody
            : Buffer.from(typeof outboundBody === "string" ? outboundBody : JSON.stringify(outboundBody), "utf8");

      // 解密 Credential（明文不出本进程）
      const [cred] = await sql`SELECT * FROM credentials WHERE id = ${jt.credential_id}`;
      if (!cred || (cred.status as string) !== "active") {
        return deny(reply, 502, "绑定的凭据不可用", "credential_inactive");
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
      const url = joinGatewayUpstreamUrl(baseUrl, upstreamPath, qs);

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
      const requestIntent = await sql.begin(async (tx) => {
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
          gatewayInputDigest: () => createHash("sha256").update(outboundBuf ?? Buffer.alloc(0)).digest("hex"),
          onRepairBody: (remaining, repairBudget) => {
            if (repairBudget || remaining !== null) {
              outboundBuf = Buffer.from(JSON.stringify(boundRepairOutput(outboundBody, upstreamPath, remaining)), "utf8");
            }
          },
        });
      }).catch(error => {
        if (error instanceof RepairTokenBudgetError || error instanceof GatewayWorkloadPolicyError) return error;
        throw error;
      });
      if (requestIntent instanceof GatewayWorkloadPolicyError) return deny(reply, 403, requestIntent.message, requestIntent.code);
      if (requestIntent instanceof RepairTokenBudgetError) {
        return reply.code(409).send({ error: { type: requestIntent.code, message: requestIntent.message },
          repair_token_budget: requestIntent.budget, retryable: false });
      }
      if ("denied" in requestIntent) {
        if (requestIntent.denied === "job_inactive") return deny(reply, 401, "job is no longer active", "job_inactive");
        if (requestIntent.denied === "workload_usage_unknown") return deny(reply, 409, "observational-memory usage requires reconciliation", "workload_usage_unknown");
        if (requestIntent.denied === "workload_usage_pending") return deny(reply, 409, "observational-memory allowance is reserved by an unsettled request", "workload_usage_pending");
        if (requestIntent.denied === "workload_token_cap_exhausted") return deny(reply, 429, "observational-memory token cap exhausted", "workload_token_cap_exhausted");
        return deny(reply, 429, "request quota exhausted", "quota_exhausted");
      }
      const { requestNo, effectId: gatewayEffectId } = requestIntent;
      const headers: Record<string, string> = {
        "content-type": (req.headers["content-type"] as string) ?? "application/json",
        accept: (req.headers.accept as string) ?? "application/json",
        ...upstreamAuthHeaders(safeProvider, secret),
      };
      // 透传 anthropic-version 等协议头（过滤 hop-by-hop 与安全头）
      for (const [k, v] of Object.entries(req.headers)) {
        if (/^(anthropic-|x-app|user-agent)/i.test(k) && typeof v === "string") headers[k] = v;
      }

      const jobDeadlineMs = gatewayJobDeadlineMs(
        jt.started_at as Date | string | number | null,
        jt.timeout_sec as number | null,
      );
      let upstreamResult: GatewayRetryResult;
      try {
        upstreamResult = await fetchGatewayUpstream({
          url,
          upstreamTimeoutMs: config.gateway.upstreamTimeoutMs,
          jobDeadlineMs,
          init: {
            method: req.method,
            headers,
            body: outboundBuf && req.method !== "GET" ? new Uint8Array(outboundBuf) : undefined,
          },
        }, requestIntent.singleAttempt ? { maxAttempts: 1 } : {});
      } catch (error) {
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
        if (!(error instanceof GatewayUpstreamUnreachableError)) throw error;
        recordGatewayRetryMetrics(safeProvider, error.attempts, error.retryReasons, error.reason);
        inc("deepsonar_provider_errors_total", { provider: safeProvider });
        if (workload === "observational_memory") return deny(reply, 409, "observational-memory usage requires reconciliation", "workload_usage_unknown");
        return deny(reply, 502, "上游不可达", "upstream_unreachable");
      }
      const upstream = upstreamResult.response;
      recordGatewayRetryMetrics(
        safeProvider,
        upstreamResult.attempts,
        upstreamResult.retryReasons,
        upstreamResult.exhaustedReason,
      );
      inc("deepsonar_model_requests_total", { provider: safeProvider });
      if (upstream.status >= 500) inc("deepsonar_provider_errors_total", { provider: safeProvider });

      // 响应直通：非流式缓存全文以解析 usage；流式边转发边扫描
      const isSse = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
      // Background responses are bounded and acknowledged only after trusted
      // terminal usage and durable settlement. A provider error, partial stream
      // or ledger failure must surface as unknown, never quota degradation.
      const backgroundChunks: Uint8Array[] | null = workload === "observational_memory" ? [] : null;
      let backgroundBytes = 0;
      if (!backgroundChunks) {
        reply.hijack();
        reply.raw.writeHead(upstream.status, {
          "content-type": upstream.headers.get("content-type") ?? "application/json",
          ...(isSse ? { "cache-control": "no-cache", connection: "keep-alive" } : {}),
        });
      }
      if (!upstream.body) {
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
          status: backgroundChunks ? "unknown" : "not_reported",
          source: isSse ? "gateway_stream" : "gateway_response",
          workload,
        }, backgroundChunks ? "unknown" : "settled");
        if (backgroundChunks) return deny(reply, 409, "observational-memory usage requires reconciliation", "workload_usage_unknown");
        reply.raw.end();
        return;
      }
      const repairUsageScanner = createRepairUsageScanner(upstreamPath, isSse);
      const reader = upstream.body.getReader();
      let streamInterrupted = false;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            if (backgroundChunks) {
              backgroundBytes += value.byteLength;
              if (backgroundBytes > 16_777_216) throw new Error("background response exceeds accounting buffer");
              backgroundChunks.push(value);
            } else reply.raw.write(value);
            // 只解析完整 SSE/JSON 行；保留未完成行，避免重叠尾巴导致
            // 同一 usage JSON 在相邻 chunk 中被重复累计。
            repairUsageScanner.push(value);
            noteResponseChunk(value);
          }
        }
      } catch {
        // 客户端/上游断流：尽力收尾
        streamInterrupted = true;
        await reader.cancel().catch(() => {});
      }
      const trustedUsage = repairUsageScanner.finish();
      const usage = trustedUsage ?? { ...EMPTY_USAGE };
      const scanned = usage.total;
      // Earlier hidden attempts and interrupted/error responses cannot establish complete cost.
      const uncertainUsage = streamInterrupted || upstreamResult.attempts > 1 || !upstream.ok
        || (backgroundChunks !== null && trustedUsage === null);
      const usageSettled = await trySettleGatewayUsage({
        jobId: String(jt.job_id),
        projectId: String(jt.project_id),
        attemptId: gatewayAttemptId,
        jobTokenId: String(jt.id),
        effectId: gatewayEffectId,
        requestNo,
        provider: safeProvider,
        model,
        modelCatalogMatch,
        upstreamReportingModel,
        usage,
        status: uncertainUsage ? "unknown" : trustedUsage ? "settled" : "not_reported",
        source: isSse ? "gateway_stream" : "gateway_response",
        workload,
      }, uncertainUsage ? "unknown" : "settled", uncertainUsage ? "模型请求完整用量无法确认" : undefined);
      if (scanned > 0 && !uncertainUsage) {
        inc("deepsonar_model_tokens_total", { provider: safeProvider }, scanned);
      }
      if (backgroundChunks) {
        if (uncertainUsage || !usageSettled) return deny(reply, 409, "observational-memory usage requires reconciliation", "workload_usage_unknown");
        return reply.code(upstream.status)
          .header("content-type", upstream.headers.get("content-type") ?? "application/json")
          .send(Buffer.concat(backgroundChunks));
      }
      reply.raw.end();
    },
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
