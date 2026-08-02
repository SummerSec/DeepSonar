import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** 无依赖 .env 加载（Node 20+；不覆盖已有环境变量） */
function loadEnvFile() {
  const candidates = [
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), "../../.env"), // 从 apps/scheduler 启动时
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m || line.trim().startsWith("#")) continue;
      if (process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
    return;
  }
}
loadEnvFile();

function str(name: string, dflt = ""): string {
  return process.env[name] ?? dflt;
}
function int(name: string, dflt: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}
function bool(name: string, dflt: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return dflt;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

export const config = {
  databaseUrl: str("DATABASE_URL", "postgres://deepsonar:deepsonar@localhost:5432/deepsonar"),
  port: int("SCHEDULER_PORT", 3100),
  /** 监听地址：默认只绑回环（P0 可信网络）；容器部署显式设 0.0.0.0 */
  host: str("SCHEDULER_HOST", "127.0.0.1"),

  /** 平台 API Token 鉴权（SEC-01/§6.1）；跨出回环部署必须 DEEPSONAR_AUTH_REQUIRED=true */
  auth: {
    required: bool("DEEPSONAR_AUTH_REQUIRED", false),
    /** 引导管理员 token（不落库）；用于首次创建 DB token 与应急 */
    adminToken: str("DEEPSONAR_ADMIN_TOKEN"),
    /** token 格式中的环境段：deepsonar_<env>_<prefix>_<secret> */
    tokenEnv: str("DEEPSONAR_TOKEN_ENV", "dev"),
  },

  /** Provider Credential 主密钥（§6.2：与密文不同库；文件优先） */
  credentials: {
    masterKeyFile: str("DEEPSONAR_MASTER_KEY_FILE"),
    masterKey: str("DEEPSONAR_MASTER_KEY"),
  },

  plane: {
    baseUrl: str("PLANE_BASE_URL", "https://api.plane.so"),
    token: str("PLANE_API_TOKEN"),
    workspaceSlug: str("PLANE_WORKSPACE_SLUG"),
    readyState: str("PLANE_READY_STATE", "Ready"),
    inProgressState: str("PLANE_IN_PROGRESS_STATE", "In Progress"),
    doneState: str("PLANE_DONE_STATE", "Done"),
    webhookSecret: str("PLANE_WEBHOOK_SECRET"),
    get enabled() {
      return Boolean(this.token && this.workspaceSlug);
    },
    /** Plane 前端地址（任务指引里给用户点的链接）；默认从 API 地址推导 */
    get webUrl() {
      const explicit = str("PLANE_WEB_URL");
      if (explicit) return explicit;
      return this.baseUrl.includes("api.plane.so")
        ? this.baseUrl.replace("api.plane.so", "app.plane.so")
        : this.baseUrl;
    },
  },

  limits: {
    maxGlobalJobs: int("MAX_GLOBAL_JOBS", 6),
    maxJobsPerProject: int("MAX_JOBS_PER_PROJECT", 2),
    maxFollowupsPerJob: int("MAX_FOLLOWUPS_PER_JOB", 20),
    maxFollowupDepth: int("MAX_FOLLOWUP_DEPTH", 4),
    maxAutoRetries: int("MAX_AUTO_RETRIES", 6),
  },

  timeouts: {
    auditSec: int("DEFAULT_AUDIT_TIMEOUT_SEC", 7200),
    verifySec: int("DEFAULT_VERIFY_TIMEOUT_SEC", 3600),
    /** provision（起沙箱）独立超时（§8.3）；claimed/provisioning 超过该时长由 reaper 判 failed */
    provisionSec: int("PROVISION_TIMEOUT_SEC", 300),
    leaseTtlSec: int("LEASE_TTL_SEC", 120),
    reaperIntervalSec: int("REAPER_INTERVAL_SEC", 30),
    /** 任务领取的兜底轮询（默认 0=关闭，纯 LISTEN/NOTIFY 事件驱动） */
    dispatchPollSec: int("DEEPSONAR_DISPATCH_POLL_SEC", 0),
    /** Plane 轮询（默认 0=关闭，走 /webhooks/plane 事件；未配 webhook 时须显式开启） */
    planePollSec: int("PLANE_POLL_INTERVAL_SEC", 0),
  },

  rules: {
    autoVerifySeverities: str("AUTO_VERIFY_SEVERITIES", "low,medium,high,critical")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  },

  /** hub 循环（Cairn 式图语义）：角色 job 成功后触发 hub_reason 读图决策 */
  hub: {
    enabled: bool("DEEPSONAR_HUB_ENABLED", true),
    maxRounds: int("DEEPSONAR_HUB_MAX_ROUNDS", 20),
    maxIntents: int("DEEPSONAR_HUB_MAX_INTENTS", 6),
  },

  /** Model Gateway（§6.3）：沙箱持短期 DEEPSONAR_JOB_TOKEN 经网关调用模型，不持有长期 Key */
  gateway: {
    /** 沙箱内可达的网关地址（容器→宿主；compose 内为服务名） */
    sandboxUrl: str("DEEPSONAR_GATEWAY_SANDBOX_URL", "http://host.docker.internal:3100/gateway"),
    /** 禁止出网 Worker 在 internal bridge 内访问的固定目标 sidecar URL。 */
    restrictedSandboxUrl: str("DEEPSONAR_GATEWAY_RESTRICTED_URL", "http://deepsonar-gateway-proxy:3100/gateway"),
    /** Job Token 默认请求上限 */
    maxRequests: int("DEEPSONAR_JOB_TOKEN_MAX_REQUESTS", 500),
    /** Job Token 生命周期（秒），应 ≥ job timeout */
    tokenTtlSec: int("DEEPSONAR_JOB_TOKEN_TTL_SEC", 4 * 3600),
    /** 转发上游超时（毫秒；流式为首字节超时） */
    upstreamTimeoutMs: int("DEEPSONAR_GATEWAY_UPSTREAM_TIMEOUT_MS", 120_000),
  },

  /** 数据库连接治理（§12.3）：池上限、语句/空闲超时 */
  db: {
    poolMax: int("DEEPSONAR_DB_POOL_MAX", 10),
    statementTimeoutMs: int("DEEPSONAR_DB_STATEMENT_TIMEOUT_MS", 60_000),
    idleTimeoutSec: int("DEEPSONAR_DB_IDLE_TIMEOUT_SEC", 30),
    connectTimeoutSec: int("DEEPSONAR_DB_CONNECT_TIMEOUT_SEC", 10),
  },

  runtime: {
    provider: str("SANDBOX_PROVIDER", "local-docker"),
    imageAudit: str("DOCKER_IMAGE_AUDIT", "deepsonar-agent:latest"),
    /** fake=内置假 agent（联调用）；real=agentbox-sdk 真实 agent */
    agentMode: str("AGENT_MODE", "fake"),
    /** agentbox-sdk agent provider：claude-code | opencode | codex（同一 API 可换） */
    agentProvider: str("AGENT_PROVIDER", "claude-code"),
    agentModel: str("AGENT_MODEL"),
    anthropicKey: str("ANTHROPIC_API_KEY"),
    anthropicBaseUrl: str("ANTHROPIC_BASE_URL"),
    anthropicAuthToken: str("ANTHROPIC_AUTH_TOKEN"),
    openaiKey: str("OPENAI_API_KEY"),
    openaiBaseUrl: str("OPENAI_BASE_URL"),
    openrouterKey: str("OPENROUTER_API_KEY"),
    /** SEC-03 沙箱硬限制（可按机器规格调；0/关 仅限调试） */
    sandboxLimits: {
      cpu: int("DEEPSONAR_SANDBOX_CPU", 2),
      memoryMiB: int("DEEPSONAR_SANDBOX_MEMORY_MIB", 2048),
      pidsLimit: int("DEEPSONAR_SANDBOX_PIDS", 512),
      capDropAll: bool("DEEPSONAR_SANDBOX_CAP_DROP_ALL", true),
      noNewPrivileges: bool("DEEPSONAR_SANDBOX_NO_NEW_PRIVILEGES", true),
    },
    /**
     * profile env_keys 白名单（P0：暂停任意环境变量下发，SEC 方案 §6.2 过渡措施）。
     * 逗号分隔，支持前缀通配（如 ANTHROPIC_*）；profile 里不在白名单的变量名会被拒绝注入。
     */
    allowedEnvKeys: str("DEEPSONAR_ALLOWED_ENV_KEYS", "ANTHROPIC_*,OPENAI_*,OPENROUTER_*"),
    isEnvKeyAllowed(key: string): boolean {
      return this.allowedEnvKeys
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .some((p) => (p.endsWith("*") ? key.startsWith(p.slice(0, -1)) : key === p));
    },
    /** 注入沙箱的 Agent 环境变量（只放非空项，密钥仅调度器持有，§9） */
    get agentEnv(): Record<string, string> {
      const env: Record<string, string> = {};
      if (this.anthropicKey) env.ANTHROPIC_API_KEY = this.anthropicKey;
      if (this.anthropicBaseUrl) env.ANTHROPIC_BASE_URL = this.anthropicBaseUrl;
      if (this.anthropicAuthToken) env.ANTHROPIC_AUTH_TOKEN = this.anthropicAuthToken;
      // 中转端点（如 Kimi for Coding）通常要求 AUTH_TOKEN；只配了 KEY 时镜像一份
      if (this.anthropicBaseUrl && !this.anthropicAuthToken && this.anthropicKey) {
        env.ANTHROPIC_AUTH_TOKEN = this.anthropicKey;
      }
      if (this.openaiKey) env.OPENAI_API_KEY = this.openaiKey;
      if (this.openaiBaseUrl) env.OPENAI_BASE_URL = this.openaiBaseUrl;
      if (this.openrouterKey) env.OPENROUTER_API_KEY = this.openrouterKey;
      return env;
    },
  },

  events: {
    payloadMaxKb: int("EVENT_PAYLOAD_MAX_KB", 256),
  },

  skillSources: {
    /** 逗号分隔的 Git host 允许列表；空 = 任意 HTTPS host。 */
    allowedGitHosts: str("DEEPSONAR_GIT_ALLOWED_HOSTS", ""),
  },

  /** 可信运行镜像目录（runtime_image_key 只能引用这里的 key；空 = 不允许自定义镜像） */
  images: {
    trustedKeys: str("DEEPSONAR_TRUSTED_IMAGE_KEYS", ""),
    isTrusted(key: string): boolean {
      return this.trustedKeys.split(",").map((s) => s.trim()).filter(Boolean).includes(key);
    },
  },
} as const;
