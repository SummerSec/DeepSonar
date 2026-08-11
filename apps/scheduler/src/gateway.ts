/**
 * Model Gateway（§6.3）：沙箱不持有长期 Provider Key。
 *
 *   Sandbox ──DEEPSONAR_JOB_TOKEN（短期/单 Job/限模型/限额度）──▶ Gateway ──解密 Credential──▶ 上游
 *
 * - Token 只在执行器内铸造，明文仅注入本 Job 的沙箱 env；库中只存 sha256 + 前缀
 * - 每次请求回查：token 有效 + job 仍在活跃状态（容器残留也调不动）+ 模型/额度限制
 * - 转发：/gateway/<上游路径> → credential.base_url + 路径，按 provider 注入真实认证头
 * - 用量：请求数必计；token 数从非流式 JSON usage 与 SSE usage 片段尽力解析
 * - 红线：上游明文 Key 不出本进程；请求/响应体不落库（usage 除外）
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { audit } from "./audit.js";
import { config } from "./config.js";
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

const JOB_ACTIVE = ["pending", "claimed", "provisioning", "running", "waiting_human"];

/** 模型网关允许进入业务层的最大请求体；超出后才由 Fastify 返回 413。 */
export const MODEL_GATEWAY_BODY_LIMIT = 16 * 1024 * 1024;

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
}): Promise<{ plaintext: string; id: string }> {
  const prefix = randomBytes(4).toString("hex");
  const secret = randomBytes(24).toString("base64url");
  const plaintext = `deepsonarjob_${prefix}_${secret}`;
  const ttl = input.ttlSec ?? config.gateway.tokenTtlSec;
  const [row] = await sql`
    INSERT INTO job_tokens ${sql({
      job_id: input.jobId,
      project_id: input.projectId,
      credential_id: input.credentialId,
      token_prefix: prefix,
      token_hash: hashJobToken(plaintext),
      allowed_models: (input.allowedModels ?? []) as never,
      max_requests: input.maxRequests ?? config.gateway.maxRequests,
      max_tokens: input.maxTokens ?? null,
      expires_at: new Date(Date.now() + ttl * 1000),
    })}
    RETURNING id`;
  // 铸造记录（无 HTTP 上下文，直接写行；actor = system）
  await sql`
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
        allowed_models: input.allowedModels ?? [],
        max_requests: input.maxRequests ?? config.gateway.maxRequests,
      } as never),
      result: "ok",
    })}`;
  return { plaintext, id: row.id as string };
}

/** Job 终态吊销（succeeded/failed/cancelled/timeout/orphan 全部调用点走这里） */
export async function revokeJobTokens(jobId: string, reason: string): Promise<void> {
  const revoked = await sql`
    UPDATE job_tokens SET status = 'revoked', revoked_at = now(), revoke_reason = ${reason}
    WHERE job_id = ${jobId} AND status = 'active'
    RETURNING id, project_id`;
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
function upstreamAuthHeaders(provider: string, secret: string): Record<string, string> {
  switch (provider) {
    case "anthropic":
      return { "x-api-key": secret, "anthropic-version": "2023-06-01" };
    case "openai":
      return { authorization: `Bearer ${secret}` };
    default:
      return {};
  }
}

/** 从 SSE 流片段/JSON 文本里尽力提取 usage（不累加精确账单，只用于额度熔断） */
function extractUsage(text: string): number {
  let total = 0;
  for (const m of text.matchAll(/"usage"\s*:\s*\{[^}]*?"input_tokens"\s*:\s*(\d+)[^}]*?"output_tokens"\s*:\s*(\d+)/g)) {
    total += Number(m[1]) + Number(m[2]);
  }
  // OpenAI 格式 prompt_tokens/completion_tokens
  for (const m of text.matchAll(/"usage"\s*:\s*\{[^}]*?"prompt_tokens"\s*:\s*(\d+)[^}]*?"completion_tokens"\s*:\s*(\d+)/g)) {
    total += Number(m[1]) + Number(m[2]);
  }
  return total;
}

