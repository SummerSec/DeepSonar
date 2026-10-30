/** Fixed-size projection of the existing gate result; never copy finding text or identifiers. */
export function analysisCompleteGateExpected(gate: { blockers: readonly string[] }) {
  const counts = {
    active_work: 0, no_role_work: 0, finding_not_converged: 0,
    missing_verification_round: 0, missing_human_blocker: 0, open_round: 0, other: 0,
  };
  const uuid = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
  const finding = new RegExp(`^finding:${uuid}:(pending|verifying|false_positive|confirmed_without_round|refuted_without_round|inconclusive_without_round|needs_human_without_blocker)$`);
  const round = new RegExp(`^open_round:${uuid}$`);
  let countCapped = false;
  for (const blocker of gate.blockers) {
    let key: keyof typeof counts = "other";
    if (blocker === "active_work" || blocker === "no_role_work") key = blocker;
    else if (round.test(blocker)) key = "open_round";
    else {
      const match = finding.exec(blocker);
      if (match) key = match[1].endsWith("_without_round") ? "missing_verification_round"
        : match[1] === "needs_human_without_blocker" ? "missing_human_blocker" : "finding_not_converged";
    }
    if (counts[key] < 1000) counts[key]++;
    else countCapped = true;
  }
  return {
    kind: "analysis_complete_gate", observed_counts: counts, count_cap: 1000, count_capped: countCapped,
    counts_scope: "gate_observations_not_inventory",
    action: "按当前 Job 已有权限补充工作、验证证据或人工处理；不得改写结论凑门。缺失项解决后用新 Idempotency-Key 重提；预检不是版本锁，最终写入仍重验。",
  };
}
