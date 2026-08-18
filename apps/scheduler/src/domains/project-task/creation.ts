import { FindingProtocolConfig as FindingProtocolConfigSchema } from "@deepsonar/shared-types";
import { config } from "../../config.js";
import {
  fixedPriorityForJob,
  resolveAgentSnapshotForJob,
  rulesForProject,
} from "../../core.js";
import { sql } from "../../db.js";
import { resolveFindingProtocol } from "../../finding-protocol.js";
import {
  RuntimeImageChannelUnavailableError,
  RuntimeImageNoTrustedVersionError,
  RuntimeImageNotReadyError,
  RuntimeImagePlatformUnavailableError,
  RuntimeImageReferenceInvalidError,
  RuntimeImageVersionUnavailableError,
} from "../../runtime-images.js";
import {
  freezeAgentSnapshotNetworkPolicy,
  type AgentRuntimeSnapshot,
} from "../role-runtime-snapshot/index.js";
import { recordJobSharedAssets } from "../shared-assets/index.js";
import {
  freezeTaskSeedTarget,
  frozenTaskSeeds,
  insertTaskSeedProjections,
} from "../../task-compose.js";

type Db = typeof sql;

export class TaskTargetInputError extends Error {
  readonly code = "TASK_TARGET_INVALID" as const;
  readonly statusCode = 400 as const;

  constructor(message: string) {
    super(message);
    this.name = "TaskTargetInputError";
  }
}

export class TaskSnapshotUnavailableError extends Error {
  readonly code = "TASK_RUNTIME_SNAPSHOT_UNAVAILABLE" as const;
  readonly statusCode = 409 as const;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "TaskSnapshotUnavailableError";
  }
}

export interface EntryHubJobInput {
  projectId: string;
  canvasId: string;
  rootNodeId: string;
  planeIssueId?: string | null;
  ingressKey?: string | null;
  payload: Record<string, unknown>;
  snapshot: AgentRuntimeSnapshot;
}

/**
 * Insert the first/retry Hub Job and its graph projection on a caller-owned
 * transaction. Snapshot resolution must already have completed on that same
 * transaction.
 */
export async function insertEntryHubJob(
  db: Db,
  input: EntryHubJobInput,
): Promise<Record<string, unknown>> {
  const [hubJob] = await db`
    INSERT INTO jobs ${db({
      project_id: input.projectId,
      canvas_id: input.canvasId,
      plane_issue_id: input.planeIssueId ?? null,
      agent_snapshot_json: input.snapshot as never,
      type: "hub_reason",
      priority: fixedPriorityForJob({ type: "hub_reason", purpose: "hub" }),
      payload_json: { ...input.payload, scheduling_purpose: "hub" } as never,
      timeout_sec: config.timeouts.auditSec,
      followup_depth: 0,
      ingress_key: input.ingressKey ?? null,
    })}
    RETURNING *`;
  await recordJobSharedAssets(
    db,
    String(hubJob.id),
    input.snapshot.shared_assets ?? [],
  );

  const [{ next_x }] = await db<[{ next_x: number }]>`
    SELECT COALESCE(MAX(x + w), 60) + 40 AS next_x
    FROM canvas_nodes
    WHERE canvas_id = ${input.canvasId}`;
  const [hubNode] = await db`
    INSERT INTO canvas_nodes ${db({
      canvas_id: input.canvasId,
      job_id: String(hubJob.id),
      node_type: "job",
      title: "Hub 决策",
      body_json: {
        type: "hub_reason",
        trigger: input.payload.trigger,
      } as never,
      x: next_x,
      y: 300,
      status: "pending",
    })}
    RETURNING id`;
  await db`
    INSERT INTO canvas_edges ${db({
      canvas_id: input.canvasId,
      from_node_id: input.rootNodeId,
      to_node_id: String(hubNode.id),
      edge_type: "child",
    })}`;
  return hubJob as Record<string, unknown>;
}

export interface CreateTaskTransactionInput {
  projectId: string;
  title: string;
  target: Record<string, unknown>;
  payload: Record<string, unknown>;
}

export type CreateTaskTransactionResult =
  | { kind: "not_found" }
  | { kind: "archived" }
  | {
      kind: "created";
      canvasId: string;
      job: Record<string, unknown>;
      frozenSeedIds: string[];
    };