function deny(reply: FastifyReply, code: number, error: string, code2: string) {
  return reply.code(code).send({ error: { type: code2, message: error } });
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
      const header = req.headers.authorization ?? "";
      const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
      const m = token.match(/^deepsonarjob_([0-9a-f]{8})_[A-Za-z0-9_-]{16,}$/);
      if (!m) return deny(reply, 401, "缺少或非法 DEEPSONAR_JOB_TOKEN", "invalid_token");

      const [jt] = await sql`
        SELECT jt.*, j.status AS job_status
        FROM job_tokens jt JOIN jobs j ON j.id = jt.job_id
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
      if ((jt.used_requests as number) >= (jt.max_requests as number)) {
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
      const bodyBuf =
        rawBody == null
          ? null
          : Buffer.isBuffer(rawBody)
            ? rawBody
            : Buffer.from(typeof rawBody === "string" ? rawBody : JSON.stringify(rawBody), "utf8");
      const upstreamPath = (req.params as { "*": string })["*"];
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
      const allowed = (jt.allowed_models as string[]) ?? [];
      if (rawBody && typeof rawBody === "object" && allowed.length > 0) {
        const model = (rawBody as { model?: string }).model;
        if (!model) {
          return deny(reply, 403, "请求缺少 model，无法执行 Credential 模型白名单", "model_required");
        }
        if (!allowed.includes(model)) {
          void auditGateway(req, {
            action: "gateway.denied",
            projectId: jt.project_id as string,
            resourceId: jt.id as string,
            result: "denied",
            errorCode: "model_not_allowed",
            after: { model },
          });
          return deny(reply, 403, `模型 ${model} 不在允许列表`, "model_not_allowed");
        }
      }

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
      const secret = decryptSecret(cred as never);
      const meta = (cred.public_metadata_json ?? {}) as { base_url?: string };
      const settingsBaseUrl = extractBaseUrlFromSettings(cred.settings_config_json);
      const baseUrl =
        meta.base_url ?? settingsBaseUrl ?? PROVIDER_ENV_MAP[safeProvider]?.defaultBaseUrl ?? "https://api.anthropic.com";
      const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
      const url = `${baseUrl.replace(/\/$/, "")}/${upstreamPath}${qs}`;

      // 转发（流式直通；请求数先计，token 数响应后补记）
      await sql`UPDATE job_tokens SET used_requests = used_requests + 1 WHERE id = ${jt.id}`;
      const headers: Record<string, string> = {
        "content-type": (req.headers["content-type"] as string) ?? "application/json",
        accept: (req.headers.accept as string) ?? "application/json",
        ...upstreamAuthHeaders(safeProvider, secret),
      };
      // 透传 anthropic-version 等协议头（过滤 hop-by-hop 与安全头）
      for (const [k, v] of Object.entries(req.headers)) {
        if (/^(anthropic-|x-app|user-agent)/i.test(k) && typeof v === "string") headers[k] = v;
      }

      let upstream: Response;
      try {
        upstream = await fetch(url, {
          method: req.method,
          headers,
          body: bodyBuf && req.method !== "GET" ? new Uint8Array(bodyBuf) : undefined,
          signal: AbortSignal.timeout(config.gateway.upstreamTimeoutMs),
        });
      } catch (e) {
        inc("deepsonar_provider_errors_total", { provider: safeProvider });
        return deny(reply, 502, `上游不可达: ${e instanceof Error ? e.message : e}`, "upstream_unreachable");
      }
      inc("deepsonar_model_requests_total", { provider: safeProvider });
      if (upstream.status >= 500) inc("deepsonar_provider_errors_total", { provider: safeProvider });

      // 响应直通：非流式缓存全文以解析 usage；流式边转发边扫描
      const isSse = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
      reply.hijack();
      reply.raw.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
        ...(isSse ? { "cache-control": "no-cache", connection: "keep-alive" } : {}),
      });
      if (!upstream.body) {
        reply.raw.end();
        return;
      }      let scanned = 0;
      let usageTail = "";
      const reader = upstream.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            reply.raw.write(value);
            // 只扫每个 chunk 的文本，累积用量（usage 片段可能跨 chunk，拼尾扫）
            const text = usageTail + Buffer.from(value).toString("utf8");
            const found = extractUsage(text);
            if (found > 0) scanned += found;
            usageTail = text.slice(-512);
          }
        }
      } catch {
        // 客户端/上游断流：尽力收尾
      } finally {
        reply.raw.end();
      }
      if (scanned > 0) {
        inc("deepsonar_model_tokens_total", { provider: safeProvider }, scanned);
        await sql`UPDATE job_tokens SET used_tokens = used_tokens + ${scanned} WHERE id = ${jt.id}`;
      }
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
