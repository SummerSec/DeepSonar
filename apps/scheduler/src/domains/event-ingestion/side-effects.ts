import { createHash } from "node:crypto";
import {
  DonePayload,
  FactPayload,
  FindingPayload,
  HumanPayload,
  ProgressPayload,
  allowedPlatformTools,
  type PlatformToolName,
  type VerificationEvidence,
  type EffectiveFindingProtocol,
} from "@deepsonar/shared-types";
import type { SharedAssetSelection } from "../shared-assets/index.js";
import {
  freezeAgentSnapshotNetworkPolicy,
  roleNameForJobType,
  type AgentRuntimeSnapshot,
} from "../role-runtime-snapshot/index.js";
import type { FindingVerificationApplication } from "../finding-verification/index.js";
import type { EventIngestionTransaction } from "./application.js";
import {
  assertHubDecisionCanvasReferences,
  parseHubDecisionPayload,
  type HubDecision,
  type HubReferenceLookup,
} from "../../graph.js";
import { ControlInputError, invalidRole, invalidVerification } from "../../control-input.js";
import { normalizeFindingProposal } from "../../finding-protocol.js";

export interface EventSideEffectServices {
  hubReferenceLookup?: HubReferenceLookup;
  hubEdgeBatchInsert?: HubEdgeBatchInsert;
}

export interface EventIngestionSideEffectApplication {
  applySideEffects(
    tx: EventIngestionTransaction,
    jobId: string,
    type: string,
    payload: unknown,
    services?: EventSideEffectServices,
  ): Promise<void>;
}

export type SchedulingPurpose = "manual" | "discovery" | "convergence_evidence" | "verify" | "report";

export interface EventProjectRules {
  minVerifySeverity: string;
  maxIntentsPerDecision: number;
  auditTimeoutSec: number;
}

export interface EventRole {
  name: string;
}

export interface HubFindingBinding {
  id: string;
  node_id: string;
  severity: unknown;
}

export function resolveHubFindingIntent(
  role: string,
  from: readonly string[],
  referenceNodes: ReadonlyMap<string, { node_type: string }>,
  findingByNodeId: ReadonlyMap<string, HubFindingBinding>,
  ambiguousFindingNodeIds: ReadonlySet<string>,
): { finding: HubFindingBinding | null; error?: string } {
  if (role !== "review" && role !== "test") return { finding: null };
  const findingNodeIds = [...new Set(from.filter((id) => referenceNodes.get(id)?.node_type === "finding"))];
  if (findingNodeIds.length === 0) return { finding: null };
  if (findingNodeIds.length > 1) {
    return { finding: null, error: "review/test intent 只能绑定一个 canonical Finding 节点。" };
  }
  const nodeId = findingNodeIds[0];
  if (ambiguousFindingNodeIds.has(nodeId)) {
    return { finding: null, error: "canonical Finding 节点对应多个 Finding 记录，无法安全绑定验证目标。" };
  }
  const finding = findingByNodeId.get(nodeId);
  return {
    finding: finding ?? null,
    error: finding ? undefined : "canonical Finding 节点没有当前项目画布内的 Finding 记录。",
  };
}

export type EventFinalizeResult = {
  summary?: string;
  error?: string;
  verdict?: string;
};

export interface EventIngestionSideEffectPorts {
  findingVerification: FindingVerificationApplication;
  rulesForProject: (tx: EventIngestionTransaction, projectId: string) => Promise<EventProjectRules>;
  rolesForProject: (tx: EventIngestionTransaction, projectId: string) => Promise<readonly EventRole[]>;
  resolveAgentSnapshotForJob: (
    tx: EventIngestionTransaction,
    projectId: string,
    jobType: string,
    findingIds?: string[],
  ) => Promise<AgentRuntimeSnapshot>;
  recordJobSharedAssets: (
    tx: EventIngestionTransaction,
    jobId: string,
    assets: SharedAssetSelection[],
  ) => Promise<void>;
  fixedPriorityForJob: (input: { type: string; purpose?: SchedulingPurpose }) => number;
  insertEdgeIfAbsent: (
    tx: EventIngestionTransaction,
    canvasId: string,
    fromId: string,
    toId: string,
    edgeType: string,
  ) => Promise<void>;
  insertEdgesIfAbsentBatch: (tx: EventIngestionTransaction, edges: readonly EventCanvasEdgeInput[]) => Promise<void>;
  findingProtocolForJob: (
    tx: EventIngestionTransaction,
    job: Record<string, unknown>,
  ) => Promise<EffectiveFindingProtocol>;
  finalizeJob: (
    tx: EventIngestionTransaction,
    jobId: string,
    status: "succeeded" | "failed",
    result?: EventFinalizeResult,
  ) => Promise<unknown>;
}

