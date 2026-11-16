/**
 * #1133：Verify 补证缺少「连续无进展」刹车。
 *
 * 现场形态是「派了 test、Job succeeded、但 missing 没减少」：同一 Finding 被反复派 test/review
 * 6–9 次（多数 succeeded）仍停在 pending，每轮真实起沙箱并消耗模型请求。
 *
 * 与既有刹车的关系（本片只补 verify_finding 回弹路径，不替换任何既有机制）：
 * - 补证完成路径（`maybeReverifyAfterFollowup`）已有 gate 指纹 + `rules.maxNoProgressRounds`
 *   的收口（settle 到 inconclusive），本模块不参与；
 * - `wait_evidence`（#574）只看 `waiting_evidence` 状态；
 * - `maxVerificationRounds` 只在轮次耗尽时转 inconclusive；
 * - 因此 verify_finding 轮次在**门禁缺项不变**时仍会一轮轮回弹补证——本模块补的就是这条：
 *   连续 N 轮回弹的「本次决策缺失集合」完全相同即收口 `needs_human`。
 *
 * 口径约定（评审 P1）：历史轮次可能用门禁替换后的缺失集合（如 `structured_supporting_fact`），
 * 与 `evidence.missing` 的原始集合不同，所以只在轮次快照里持久化本次决策集合
 * （`evidence_snapshot_json.decision_missing`）并按同一口径比较；没有该字段的历史轮次
 * 视为不可比、直接中断 streak（宁可少收口，也不误收口）。
 */

/** 连续多少次「同一 missing 指纹的回弹」即判定无进展（含本次判定，故 2 表示第 2 次就收口）。 */
export const VERIFY_NO_PROGRESS_LIMIT = 2;

/** 稳定原因码：写入 round error 与 finding 结算 reason，便于检索与看板聚合。 */
export const VERIFY_NO_PROGRESS_REASON = "verify_no_progress";

/** 缺失证据集合指纹：排序去重后拼接，顺序差异不算进展，重复项被忽略。 */
export function missingFingerprint(missing: readonly string[] | null | undefined): string {
  const values = (missing ?? []).filter((value): value is string => typeof value === "string" && value.length > 0);
  return [...new Set(values)].sort((left, right) => left.localeCompare(right)).join("|");
}

export interface VerifyRoundProgress {
  final_outcome: string | null;
  missing: unknown;
}

/** 只有数组才是可比的历史缺失集合；null/缺字段表示「无该口径」→ 不可比（不能当作空集合）。 */
function comparableRoundMissing(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * 从**最近向远**排列的历史轮次里，数出与本次缺失集合相同的连续回弹次数（不含本次）。
 *
 * 只统计 `final_outcome = 'rework'`（其它终态已收口）、且缺失集合指纹相同的连续轮次；
 * 一旦遇到缺失集合不同或其它终态就停止，避免把「确实缩小了 missing 但后面又遇到新缺口」
 * 的历史算成无进展。
 */
export function noProgressStreak(rounds: readonly VerifyRoundProgress[], missing: readonly string[] | null | undefined): number {
  const current = missingFingerprint(missing);
  let streak = 0;
  for (const round of rounds) {
    if (round.final_outcome !== "rework") break;
    const historical = comparableRoundMissing(round.missing);
    if (historical === null) break; // 旧快照没有 decision_missing：不可比，直接中断（宁可少收口）
    if (missingFingerprint(historical) !== current) break;
    streak += 1;
  }
  return streak;
}

/** 本次回弹是否已达到无进展上限（即应当收口而不是再派一轮补证）。 */
export function reachedNoProgressLimit(
  rounds: readonly VerifyRoundProgress[],
  missing: readonly string[] | null | undefined,
  limit: number = VERIFY_NO_PROGRESS_LIMIT,
): boolean {
  if (limit <= 0) return false;
  // 含本次：已有 streak 次回弹 + 本次 = streak + 1。
  return noProgressStreak(rounds, missing) + 1 >= limit;
}

import { sql } from "./db.js";

type Tx = typeof sql;

const RECENT_ROUNDS = Math.max(1, VERIFY_NO_PROGRESS_LIMIT);

/** #1133：取最近 N 轮回弹并判定是否达到无进展上限；判定纯函数见 reachedNoProgressLimit。 */
export async function shouldStopForNoProgress(
  tx: Tx,
  findingId: string,
  roundId: string,
  missing: readonly string[] | null | undefined,
): Promise<boolean> {
  const recentRounds = await tx<Array<VerifyRoundProgress>>`
    SELECT final_outcome, evidence_snapshot_json->'decision_missing' AS missing
    FROM finding_verification_rounds
    WHERE finding_id = ${findingId} AND id <> ${roundId} AND final_outcome IS NOT NULL
    ORDER BY attempt DESC, id DESC
    LIMIT ${RECENT_ROUNDS}`;
  return reachedNoProgressLimit(recentRounds, missing);
}