function parseFindingProtocolLayer(value: unknown, layer: string) {
  if (value === undefined || value === null) return undefined;
  try {
    return FindingProtocolConfigSchema.parse(value);
  } catch {
    throw new TaskTargetInputError(`${layer} finding protocol 配置无效`);
  }
}

function isRuntimeImageSelectionError(error: unknown): boolean {
  return error instanceof RuntimeImageNoTrustedVersionError
    || error instanceof RuntimeImageVersionUnavailableError
    || error instanceof RuntimeImagePlatformUnavailableError
    || error instanceof RuntimeImageChannelUnavailableError
    || error instanceof RuntimeImageReferenceInvalidError
    || error instanceof RuntimeImageNotReadyError;
}

/**
 * Create a human task as one PostgreSQL commit. No audit is written here:
 * audit() owns an independent connection and must run only after this returns.
 */
export async function createTaskTransaction(
  input: CreateTaskTransactionInput,
): Promise<CreateTaskTransactionResult> {
  return sql.begin(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    const [project] = await tx`
      SELECT id, status, config_json
      FROM projects
      WHERE id = ${input.projectId}
      FOR UPDATE`;
    if (!project) return { kind: "not_found" as const };
    if (project.status !== "active") return { kind: "archived" as const };

    const requestedPolicy = (input.target.network_policy ?? {}) as Record<string, unknown>;
    const effectiveRules = await rulesForProject(tx, input.projectId);
    const [globalSettings] = await tx`
      SELECT rules_json FROM global_settings WHERE id = 'global' FOR SHARE`;
    const globalProtocol = parseFindingProtocolLayer(
      ((globalSettings?.rules_json ?? {}) as Record<string, unknown>).finding_protocol,
      "global",
    );
    const projectProtocol = parseFindingProtocolLayer(
      ((project.config_json ?? {}) as Record<string, unknown>).finding_protocol,
      "project",
    );
    const taskProtocol = parseFindingProtocolLayer(input.target.finding_protocol, "task");
    const target = await freezeTaskSeedTarget(
      tx,
      input.projectId,
      {
        ...input.target,
        effective_finding_protocol: resolveFindingProtocol(
          globalProtocol,
          projectProtocol,
          taskProtocol,
        ),
        network_policy: {
          allow_egress:
            typeof requestedPolicy.allow_egress === "boolean"
              ? requestedPolicy.allow_egress
              : effectiveRules.allowEgress,
        },
      },
      true,
    );
    const frozenSeedIds = frozenTaskSeeds(target).map((seed) => seed.id);

    const [canvas] = await tx`
      INSERT INTO canvases ${tx({
        project_id: input.projectId,
        plane_issue_id: null,
        title: input.title,
        target_json: target as never,
      })}
      RETURNING id`;
    const canvasId = String(canvas.id);
    const [rootNode] = await tx`
      INSERT INTO canvas_nodes ${tx({
        canvas_id: canvasId,
        job_id: null,
        node_type: "root",
        title: input.title,
        body_json: { target } as never,
        x: 100,
        y: 100,
        status: "active",
      })}
      RETURNING id`;
    await insertTaskSeedProjections(
      tx,
      canvasId,
      String(rootNode.id),
      target,
    );

    let snapshot: AgentRuntimeSnapshot;
    try {
      snapshot = await freezeAgentSnapshotNetworkPolicy(
        tx,
        canvasId,
        await resolveAgentSnapshotForJob(
          tx,
          input.projectId,
          "hub_reason",
          frozenSeedIds,
        ),
      );
    } catch (error) {
      if (isRuntimeImageSelectionError(error)) throw error;
      throw new TaskSnapshotUnavailableError(error);
    }

    const job = await insertEntryHubJob(tx, {
      projectId: input.projectId,
      canvasId,
      rootNodeId: String(rootNode.id),
      payload: {
        ...input.payload,
        ...(target.kind === "compose"
          ? { related_finding_ids: frozenSeedIds }
          : {}),
      },
      snapshot,
    });
    return {
      kind: "created" as const,
      canvasId,
      job,
      frozenSeedIds,
    };
  });
}
