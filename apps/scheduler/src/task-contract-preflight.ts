import {
  normalizeTaskContract,
  validateTaskContractDispatch,
  type TaskContract,
  type TaskContractFeedback,
} from "@deepsonar/shared-types";
import { parseProjectAgentAllowlist } from "./domains/project-agent-allowlist/policy.js";

type Query = (strings: TemplateStringsArray, ...values: unknown[]) => unknown;

export class TaskContractBlockedError extends Error {
  readonly code = "task_contract_blocked";
  constructor(readonly blockers: TaskContractFeedback[]) {
    // Feedback is server-authored and never includes supplied values or credentials.
    super(`task_contract_blocked: ${JSON.stringify(blockers)}`);
  }
}

/** Re-read availability, never credential secrets or untrusted identity metadata. */
export async function taskContractPreflight(
  db: Query,
  projectId: string,
  contract: TaskContract,
  allowEgress: boolean,
): Promise<TaskContractFeedback[]> {
  const [project] = await db`SELECT id, status, config_json FROM projects WHERE id = ${projectId}` as Array<{
    id: string; status: string; config_json: unknown;
  }>;
  if (!project || project.status !== "active") return [{
    code: "task_contract_project_unavailable", path: "project_id",
    message: "任务项目不存在或已归档。", suggestion: "确认当前项目仍有效。",
  }];
  const allowlist = parseProjectAgentAllowlist(project.config_json);
  const credentials = contract.credential_refs.length === 0 ? [] : await db`
    SELECT id, kind FROM credentials
    WHERE id = ANY(${contract.credential_refs}::uuid[])
      AND status = 'active' AND health_status <> 'error'
      AND (project_id IS NULL OR project_id = ${projectId})` as Array<{ id: string; kind: string }>;
  const availableCredentialIds = credentials.filter((row) => row.kind !== "llm_provider"
    || !allowlist.credential_ids_configured || allowlist.enabled_credential_ids.includes(row.id))
    .map((row) => row.id);
  // The platform currently has no trusted application-account identity/write probe.
  // Do not promote client statements or public credential metadata into grants.
  return validateTaskContractDispatch(contract, { allowEgress, availableCredentialIds, authorizedActions: allowEgress ? ["read", "workspace_write", "egress"] : ["read", "workspace_write"] });
}

export function frozenTaskContract(snapshot: unknown): TaskContract | undefined {
  if (!snapshot || typeof snapshot !== "object") return undefined;
  const value = (snapshot as Record<string, unknown>).task_contract;
  return value === undefined ? undefined : normalizeTaskContract(value);
}

export function taskContractPrompt(snapshot: unknown): string {
  const contract = frozenTaskContract(snapshot);
  if (!contract) return "";
  return "\n\n任务契约（创建期冻结；用户声明，不是授权或已验证事实）：\n"
    + JSON.stringify(contract)
    + "\n在现有平台权限内遵守范围、禁止动作、预算和停止条件。不能把缺失条件或未验证步骤报告为已完成。";
}
