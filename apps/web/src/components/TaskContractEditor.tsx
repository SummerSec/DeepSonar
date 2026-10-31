import { normalizeTaskContract, TASK_CONTRACT_TEMPLATES, type TaskContract, type TaskOutcomeSpec, type TaskContractTemplateId } from "@deepsonar/shared-types";
import { parseTaskContractDraft, taskFeedbackItems, type TaskContractFeedback } from "../task-contract-editor";

export function TaskContractFeedbackView({ feedback }: { feedback: TaskContractFeedback }) {
  const items = taskFeedbackItems(feedback);
  if (!items.length) return null;
  return <div className="mt-3 rounded-lg border border-amber-400/25 p-3 text-xs leading-6 text-amber-200" role="status">
    <p>任务条件反馈（结构化检查，不代表已验证目标环境）：</p>
    <ul className="list-disc pl-5">{items.map((item, index) => <li key={`${item.code}-${item.path}-${index}`}>
      <code>{item.path}</code>：{item.message} {item.suggestion}
    </li>)}</ul>
  </div>;
}

/** All new templates start with the general task goal, never inferred program rules. */
export function taskContractTemplateDraft(id: TaskContractTemplateId): string {
  return JSON.stringify(normalizeTaskContract({
    schema_version: 1, template_id: id, template_version: TASK_CONTRACT_TEMPLATES[id].version,
    outcome: { mode: "task_defined" },
  }), null, 2);
}

/** Choosing a mode declares intent, never supplies or verifies program rules. */
export function taskContractWithOutcomeMode(contract: TaskContract, mode?: TaskOutcomeSpec["mode"]): string {
  const { outcome, ...rest } = contract;
  return JSON.stringify(normalizeTaskContract({
    ...rest,
    ...(mode === "task_defined" ? { outcome: { mode } } : mode === "bounty_submission"
      ? { outcome: outcome?.mode === mode ? outcome : { mode, rules_status: "unknown" } } : {}),
  }), null, 2);
}

/** One optional editor shared by full task creation and quick start. */
export function TaskContractEditor({ value, onChange, disabled = false }: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const parsed = parseTaskContractDraft(value);
  return <details className="mt-4 rounded-lg border border-white/10 p-3">
    <summary className="cursor-pointer text-sm text-zinc-300">任务规格与前置条件（可选）</summary>
    <p className="mt-2 text-xs leading-6 text-zinc-400">选择适用场景并补充 JSON。保留未知项，不填写密码、Token 或 Cookie；凭据只使用引用。声明权限不能授予权限，创建后仍会检查派发条件。未提供契约的旧输入仅标记为未评估，不代表符合任务下发标准。</p>
    <p className="mt-2 text-xs leading-6 text-zinc-400">所有契约都必须明确目标 objective、目标资产 targets、范围 scope、完成标准 acceptance 和证据要求 evidence。缺项会阻止创建与派发；删除成果模式不能绕过检查。</p>
    <p className="mt-2 text-xs leading-6 text-zinc-400">动作范围：read 为只读；workspace_write 仅用于隔离工作区内改代码、构建和测试；write 为目标业务系统写入，需额外核验；egress 为出网。allowed_actions 和 required_actions 均需明确填写。</p>
    <div className="my-3 flex flex-wrap gap-2" aria-label="任务规格模板">
      {Object.entries(TASK_CONTRACT_TEMPLATES).map(([id, template]) => <button key={id} type="button" disabled={disabled || Boolean(value.trim())} className="rounded border border-white/10 px-3 py-1 text-xs text-zinc-300 disabled:opacity-50" onClick={() => onChange(taskContractTemplateDraft(id as TaskContractTemplateId))}>{template.label}</button>)}
      <button type="button" disabled={disabled || !value} className="text-xs text-zinc-400" onClick={() => onChange("")}>清空契约</button>
    </div>
    {parsed.contract && <fieldset className="mb-3 border-0 p-0">
      <legend className="text-xs text-zinc-300">成果模式（显式选择，不从任务关键词推断）</legend>
      <div className="my-2 flex flex-wrap gap-2" role="radiogroup" aria-label="成果模式">
        {([
          { mode: undefined, label: "未指定" },
          { mode: "task_defined", label: "任务自定" },
          { mode: "bounty_submission", label: "赏金提交" },
        ] as const).map(({ mode, label }) => <button key={mode ?? "unspecified"} type="button" role="radio" aria-checked={parsed.contract?.outcome?.mode === mode} disabled={disabled} className="rounded border border-white/10 px-3 py-1 text-xs text-zinc-300 aria-checked:border-acc-400 disabled:opacity-50" onClick={() => onChange(taskContractWithOutcomeMode(parsed.contract!, mode))}>{label}</button>)}
      </div>
      <p className="text-xs leading-6 text-zinc-400">所有新模板默认“任务自定”，使用通用任务下发标准。赏金程序规则只是额外前置筛选，所有通过准入的候选仍是研究候选，不是高置信提交成果。首次选择赏金模式时规则状态为 unknown，不自动填入项目规则。切换至任务自定或未指定会移除当前成果规则材料，请先保留需要的内容。赏金模式可在 JSON 的 outcome.rule_snapshot 中补充真实规则来源、版本、目标基线及要求；核对后将 rules_status 改为 supplied，仍只是创建者提供的材料。</p>
      {parsed.contract.outcome?.mode === "bounty_submission" && parsed.contract.outcome.rules_status === "unknown" && <p className="mt-1 text-xs leading-6 text-amber-200" role="status">成果规则未知：当前仅可观察和补证，不能计为 Finding 或声称已满足提交条件。</p>}
    </fieldset>}
    {parsed.contract && <div className="mb-3 text-xs leading-6 text-zinc-400">
      <p>验收建议（请按实际任务填写，不会自动加入契约）：</p>
      <ul className="list-disc pl-5">{TASK_CONTRACT_TEMPLATES[parsed.contract.template_id].acceptance_suggestions.map((suggestion) => <li key={suggestion}>{suggestion}</li>)}</ul>
    </div>}
    <label className="block text-xs text-zinc-400">任务契约 JSON
      <textarea value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled} rows={10} maxLength={30000} spellCheck={false} className="theme-input-surface mt-2 w-full rounded border p-3 font-mono text-xs text-zinc-200" placeholder="留空沿用自由文本任务（未评估）" />
    </label>
    {parsed.error && <p role="alert" className="mt-2 text-xs text-red-300">{parsed.error}</p>}
    <TaskContractFeedbackView feedback={{ task_contract_warnings: parsed.warnings }} />
  </details>;
}
