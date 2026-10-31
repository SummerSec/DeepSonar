import { appendFile } from 'node:fs/promises';

/** Only fixed, allowlisted observations from isolated tests; never payloads or credentials. */
export async function recordPlanReplay(mode: string, id: string, observed: Record<string, unknown>): Promise<void> {
  const target=process.env.PLAN_REPLAY_OUTPUT;
  if (!target) return;
  await appendFile(target,JSON.stringify({mode,id,observed})+'\n',{encoding:'utf8',mode:0o600});
}
