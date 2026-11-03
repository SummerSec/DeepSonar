export interface AttemptLeaseOwner {
  jobId: string;
  attemptId: string;
  sandboxId: string;
}

/** A heartbeat is a short pure DB transaction; a cached alive result grants no ownership. */
export async function renewCurrentAttemptLease(
  db: typeof import("./db.js").sql,
  owner: AttemptLeaseOwner,
  ttlSec: number,
  isCurrent: () => boolean = () => true,
): Promise<boolean> {
  return db.begin(async (raw) => {
    const tx = raw as unknown as typeof db;
    const [job] = await tx<{ id: string; status: string; sandbox_id: string | null }[]>`
      SELECT id, status, sandbox_id FROM jobs WHERE id = ${owner.jobId} FOR UPDATE`;
    if (!isCurrent() || !job || job.status !== "running" || job.sandbox_id !== owner.sandboxId) return false;
    const [attempt] = await tx<{ id: string; status: string; cancel_requested: boolean; sandbox_id: string | null }[]>`
      SELECT id, status, cancel_requested, sandbox_id FROM job_attempts WHERE job_id = ${owner.jobId}
      ORDER BY attempt_no DESC LIMIT 1 FOR UPDATE`;
    if (!isCurrent() || !attempt || attempt.id !== owner.attemptId || attempt.status !== "active"
      || attempt.cancel_requested || attempt.sandbox_id !== owner.sandboxId) return false;
    const updated = await tx`UPDATE jobs
      SET lease_expires_at = clock_timestamp() + (${ttlSec} * interval '1 second'), heartbeat_at = clock_timestamp()
      WHERE id = ${owner.jobId} AND status = 'running' AND sandbox_id = ${owner.sandboxId} RETURNING id`;
    return updated.length === 1;
  });
}

/** Each run owns its stop closure. An older run never removes another registration. */
export function createAttemptLeaseRenewals(deps: {
  intervalMs: number;
  isAlive: (owner: AttemptLeaseOwner) => Promise<boolean>;
  renew: (owner: AttemptLeaseOwner, isCurrent: () => boolean) => Promise<boolean>;
  onError: (error: unknown, owner: AttemptLeaseOwner) => void;
}) {
  const registrations = new Map<string, { stop: () => void }>();
  return {
    stopAll(): void {
      for (const registration of registrations.values()) registration.stop();
    },
    start(input: AttemptLeaseOwner): () => void {
      const owner = { ...input };
      const key = JSON.stringify([owner.jobId, owner.attemptId, owner.sandboxId]);
      registrations.get(key)?.stop();
      let timer: ReturnType<typeof setInterval>;
      let busy = false;
      const registration = {
        stop() {
          clearInterval(timer);
          if (registrations.get(key) === registration) registrations.delete(key);
        },
      };
      const isCurrent = () => registrations.get(key) === registration;
      const tick = async () => {
        if (!isCurrent() || busy) return;
        busy = true;
        try {
          const alive = await deps.isAlive(owner).catch(() => false);
          if (!alive || !isCurrent()) return;
          if (!await deps.renew(owner, isCurrent)) registration.stop();
        } catch (error) {
          deps.onError(error, owner);
        } finally {
          busy = false;
        }
      };
      registrations.set(key, registration);
      timer = setInterval(() => { void tick(); }, deps.intervalMs);
      return registration.stop;
    },
  };
}
