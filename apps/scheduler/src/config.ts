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

export const config = {
  databaseUrl: str("DATABASE_URL", "postgres://dfh:dfh@localhost:5432/deepflowhunter"),
  port: int("SCHEDULER_PORT", 3100),

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
  },

  limits: {
    maxGlobalJobs: int("MAX_GLOBAL_JOBS", 6),
    maxJobsPerProject: int("MAX_JOBS_PER_PROJECT", 2),
    maxFollowupsPerJob: int("MAX_FOLLOWUPS_PER_JOB", 10),
    maxFollowupDepth: int("MAX_FOLLOWUP_DEPTH", 2),
  },

  timeouts: {
    auditSec: int("DEFAULT_AUDIT_TIMEOUT_SEC", 3600),
    verifySec: int("DEFAULT_VERIFY_TIMEOUT_SEC", 1800),
    leaseTtlSec: int("LEASE_TTL_SEC", 120),
    reaperIntervalSec: int("REAPER_INTERVAL_SEC", 30),
    pollIntervalSec: int("POLL_INTERVAL_SEC", 15),
  },

  rules: {
    autoVerifySeverities: str("AUTO_VERIFY_SEVERITIES", "high,critical")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  },

  runtime: {
    provider: str("SANDBOX_PROVIDER", "local-docker"),
    imageAudit: str("DOCKER_IMAGE_AUDIT", "deepflowhunter-agent:latest"),
    anthropicKey: str("ANTHROPIC_API_KEY"),
  },

  events: {
    payloadMaxKb: int("EVENT_PAYLOAD_MAX_KB", 256),
  },
} as const;
