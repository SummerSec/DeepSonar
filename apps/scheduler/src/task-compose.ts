import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import type { sql } from "./db.js";

export const TASK_KINDS = ["standard", "compose"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
export const MAX_TASK_SEED_FINDINGS = 8;
export const COMPOSE_SEED_DISPOSITIONS = ["open", "accepted", "confirmed_vuln"] as const;

export interface FrozenTaskSeedFinding {
  id: string;
  title: string;
  severity: string | null;
  profile: string;
  category: string | null;
  tags: string[];
  location: string | null;
  summary: string | null;
  content_source: "finding_summary" | "finding_report";
  report_version: number | null;
  report_markdown_sha256: string | null;
  origin_canvas_id: string;
  origin_job_id: string;
  disposition: string;
  verify_status: "confirmed";
}

type Db = typeof sql;

export class TaskSeedInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskSeedInputError";
  }
}

function requestedKind(target: Record<string, unknown>): TaskKind {
  const value = target.kind ?? "standard";
  if (value !== "standard" && value !== "compose") {
    throw new TaskSeedInputError("任务 kind 只能是 standard 或 compose");
  }
  return value;
}

function requestedSeedIds(target: Record<string, unknown>): string[] {
  if (!Object.prototype.hasOwnProperty.call(target, "seed_finding_ids")) return [];
  const value = target.seed_finding_ids;
  if (!Array.isArray(value)) throw new TaskSeedInputError("seed_finding_ids 必须是 UUID 数组");
  const ids = value.map((id) => String(id).toLowerCase());
  if (new Set(ids).size !== ids.length) throw new TaskSeedInputError("seed_finding_ids 不能重复");
  return ids;
}

function assertRequestShape(kind: TaskKind, ids: readonly string[]): void {
  if (kind === "standard" && ids.length > 0) {
    throw new TaskSeedInputError("standard 任务禁止携带 seed_finding_ids");
  }
  if (kind === "compose" && (ids.length < 1 || ids.length > MAX_TASK_SEED_FINDINGS)) {
    throw new TaskSeedInputError(
      `compose 任务必须选择 1-` + MAX_TASK_SEED_FINDINGS + ` 条 confirmed Finding`,
    );
  }
}

async function loadEligibleSeedFindings(
  db: Db,
  projectId: string,
  ids: readonly string[],
): Promise<FrozenTaskSeedFinding[]> {
  if (ids.length === 0) return [];
  const rows = await db`
    SELECT f.id, f.title, f.severity, f.profile, f.category, f.tags_json,
           f.location, f.summary, f.verify_status, f.disposition,
           f.job_id AS origin_job_id, origin.canvas_id AS origin_canvas_id,
           report.version AS report_version, report.markdown_uri, report.markdown_sha256
    FROM findings f
    JOIN jobs origin ON origin.id = f.job_id
    LEFT JOIN LATERAL (
      SELECT fr.version, fr.markdown_uri, fr.markdown_sha256
      FROM finding_reports fr
      WHERE fr.finding_id = f.id AND fr.status = 'succeeded' AND fr.markdown_uri IS NOT NULL
      ORDER BY fr.version DESC
      LIMIT 1
    ) report ON true
    WHERE f.project_id = ${projectId}
      AND f.id = ANY(${ids as string[]}::uuid[])
      AND f.verify_status = 'confirmed'
      AND f.disposition = ANY(${[...COMPOSE_SEED_DISPOSITIONS]}::text[])`;
  const byId = new Map(rows.map((row) => [String(row.id).toLowerCase(), row]));
  if (byId.size !== ids.length) {
    throw new TaskSeedInputError(
      "种子必须全部属于当前项目，且当前为 confirmed 并处于 open/accepted/confirmed_vuln",
    );
  }
  return Promise.all(ids.map(async (id) => {
    const row = byId.get(id)!;
    let summary = row.summary == null ? null : String(row.summary);
    let contentSource: FrozenTaskSeedFinding["content_source"] = "finding_summary";
    let reportVersion: number | null = null;
    let reportMarkdownSha256: string | null = null;
    if (row.markdown_uri != null) {
      const blobRoot = path.resolve(config.storage.blobDir);
      const reportPath = path.resolve(blobRoot, String(row.markdown_uri));
      if (reportPath !== blobRoot && !reportPath.startsWith(blobRoot + path.sep)) {
        throw new TaskSeedInputError("Finding 报告路径无效，无法冻结组合任务种子");
      }
      try {
        summary = await readFile(reportPath, "utf8");
      } catch {
        throw new TaskSeedInputError("Finding 报告内容不可读，无法冻结组合任务种子");
      }
      reportMarkdownSha256 = row.markdown_sha256 == null ? null : String(row.markdown_sha256);
      if (reportMarkdownSha256 && createHash("sha256").update(summary).digest("hex") !== reportMarkdownSha256) {
        throw new TaskSeedInputError("Finding 报告内容校验失败，无法冻结组合任务种子");
      }
      reportVersion = Number(row.report_version);
      contentSource = "finding_report";
    }
    return {
      id,
      title: String(row.title),
      severity: row.severity == null ? null : String(row.severity),
      profile: String(row.profile),
      category: row.category == null ? null : String(row.category),
      tags: Array.isArray(row.tags_json) ? row.tags_json.map(String) : [],
      location: row.location == null ? null : String(row.location),
      summary,
      content_source: contentSource,
      report_version: reportVersion,
      report_markdown_sha256: reportMarkdownSha256,
      origin_canvas_id: String(row.origin_canvas_id),
      origin_job_id: String(row.origin_job_id),
      disposition: String(row.disposition),
      verify_status: "confirmed",
    };
  }));
}

