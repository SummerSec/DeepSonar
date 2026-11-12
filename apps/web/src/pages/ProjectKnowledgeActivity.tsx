import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { projectKnowledgeApi, type KnowledgeActivity, type KnowledgeActivityWork } from "../ProjectKnowledgeApi";

const states: Record<string, string> = { pending: "排队中", running: "整理中", completed: "流程已完成", blocked: "受阻", cancelled: "已取消" };
const stages: Record<string, string> = { maker: "候选整理", evaluator: "评测", reviewer: "审查", settle: "结算" };
const proposalStates: Record<string, string> = { candidate: "候选", evaluating: "评测中", review_pending: "待审查",
  active: "已生效", needs_eval: "待补评测", blocked: "受阻", rejected: "已拒绝", retired: "已退役" };
const reasons: Record<string, string> = {
  governance_baseline_changed: "治理基线已变化", job_budget_exhausted: "Job 数量预算已耗尽",
  work_budget_exhausted: "工作预算已耗尽", run_budget_exhausted: "运行时间预算已耗尽",
  trial_job_budget_exhausted: "试验 Job 预算已耗尽", active_job_missing: "当前 Job 缺失",
  maker_revision_unavailable: "候选无法继续修订", proposal_missing: "缺少候选提案",
  review_rejected_or_unsettled: "审查已拒绝或结果尚未结算", evaluation_plan_incomplete: "评测计划不完整",
  trial_matrix_excess: "试验数量超出上限", trial_not_successful: "试验未成功完成",
  evaluator_terminal_without_record: "评测 Job 已结束但缺少记录", behavior_evaluation_missing: "缺少行为评测",
  reviewer_terminal_without_record: "审查 Job 已结束但缺少记录", unknown_work_stage: "工作阶段无法识别",
  automatic_execution_deferred: "自动执行已暂缓", job_cancelled: "Job 已取消", job_failed: "Job 执行失败",
  job_timeout: "Job 已超时", unknown_external_effect: "存在未知外部效果，需先对账",
  attempt_not_settled_successfully: "执行尝试尚未成功结算", trial_missing_evidence: "试验缺少证据",
  maker_missing_proposal: "整理 Job 未提交候选", evaluator_missing_record: "缺少评测记录",
  reviewer_missing_record: "缺少审查记录", review_needs_eval: "审查要求补充评测", review_rejected: "审查已拒绝",
  proposal_blocked: "候选提案受阻", proposal_rejected: "候选提案已拒绝", proposal_needs_eval: "候选尚需评测",
  proposal_retired: "候选提案已退役", project_sources_collected: "来源已纳入整理，等待执行",
  scheduler_admission_failed: "调度准入失败，已达到有界重试限制或等待后续重试",
  project_archived: "项目已归档", excluded_job_type: "此类 Job 不参与来源采集",
  knowledge_governance_job: "知识治理 Job 不作为新来源", job_not_succeeded: "来源 Job 尚未成功",
  latest_attempt_not_succeeded: "来源最新执行尝试未成功", request_not_allowed: "来源 Job 未获知识请求权限",
  unsettled_effects: "来源仍有未结算效果", no_sources: "来源没有可采集证据", job_not_found: "来源 Job 不存在",
  existing_knowledge_work: "来源已有知识工作", source_input_limit: "来源输入超过单次采集上限",
  source_ineligible: "来源未满足采集条件", source_preparation_failed: "来源准备失败",
  source_asset_unavailable: "证据引用的资产版本不可用",
  source_collection_retry_exhausted: "来源准备重试已耗尽，请查看来源执行记录",
  source_database_permission_denied: "来源采集的数据库权限不足",
  source_attempt_changed: "来源执行身份已变化", source_governor_revoked: "来源冻结的治理方法已撤销",
  KNOWLEDGE_SCOPE_DENIED: "来源权限校验未通过", KNOWLEDGE_REVOKED: "来源授权已撤销",
  KNOWLEDGE_SNAPSHOT_INVALID: "来源冻结快照无效", KNOWLEDGE_INPUT_LIMIT: "来源输入超出限制",
  KNOWLEDGE_INPUT_TOO_LARGE: "来源内容超出读取上限", KNOWLEDGE_HASH_MISMATCH: "来源内容完整性校验未通过",
  details_unavailable: "原因详情未公开，请查看关联执行记录",
};
const reasonLabel = (value: string | null) => value ? reasons[value] ?? "工作无法继续，请查看关联执行记录" : "未提供原因，请查看关联执行记录";
const date = (value: string) => new Date(value).toLocaleString("zh-CN");
const button = "rounded-lg border border-white/10 px-3 py-1.5 text-xs text-zinc-300 hover:bg-white/[.06] focus-visible:outline focus-visible:outline-acc-400 disabled:opacity-40";
const link = "text-acc-300 underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-acc-400";
const jobHref = (projectId: string, jobId: string) => `/jobs?${new URLSearchParams({ project: projectId, job: jobId })}`;

