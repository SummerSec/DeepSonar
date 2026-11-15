/**
 * #1133：Verify 补证缺少「连续无进展」刹车。
 *
 * 现场形态是「派了 test、Job succeeded、但 missing 没减少」——现有刹车都不覆盖：
 * `maxNoProgressRounds` 只在 plan 协议预算内，`wait_evidence`（#574）只看 `waiting_evidence`
 * 状态，`maxVerificationRounds` 只在轮次耗尽时转 inconclusive。于是同一 Finding 被反复派
 * test/review 6–9 次（多数 succeeded）仍停在 pending，每轮真实起沙箱并消耗模型请求。
 *
 * 本模块只提供**判定**（纯函数），不碰终态写入：把「连续 N 次回弹时缺失证据集合完全相同」
 * 视作无进展，由 verify.ts 据此收口到 needs_human（带可读原因），而不是继续派注定无用的补证。
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

function roundMissing(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
  return [];
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
    if (missingFingerprint(roundMissing(round.missing)) !== current) break;
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
    SELECT final_outcome, evidence_snapshot_json->'missing' AS missing
    FROM finding_verification_rounds
    WHERE finding_id = ${findingId} AND id <> ${roundId} AND final_outcome IS NOT NULL
    ORDER BY attempt DESC, id DESC
    LIMIT ${RECENT_ROUNDS}`;
  return reachedNoProgressLimit(recentRounds, missing);
}
