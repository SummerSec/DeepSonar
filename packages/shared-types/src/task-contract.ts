import { z } from "zod";
import { TaskOutcomeSpec, normalizeTaskOutcomeSpec } from "./task-outcome.js";

export const TASK_CONTRACT_ACTIONS = ["read", "workspace_write", "write", "egress"] as const;
export const TASK_CONTRACT_TEMPLATE_IDS = ["engineering", "whitebox", "blackbox", "graybox"] as const;
const text = z.string().trim().min(1).max(2_000);
const texts = z.array(text).max(100).default([]);
const actions = z.array(z.enum(TASK_CONTRACT_ACTIONS)).max(4).default([]);

/** Client statements are never verification or an independent authorization source. */
export const TaskContract = z.object({
  schema_version: z.literal(1),
  template_id: z.enum(TASK_CONTRACT_TEMPLATE_IDS),
  template_version: z.literal(1),
  objective: text.optional(),
  outcome: TaskOutcomeSpec.optional(),
  targets: texts,
  baseline: text.optional(),
  scope: texts,
  exclusions: texts,
  acceptance: texts,
  evidence: texts,
  stop_conditions: texts,
  cleanup: texts,
  materials: texts,
  hypotheses: texts,
  budget: z.object({
    max_minutes: z.number().int().positive().max(10_080),
    max_steps: z.number().int().positive().max(10_000),
  }).strict().optional(),
  allowed_actions: actions,
  required_actions: actions,
  forbidden_actions: actions,
  credential_refs: z.array(z.string().uuid()).max(100).default([]),
  identity: z.object({ tenant: text.optional(), role: text.optional(), resource: text.optional() }).strict().optional(),
  prerequisites: z.array(z.object({
    id: z.string().trim().min(1).max(100),
    required: z.boolean(),
    state: z.enum(["declared", "missing", "not_applicable"]),
    description: text,
  }).strict()).max(100).default([]),
}).strict().superRefine((contract, ctx) => {
  if (new TextEncoder().encode(JSON.stringify(contract)).byteLength > 20_000) {
    ctx.addIssue({ code: "custom", message: "Task contract exceeds 20000 UTF-8 bytes" });
  }
  const seen = new Set<string>();
  contract.prerequisites.forEach((item, index) => {
    if (seen.has(item.id)) ctx.addIssue({ code: "custom", path: ["prerequisites", index, "id"], message: "Prerequisite IDs must be unique" });
    seen.add(item.id);
  });
});
export type TaskContract = z.infer<typeof TaskContract>;
export type TaskContractAction = typeof TASK_CONTRACT_ACTIONS[number];
export type TaskContractTemplateId = typeof TASK_CONTRACT_TEMPLATE_IDS[number];

const commonFields = ["objective", "targets", "scope", "acceptance", "evidence", "budget", "allowed_actions", "required_actions", "stop_conditions"] as const;

/** Suggestions are UI/help content only. They are never silently inserted into a task. */
export const TASK_CONTRACT_TEMPLATES = {
  engineering: {
    id: "engineering", version: 1, label: "工程任务",
    required_fields: [...commonFields],
    acceptance_suggestions: ["明确变更前后行为和交付文件", "提供可重复的测试命令与结果；无法运行时说明限制"],
  },
  whitebox: {
    id: "whitebox", version: 1, label: "白盒审查",
    required_fields: [...commonFields, "baseline"],
    acceptance_suggestions: ["引用源码基线、模块和证据位置", "分别报告静态结论、动态验证结果及未验证限制，不要求必然发现漏洞"],
  },
  blackbox: {
    id: "blackbox", version: 1, label: "黑盒验证",
    required_fields: [...commonFields],
    acceptance_suggestions: ["记录授权资产、实际身份与资源归属", "报告获准状态链的证据、清理结果及无法验证的步骤"],
  },
  graybox: {
    id: "graybox", version: 1, label: "灰盒验证",
    required_fields: [...commonFields, "baseline"],
    acceptance_suggestions: ["关联源码基线与目标环境证据", "分别报告只读观察和获准动态验证的结果及限制"],
  },
} as const;

export interface TaskContractFeedback {
  code: string;
  path: string;
  message: string;
  suggestion: string;
}

const uniqueSorted = <T extends string>(values: readonly T[]): T[] => [...new Set(values)].sort();

