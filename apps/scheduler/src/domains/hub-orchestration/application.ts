import { sql } from "../../db.js";
import {
  isHubRoundWithinBudget,
  shouldConsiderHubTrigger,
  shouldWakeEvidenceHub,
} from "./policy.js";
import type {
  HubCanvasConvergence,
  HubCanvasJobTerminalStatus,
  HubJobRecord,
  HubOrchestrationDatabase,
  HubOrchestrationPorts,
  HubOrchestrationTransaction,
} from "./ports.js";

export type {
  HubCanvasConvergence,
  HubCanvasJobTerminalStatus,
  HubJobRecord,
  HubOrchestrationDatabase,
  HubOrchestrationPorts,
  HubOrchestrationTransaction,
} from "./ports.js";
export { isHubRoundWithinBudget, shouldConsiderHubTrigger, shouldWakeEvidenceHub } from "./policy.js";

export interface HubTriggerOptions {
  force?: boolean;
  sourceNodeIds?: string[];
  trigger?: Record<string, unknown>;
  /** 人工 run-hub-now：忽略 hub_paused / auto_stopped */
  manual?: boolean;
  /** 画布空闲唤醒：无待跑 job 时入队 Hub。 */
  idleWake?: boolean;
}

export interface HubHumanCommentInput {
  findingId: string;
  commentId: string;
  commentBody: string;
  authorName: string;
}

export interface HubHumanCommentResult {
  hub_queued: boolean;
  reason?: string;
  canvas_id?: string;
  hub_job_id?: string;
}

