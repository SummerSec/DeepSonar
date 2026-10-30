import {
  normalizeTaskContract,
  deriveTaskGoalCriteria,
  validateTaskContractDispatch,
  type TaskContract,
  type TaskContractFeedback,
} from "@deepsonar/shared-types";
import { assertChromeRuntimeEgressAllowed } from "./domains/role-runtime-snapshot/sandbox-limits.js";
import { parseProjectAgentAllowlist } from "./domains/project-agent-allowlist/policy.js";
import { taskContractDigest } from "./task-outcome-snapshot.js";

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
  const outcomeGuide = "\n任务目标决定研究方向，技术弱点本身不是默认成果。先 emit_fact 保存观察，再用 outcome_claim 引用同任务 Fact 与全契约摘要申请研究候选准入；逐项声明目标相关性、范围、证据及排除条件，至少关联一项 acceptance 判据。matches 仅表示贡献关联，不表示整个验收判据或任务已完成。无关观察不计成果，未知需要补证或 request_human。准入仅为 admitted_for_research，submission_eligibility 保持 not_assessed。"
    + `\n冻结任务契约身份 task_contract_sha256=${taskContractDigest(contract)}`
    + "\n研究判据 ID：" + JSON.stringify(deriveTaskGoalCriteria(contract).map((item) => item.id))
    + (outcome?.mode === "bounty_submission"
      ? "\n赏金是额外高标准任务类型：rule_assessments 还须覆盖冻结程序规则，未知规则不能产生候选。此处检查仍不构成高置信度提交资格；独立复核、可复现证据、攻击链、已知问题适用性与程序资格需后续独立评审，不能用严重度、相似词或置信度分数替代。"
      : "");
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
