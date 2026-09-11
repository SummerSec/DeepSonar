import type { TaskTraceEntry, TaskTraceKind } from "./types";

export type TraceJob = {
  id: string;
  type?: string | null;
  status?: string | null;
  role_name?: string | null;
  created_at?: string | null;
  started_at?: string | null;
};

export type TraceFact = {
  id: string;
  verification_status?: string | null;
  created_at?: string | null;
};

export type TraceFinding = {
  id: string;
  verify_status?: string | null;
  created_at?: string | null;
};

export type TraceReport = {
  id?: string;
  version: number;
  status: string;
  created_at?: string;
  updated_at?: string;
  generated_at?: string | null;
};

export type TaskTraceInput = {
  objective: string;
  createdAt: string;
  jobs?: readonly TraceJob[];
  facts?: readonly TraceFact[];
  findings?: readonly TraceFinding[];
  report?: TraceReport | null;
  lifecycleLabel?: string | null;
  lifecycleReason?: string | null;
};

const TRACE_ORDER: TaskTraceKind[] = [
  "intent",
  "plan",
  "capability",
  "run",
  "evidence",
  "decision",
  "report",
];

/** Browser-safe digest for UI projection; not a security hash. */
export function taskTraceDigest(sourceRefs: readonly string[], stamp: string): string {
  const text = `${sourceRefs.join("|")}@${stamp}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function stampOf(value: string | null | undefined, fallback: string): string {
  if (!value) return fallback;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : fallback;
}

function entry(
  kind: TaskTraceKind,
  title: string,
  status: string,
  reason: string | null,
  sourceRefs: string[],
  createdAt: string,
): TaskTraceEntry {
  return {
    id: `trace:${kind}`,
    kind,
    title,
    status,
    reason,
    source_refs: sourceRefs,
    digest: sourceRefs.length ? taskTraceDigest(sourceRefs, createdAt) : null,
    created_at: createdAt,
  };
}

export function projectTaskTrace(input: TaskTraceInput): TaskTraceEntry[] {
  const createdAt = stampOf(input.createdAt, new Date().toISOString());
  const jobs = input.jobs ?? [];
  const facts = input.facts ?? [];
  const findings = input.findings ?? [];
  const hub = jobs.find((job) => (job.type ?? "").toLowerCase() === "hub_reason") ?? jobs[0];
  const roles = [...new Set(jobs.map((job) => job.role_name || job.type).filter((value): value is string => Boolean(value)))];
  const latestJobStamp = jobs.reduce((best, job) => stampOf(job.started_at ?? job.created_at, best), createdAt);
  const evidenceStamp = [...facts, ...findings].reduce(
    (best, row) => stampOf(row.created_at, best),
    createdAt,
  );
  const reportStamp = stampOf(
    input.report?.generated_at ?? input.report?.updated_at ?? input.report?.created_at,
    createdAt,
  );

  const rows: TaskTraceEntry[] = [
    entry("intent", input.objective.trim() || "任务目标", "ready", null, [], createdAt),
    entry(
      "plan",
      hub ? "Hub 已根据当前证据选择下一步" : "计划尚未投影到可查询结构",
      hub?.status ?? "pending",
      hub ? null : "Phase 1 先复用现有 Hub/Job，不发明第二套计划表",
      hub ? [`job:${hub.id}`] : [],
      stampOf(hub?.created_at, createdAt),
    ),
    entry(
      "capability",
      roles.length ? `已使用：${roles.slice(0, 4).join("、")}` : "尚未选择能力包",
      roles.length ? "active" : "pending",
      "Capability Pack 契约未落地前，只投影已冻结角色",
      roles.slice(0, 8).map((role, index) => `role:${role}:${index}`),
      latestJobStamp,
    ),
    entry(
      "run",
      jobs.length ? `${jobs.length} 次运行` : "还没有运行记录",
      jobs.some((job) => ["pending", "claimed", "provisioning", "running", "waiting_human"].includes(job.status ?? ""))
        ? "running"
        : jobs.length ? "idle" : "pending",
      null,
      jobs.slice(0, 8).map((job) => `job:${job.id}`),
      latestJobStamp,
    ),
    entry(
      "evidence",
      `${facts.length} 条事实 · ${findings.length} 条发现`,
      facts.length || findings.length ? "ready" : "pending",
      null,
      [...facts.slice(0, 4).map((fact) => `fact:${fact.id}`), ...findings.slice(0, 4).map((finding) => `finding:${finding.id}`)],
      evidenceStamp,
    ),
    entry(
      "decision",
      input.lifecycleLabel ?? "尚未形成判断",
      "projected",
      input.lifecycleReason ?? null,
      findings.slice(0, 6).map((finding) => `finding:${finding.id}`),
      evidenceStamp,
    ),
    entry(
      "report",
      input.report ? `报告 v${input.report.version}` : "报告尚未生成",
      input.report?.status ?? "none",
      input.report ? null : "执行结束、证据成立和报告生成是三条独立状态",
      input.report?.id ? [`report:${input.report.id}`] : [],
      reportStamp,
    ),
  ];

  return TRACE_ORDER.map((kind) => rows.find((row) => row.kind === kind)!);
}