function WorkRow({ work, projectId }: { work: KnowledgeActivityWork; projectId: string }) {
  return <li className="border-t border-white/[.06] py-3 text-xs">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className={work.state === "blocked" ? "text-amber-300" : "text-zinc-300"}>{states[work.state] ?? "状态未知"}</span>
      <span className="text-zinc-400">{stages[work.stage] ?? "阶段未知"} · {work.source_count} 个来源</span>
      {work.state === "blocked" && <span className="break-words text-amber-200/90">{reasonLabel(work.reason)}</span>}
      <div className="ml-auto flex shrink-0 gap-3">
        {work.active_job_id && <Link className={link} to={jobHref(projectId, work.active_job_id)}>查看 Job</Link>}
        {work.canvas_id && <Link className={link} to={`/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(work.canvas_id)}`}>查看 Canvas</Link>}
      </div>
    </div>
    <details className="mt-2 text-zinc-500">
      <summary className="w-fit cursor-pointer focus-visible:outline focus-visible:outline-acc-400">工作详情</summary>
      <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-2 break-all leading-5">
        <div><dt className="inline">工作 </dt><dd className="inline font-mono">{work.id}</dd></div>
        <div><dt className="inline">Job 数 </dt><dd className="inline">{work.job_count}</dd></div>
        <div><dt className="inline">累计运行 </dt><dd className="inline">{work.run_seconds} 秒</dd></div>
        <div><dt className="inline">最新提案 </dt><dd className="inline">{work.latest_proposal_state ? proposalStates[work.latest_proposal_state] ?? "状态未知" : "暂无提案"}</dd></div>
        <div><dt className="inline">创建 </dt><dd className="inline">{date(work.created_at)}</dd></div>
        <div><dt className="inline">更新 </dt><dd className="inline">{date(work.updated_at)}</dd></div>
      </dl>
      {work.state !== "blocked" && work.reason && <p className="mt-2">{reasonLabel(work.reason)}</p>}
    </details>
  </li>;
}

