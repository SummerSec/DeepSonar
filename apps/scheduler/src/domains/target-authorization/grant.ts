import { z } from "zod";
import {
  TargetAuthorizationSnapshot,
  TARGET_AUTHORIZATION_PROTOCOL,
  targetBindingFromDigest,
  type TargetAuthorizationSnapshot as FrozenTargetAuthorization,
} from "./contract.js";

const token = z.string().trim().min(1).max(200);

const grantRecordSchema = z.object({
  protocol: z.literal(TARGET_AUTHORIZATION_PROTOCOL),
  project_id: token,
  canvas_id: token,
  binding: z.object({
    content_sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    task_contract_sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    revision: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  }).strict(),
  snapshot: TargetAuthorizationSnapshot,
}).strict().superRefine((value, ctx) => {
  const expected = targetBindingFromDigest(value.binding.content_sha256, value.binding.task_contract_sha256);
  if (value.snapshot.project_id !== value.project_id) {
    ctx.addIssue({ code: "custom", path: ["snapshot", "project_id"], message: "grant project does not match snapshot" });
  }
  for (const key of ["content_sha256", "task_contract_sha256", "revision"] as const) {
    if (value.snapshot[key] !== value.binding[key]) {
      ctx.addIssue({ code: "custom", path: ["snapshot", key], message: "grant binding does not match snapshot" });
    }
    if (expected[key] !== value.binding[key]) {
      ctx.addIssue({ code: "custom", path: ["binding", key], message: "grant binding revision is invalid" });
    }
  }
});

export type TargetAuthorizationGrant = z.infer<typeof grantRecordSchema>;

type GrantQuery = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => unknown;

function grantRecord(projectId: string, canvasId: string, snapshot: FrozenTargetAuthorization): TargetAuthorizationGrant {
  return grantRecordSchema.parse({
    protocol: TARGET_AUTHORIZATION_PROTOCOL,
    project_id: projectId,
    canvas_id: canvasId,
    binding: {
      content_sha256: snapshot.content_sha256,
      task_contract_sha256: snapshot.task_contract_sha256,
      revision: snapshot.revision,
    },
    snapshot,
  });
}

/**
 * The audit row is the Scheduler-owned grant ledger. It is deliberately a
 * dedicated system action and contains only the strict secret-free snapshot.
 * Callers must invoke this with the transaction that will insert the Job.
 */
export async function recordTargetAuthorizationGrant(
  db: GrantQuery,
  projectId: string,
  canvasId: string,
  snapshot: unknown,
): Promise<TargetAuthorizationGrant> {
  const parsedSnapshot = TargetAuthorizationSnapshot.parse(snapshot);
  const record = grantRecord(projectId, canvasId, parsedSnapshot);
  await db`
    INSERT INTO audit_logs (
      actor_type, actor_id, action, project_id, resource_type, resource_id,
      request_id, ip, user_agent, before_json, after_json, result, error_code
    ) VALUES (
      'system', 'target-authorization', 'task.target_authorization', ${projectId},
      'canvas', ${canvasId}, NULL, NULL, NULL, NULL, ${JSON.stringify(record)}::text::jsonb, 'ok', NULL
    )`;
  return record;
}

/**
 * Read exactly the latest host grant for this Canvas. An invalid latest row
 * is an error: older grants are never used as a fallback after an edit or
 * revocation epoch.
 */
export async function readLatestTargetAuthorizationGrant(
  db: GrantQuery,
  projectId: string,
  canvasId: string,
): Promise<TargetAuthorizationGrant | undefined> {
  const rows = await db`
    SELECT after_json
    FROM audit_logs
    WHERE actor_type = 'system'
      AND actor_id = 'target-authorization'
      AND action = 'task.target_authorization'
      AND project_id = ${projectId}
      AND resource_type = 'canvas'
      AND resource_id = ${canvasId}
    ORDER BY id DESC
    LIMIT 1` as Array<{ after_json?: unknown }>;
  if (rows.length === 0) return undefined;
  const parsed = grantRecordSchema.safeParse(rows[0]?.after_json);
  if (!parsed.success) throw new Error("latest target authorization grant is invalid");
  if (parsed.data.project_id !== projectId || parsed.data.canvas_id !== canvasId) {
    throw new Error("latest target authorization grant scope is invalid");
  }
  return parsed.data;
}

export function parseTargetAuthorizationGrant(value: unknown): TargetAuthorizationGrant {
  return grantRecordSchema.parse(value);
}
