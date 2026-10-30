import { TaskContract as TaskContractSchema, normalizeTaskContract, taskContractWarnings, type TaskContract } from "@deepsonar/shared-types";

export interface ContractFeedbackItem {
  code: string;
  path: string;
  message: string;
  suggestion: string;
}
export interface TaskContractFeedback {
  task_contract_warnings?: ContractFeedbackItem[];
  task_contract_blockers?: ContractFeedbackItem[];
}

/** Empty means deliberately omitted, never an inferred audit or authorization. */
export function parseTaskContractDraft(draft: string): {
  contract?: TaskContract;
  error?: string;
  warnings: ContractFeedbackItem[];
} {
  if (!draft.trim()) return { warnings: [] };
  try {
    const checked = TaskContractSchema.safeParse(JSON.parse(draft));
    if (!checked.success) return {
      error: "契约格式无效，请修正以下字段后提交。",
      warnings: checked.error.issues.map((issue) => ({
        code: issue.code,
        path: issue.path.join(".") || "task_contract",
        message: "字段类型、枚举、版本或结构不符合契约。",
        suggestion: "按共享契约填写，删除未知字段；未知条件不要声明为已验证。",
      })),
    };
    const contract = normalizeTaskContract(checked.data);
    return { contract, warnings: taskContractWarnings(contract) };
  } catch {
    return { error: "契约格式无效：请检查 JSON、字段类型、版本和未知字段。", warnings: [] };
  }
}

export function taskFeedbackItems(feedback: TaskContractFeedback): ContractFeedbackItem[] {
  return [...(feedback.task_contract_blockers ?? []), ...(feedback.task_contract_warnings ?? [])];
}