/** Reuses the knowledge page refresh trigger; no timer or background polling. */
export function ProjectKnowledgeActivity({ projectId, refresh, onRefresh }: {
  projectId: string; refresh: number; onRefresh: () => void;
}) {
  const scope = `${projectId}:${refresh}`;
  const [pagination, setPagination] = useState({ scope, offset: 0 });
  const offset = pagination.scope === scope ? pagination.offset : 0;
  const requestKey = `${scope}:${offset}`;
  const [result, setResult] = useState<{ key: string; data?: KnowledgeActivity; failed?: boolean } | null>(null);
  useEffect(() => {
    let active = true;
    setResult(null);
    projectKnowledgeApi.activity(projectId, { limit: 10, offset })
      .then(data => { if (active) setResult({ key: requestKey, data }); })
      .catch(() => { if (active) setResult({ key: requestKey, failed: true }); });
    return () => { active = false; };
  }, [projectId, offset, requestKey]);
  // Do not display a previous project's data even for the render before effect cleanup.
  const current = result?.key === requestKey ? result : null;
  const data = current?.data;
  const loading = !current;
  return <section aria-label="知识积累与复用" aria-busy={loading} className="mb-5 rounded-xl border border-white/[.07] bg-white/[.025] px-4 py-3">
    <h2 className="mb-3 text-sm font-medium text-zinc-200">积累与复用</h2>
    {loading && <p role="status" className="text-xs text-zinc-500">正在加载积累与复用进展…</p>}
    {current?.failed && <div role="alert" className="text-xs text-red-200">加载积累与复用进展失败。
      <button type="button" className="ml-3 underline" onClick={onRefresh}>重试</button></div>}
    {data && <>
      <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs leading-6 text-zinc-400">
        <span>已登记来源 <strong className="text-zinc-200">{data.summary.registered_sources}</strong></span>
        <span>已纳入整理 <strong className="text-zinc-200">{data.summary.collected_sources}</strong></span>
        <span>待采集来源 <strong className="text-zinc-200">{data.summary.pending_sources}</strong></span>
        <span>已跳过来源 <strong className="text-zinc-200">{data.summary.skipped_sources}</strong></span>
        <span>已生效 Memory <strong className="text-zinc-200">{data.summary.active_memory}</strong> / Skill <strong className="text-zinc-200">{data.summary.active_skills}</strong></span>
        <span>本项目拉取 <strong className="text-zinc-200">{data.summary.usage_count}</strong></span>
        <span>模型反馈 <strong className="text-zinc-200">{data.summary.feedback_count}</strong></span>
      </div>
      <details className="mt-3 text-xs leading-6 text-zinc-500">
        <summary className="w-fit cursor-pointer focus-visible:outline focus-visible:outline-acc-400">统计口径与跳过原因</summary>
        <p className="mt-2">来源登记是可追溯入口；已纳入整理包含排队批次，不代表知识已生效。候选 {data.summary.draft_items} 项，需经过评测与审查才可生效。</p>
        <p>拉取只统计本项目使用本项目知识的记录，不能证明实际采用。反馈是模型报告，其中报告成功 {data.summary.successful_feedback} 次，不代表效果已证明。</p>
        <p>跳过来源不再自动重试。最近最多 10 条原因如下；重复来源只计一次，待采集按已登记来源排除已采集或已跳过的来源。</p>
        {data.skipped_sources.length === 0 ? <p>暂无跳过来源记录。</p> : <ul className="mt-2 divide-y divide-white/[.06]">
          {data.skipped_sources.map(source => <li key={source.job_id} className="flex flex-wrap gap-x-3 gap-y-1 py-2">
            <span>{reasonLabel(source.reason)}</span><span>{date(source.at)}</span>
            <Link className={link} to={jobHref(projectId, source.job_id)}>查看来源 Job <span className="font-mono">{source.job_id.slice(0, 8)}</span></Link>
          </li>)}
        </ul>}
      </details>
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
        <h3 className="text-zinc-300">最近知识工作</h3>
        <span className="text-zinc-500">流程完成 {data.summary.completed_work} · 受阻 {data.summary.blocked_work}</span>
      </div>
      {data.items.length === 0 ? <p className="mt-3 text-xs text-zinc-500">暂无知识工作；已登记来源仍可等待采集。</p>
        : <ul className="mt-2">{data.items.map(work => <WorkRow key={work.id} projectId={projectId} work={work} />)}</ul>}
      {(offset > 0 || data.next_offset !== null) && <div className="mt-3 flex justify-end gap-2">
        <button type="button" className={button} disabled={offset === 0}
          onClick={() => setPagination({ scope, offset: Math.max(0, offset - 10) })}>上一页工作</button>
        <button type="button" className={button} disabled={data.next_offset === null}
          onClick={() => setPagination({ scope, offset: data.next_offset ?? offset })}>下一页工作</button>
      </div>}
    </>}
  </section>;
}