/** Validate a creation request and freeze the exact eligible Finding summaries. */
export async function freezeTaskSeedTarget(
  db: Db,
  projectId: string,
  inputTarget: Record<string, unknown>,
  allowCompose = false,
): Promise<Record<string, unknown>> {
  const kind = requestedKind(inputTarget);
  if (!allowCompose && (kind === "compose" || Object.prototype.hasOwnProperty.call(inputTarget, "seed_finding_ids"))) {
    throw new TaskSeedInputError("该任务入口不允许选择历史 Finding 种子");
  }
  const hasSeedField = Object.prototype.hasOwnProperty.call(inputTarget, "seed_finding_ids");
  const ids = requestedSeedIds(inputTarget);
  if (kind === "standard" && hasSeedField) {
    throw new TaskSeedInputError("standard 任务禁止携带 seed_finding_ids");
  }
  assertRequestShape(kind, ids);
  if (kind === "standard") {
    const target: Record<string, unknown> = { ...inputTarget, kind };
    delete target.seed_finding_ids;
    delete target.seed_findings;
    return target;
  }
  const seedFindings = await loadEligibleSeedFindings(db, projectId, ids);
  return { ...inputTarget, kind, seed_finding_ids: ids, seed_findings: seedFindings };
}

export function frozenTaskSeeds(target: Record<string, unknown>): FrozenTaskSeedFinding[] {
  if (target.kind !== "compose") return [];
  const raw = target.seed_findings;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_TASK_SEED_FINDINGS) {
    throw new TaskSeedInputError("compose 任务缺少有效的冻结种子摘要");
  }
  return raw.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TaskSeedInputError("compose 任务的冻结种子摘要无效");
    }
    const seed = value as Record<string, unknown>;
    if (typeof seed.id !== "string" || typeof seed.title !== "string") {
      throw new TaskSeedInputError("compose 任务的冻结种子标识无效");
    }
    return seed as unknown as FrozenTaskSeedFinding;
  });
}

/** A retry is a new execution: stale or disposed seeds fail closed before wipe. */
export async function validateFrozenTaskSeedsForRetry(
  db: Db,
  projectId: string,
  target: Record<string, unknown>,
): Promise<FrozenTaskSeedFinding[]> {
  const seeds = frozenTaskSeeds(target);
  if (seeds.length === 0) return [];
  await loadEligibleSeedFindings(db, projectId, seeds.map((seed) => seed.id));
  return seeds;
}

/** Recreate read-only, canvas-local Finding projections from frozen summaries. */
export async function insertTaskSeedProjections(
  db: Db,
  canvasId: string,
  rootNodeId: string,
  target: Record<string, unknown>,
): Promise<string[]> {
  const seeds = frozenTaskSeeds(target);
  const nodeIds: string[] = [];
  for (const [index, seed] of seeds.entries()) {
    const [node] = await db`
      INSERT INTO canvas_nodes ${db({
        canvas_id: canvasId,
        job_id: null,
        node_type: "finding",
        title: seed.title,
        body_json: {
          origin: "seed",
          imported: true,
          readonly: true,
          finding_id: seed.id,
          severity: seed.severity,
          profile: seed.profile,
          category: seed.category,
          tags: seed.tags,
          location: seed.location,
          summary: seed.summary,
          content_source: seed.content_source,
          report_version: seed.report_version,
          report_markdown_sha256: seed.report_markdown_sha256,
          origin_canvas_id: seed.origin_canvas_id,
          origin_job_id: seed.origin_job_id,
          frozen_disposition: seed.disposition,
          frozen_verify_status: seed.verify_status,
        } as never,
        x: 460 + index * 320,
        y: 100,
        status: "imported",
      })}
      RETURNING id`;
    nodeIds.push(String(node.id));
    await db`
      INSERT INTO canvas_edges ${db({
        canvas_id: canvasId,
        from_node_id: rootNodeId,
        to_node_id: node.id as string,
        edge_type: "child",
      })}`;
  }
  return nodeIds;
}

/** Prompt projection excludes project Finding IDs; agents reference canvas node UUIDs only. */
export function taskTargetForPrompt(target: Record<string, unknown>): Record<string, unknown> {
  if (target.kind !== "compose") return target;
  const promptTarget: Record<string, unknown> = {
    ...target,
    seed_count: frozenTaskSeeds(target).length,
  };
  delete promptTarget.seed_finding_ids;
  delete promptTarget.seed_findings;
  return promptTarget;
}
