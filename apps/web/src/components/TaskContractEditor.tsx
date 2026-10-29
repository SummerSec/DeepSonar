import { normalizeTaskContract, TASK_CONTRACT_TEMPLATES } from "@deepsonar/shared-types";
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

/** One optional editor shared by full task creation and quick start. */
export function TaskContractEditor({ value, onChange, disabled = false }: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const parsed = parseTaskContractDraft(value);
  return <details className="mt-4 rounded-lg border border-white/10 p-3">
    <summary className="cursor-pointer text-sm text-zinc-300">任务规格与前置条件（可选）</summary>
    <p className="mt-2 text-xs leading-6 text-zinc-400">选择适用场景并补充 JSON。保留未知项，不填写密码、Token 或 Cookie；凭据只使用引用。声明权限不能授予权限，创建后仍会检查派发条件。清空编辑器可省略契约。</p>
    <p className="mt-2 text-xs leading-6 text-zinc-400">动作范围：read 为只读；workspace_write 仅用于隔离工作区内改代码、构建和测试；write 为目标业务系统写入，需额外核验；egress 为出网。allowed_actions 和 required_actions 均需明确填写。</p>
    <div className="my-3 flex flex-wrap gap-2" aria-label="任务规格模板">
      {Object.entries(TASK_CONTRACT_TEMPLATES).map(([id, template]) => <button key={id} type="button" disabled={disabled || Boolean(value.trim())} className="rounded border border-white/10 px-3 py-1 text-xs text-zinc-300 disabled:opacity-50" onClick={() => onChange(JSON.stringify(normalizeTaskContract({ schema_version: 1, template_id: id, template_version: template.version }), null, 2))}>{template.label}</button>)}
      <button type="button" disabled={disabled || !value} className="text-xs text-zinc-400" onClick={() => onChange("")}>清空契约</button>
    </div>
    {parsed.contract && <div className="mb-3 text-xs leading-6 text-zinc-400">
      <p>验收建议（请按实际任务填写，不会自动加入契约）：</p>
      <ul className="list-disc pl-5">{TASK_CONTRACT_TEMPLATES[parsed.contract.template_id].acceptance_suggestions.map((suggestion) => <li key={suggestion}>{suggestion}</li>)}</ul>
    </div>}
    <label className="block text-xs text-zinc-400">任务契约 JSON
      <textarea value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled} rows={10} maxLength={30000} spellCheck={false} className="theme-input-surface mt-2 w-full rounded border p-3 font-mono text-xs text-zinc-200" placeholder="留空沿用自由文本任务" />
    </label>
    {parsed.error && <p role="alert" className="mt-2 text-xs text-red-300">{parsed.error}</p>}
    <TaskContractFeedbackView feedback={{ task_contract_warnings: parsed.warnings }} />
  </details>;
}
