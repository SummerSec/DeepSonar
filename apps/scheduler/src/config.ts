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
/** Bounded positive integer configuration; invalid or out-of-range values use the safe default. */
function boundedInt(name: string, dflt: number, max: number): number {
  const v = Number(process.env[name]);
  return Number.isSafeInteger(v) && v > 0 && v <= max ? v : dflt;
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
    maxGlobalJobs: int("MAX_GLOBAL_JOBS", 12),
    maxJobsPerProject: int("MAX_JOBS_PER_PROJECT", 4),
    maxFollowupsPerJob: int("MAX_FOLLOWUPS_PER_JOB", 60),
    maxFollowupDepth: int("MAX_FOLLOWUP_DEPTH", 12),
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
    /** 默认只自动验证高危；项目/全局 rules 可覆盖 */
    autoVerifySeverities: str("AUTO_VERIFY_SEVERITIES", "critical,high")
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

  /** Server-side graph prompt budgets (Issue #30). */
  graph: {
    maxYamlCharsHub: int("MAX_GRAPH_YAML_CHARS_HUB", 48_000),
    maxYamlCharsAgent: int("MAX_GRAPH_YAML_CHARS_AGENT", 16_000),
    maxYamlCharsVerify: int("MAX_GRAPH_YAML_CHARS_VERIFY", 24_000),
    maxYamlCharsReport: int("MAX_GRAPH_YAML_CHARS_REPORT", 8_000),
    maxFindingReportInputChars: int("MAX_FINDING_REPORT_INPUT_CHARS", 40_000),
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
  },

  events: {
    payloadMaxKb: int("EVENT_PAYLOAD_MAX_KB", 256),
    /** Persistent per-Job semantic-event fixed-window budgets (Issue #57). */
    rateLimitWindowSec: boundedInt("EVENT_RATE_LIMIT_WINDOW_SEC", 60, 3600),
    rateLimitProgressPerWindow: boundedInt("EVENT_RATE_LIMIT_PROGRESS_PER_WINDOW", 30, 10_000),
    rateLimitStandardPerWindow: boundedInt("EVENT_RATE_LIMIT_STANDARD_PER_WINDOW", 120, 10_000),
    // Reserved terminal bucket keeps done/human semantics available even when
    // progress is noisy. It is intentionally independent, not a shared pool.
    rateLimitTerminalPerWindow: boundedInt("EVENT_RATE_LIMIT_TERMINAL_PER_WINDOW", 8, 1000),
  },

  /** Job 原始 Session、normalized stream 与 OTLP 冷存储。 */
  storage: {
    blobDir: path.resolve(process.cwd(), str("BLOB_DIR", "./data/blobs")),
    transcriptRetentionDays: int("TRANSCRIPT_RETENTION_DAYS", 90),
  },

  skillSources: {
    /** 逗号分隔的 Git host 允许列表；空 = 任意 HTTPS host。 */
    allowedGitHosts: str("DEEPSONAR_GIT_ALLOWED_HOSTS", ""),
    /** 启动时对已信任且启用的模块源默认执行一次同步。 */
    bootSync: bool("DEEPSONAR_SKILL_SOURCE_BOOT_SYNC", true),
  },

  /** 可信运行镜像目录由数据库管理；环境变量只负责引导官方 digest 与 registry 边界。 */
  images: {
    officialBaseRef: str("DEEPSONAR_OFFICIAL_BASE_IMAGE"),
    officialAuditRef: str("DEEPSONAR_OFFICIAL_AUDIT_IMAGE"),
    officialKaliMinimalRef: str("DEEPSONAR_OFFICIAL_KALI_MINIMAL_IMAGE"),
    /** 私有 GitHub Release 清单的短期/部署级读取凭据；永不返回 API。 */
    registryGithubToken: str("DEEPSONAR_RUNTIME_REGISTRY_GITHUB_TOKEN"),
    registrySyncSec: int("DEEPSONAR_RUNTIME_REGISTRY_SYNC_SEC", 3600),
    allowedRegistries: str("DEEPSONAR_ALLOWED_IMAGE_REGISTRIES", "ghcr.io,docker.io,registry-1.docker.io"),
    isRegistryAllowed(imageRef: string): boolean {
      const first = imageRef.split("/")[0]?.toLowerCase() ?? "";
      const registry = first.includes(".") || first.includes(":") ? first : "docker.io";
      return this.allowedRegistries.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean).includes(registry);
    },
  },
} as const;
