/** Keep list/detail advice identical without opening a transaction for every active Job. */
export async function withWaitingExecutionStates<T extends { id: unknown; status: unknown }, S>(
  rows: readonly T[],
  readState: (jobId: string) => Promise<S>,
): Promise<Array<T & { execution_state?: S }>> {
  const result: Array<T & { execution_state?: S }> = [...rows];
  const waiting = rows.flatMap((row, index) => row.status === "waiting_human" ? [index] : []);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, waiting.length) }, async () => {
    while (cursor < waiting.length) {
      const index = waiting[cursor++]!;
      const row = rows[index]!;
      result[index] = { ...row, execution_state: await readState(String(row.id)) };
    }
  }));
  return result;
}