export interface HubOrchestrationApplication {
  maybeTriggerHub(
    tx: HubOrchestrationTransaction,
    job: HubJobRecord | undefined,
    options?: HubTriggerOptions,
  ): Promise<void>;
  advanceCanvasAfterTerminalJob(
    tx: HubOrchestrationTransaction,
    job: HubJobRecord,
    terminalStatus: HubCanvasJobTerminalStatus,
    opts?: Pick<HubTriggerOptions, "sourceNodeIds" | "trigger">,
  ): Promise<"report" | "hub" | "noop">;
  triggerHubFromHumanComment(input: HubHumanCommentInput): Promise<HubHumanCommentResult>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Build the Hub application around explicit ports.  The caller owns the
 * transaction and supplies the same Canvas-first lock boundary used by the
 * legacy core implementation; this application never starts a nested
 * transaction for a terminal/recovery path.
 */
export function createHubOrchestrationApplication(
  db: HubOrchestrationDatabase = sql,
  ports: HubOrchestrationPorts,
): HubOrchestrationApplication {
  async function hasActiveBlockingVerify(
    tx: HubOrchestrationTransaction,
    canvasId: string,
    severities: string[],
  ): Promise<boolean> {
    if (severities.length === 0) {
      const rows = await tx`
        SELECT 1 FROM jobs
        WHERE canvas_id = ${canvasId} AND type = 'verify_finding'
          AND status IN ('pending','claimed','provisioning','running')
        LIMIT 1`;
      return rows.length > 0;
    }
    const rows = await tx`
      SELECT 1 FROM jobs j
      JOIN findings f ON f.id = j.finding_id
      WHERE j.canvas_id = ${canvasId} AND j.type = 'verify_finding'
        AND j.status IN ('pending','claimed','provisioning','running')
        AND lower(f.severity) = ANY(${severities})
      LIMIT 1`;
    return rows.length > 0;
  }

  async function hasActiveRoleJobs(tx: HubOrchestrationTransaction, canvasId: string): Promise<boolean> {
    const rows = await tx`
      SELECT 1 FROM jobs
      WHERE canvas_id = ${canvasId}
        AND type NOT IN ('hub_reason', 'verify_finding', 'report')
        AND status IN ('pending','claimed','provisioning','running','waiting_human')
      LIMIT 1`;
    return rows.length > 0;
  }

  async function waitingEvidenceRound(tx: HubOrchestrationTransaction, canvasId: string): Promise<{
    id: string;
    finding_id: string;
    origin_job_id: string | null;
    missing: string[];
    evidence_signature: string;
    hub_evidence_signature: string | null;
    node_id: string | null;
  } | null> {
    const rows = await tx`
      SELECT r.id, r.finding_id, r.requirements_json, r.evidence_snapshot_json,
             f.job_id AS origin_job_id, f.node_id
      FROM finding_verification_rounds r
      JOIN findings f ON f.id = r.finding_id
      JOIN jobs origin ON origin.id = f.job_id
      WHERE origin.canvas_id = ${canvasId}
        AND r.status = 'pending'
        AND r.verify_job_id IS NULL
        AND r.requirements_json->>'eligibility' = 'waiting_evidence'
      ORDER BY r.created_at ASC, r.id ASC
      FOR UPDATE OF r`;
    for (const row of rows) {
      const req = asRecord(row.requirements_json);
      const snap = asRecord(row.evidence_snapshot_json);
      const ids = (key: string) =>
        Array.isArray(snap[key])
          ? (snap[key] as Array<Record<string, unknown>>)
              .map((item) => String(item.node_id ?? ""))
              .filter(Boolean)
              .sort()
          : [];
      const missing = Array.isArray(req.missing)
        ? (req.missing as unknown[]).map(String).filter(Boolean).sort()
        : [];
      const evidence_signature = JSON.stringify({ review: ids("review"), test: ids("test"), missing });
      const hub_evidence_signature = (req.hub_evidence_signature as string | null) ?? null;
      // Skip a consumed evidence edge so an older stalled finding cannot
      // starve a newer waiting round.
      if (!shouldWakeEvidenceHub(hub_evidence_signature, evidence_signature)) continue;
      return {
        id: row.id as string,
        finding_id: row.finding_id as string,
        origin_job_id: (row.origin_job_id as string | null) ?? null,
        missing,
        evidence_signature,
        hub_evidence_signature,
        node_id: (row.node_id as string | null) ?? null,
      };
    }
    return null;
  }

  async function hasWaitingEvidenceRound(tx: HubOrchestrationTransaction, canvasId: string): Promise<boolean> {
    const rows = await tx`
      SELECT 1
      FROM finding_verification_rounds r
      JOIN findings f ON f.id = r.finding_id
      JOIN jobs origin ON origin.id = f.job_id
      WHERE origin.canvas_id = ${canvasId}
        AND r.status = 'pending'
        AND r.verify_job_id IS NULL
        AND r.requirements_json->>'eligibility' = 'waiting_evidence'
      LIMIT 1`;
    return rows.length > 0;
  }

  async function hasActiveRunnableJobs(
    tx: HubOrchestrationTransaction,
    canvasId: string,
    excludeJobId?: string | null,
  ): Promise<boolean> {
    if (excludeJobId) {
      const rows = await tx`
        SELECT 1 FROM jobs
        WHERE canvas_id = ${canvasId}
          AND id <> ${excludeJobId}
          AND status IN ('pending','claimed','provisioning','running','waiting_human')
        LIMIT 1`;
      return rows.length > 0;
    }
    const rows = await tx`
      SELECT 1 FROM jobs
      WHERE canvas_id = ${canvasId}
        AND status IN ('pending','claimed','provisioning','running','waiting_human')
      LIMIT 1`;
    return rows.length > 0;
  }

  async function rootAnalysisFinished(tx: HubOrchestrationTransaction, canvasId: string): Promise<boolean> {
    const [root] = await tx`
      SELECT status FROM canvas_nodes
      WHERE canvas_id = ${canvasId} AND node_type = 'root' LIMIT 1`;
    return ["analysis_complete", "reporting", "succeeded"].includes(String(root?.status ?? ""));
  }

  async function maybeTriggerHub(
    tx: HubOrchestrationTransaction,
    job: HubJobRecord | undefined,
    options: HubTriggerOptions = {},
  ): Promise<void> {
    if (!job?.canvas_id) return;
    if (!shouldConsiderHubTrigger(job.type, options)) return;

    const canvasId = job.canvas_id as string;
    const projectId = job.project_id as string | undefined;
    if (!projectId) return;

    const rules = await ports.rulesForProject(tx, projectId);
    if (!rules.hubEnabled && !options.force && !options.manual) return;

    // Serialize the eligibility check and INSERT per canvas. This is the
    // same Canvas-first lock boundary used by terminal/recovery callers.
    if (!(await ports.lockCanvasForConvergence(tx, canvasId))) return;
    if (await rootAnalysisFinished(tx, canvasId)) return;

    const convergence = await ports.readCanvasConvergence(tx, canvasId);
    if (!options.manual) {
      if (convergence.hub_paused) {
        console.info(`[hub] 画布 ${canvasId} 已暂停决策（hub_paused），跳过`);
        return;
      }
      if (convergence.auto_stopped && !options.force && !options.idleWake) {
        console.info(`[hub] 画布 ${canvasId} 已自动停止自驱（auto_stopped），跳过`);
        return;
      }
      if (convergence.auto_stopped && (options.force || options.idleWake)) {
        await ports.patchCanvasConvergence(tx, canvasId, {
          auto_stopped: false,
          paused_reason: undefined,
          paused_at: undefined,
        });
      }
    }

    const activeHub = await tx`
      SELECT 1 FROM jobs
      WHERE canvas_id = ${canvasId} AND type = 'hub_reason'
        AND status IN ('pending', 'claimed', 'provisioning', 'running')
      LIMIT 1`;
    if (activeHub.length > 0) return;

    if (options.idleWake) {
      if (await hasActiveRunnableJobs(tx, canvasId, (job.id as string) ?? null)) return;
    } else if (!options.manual && !options.force) {
      if (await hasActiveRoleJobs(tx, canvasId)) return;
    }

    const waiting = await waitingEvidenceRound(tx, canvasId);
    let waitingWake: { id: string; evidence_signature: string } | null = null;
    let trigger = options.trigger ?? {
      kind: options.idleWake ? "canvas_idle" : "graph_progress",
    };
    if (waiting && !options.manual) {
      if (!shouldWakeEvidenceHub(waiting.hub_evidence_signature, waiting.evidence_signature)) return;
      trigger = {
        kind: "verify_rework",
        finding_id: waiting.finding_id,
        missing_evidence: waiting.missing,
        summary: "Verify 缺少独立 review/test 证据，先派发补证工作",
        evidence_signature: waiting.evidence_signature,
      };
      waitingWake = { id: waiting.id, evidence_signature: waiting.evidence_signature };
    } else if (!waiting && !options.manual && (await hasWaitingEvidenceRound(tx, canvasId))) {
      return;
    }

    const waitSeverities = ports.careSeverities(rules.minVerifySeverity);
    if (!options.manual && !options.force) {
      if (await hasActiveBlockingVerify(tx, canvasId, waitSeverities)) return;
    }

    const [{ count }] = await tx<[{ count: number }]>`
      SELECT COUNT(*)::int AS count FROM jobs
      WHERE canvas_id = ${canvasId} AND type = 'hub_reason' AND status = 'succeeded'`;
    if (!isHubRoundWithinBudget(Number(count), rules.maxHubRounds)) {
      console.warn(`[hub] 画布 ${canvasId} 已达 hub 决策轮次上限 ${rules.maxHubRounds}，停止自驱`);
      await ports.settleCanvasFindingsAtGuardrail(tx, canvasId, "max_hub_rounds").catch((e) =>
        console.error(`[hub] settle findings at maxHubRounds failed:`, e),
      );
      const gate = await ports.evaluateAnalysisCompleteGate(tx, canvasId, {
        excludeJobId: (job.id as string) ?? null,
      });
      if (gate.ok) {
        await tx`
          UPDATE canvas_nodes SET status = 'analysis_complete',
            body_json = body_json || ${tx.json({
              conclusion: `Hub 决策轮次达上限 ${rules.maxHubRounds}；未完成 Finding 已收口为 needs_human，自动进入报告。`,
              guardrail: "max_hub_rounds",
            })},
            updated_at = now()
          WHERE canvas_id = ${canvasId} AND node_type = 'root'
            AND status IS DISTINCT FROM 'succeeded'
            AND status IS DISTINCT FROM 'reporting'`;
        await ports.maybeDispatchReport(tx, canvasId).catch((e) =>
          console.error(`[hub] auto report after maxHubRounds failed:`, e),
        );
      } else {
        const noRole = !(await ports.hasSucceededRoleWork(tx, canvasId));
        await ports.patchCanvasConvergence(tx, canvasId, {
          auto_stopped: true,
          paused_reason: noRole
            ? `max_hub_rounds_no_role_work:${rules.maxHubRounds}`
            : `max_hub_rounds_incomplete:${rules.maxHubRounds}`,
          paused_at: new Date().toISOString(),
        });
        console.warn(
          `[hub] maxHubRounds 后未过完成门 (${gate.blockers.join(",")})，auto_stopped，不派发 Report`,
        );
      }
      return;
    }

    if (waitingWake) {
      await tx`
        UPDATE finding_verification_rounds
        SET requirements_json = requirements_json || ${tx.json({ hub_evidence_signature: waitingWake.evidence_signature } as never)}
        WHERE id = ${waitingWake.id}`;
    }

    const triggerFindingId = typeof trigger.finding_id === "string" ? trigger.finding_id : null;
    const snapshot = await ports.resolveAgentSnapshotForJob(tx, projectId, "hub_reason", triggerFindingId ? [triggerFindingId] : []);
    const [hubJob] = await tx`
      INSERT INTO jobs ${tx({
        project_id: projectId,
        canvas_id: canvasId,
        agent_snapshot_json: snapshot as never,
        type: "hub_reason",
        priority: ports.fixedPriorityForJob({ type: "hub_reason", purpose: "hub" }),
        payload_json: { trigger, scheduling_purpose: "hub" } as never,
        timeout_sec: rules.auditTimeoutSec,
        followup_depth: 0,
      })}
      RETURNING id`;
    await ports.recordJobSharedAssets(tx, hubJob.id as string, snapshot);

    const [{ next_x }] = await tx<[{ next_x: number }]>`
      SELECT COALESCE(MAX(x + w), 60) + 40 AS next_x FROM canvas_nodes
      WHERE canvas_id = ${canvasId}`;
    const title =
      options.force || options.manual
        ? "Hub 风险验收"
        : options.idleWake
          ? "Hub 空闲唤醒"
          : "Hub 决策";
    const [hubNode] = await tx`
      INSERT INTO canvas_nodes ${tx({
        canvas_id: canvasId,
        job_id: hubJob.id as string,
        node_type: "job",
        title,
        body_json: { type: "hub_reason", trigger } as never,
        x: next_x,
        y: 300,
        status: "pending",
      })}
      RETURNING id`;

    let sourceNodeIds = options.sourceNodeIds ?? [];
    if (sourceNodeIds.length === 0 && job.id) {
      const sources = await tx`
        SELECT id FROM canvas_nodes
        WHERE canvas_id = ${canvasId} AND job_id = ${job.id as string}
          AND node_type = ANY(${["fact", "finding", "intent", "job"]})`;
      sourceNodeIds = sources.map((source) => source.id as string);
    }
    if (sourceNodeIds.length === 0) {
      const [root] = await tx`
        SELECT id FROM canvas_nodes WHERE canvas_id = ${canvasId} AND node_type = 'root' LIMIT 1`;
      if (root) sourceNodeIds = [root.id as string];
    }
    for (const sourceNodeId of sourceNodeIds) {
      await ports.insertEdgeIfAbsent(tx, canvasId, sourceNodeId, hubNode.id as string, "next");
    }

    console.info(
      `[hub] 画布 ${canvasId} 入队 Hub ${hubJob.id} trigger=${String((trigger as { kind?: string }).kind ?? "graph_progress")}` +
        (options.idleWake ? " (idleWake)" : "") +
        (options.force ? " (force)" : ""),
    );
  }

  async function advanceCanvasAfterTerminalJob(
    tx: HubOrchestrationTransaction,
    job: HubJobRecord,
    terminalStatus: HubCanvasJobTerminalStatus,
    opts: Pick<HubTriggerOptions, "sourceNodeIds" | "trigger"> = {},
  ): Promise<"report" | "hub" | "noop"> {
    const canvasId = (job.canvas_id as string | null) ?? null;
    if (!canvasId || job.type === "report") return "noop";
    if (!(await ports.lockCanvasForConvergence(tx, canvasId))) return "noop";

    const [root] = await tx`
      SELECT status FROM canvas_nodes
      WHERE canvas_id = ${canvasId} AND node_type = 'root' LIMIT 1`;
    if (root?.status === "analysis_complete" || root?.status === "reporting") {
      await ports.maybeDispatchReport(tx, canvasId);
      return "report";
    }

    if (job.type === "hub_reason" && terminalStatus !== "succeeded") {
      await tx`
        UPDATE finding_verification_rounds r
        SET requirements_json = requirements_json - 'hub_evidence_signature'
        FROM findings f
        JOIN jobs origin ON origin.id = f.job_id
        WHERE r.finding_id = f.id
          AND origin.canvas_id = ${canvasId}
          AND r.status = 'pending'
          AND r.requirements_json->>'eligibility' = 'waiting_evidence'`;
      return "noop";
    }

    await maybeTriggerHub(tx, job, {
      force: false,
      sourceNodeIds: opts.sourceNodeIds ?? [],
      trigger: opts.trigger ?? {
        kind: "canvas_idle",
        after_job_id: job.id,
        after_job_type: job.type,
        after_job_status: terminalStatus,
      },
      idleWake: true,
    });
    return "hub";
  }

  async function triggerHubFromHumanComment(input: HubHumanCommentInput): Promise<HubHumanCommentResult> {
    const [finding] = await db`
      SELECT f.id, f.project_id, f.verify_status, f.disposition, f.title, f.node_id, f.job_id,
             j.canvas_id, j.priority
      FROM findings f
      JOIN jobs j ON j.id = f.job_id
      WHERE f.id = ${input.findingId}`;
    if (!finding) return { hub_queued: false, reason: "finding_not_found" };

    const confirmed = finding.verify_status === "confirmed" || finding.disposition === "confirmed_vuln";
    if (!confirmed) {
      return { hub_queued: false, reason: "not_confirmed", canvas_id: finding.canvas_id as string };
    }
    if (!finding.canvas_id) return { hub_queued: false, reason: "no_canvas" };

    const canvasId = finding.canvas_id as string;
    const projectId = finding.project_id as string;
    const preview = input.commentBody.trim().slice(0, 500);
    let hubJobId: string | undefined;

    await db.begin(async (rawTx) => {
      const tx = rawTx as unknown as HubOrchestrationTransaction;
      const [findingNode] = finding.node_id
        ? await tx`SELECT id, x, y FROM canvas_nodes WHERE id = ${finding.node_id as string}`
        : [null];
      const x = findingNode ? (findingNode.x as number) + 40 : 200;
      const y = findingNode ? (findingNode.y as number) + 160 : 400;
      const [humanNode] = await tx`
        INSERT INTO canvas_nodes ${tx({
          canvas_id: canvasId,
          job_id: null,
          node_type: "human",
          title: `人工评论：${String(finding.title).slice(0, 80)}`,
          body_json: {
            reason: preview,
            kind: "finding_comment",
            finding_id: input.findingId,
            comment_id: input.commentId,
            author: input.authorName,
          } as never,
          x,
          y,
          status: "open",
        })}
        RETURNING id`;
      if (findingNode) {
        await ports.insertEdgeIfAbsent(tx, canvasId, findingNode.id as string, humanNode.id as string, "next");
      }

      await ports.patchCanvasConvergence(tx, canvasId, {
        auto_stopped: false,
        paused_reason: undefined,
        paused_at: undefined,
      });

      const before = await tx`
        SELECT id FROM jobs WHERE canvas_id = ${canvasId} AND type = 'hub_reason'
          AND status IN ('pending','claimed','provisioning','running') LIMIT 1`;
      await maybeTriggerHub(
        tx,
        {
          id: finding.job_id,
          project_id: projectId,
          canvas_id: canvasId,
          type: "human_comment",
          priority: ports.fixedPriorityForJob({ type: "hub_reason", purpose: "hub" }),
        },
        {
          force: true,
          sourceNodeIds: [humanNode.id as string, ...(findingNode ? [findingNode.id as string] : [])],
          trigger: {
            kind: "human_comment",
            finding_id: input.findingId,
            comment_id: input.commentId,
            author: input.authorName,
            comment_preview: preview,
            finding_title: finding.title,
          },
        },
      );

      const after = await tx`
        SELECT id FROM jobs WHERE canvas_id = ${canvasId} AND type = 'hub_reason'
          AND status IN ('pending','claimed','provisioning','running')
        ORDER BY created_at DESC LIMIT 1`;
      if (after[0] && (!before[0] || before[0].id !== after[0].id)) {
        hubJobId = after[0].id as string;
        await tx`
          UPDATE canvas_nodes SET title = 'Hub 人工反馈决策', updated_at = now()
          WHERE job_id = ${hubJobId} AND node_type = 'job'`;
      }
    });

    if (!hubJobId) {
      const conv = await ports.readCanvasConvergence(db, canvasId);
      if (conv.hub_paused) return { hub_queued: false, reason: "hub_paused", canvas_id: canvasId };
      return { hub_queued: false, reason: "hub_not_queued", canvas_id: canvasId };
    }
    return { hub_queued: true, canvas_id: canvasId, hub_job_id: hubJobId };
  }

  return { maybeTriggerHub, advanceCanvasAfterTerminalJob, triggerHubFromHumanComment };
}
