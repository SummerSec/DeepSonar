/**
 * 指标（§13.1）：进程内计数器 + 抓取时 DB 聚合 gauge，Prometheus 文本格式。
 * Level A 单节点设计：无外部依赖；多实例时需换 pushgateway/OTel。
 */
import { sql } from "./db.js";

const counters = new Map<string, number>();

function key(name: string, labels?: Record<string, string>): string {
  if (!labels) return name;
  const l = Object.entries(labels)
    .map(([k, v]) => `${k}="${v.replace(/"/g, '\\"')}"`)
    .join(",");
  return `${name}{${l}}`;
}

/** 计数器 +n（默认 +1）；labels 仅放低基数值（reason/provider 等），禁止放 job_id */
export function inc(name: string, labels?: Record<string, string>, n = 1): void {
  const k = key(name, labels);
  counters.set(k, (counters.get(k) ?? 0) + n);
}

interface Gauge {
  help: string;
  query: () => Promise<number>;
}

/** 抓取时现算的 gauge（DB 是唯一真相，进程重启不丢） */
const GAUGES: Record<string, Gauge> = {
  deepsonar_jobs_active: {
    help: "Jobs in non-terminal states",
    query: async () =>
      (await sql<[{ n: number }]>`
        SELECT COUNT(*)::int AS n FROM jobs
        WHERE status IN ('pending','claimed','provisioning','running','waiting_human')`)[0].n,
  },
  deepsonar_queue_depth: {
    help: "Pending jobs waiting to be claimed",
    query: async () =>
      (await sql<[{ n: number }]>`
        SELECT COUNT(*)::int AS n FROM jobs WHERE status = 'pending'`)[0].n,
  },
  deepsonar_sandbox_active: {
    help: "Running jobs with a live sandbox_id",
    query: async () =>
      (await sql<[{ n: number }]>`
        SELECT COUNT(*)::int AS n FROM jobs
        WHERE status = 'running' AND sandbox_id IS NOT NULL`)[0].n,
  },
  deepsonar_audit_logs_total: {
    help: "Audit log rows (append-only)",
    query: async () =>
      (await sql<[{ n: number }]>`
        SELECT COUNT(*)::int AS n FROM audit_logs`)[0].n,
  },
};

const HELP: Record<string, string> = {
  deepsonar_jobs_created_total: "Jobs created",
  deepsonar_jobs_failed_total: "Jobs reaching failed/timeout terminal states, by reason",
  deepsonar_jobs_orphan_total: "Jobs marked orphan",
  deepsonar_job_duration_seconds_sum: "Sum of finished job durations (succeeded/failed)",
  deepsonar_job_duration_seconds_count: "Count of finished jobs with duration",
  deepsonar_model_requests_total: "Model gateway forwarded requests",
  deepsonar_model_tokens_total: "Model gateway usage tokens (best-effort from usage fields)",
  deepsonar_provider_errors_total: "Model gateway upstream/provider errors",
  deepsonar_api_auth_failed_total: "API auth failures (401/403)",
  deepsonar_sandbox_cleanup_failed_total: "Sandbox destroy/cleanup failures",
  deepsonar_plane_sync_errors_total: "Plane sync/writeback errors",
  deepsonar_graph_snapshots_total: "Bounded graph prompt projections by scope and truncation",
  deepsonar_graph_yaml_chars_total: "Total characters injected through bounded graph projections by scope",
};

/** Prometheus text exposition */
export async function renderMetrics(): Promise<string> {
  const out: string[] = [];
  for (const [name, help] of Object.entries(HELP)) {
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} counter`);
    for (const [k, v] of counters) {
      if (k === name || k.startsWith(`${name}{`)) out.push(`${k} ${v}`);
    }
  }
  for (const [name, g] of Object.entries(GAUGES)) {
    out.push(`# HELP ${name} ${g.help}`, `# TYPE ${name} gauge`);
    try {
      out.push(`${name} ${await g.query()}`);
    } catch {
      out.push(`${name} 0`);
    }
  }
  return out.join("\n") + "\n";
}