/** Parse first, then canonicalize sets. No free-text inference or permission defaults. */
export function normalizeTaskContract(input: unknown): TaskContract {
  const value = TaskContract.parse(input);
  return {
    ...value,
    ...(value.outcome ? { outcome: normalizeTaskOutcomeSpec(value.outcome) } : {}),
    targets: uniqueSorted(value.targets),
    scope: uniqueSorted(value.scope),
    exclusions: uniqueSorted(value.exclusions),
    acceptance: uniqueSorted(value.acceptance),
    evidence: uniqueSorted(value.evidence),
    stop_conditions: uniqueSorted(value.stop_conditions),
    cleanup: uniqueSorted(value.cleanup),
    materials: uniqueSorted(value.materials),
    hypotheses: uniqueSorted(value.hypotheses),
    allowed_actions: uniqueSorted(value.allowed_actions),
    required_actions: uniqueSorted(value.required_actions),
    forbidden_actions: uniqueSorted(value.forbidden_actions),
    credential_refs: uniqueSorted(value.credential_refs.map((id) => id.toLowerCase())),
    prerequisites: [...value.prerequisites].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  };
}

const feedback = (code: string, path: string, message: string, suggestion: string): TaskContractFeedback => ({ code, path, message, suggestion });

/** Structural guidance, not a claim to understand or score arbitrary task prose. */
export function taskContractWarnings(contract?: TaskContract | null): TaskContractFeedback[] {
  if (!contract) return [feedback("task_contract_not_assessed", "task_contract", "未提供任务契约，未评估文本完整性或执行前置条件。", "可使用场景模板补充结构化契约；原始需求仍会保留。")];
  const result: TaskContractFeedback[] = [];
  if (contract.outcome?.mode === "bounty_submission" && contract.outcome.rules_status === "unknown") {
    result.push(feedback("task_outcome_rules_unknown", "task_contract.outcome.rules_status", "成果规则未知：可先观察和补证，但不能提交 Finding 或认定成果达标。", "由授权创建者补充可追溯规则后重新下发；已冻结 Job 不自动采用新规则。"));
  }
  for (const field of TASK_CONTRACT_TEMPLATES[contract.template_id].required_fields) {
    const value = contract[field];
    if (value === undefined || (Array.isArray(value) && value.length === 0)) {
      result.push(feedback("task_contract_missing_field", `task_contract.${field}`, `尚未声明 ${field}。`, `补充本场景的 ${field}；未知条件需明确保留未核验状态。`));
    }
  }
  if (contract.targets.length > 10) result.push(feedback("task_contract_scope_review", "task_contract.targets", "目标较多，需要人工核对范围与预算。", "按共同前置条件和可独立验收的目标评估是否拆分；不要拆断必要状态链。"));
  if (contract.budget && contract.scope.length > contract.budget.max_steps) result.push(feedback("task_contract_budget_review", "task_contract.budget.max_steps", "范围条目数超过声明的步骤预算。", "人工核对步骤预算与范围是否匹配；此提示不估算实际执行成本。"));
  for (const action of uniqueSorted([...contract.required_actions, ...contract.allowed_actions])) {
    const path = contract.required_actions.includes(action) ? "task_contract.required_actions" : "task_contract.allowed_actions";
    if (!contract.allowed_actions.includes(action) || contract.forbidden_actions.includes(action)) result.push(feedback("task_contract_action_conflict", path, `声明动作 ${action} 不在本次允许范围内或已被禁止。`, "缩小任务步骤或经授权重新明确动作范围；契约不能授予平台权限。"));
  }
  for (const [index, item] of contract.prerequisites.entries()) {
    if (item.state !== "not_applicable" || item.required) result.push(feedback("task_contract_prerequisite_unverified", `task_contract.prerequisites.${index}`, "前置条件尚无当前可信核验。", "补充可由平台低风险核验的材料；客户端声明不视为已验证。"));
  }
  if ((contract.required_actions.includes("write") || contract.allowed_actions.includes("write")) && (!contract.identity?.tenant || !contract.identity?.role || !contract.identity?.resource)) result.push(feedback("task_contract_identity_incomplete", "task_contract.identity", "写入任务缺少完整租户、角色或资源边界。", "补充目标身份与资源归属，并由可信适配器核验；不要提交账号密码。"));
  return result;
}

