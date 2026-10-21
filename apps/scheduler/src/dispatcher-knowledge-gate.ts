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
