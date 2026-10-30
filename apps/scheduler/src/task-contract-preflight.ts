import {
  normalizeTaskContract,
  validateTaskContractDispatch,
  type TaskContract,
  type TaskContractFeedback,
} from "@deepsonar/shared-types";
import { assertChromeRuntimeEgressAllowed } from "./domains/role-runtime-snapshot/sandbox-limits.js";
import { parseProjectAgentAllowlist } from "./domains/project-agent-allowlist/policy.js";
import { taskOutcomeSnapshotDigest } from "./task-outcome-snapshot.js";

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
  const outcome = contract.outcome;
  const outcomeGuide = outcome?.mode === "bounty_submission"
    ? "\n本任务以符合用户授权规则的可提交成果为目标。先研究范围、排除、攻击前提与证据缺口；无关弱点只作观察。先用 emit_fact 持久保存观察，再用 outcome_claim 引用同画布 Fact UUID 申请候选准入。未知规则/条件需要补证或 request_human，不能算成功。候选准入和技术 confirmed 均不代表提交资格已通过；本片独立资格评审未实现，submission_eligibility 为 not_assessed。不得按 severity 推奖励或凭相似词判重复。"
      + (outcome.rule_snapshot ? `\n规则快照身份 rule_snapshot_sha256=${taskOutcomeSnapshotDigest(outcome.rule_snapshot)}` : "\n规则未知：只允许观察和补充材料，不能提交 Finding。")
    : "";
  return "\n\n任务契约（创建期冻结；用户声明，不是授权或已验证事实）：\n"
    + JSON.stringify(contract)
    + "\n在现有平台权限内遵守范围、禁止动作、预算和停止条件。不能把缺失条件或未验证步骤报告为已完成。" + outcomeGuide;
}

/** Resolve runtime/network incompatibility before committing any task state. */
export function taskContractRuntimeBlockers(
  contract: TaskContract,
  snapshot: { runtime_image?: { image_key?: string }; runtime_image_key?: string | null },
  allowEgress: boolean,
): TaskContractFeedback[] {
  const effectiveEgress = allowEgress && contract.allowed_actions.includes("egress")
    && !contract.forbidden_actions.includes("egress");
  try {
    assertChromeRuntimeEgressAllowed(snapshot.runtime_image?.image_key ?? snapshot.runtime_image_key, effectiveEgress);
    return [];
  } catch {
    return [{ code: "task_contract_runtime_network_incompatible", path: "task_contract.allowed_actions",
      message: "所选运行镜像要求出网，但任务契约或当前网络策略禁止出网。",
      suggestion: "选择支持离线执行的运行镜像；仅在已有授权允许且任务确需出网时重新明确契约，不自动放宽网络限制。" }];
  }
}