/** Must be freshly supplied by Scheduler-owned adapters, never copied from contract claims. */
export interface TaskContractDispatchFacts {
  allowEgress: boolean;
  availableCredentialIds: readonly string[];
  authorizedActions?: readonly TaskContractAction[];
  identity?: { tenant?: string; role?: string; resource?: string };
  verifiedPrerequisiteIds?: readonly string[];
}

/** Refuse dispatch if any declared permitted action exceeds a current trusted boundary. */
export function validateTaskContractDispatch(contract: TaskContract, facts: TaskContractDispatchFacts): TaskContractFeedback[] {
  const result: TaskContractFeedback[] = [];
  if (contract.required_actions.length === 0) result.push(feedback("task_contract_actions_unknown", "task_contract.required_actions", "尚未声明执行所需动作，无法核对权限边界。", "显式列出 read、workspace_write、write 或 egress；不要从需求文本推断授权。"));
  for (const action of uniqueSorted([...contract.required_actions, ...contract.allowed_actions])) {
    const path = contract.required_actions.includes(action) ? "task_contract.required_actions" : "task_contract.allowed_actions";
    if (!contract.allowed_actions.includes(action) || contract.forbidden_actions.includes(action)) {
      result.push(feedback("task_contract_action_forbidden", path, `声明动作 ${action} 超出契约允许范围或已被禁止。`, "收窄任务或补充经授权的契约；不能仅修改声明获得新权限。"));
    }
    if (action === "workspace_write" && !facts.authorizedActions?.includes("workspace_write")) result.push(feedback("task_contract_workspace_write_denied", path, "当前 Job 未获准修改沙箱工作区。", "由平台确认当前沙箱工作区写入权限；此动作不包括推送或修改外部资产。"));
    if (action === "write" && !facts.authorizedActions?.includes("write")) result.push(feedback("task_contract_write_unverified", path, "当前平台信息不能确认目标写入授权。", "通过既有治理流程确认目标授权，并等待可信适配器核验；可改为单独的只读任务。"));
    if (action === "egress" && !facts.allowEgress) result.push(feedback("task_contract_egress_denied", path, "当前项目或 Job 策略不允许外联。", "去掉依赖外联的步骤；契约不能扩大网络权限。"));
    if (facts.authorizedActions && !facts.authorizedActions.includes(action) && action !== "write" && action !== "workspace_write") result.push(feedback("task_contract_action_not_granted", path, `当前可信权限不包含 ${action}。`, "缩小任务到已获准动作，或由授权管理者补充实际权限。"));
  }
  for (const id of contract.credential_refs) {
    if (!facts.availableCredentialIds.includes(id)) result.push(feedback("task_contract_credential_unavailable", "task_contract.credential_refs", `凭据引用 ${id} 当前不可用于本项目。`, "检查引用、项目授权及凭据当前可用状态；不要在契约中填写秘密。"));
  }
  for (const key of ["tenant", "role", "resource"] as const) {
    const expected = contract.identity?.[key];
    const actual = facts.identity?.[key];
    if (expected && actual === undefined) result.push(feedback("task_contract_identity_unverified", `task_contract.identity.${key}`, `无法低风险核验目标 ${key}。`, "补充可信身份核验适配器或移除依赖此边界的步骤。"));
    else if (expected && expected !== actual) result.push(feedback("task_contract_identity_mismatch", `task_contract.identity.${key}`, `当前身份的 ${key} 与任务要求不匹配。`, "选择正确身份或目标；不得自动改用其他租户或提权。"));
    else if (!expected && (contract.required_actions.includes("write") || contract.allowed_actions.includes("write"))) result.push(feedback("task_contract_identity_missing", `task_contract.identity.${key}`, `写入任务未声明目标 ${key}。`, "补充写入所需身份和资源边界后重新核验。"));
  }
  for (const [index, item] of contract.prerequisites.entries()) {
    if (item.required && (item.state !== "declared" || !facts.verifiedPrerequisiteIds?.includes(item.id))) result.push(feedback("task_contract_prerequisite_blocked", `task_contract.prerequisites.${index}`, "必要前置条件未经当前可信核验。", "补齐材料并由可信适配器核验，或收窄为不依赖该条件的任务。"));
  }
  return result;
}
