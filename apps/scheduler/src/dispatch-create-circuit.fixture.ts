import assert from "node:assert/strict";
import type { sql } from "./db.js";
import { config } from "./config.js";
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
    recordOpenSandboxProvisionFailure("DOCKER::SANDBOX_START_FAILED", competing[0]!.probe);
    await db`DELETE FROM jobs WHERE id = ${competing[0]!.id}`;
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