export type EventCanvasEdgeInput = {
  canvasId: string;
  fromId: string;
  toId: string;
  edgeType: string;
};

export type EventHubEdgeBatchInsert = (
  tx: EventIngestionTransaction,
  edges: readonly EventCanvasEdgeInput[],
) => Promise<void>;

type HubEdgeBatchInsert = EventHubEdgeBatchInsert;

function dedupeCanvasEdges(edges: readonly EventCanvasEdgeInput[]): EventCanvasEdgeInput[] {
  const unique = new Map<string, EventCanvasEdgeInput>();
  for (const edge of edges) {
    const key = `${edge.canvasId}\u0000${edge.fromId}\u0000${edge.toId}\u0000${edge.edgeType}`;
    unique.set(key, edge);
  }
  return [...unique.values()];
}

export function sha16(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

export function createEventIngestionSideEffectApplication(
  ports: EventIngestionSideEffectPorts,
): EventIngestionSideEffectApplication {
  const SEMANTIC_TOOL_BY_EVENT: Readonly<Record<string, PlatformToolName>> = {
    progress: "emit_progress",
    finding: "emit_finding",
    fact: "emit_fact",
    hub_decision: "submit_hub_decision",
    done: "mark_job_done",
    human: "request_human",
  };

  type SemanticRoleKind = "role" | "hub" | "system";

  const RESERVED_SNAPSHOT_NAMES: Readonly<Record<string, SemanticRoleKind>> = {
    hub: "hub",
    hub_reason: "hub",
    verify: "system",
    verify_finding: "system",
    report: "system",
  };

  // Older/imported snapshots may omit `name` for these built-in and historical
  // Job types. Unknown/custom roles must carry their frozen canonical name; a
  // missing name cannot be inferred safely from arbitrary DB content.
  const SNAPSHOT_NAME_FALLBACK_TYPES = new Set([
    "explore",
    "analyze",
    "review",
    "test",
    "code",
    "audit",
    "audit_module",
    "hub_reason",
    "hub",
    "verify",
    "verify_finding",
    "report",
  ]);

  function semanticRoleNamesEquivalent(typeName: string, snapshotName: string): boolean {
    // Hub snapshots emitted by older/runtime adapters used `hub` while the
    // persisted system Job type is `hub_reason`, and vice versa.
    if (
      (typeName === "hub_reason" && snapshotName === "hub") ||
      (typeName === "hub" && snapshotName === "hub_reason")
    ) {
      return true;
    }
    return typeName === snapshotName;
  }

  function isSemanticRoleKind(value: unknown): value is SemanticRoleKind {
    return value === "role" || value === "hub" || value === "system";
  }

  function semanticJobContract(job: Record<string, unknown>): {
    name: string;
    kind: SemanticRoleKind;
    platformTools: string[] | null;
  } {
    const rawSnapshot = job.agent_snapshot_json;
    if (!rawSnapshot || typeof rawSnapshot !== "object" || Array.isArray(rawSnapshot)) {
      throw new ControlInputError("tool_not_allowed", "Job 快照必须是 JSON object。", "agent_snapshot_json");
    }
    const snapshot = rawSnapshot as Record<string, unknown>;
    const jobType = String(job.type ?? "")
      .trim()
      .toLowerCase();
    if (!jobType) {
      throw new ControlInputError("tool_not_allowed", "Job type 不能为空。", "type");
    }
    const typeName = roleNameForJobType(jobType);
    // The persisted Job type is the Scheduler's authority for the role kind.
    // Snapshot role_kind/name are checked against it, never allowed to upgrade a
    // normal worker (for example, `review`) into a Hub.
    const kind: SemanticRoleKind = RESERVED_SNAPSHOT_NAMES[typeName] ?? "role";
    const hasSnapshotName = Object.prototype.hasOwnProperty.call(snapshot, "name");
    if (hasSnapshotName && (typeof snapshot.name !== "string" || !snapshot.name.trim())) {
      throw new ControlInputError("tool_not_allowed", "Job 快照 name 必须是非空字符串。", "name");
    }
    const rawName = hasSnapshotName ? roleNameForJobType((snapshot.name as string).trim().toLowerCase()) : null;
    const canFallbackSnapshotName = SNAPSHOT_NAME_FALLBACK_TYPES.has(jobType);
    if (!rawName && !canFallbackSnapshotName) {
      throw new ControlInputError("tool_not_allowed", "未知 Job type 必须在冻结快照中提供 canonical name。", "name");
    }
    if (!canFallbackSnapshotName && !Object.prototype.hasOwnProperty.call(snapshot, "role_kind")) {
      throw new ControlInputError("tool_not_allowed", "未知 Job type 必须在冻结快照中提供 role_kind。", "role_kind");
    }
    if (!canFallbackSnapshotName && !Object.prototype.hasOwnProperty.call(snapshot, "platform_tools")) {
      throw new ControlInputError(
        "tool_not_allowed",
        "未知 Job type 必须在冻结快照中提供 platform_tools。",
        "platform_tools",
      );
    }
    if (rawName && !semanticRoleNamesEquivalent(typeName, rawName)) {
      throw new ControlInputError("tool_not_allowed", "Job 快照角色名称与 Scheduler Job 类型不一致。", "name");
    }
    const snapshotReservedKind = rawName ? RESERVED_SNAPSHOT_NAMES[rawName] : undefined;
    if (snapshotReservedKind && snapshotReservedKind !== kind) {
      throw new ControlInputError("tool_not_allowed", "Job 快照角色与 Scheduler Job 类型不一致。", "role_kind");
    }
    if (Object.prototype.hasOwnProperty.call(snapshot, "role_kind")) {
      if (!isSemanticRoleKind(snapshot.role_kind) || snapshot.role_kind !== kind) {
        throw new ControlInputError(
          "tool_not_allowed",
          "Job 快照 role_kind 与 Scheduler Job 类型不一致。",
          "role_kind",
        );
      }
    }
    const name = kind === "hub" || kind === "system" ? typeName : (rawName ?? typeName);
    let platformTools: string[] | null = null;
    if (Object.prototype.hasOwnProperty.call(snapshot, "platform_tools")) {
      if (!Array.isArray(snapshot.platform_tools) || snapshot.platform_tools.some((tool) => typeof tool !== "string")) {
        throw new ControlInputError("tool_not_allowed", "Job 快照 platform_tools 格式无效。", "platform_tools");
      }
      platformTools = snapshot.platform_tools as string[];
    }
    return { name, kind, platformTools };
  }

  /**
   * Re-apply the frozen Job tool contract at the authoritative ingest boundary.
   * The real executor performs the same check while buffering MCP events, but
   * direct/fake/recovery callers must not be able to skip it.
   */
  function assertSemanticToolAuthority(job: Record<string, unknown>, type: string): void {
    const requiredTool = SEMANTIC_TOOL_BY_EVENT[type];
    if (!requiredTool) return;
    const contract = semanticJobContract(job);
    // 授权只认：平台工具全集是否包含该工具 + Job 冻结快照是否启用。
    // 不再按 role name/kind 硬编码裁剪（配置层已对所有 Agent 开放可选 list）。
    const staticAllowed = allowedPlatformTools(contract.name, contract.kind).includes(requiredTool);
    const snapshotAllowed = contract.platformTools === null || contract.platformTools.includes(requiredTool);
    if (!staticAllowed || !snapshotAllowed) {
      throw new ControlInputError("tool_not_allowed", `${requiredTool} is not authorized for this Job`, requiredTool);
    }
  }

  /** Semantic events are accepted only while the Scheduler still owns a
   * running Job.  The event-ingestion transaction has already locked this row;
   * the check therefore rolls back the current dedup marker, quota row, event,
   * and any Canvas side effects when a terminal/late callback arrives. */
  function assertSemanticJobRunning(job: Record<string, unknown>, type: string): void {
    if (!SEMANTIC_TOOL_BY_EVENT[type]) return;
    if (job.status !== "running") {
      throw new ControlInputError("job_not_running", "语义事件只能提交给 status=running 的 Job。", "status");
    }
  }

  /**
   * Terminal/control events are serialized by the Job lock acquired upstream.
   * A Hub decision may be followed by exactly one done event; human is mutually
   * exclusive with both, and each event type is single-shot per Job.
   */
  async function assertTerminalEventHistory(tx: EventIngestionTransaction, jobId: string, type: string): Promise<void> {
    if (!(type in SEMANTIC_TOOL_BY_EVENT) || !["done", "human", "hub_decision"].includes(type)) return;
    const rows = await tx<{ type: string }[]>`
    SELECT type FROM events
    WHERE job_id = ${jobId} AND type IN ('done', 'human', 'hub_decision')
    ORDER BY job_seq`;
    const doneCount = rows.filter((row) => row.type === "done").length;
    const humanCount = rows.filter((row) => row.type === "human").length;
    const hubCount = rows.filter((row) => row.type === "hub_decision").length;
    if (doneCount > 1 || humanCount > 1 || hubCount > 1) {
      throw new ControlInputError("duplicate_tool_call", "同一 Job 的终态工具每类只能提交一次。", type);
    }
    if (humanCount > 0 && (doneCount > 0 || hubCount > 0)) {
      throw new ControlInputError(
        "duplicate_tool_call",
        "request_human 不得与 mark_job_done 或 submit_hub_decision 同时提交。",
        type,
      );
    }
    const hubIndex = rows.findIndex((row) => row.type === "hub_decision");
    const doneIndex = rows.findIndex((row) => row.type === "done");
    if (hubIndex >= 0 && doneIndex >= 0 && hubIndex > doneIndex) {
      throw new ControlInputError("duplicate_tool_call", "Hub 决策必须先于 mark_job_done 提交。", type);
    }
  }

  async function applySideEffects(
    tx: EventIngestionTransaction,
    jobId: string,
    type: string,
    payload: unknown,
    services: EventSideEffectServices = {},
  ) {
    // Re-parse every payload at the side-effect boundary.  Callers normally
    // arrive through EventEnvelope, but tests, recovery and future adapters may
    // invoke this function directly; no untrusted shape may reach SQL.
    const parsePayload = <T>(
      schema: {
        safeParse(value: unknown): { success: true; data: T } | { success: false };
      },
      value: unknown,
      code: string,
      label: string,
    ): T => {
      const parsed = schema.safeParse(value);
      if (!parsed.success) throw new ControlInputError(code as never, `${label} 参数不符合严格契约。`);
      return parsed.data;
    };
    const validatedPayload =
      type === "progress"
        ? parsePayload(ProgressPayload, payload, "invalid_progress", "emit_progress")
        : type === "finding"
          ? parsePayload(FindingPayload, payload, "invalid_payload", "emit_finding")
          : type === "fact"
            ? parsePayload(FactPayload, payload, "invalid_payload", "emit_fact")
            : type === "done"
              ? parsePayload(DonePayload, payload, "invalid_done", "mark_job_done")
              : type === "human"
                ? parsePayload(HumanPayload, payload, "invalid_human", "request_human")
                : payload;
    // Parse Hub references before the event/application can perform any write.
    // Event-ingestion wraps this callback in the same transaction, so a later
    // rejection rolls back the event, jobs, nodes, and edges as one decision.
    const hubDecision: HubDecision | null = type === "hub_decision" ? parseHubDecisionPayload(payload) : null;
    const [job] = await tx`SELECT * FROM jobs WHERE id = ${jobId} FOR UPDATE`;
    if (!job) throw new Error(`job ${jobId} 不存在`);
    assertSemanticJobRunning(job as Record<string, unknown>, type);
    assertSemanticToolAuthority(job as Record<string, unknown>, type);
    await assertTerminalEventHistory(tx, jobId, type);

    if (type === "done") {
      // The real executor performs the same check before buffering terminal
      // state, but ingestion is the authority for direct/recovery callers too.
      // Keep verify's verdict contract and non-verify's clean terminal payload
      // enforced inside the outer event transaction.
      const done = validatedPayload as {
        verdict?: string;
        missing_evidence?: string[];
      };
      const isVerifyJob = job.type === "verify_finding" || job.type === "verify";
      if (isVerifyJob && !done.verdict) {
        throw new ControlInputError("invalid_done", "verify Job 的 mark_job_done 必须提供 verdict。", "verdict");
      }
      if (!isVerifyJob && (done.verdict !== undefined || done.missing_evidence !== undefined)) {
        throw new ControlInputError(
          "invalid_done",
          "非 verify Job 的 mark_job_done 不得提供 verdict 或 missing_evidence。",
          done.verdict !== undefined ? "verdict" : "missing_evidence",
        );
      }
      if (isVerifyJob && done.verdict === "rework" && (!done.missing_evidence || done.missing_evidence.length === 0)) {
        throw new ControlInputError(
          "invalid_done",
          "verdict=rework 必须列出至少一项 missing_evidence。",
          "missing_evidence",
        );
      }
      if (isVerifyJob && done.verdict !== "rework" && done.missing_evidence !== undefined) {
        throw new ControlInputError(
          "invalid_done",
          "只有 verdict=rework 才能提供 missing_evidence。",
          "missing_evidence",
        );
      }
    }

    if (type === "progress") {
      const p = validatedPayload as { message: string; percent?: number };
      await tx`
      UPDATE canvas_nodes SET body_json = body_json || ${tx.json({ last_progress: p })}, updated_at = now()
      WHERE job_id = ${jobId} AND node_type = ANY(${["job", "intent"]})`;
      await tx`UPDATE jobs SET heartbeat_at = now() WHERE id = ${jobId}`;
      return;
    }

    if (type === "finding") {
      const f = validatedPayload as FindingPayload;
      const protocol = await ports.findingProtocolForJob(tx, job as Record<string, unknown>);
      let normalized: ReturnType<typeof normalizeFindingProposal>;
      try {
        normalized = normalizeFindingProposal(f, protocol);
      } catch (error) {
        throw new ControlInputError(
          "invalid_payload",
          `Finding 不符合任务冻结协议：${error instanceof Error ? error.message : "invalid finding protocol"}`,
          f.scoring ? "scoring" : "profile",
        );
      }
      const severity =
        normalized.scoring?.status === "supported"
          ? normalized.scoring.base_severity === "none"
            ? null
            : normalized.scoring.base_severity
          : (normalized.severity ?? null);
      const fingerprint = sha16(
        [
          normalized.profile,
          normalized.title.trim().toLowerCase(),
          (normalized.location ?? "").trim(),
          (normalized.rule_id ?? "").trim(),
        ].join("|"),
      );
      const [finding] = await tx`
      INSERT INTO findings ${tx({
        project_id: job.project_id,
        job_id: jobId,
        fingerprint,
        title: normalized.title,
        severity,
        profile: normalized.profile,
        category: normalized.category ?? null,
        tags_json: (normalized.tags ?? []) as never,
        evidence_refs_json: (normalized.evidence_refs ?? []) as never,
        scoring_json: (normalized.scoring ?? {}) as never,
        location: normalized.location ?? null,
        summary: normalized.summary ?? null,
        suggest_verify: normalized.suggest_verify ?? false,
        raw_json: (normalized.raw ?? {}) as never,
      })}
      ON CONFLICT (project_id, fingerprint) DO NOTHING
      RETURNING *`;
      if (!finding) return; // fingerprint 去重命中：同一 finding 不重复上图、不重复派生

      // 画布：finding 节点挂在 job 节点下，坐标服务端分配（§3.2）
      const [jobNode] = await tx`
      SELECT id, canvas_id, x, y FROM canvas_nodes
      WHERE job_id = ${jobId} AND node_type = ANY(${["job", "intent"]})`;
      if (jobNode) {
        const [{ count }] = await tx<[{ count: number }]>`
        SELECT COUNT(*)::int AS count FROM canvas_nodes WHERE job_id = ${jobId} AND node_type = 'finding'`;
        const [node] = await tx`
        INSERT INTO canvas_nodes ${tx({
          canvas_id: jobNode.canvas_id,
          job_id: jobId,
          node_type: "finding",
          title: normalized.title,
          body_json: {
            profile: normalized.profile,
            category: normalized.category,
            severity,
            score: normalized.scoring?.base_score ?? null,
            score_version: normalized.scoring?.version ?? null,
            location: normalized.location,
            summary: normalized.summary,
          } as never,
          x: jobNode.x + 300,
          y: jobNode.y + count * 140,
          status: "open",
        })}
        RETURNING id`;
        await tx`
        INSERT INTO canvas_edges ${tx({
          canvas_id: jobNode.canvas_id,
          from_node_id: jobNode.id,
          to_node_id: node.id,
          edge_type: "produces",
        })}`;
        await tx`UPDATE findings SET node_id = ${node.id} WHERE id = ${finding.id}`;
      }

      // 规则引擎：达到最低关注级别或未评分的 Finding 自动进入 Verify。
      await ports.findingVerification.evaluateFollowup(tx, job, finding);
      return;
    }

    if (type === "fact") {
      // 角色 agent 的发现 → fact 节点（§8.3：agent 只负责把发现写入画布）
      const p = validatedPayload as {
        intent_node_id?: string;
        title?: string;
        description?: string;
        verification?: VerificationEvidence;
      };
      if (!p.description) return;
      let canvasId = (job.canvas_id as string) ?? null;
      let intentNode: Record<string, unknown> | null = null;
      if (p.intent_node_id) {
        const [n] = await tx`SELECT * FROM canvas_nodes WHERE id = ${p.intent_node_id}`;
        if (n) {
          intentNode = n;
          canvasId = (n.canvas_id as string) ?? canvasId;
        }
      }
      if (!canvasId) {
        const [jobNode] = await tx`
        SELECT canvas_id FROM canvas_nodes WHERE job_id = ${jobId} AND node_type = ANY(${["job", "intent"]})`;
        canvasId = (jobNode?.canvas_id as string) ?? null;
      }
      if (!canvasId) return;

      const [{ count }] = await tx<[{ count: number }]>`
      SELECT COUNT(*)::int AS count FROM canvas_nodes WHERE canvas_id = ${canvasId} AND node_type = 'fact'`;
      const [node] = await tx`
      INSERT INTO canvas_nodes ${tx({
        canvas_id: canvasId,
        job_id: jobId,
        node_type: "fact",
        title: (p.title ?? p.description.slice(0, 60)).slice(0, 200),
        body_json: { description: p.description } as never,
        x: ((intentNode?.x as number) ?? 100) + 340,
        y: ((intentNode?.y as number) ?? 100) + count * 140,
        status: "open",
        verification_status: "unverified",
      })}
      RETURNING id`;
      // 'to' 边：意图 → 产出的事实（Cairn Intent.to）
      if (intentNode) {
        await ports.insertEdgeIfAbsent(tx, canvasId, intentNode.id as string, node.id as string, "to");
      }
      // 结构化验证证据：仅 Hub 回弹补证 Job 绑定 finding 时接受
      if (p.verification) {
        const attached = await ports.findingVerification.attachVerificationEvidence(
          tx,
          job,
          node.id as string,
          canvasId,
          p.verification,
        );
        if (!attached) {
          throw invalidVerification("verification 证据未能附着到当前绑定 Finding；本次 fact 已拒绝。", "verification");
        }
      }
      return;
    }

    if (type === "hub_decision") {
      // hub 读图后的决策：complete=目标达成；intents=派发角色 job（§8.3）
      const p = hubDecision!;
      const canvasId = (job.canvas_id as string) ?? null;
      if (!canvasId) return;
      // Resolve every submitted reference, including intents beyond the runtime
      // dispatch cap, before role/job/payload/edge side effects begin.
      const referenceNodes = await assertHubDecisionCanvasReferences(tx, canvasId, p, services.hubReferenceLookup);
      const insertHubEdges: HubEdgeBatchInsert = async (edgeTx, edges) => {
        const uniqueEdges = dedupeCanvasEdges(edges);
        if (uniqueEdges.length === 0) return;
        await (services.hubEdgeBatchInsert ?? ports.insertEdgesIfAbsentBatch)(edgeTx, uniqueEdges);
      };
      const rules = await ports.rulesForProject(tx, job.project_id as string);

      if (p.complete?.description) {
        // Hub complete 只是提案：统一完成门（排除当前仍 running 的 Hub 做门检）
        // **不在此处派 Report**：当前 Hub 尚未 mark_job_done；由 finalizeJob 在 Hub succeeded 后派发，
        // 避免 exclude 后抢跑 Report，也避免 Hub 崩溃时报告先于 Hub 终态。
        const gate = await ports.findingVerification.evaluateAnalysisCompleteGate(tx, canvasId, {
          excludeJobId: jobId,
        });
        if (!gate.ok) {
          const detail =
            gate.problems.length > 0
              ? gate.problems
                  .slice(0, 8)
                  .map((x) =>
                    x.finding_id
                      ? `[${x.severity}] ${x.title || x.finding_id}: ${x.verify_status}（${x.issue}）`
                      : x.issue,
                  )
                  .join("; ")
              : gate.blockers.slice(0, 5).join("; ");
          throw new Error(`Hub complete 被拒绝：${detail}`);
        }

        const [root] = await tx`
        SELECT id FROM canvas_nodes WHERE canvas_id = ${canvasId} AND node_type = 'root' LIMIT 1`;
        if (root) {
          await tx`
          UPDATE canvas_nodes SET status = 'analysis_complete',
            body_json = body_json || ${tx.json({ conclusion: p.complete.description })}, updated_at = now()
          WHERE id = ${root.id}`;
          const edges: EventCanvasEdgeInput[] = [];
          for (const fid of p.complete.from) {
            const src = referenceNodes.get(fid);
            if (src)
              edges.push({
                canvasId,
                fromId: src.id,
                toId: root.id as string,
                edgeType: "to",
              });
          }
          await insertHubEdges(tx, edges);
        }
        return;
      }

      // 项目启用的角色（hub 可下发清单）；一个都没启用则不再派生
      const roles = await ports.rolesForProject(tx, job.project_id as string);
      const enabledNames = new Set(roles.map((r) => r.name));
      const submittedIntents = p.intents ?? [];
      // Validate the complete proposal before applying the runtime dispatch
      // cap. Otherwise an invalid role after maxIntentsPerDecision could be
      // silently truncated and the same internal call would appear accepted.
      for (const it of submittedIntents) {
        if (!it.role || !enabledNames.has(it.role)) {
          throw invalidRole(it.role ?? "<missing>", "intents.role");
        }
      }
      const hubEdges: EventCanvasEdgeInput[] = [];

      const decisionTrigger = ((job.payload_json as Record<string, unknown> | undefined)?.trigger ?? {}) as {
        kind?: string;
        finding_id?: string;
        missing_evidence?: string[];
      };
      if (["verify_rework", "verify_failed"].includes(decisionTrigger.kind ?? "")) {
        for (const it of submittedIntents) {
          if (it.role !== "review" && it.role !== "test") {
            throw new Error(`Verify 补证只允许派发 review/test，收到 ${it.role ?? "<missing>"}`);
          }
        }
      }

      const findingNodeIds = [
        ...new Set(
          [...referenceNodes.values()]
            .filter((node) => node.node_type === "finding")
            .map((node) => node.id),
        ),
      ];
      const findingRows = findingNodeIds.length
        ? (await tx<HubFindingBinding[]>`
            SELECT f.id, f.node_id, f.severity
            FROM findings f
            JOIN jobs origin ON origin.id = f.job_id AND origin.project_id = f.project_id
            JOIN canvas_nodes source ON source.id = f.node_id
              AND source.canvas_id = ${canvasId}
              AND source.node_type = 'finding'
            WHERE f.project_id = ${job.project_id as string}
              AND origin.canvas_id = ${canvasId}
              AND f.node_id = ANY(${findingNodeIds}::uuid[])`) as HubFindingBinding[]
        : [];
      const findingByNodeId = new Map<string, HubFindingBinding>();
      const ambiguousFindingNodeIds = new Set<string>();
      for (const finding of findingRows) {
        if (findingByNodeId.has(finding.node_id)) {
          ambiguousFindingNodeIds.add(finding.node_id);
          continue;
        }
        findingByNodeId.set(finding.node_id, finding);
      }

      for (const [index, intent] of submittedIntents.entries()) {
        const resolution = resolveHubFindingIntent(
          intent.role,
          intent.from,
          referenceNodes,
          findingByNodeId,
          ambiguousFindingNodeIds,
        );
        if (resolution.error) {
          throw invalidVerification(resolution.error, `intents.${index}.from`);
        }
        const sourceFinding = resolution.finding;
        if (
          ["verify_rework", "verify_failed"].includes(decisionTrigger.kind ?? "") &&
          (!sourceFinding || decisionTrigger.finding_id !== sourceFinding.id)
        ) {
          throw invalidVerification(
            "Verify trigger 必须与 review/test intent 的 canonical Finding 一致，无法绑定验证目标。",
            `intents.${index}.from`,
          );
        }
        if (
          sourceFinding &&
          !ports.findingVerification.isSeverityInVerifyScope(rules.minVerifySeverity, sourceFinding.severity)
        ) {
          throw invalidVerification(
            "该 Finding 低于当前 Verify 最低关注级别，已豁免自动验证；请 complete 或仅处理范围内 Finding。",
            `intents.${index}.from`,
          );
        }
      }

      const intents = submittedIntents.slice(0, rules.maxIntentsPerDecision);

      for (const it of intents) {
        if (roles.length === 0) {
          throw invalidRole(it.role, "intents.role");
        }
        const title = it.description.trim().slice(0, 120);
        // 去重：同画布已有同标题的未结论 intent → 跳过（hub 重复派发护栏）
        const dup = await tx`
        SELECT 1 FROM canvas_nodes
        WHERE canvas_id = ${canvasId} AND node_type = 'intent' AND title = ${title}
          AND status NOT IN ('succeeded', 'failed', 'cancelled')
        LIMIT 1`;
        if (dup.length > 0) continue;

        // 服务端硬边界：只接受数据库实时查询出的项目可用工作角色，不做默认或回退。
        const role = it.role!;
        const sourceFinding = resolveHubFindingIntent(
          role,
          it.from,
          referenceNodes,
          findingByNodeId,
          ambiguousFindingNodeIds,
        ).finding;
        const trigger = sourceFinding
          ? {
              ...decisionTrigger,
              kind: ["verify_rework", "verify_failed"].includes(decisionTrigger.kind ?? "")
                ? decisionTrigger.kind
                : "hub_finding",
              finding_id: sourceFinding.id,
            }
          : decisionTrigger;
        // verify_rework/verify_failed 补证不得 hub_followup：否则每个补证成功都会 force Hub，
        // 与「全部补证终态后 maybeReverifyAfterFollowup」冲突。
        const hubFollowup = ["confirmed_finding", "risk_acceptance_followup", "human_comment"].includes(
          trigger.kind ?? "",
        );
        const verificationFollowup = ports.findingVerification.buildVerificationFollowupPayload(trigger, it.from, role);
        const followupFindingId =
          typeof verificationFollowup?.finding_id === "string" ? verificationFollowup.finding_id : null;
        const snapshot = await freezeAgentSnapshotNetworkPolicy(
          tx,
          canvasId,
          await ports.resolveAgentSnapshotForJob(
            tx,
            job.project_id as string,
            role,
            followupFindingId ? [followupFindingId] : [],
          ),
        );
        // 补证 Job 即使 Hub 因其它原因带了 hub_followup，也禁止 force 提前回弹
        const applyHubFollowup = hubFollowup && !verificationFollowup;
        const schedulingPurpose: SchedulingPurpose = verificationFollowup ? "convergence_evidence" : "discovery";
        const [roleJob] = await tx`
        INSERT INTO jobs ${tx({
          project_id: job.project_id as string,
          canvas_id: canvasId,
          parent_job_id: job.id as string,
          finding_id: followupFindingId,
          agent_snapshot_json: snapshot as never,
          type: role,
          priority: ports.fixedPriorityForJob({
            type: role,
            purpose: schedulingPurpose,
          }),
          payload_json: {
            scheduling_purpose: schedulingPurpose,
            intent: {
              description: it.description,
              prompt: it.prompt.trim(),
              from: it.from,
            },
            ...(applyHubFollowup ? { hub_followup: true } : {}),
            ...(verificationFollowup
              ? {
                  verification_followup: {
                    ...verificationFollowup,
                    scheduler_owned: true,
                  },
                }
              : {}),
          } as never,
          timeout_sec: rules.auditTimeoutSec,
          followup_depth: 0,
        })}
        RETURNING id`;
        await ports.recordJobSharedAssets(tx, roleJob.id as string, snapshot.shared_assets ?? []);
        // intent 节点与角色 job 1:1（节点即任务卡：pending=未认领 running=进行中 succeeded=已结论）
        const [{ next_y }] = await tx<[{ next_y: number }]>`
        SELECT COALESCE(MAX(y), 60) + 140 AS next_y FROM canvas_nodes
        WHERE canvas_id = ${canvasId} AND node_type = 'intent'`;
        const [intentNode] = await tx`
        INSERT INTO canvas_nodes ${tx({
          canvas_id: canvasId,
          job_id: roleJob.id as string,
          node_type: "intent",
          title,
          // Freeze the scheduler-selected worker color with the intent so
          // historical canvases do not change when a role is later edited or
          // deleted.  System/Hub snapshots intentionally carry null here.
          body_json: {
            role,
            description: it.description,
            ...(snapshot.ui_color ? { ui_color: snapshot.ui_color } : {}),
          } as never,
          x: 1220,
          y: next_y,
          status: "pending",
        })}
        RETURNING id`;
        await tx`
        UPDATE jobs SET payload_json = payload_json || ${tx.json({ intent_node_id: intentNode.id })}
        WHERE id = ${roleJob.id}`;
        // 'from' 边：被引用事实 → 新意图（Cairn Intent.from）
        for (const fid of it.from) {
          const src = referenceNodes.get(fid);
          if (src)
            hubEdges.push({
              canvasId,
              fromId: src.id,
              toId: intentNode.id as string,
              edgeType: "from",
            });
        }
      }
      await insertHubEdges(tx, hubEdges);
      return;
    }

    if (type === "done") {
      await ports.finalizeJob(
        tx,
        jobId,
        "succeeded",
        validatedPayload as {
          summary?: string;
          verdict?: string;
          missing_evidence?: string[];
        },
      );
      return;
    }

    if (type === "human") {
      const p = validatedPayload as HumanPayload;
      const canvasId = (job.canvas_id as string | null) ?? null;
      if (p.subject.type === "finding") {
        if (!canvasId) {
          throw new ControlInputError("invalid_human", "Finding 人工请求必须绑定当前 Job 的画布。", "subject.finding_id");
        }
        const [finding] = await tx`
          SELECT f.id, f.severity
          FROM findings f
          JOIN jobs origin ON origin.id = f.job_id AND origin.project_id = f.project_id
          JOIN canvas_nodes source ON source.id = f.node_id
            AND source.canvas_id = ${canvasId}
            AND source.node_type = 'finding'
          WHERE f.id = ${p.subject.finding_id}
            AND f.project_id = ${job.project_id as string}
            AND origin.canvas_id = ${canvasId}`;
        if (!finding) {
          throw new ControlInputError(
            "invalid_human",
            "Finding 人工请求只能绑定当前项目、当前画布的 canonical Finding。",
            "subject.finding_id",
          );
        }
        const rules = await ports.rulesForProject(tx, job.project_id as string);
        if (!ports.findingVerification.isSeverityInVerifyScope(rules.minVerifySeverity, finding.severity)) {
          throw new ControlInputError(
            "invalid_human",
            "该 Finding 低于当前 Verify 最低关注级别，不得以 Finding 阻塞任务。",
            "subject.finding_id",
          );
        }
      }
      await tx`
      UPDATE jobs SET status = 'waiting_human' WHERE id = ${jobId} AND status = 'running'`;
      const [jobNode] = await tx`
      SELECT id, canvas_id, x, y FROM canvas_nodes WHERE job_id = ${jobId} AND node_type = 'job'`;
      if (jobNode) {
        await tx`
        INSERT INTO canvas_nodes ${tx({
          canvas_id: jobNode.canvas_id,
          job_id: jobId,
          node_type: "human",
          title: p.reason.slice(0, 200),
          body_json: { reason: p.reason, subject: p.subject } as never,
          x: jobNode.x + 150,
          y: jobNode.y - 160,
          status: "open",
        })}`;
      }
      return;
    }
  }

  return { applySideEffects };
}
