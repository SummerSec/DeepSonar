import { appendFile } from "node:fs/promises";

/**
 * append-only 设备审计（#495）。只记设备控制事实，不记凭据：`token` 永不入日志。
 * 轮转交给 rig 上的日志系统（logrotate），broker 自身不做删除。
 */
export type BrokerEvent = {
  action: string;
  device_key?: string | null;
  lease_id?: string | null;
  job_id?: string | null;
  actor: string;
  outcome: string;
  detail?: Record<string, unknown>;
};

export function redactBrokerEvent(event: BrokerEvent): Record<string, unknown> {
  return {
    ts: new Date().toISOString(),
    action: event.action,
    device_key: event.device_key ?? null,
    lease_id: event.lease_id ?? null,
    job_id: event.job_id ?? null,
    actor: event.actor,
    outcome: event.outcome,
    ...(event.detail ? { detail: event.detail } : {}),
  };
}

export async function appendBrokerEvent(path: string, event: BrokerEvent): Promise<void> {
  const line = `${JSON.stringify(redactBrokerEvent(event))}\n`;
  await appendFile(path, line, { encoding: "utf8", mode: 0o600 });
}
