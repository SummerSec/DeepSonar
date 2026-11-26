/** A stop cannot cancel SQL already sent; the host drain/identity fence remains
 * authoritative. Do not begin the next knowledge/claim stage after a stop. */
export async function tickKnowledgeBeforeDispatch(
  stopped: () => boolean,
  load: () => Promise<{tick: (stopped: () => boolean) => Promise<number>}>,
): Promise<boolean> {
  if (stopped()) return false;
  const scheduler = await load();
  if (stopped()) return false;
  await scheduler.tick(stopped);
  return !stopped();
}

/** #1287：普通任务领取与知识推进解耦——先领取并启动，再跑知识推进。
 * 知识推进失败或停机只影响知识侧，不能挡住已经领取的普通任务。 */
export async function claimThenTickKnowledge<J>(
  stopped: () => boolean,
  claim: () => Promise<J[]>,
  start: (jobs: J[]) => void,
  load: () => Promise<{tick: (stopped: () => boolean) => Promise<number>}>,
): Promise<number> {
  const jobs = await claim();
  start(jobs);
  if (stopped()) return jobs.length;
  try {
    const scheduler = await load();
    if (!stopped()) await scheduler.tick(stopped);
  } catch (error) {
    console.error("[dispatcher] 知识推进失败，不影响已领取的任务:", error);
  }
  return jobs.length;
}

/** #1287：知识推进必须能脱离领取循环单独跑完——否则慢查询会卡住随后到达的 kick。
 * 单飞：同时只有一个知识 tick；停机后不再加载/进入；错误只记日志。 */
let knowledgeAdvanceInFlight: Promise<void> | null = null;

export function requestKnowledgeAdvance(
  stopped: () => boolean,
  load: () => Promise<{tick: (stopped: () => boolean) => Promise<number>}>,
): Promise<void> {
  if (knowledgeAdvanceInFlight) return knowledgeAdvanceInFlight;
  knowledgeAdvanceInFlight = (async () => {
    try {
      if (stopped()) return;
      const scheduler = await load();
      if (!stopped()) await scheduler.tick(stopped);
    } catch (error) {
      console.error("[dispatcher] 知识推进失败，不影响普通任务领取:", error);
    } finally {
      knowledgeAdvanceInFlight = null;
    }
  })();
  return knowledgeAdvanceInFlight;
}
