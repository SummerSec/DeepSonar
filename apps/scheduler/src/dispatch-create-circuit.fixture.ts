import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import type { sql } from "./db.js";
import { config } from "./config.js";
import { DISPATCH_CLAIM_ADVISORY_KEY } from "./core.js";
import { refreshOpenSandboxServerStatus, resetOpenSandboxServerStatusForTests } from "./opensandbox-health.js";
import { CREATE_CIRCUIT_COOLDOWN_MS, recordOpenSandboxProvisionFailure,
  resetOpenSandboxCreateCircuitForTests } from "./opensandbox-create-circuit.js";

export async function runUnlimitedCreateCircuitFixture(
  db: typeof sql, claim: () => Promise<{ id: string; probe: { canary: boolean; episode: number | null } | null }[]>,
  pendingIds: string[],
): Promise<void> {
  const runtime = { ...config.runtime };
  const sandbox = { ...config.runtime.openSandbox };
  let now = 1_000_000;
  try {
    // Controlled healthy upstream isolates the create circuit from unrelated
    // host Docker/list readiness. Job/Attempt admission remains the real SQL path.
    Object.assign(config.runtime, { agentMode: "real", provider: "opensandbox" });
    Object.assign(config.runtime.openSandbox, { kubernetes: true, apiKey: "fixture-key" });
    resetOpenSandboxServerStatusForTests();
    await refreshOpenSandboxServerStatus(async () => {}, { agentMode: "real", provider: "opensandbox",
      domain: config.runtime.openSandbox.domain, apiKey: "fixture-key" });
    resetOpenSandboxCreateCircuitForTests(() => now);
    recordOpenSandboxProvisionFailure("DOCKER::SANDBOX_START_FAILED");
    recordOpenSandboxProvisionFailure("DOCKER::SANDBOX_START_FAILED");
    now += CREATE_CIRCUIT_COOLDOWN_MS;
    const competing = (await Promise.all([claim(), claim()])).flat();
    assert.equal(competing.length, 1, "unlimited global/provision quotas admit only one recovery probe");
    assert.ok(pendingIds.includes(competing[0]!.id));
    assert.equal(competing[0]!.probe?.canary, true);
    assert.deepEqual(await claim(), [], "in-flight recovery probe occupies the independent seat");
    const blocker = await db.reserve();
    let waiting: ReturnType<typeof claim> | undefined;
    try {
      await blocker`SELECT pg_advisory_lock(hashtext(${DISPATCH_CLAIM_ADVISORY_KEY}))`;
      waiting = claim();
      const deadline = Date.now() + 5_000;
      let blocked = false;
      while (Date.now() < deadline) {
        const [row] = await db`SELECT count(*)::int AS count FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event = 'advisory'
            AND query LIKE '%pg_advisory_xact_lock%'`;
        if (Number(row!.count) > 0) { blocked = true; break; }
        await delay(10);
      }
      assert.ok(blocked, "second claim really waits on the dispatch DB lock with the old probe");
      recordOpenSandboxProvisionFailure("DOCKER::SANDBOX_START_FAILED", competing[0]!.probe);
      await db`DELETE FROM jobs WHERE id = ${competing[0]!.id}`;
    } finally {
      await blocker`SELECT pg_advisory_unlock(hashtext(${DISPATCH_CLAIM_ADVISORY_KEY}))`;
      blocker.release();
      if (waiting) assert.deepEqual(await waiting, [], "lock waiter must recheck the reopened episode after seat release");
    }
    assert.deepEqual(await claim(), [], "failed probe reopens the gate after its seat is released");
    const [remaining] = await db`SELECT count(*)::int AS count FROM jobs
      WHERE id = ANY(${pendingIds}::uuid[]) AND status = 'pending' AND claimed_at IS NULL`;
    assert.equal(remaining!.count, pendingIds.length - 1);
  } finally {
    Object.assign(config.runtime, runtime);
    Object.assign(config.runtime.openSandbox, sandbox);
    resetOpenSandboxCreateCircuitForTests();
    resetOpenSandboxServerStatusForTests();
  }
}
