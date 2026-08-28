import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanupManagedResourcesOnce,
  resetResourceCleanupStateForTests,
  shouldCleanupManagedResources,
  type DesiredStateCleanupDependencies,
} from "./resource-cleanup.js";

const activeJob = "11111111-1111-4111-8111-111111111111";
const activeAttempt = "22222222-2222-4222-8222-222222222222";
const oldAttempt = "33333333-3333-4333-8333-333333333333";
const terminalJob = "44444444-4444-4444-8444-444444444444";

function dependencies(overrides: Partial<DesiredStateCleanupDependencies> = {}): DesiredStateCleanupDependencies {
  return {
    loadActiveResources: async () => [{ jobId: activeJob, attemptId: activeAttempt }],
    listContainers: async () => [
      { containerId: "active", jobId: activeJob, attemptId: activeAttempt, state: "running" },
      { containerId: "old-attempt", jobId: activeJob, attemptId: oldAttempt, state: "exited" },
      { containerId: "terminal", jobId: terminalJob, attemptId: oldAttempt, state: "exited" },
    ],
    removeContainer: async () => {},
    listVolumes: async () => [
      { volumeName: `deepsonar-assets-${activeJob}`, jobId: activeJob },
      { volumeName: `deepsonar-assets-${terminalJob}`, jobId: terminalJob },
    ],
    removeVolumeForJob: async () => {},
    ...overrides,
  };
}

test("desired-state cleanup runs for any real provider, including OpenSandbox", () => {
  assert.equal(shouldCleanupManagedResources({ agentMode: "real", provider: "opensandbox" }), true);
  assert.equal(shouldCleanupManagedResources({ agentMode: "real", provider: "local-docker" }), true);
  assert.equal(shouldCleanupManagedResources({ agentMode: "fake", provider: "opensandbox" }), false);
});

test("desired-state cleanup preserves only exact active Job/Attempt resources", async () => {
  resetResourceCleanupStateForTests();
  const removedContainers: string[] = [];
  const removedVolumes: string[] = [];
  const result = await cleanupManagedResourcesOnce(dependencies({
    removeContainer: async (containerId) => {
      removedContainers.push(containerId);
    },
    removeVolumeForJob: async (jobId) => {
      removedVolumes.push(jobId);
    },
  }));
  assert.deepEqual(removedContainers, ["old-attempt", "terminal"]);
  assert.deepEqual(removedVolumes, [terminalJob]);
  assert.deepEqual(result, {
    skipped: false,
    removedContainers: 2,
    removedVolumes: 1,
    residualContainers: 0,
    residualVolumes: 0,
    failures: 0,
  });
});

test("desired-state cleanup reports residual resources and retries them next cycle", async () => {
  resetResourceCleanupStateForTests();
  let attempts = 0;
  const deps = dependencies({
    listContainers: async () => [
      { containerId: "terminal", jobId: terminalJob, attemptId: oldAttempt, state: "exited" },
    ],
    listVolumes: async () => [],
    removeContainer: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("daemon busy");
    },
  });
  const first = await cleanupManagedResourcesOnce(deps);
  const second = await cleanupManagedResourcesOnce(deps);
  assert.equal(first.residualContainers, 1);
  assert.equal(first.failures, 1);
  assert.equal(second.removedContainers, 1);
  assert.equal(second.residualContainers, 0);
  assert.equal(attempts, 2);
});

test("desired-state cleanup is non-reentrant", async () => {
  resetResourceCleanupStateForTests();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = cleanupManagedResourcesOnce(dependencies({
    loadActiveResources: async () => {
      await blocked;
      return [];
    },
    listContainers: async () => [],
    listVolumes: async () => [],
  }));
  const overlapping = await cleanupManagedResourcesOnce(dependencies());
  assert.equal(overlapping.skipped, true);
  release();
  await first;
});
