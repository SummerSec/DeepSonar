/** Synthetic payloads for AGENT_MODE=fake; never evidence of a real target. */
import { evaluateFindingFactGate, type EvidenceSnapshot } from "./verify.js";

export function fakeFindingPayload(overrides?: {
  title?: string; severity?: string; location?: string; summary?: string;
} | null) {
  return {
    title: overrides?.title ?? "SQL 注入：未参数化的查询拼接",
    severity: overrides?.severity ?? "high",
    location: overrides?.location ?? "auth/login.php:42",
    summary: overrides?.summary ?? "用户输入未经参数化处理直接拼入 SQL 查询语句，攻击者可构造恶意参数改变查询语义并读取未授权数据。",
    profile: "security.vulnerability",
    rule_id: "fake-sqli-001",
    impact: {
      attacker_entry: "演示请求中的未受信任查询参数",
      victim_resource: "演示数据库中的其他租户记录",
      impact_flow: "演示输入经未参数化查询改变 SQL 语义，返回其他租户记录；仅用于 fake 状态机联调。",
    },
    raw: { source: "fake-agent", v: 1 },
  };
}

export function fakeVerificationFact(findingId: string, jobId: string, kind: "review" | "test", intentNodeId: string | null) {
  return {
    intent_node_id: intentNodeId,
    title: `假 agent ${kind} 证据`,
    description: `假 agent（${kind}）：对 Finding ${findingId} 的${kind === "test" ? "实测" : "独立复核"}证据（演示）。`,
    verification: {
      finding_id: findingId,
      evidence_kind: kind,
      outcome: "supports" as const,
      subject_revision: "demo-target@v1",
      environment: "fake-sandbox",
      steps: [
        kind === "test" ? "构造恶意输入" : "阅读相关源码路径",
        kind === "test" ? "发送请求并观察响应" : "追踪数据流至汇点",
        "记录可复核结果",
      ],
      expected: kind === "test" ? "未授权数据不应返回" : "输入应参数化",
      actual: kind === "test" ? "响应包含其他租户记录" : "$_GET 直达查询拼接",
      artifact_refs: [{ uri: `fake://evidence/${jobId}` }],
      attempted_refutation: [kind === "test"
        ? "演示负向对照：普通参数仅返回当前租户记录；恶意参数返回其他租户记录。"
        : "演示源码复核：检查参数绑定与租户过滤，确认该查询路径均未应用。"],
    },
  };
}

export function fakeVerifyDone(finding: Record<string, unknown> | null, evidence: EvidenceSnapshot) {
  const decision = finding
    ? evaluateFindingFactGate(finding, evidence, typeof finding.job_id === "string" ? finding.job_id : null)
    : null;
  return decision?.strategy.ok
    ? { summary: "假 agent：独立复核与实测证据满足完整安全门禁（演示）", verdict: "confirmed" as const }
    : {
        summary: "假 agent：完整安全门禁未通过，需要 Hub 补证（演示）",
        verdict: "rework" as const,
        missing_evidence: decision?.strategy.required_missing.length ? decision.strategy.required_missing : ["finding_context"],
      };
}
