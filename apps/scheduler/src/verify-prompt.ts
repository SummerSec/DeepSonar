/** Fact-only verify_finding input: consume validated Facts and propose close. No second review. */

export function buildVerifyJobPrompt(opts: {
  attempt: number;
  subject: { id?: string; location?: string | null; artifact_refs?: unknown };
  evidenceJson: string;
  taskGoal: string;
  graphYaml?: string | null;
}): string {
  return `根据已落库的结构化 Fact 提交 Finding 收口提案（第 ${opts.attempt} 轮）。不要重读源代码、原始制品或 maker 结论做第二次复核。

主体身份：${opts.subject.id || "未知"}
位置：${opts.subject.location || "未知"}
任务目标：${opts.taskGoal || "未提供"}

## 本轮冻结 Fact 快照（唯一权威测量集合，与 Scheduler Fact-first 硬门同源）
\`\`\`json
${opts.evidenceJson}
\`\`\`

协议：
1. 只消费快照中的 finding_id、subject_revision、ownership（source_job_id/source_role）、expected、actual、outcome 与有限 limitations。
2. 普通文本 verdict 不是 Fact；缺结构化 expected/actual 的条目不得当作验证结果。
3. 结构化 Fact 带 expected/actual、outcome=supports，且 finding_id / subject_revision / ownership 匹配时，提案 verdict=confirmed。expected 与 actual 一致是直通示例，不是唯一通过条件。
4. outcome=rejects/refutes、来源 Job 失败、Fact 冲突、finding_id 或 subject_revision 不匹配、Fact 不足 → verdict=rework，并列出 missing_evidence。
5. 禁止根据标题、摘要、严重度、结论文本或 artifact 原文重新复核。

画布 YAML 只提供骨架与引用，不能补齐或覆盖快照字段。

${opts.graphYaml ? `任务画布（YAML 摘要）：\n${opts.graphYaml}` : "（无画布快照）"}`;
}
