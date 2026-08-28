import {
  type DeepSonarContainer,
  type SharedAssetsVolumeManager,
} from "@deepsonar/runtime-sandbox";
import { sql } from "./db.js";
import { inc, setGauge } from "./metrics.js";
import { runner, sharedAssetsVolumeManager } from "./runtime.js";

const ACTIVE_JOB_STATUSES = ["claimed", "provisioning", "running", "waiting_human"] as const;

export interface ManagedVolume {
  volumeName: string;
  jobId: string;
  createdAt?: string;
}

export interface DesiredStateCleanupDependencies {
  loadActiveResources: () => Promise<Array<{ jobId: string; attemptId: string | null }>>;
  listContainers: () => Promise<DeepSonarContainer[]>;
  removeContainer: (containerId: string) => Promise<void>;
  listVolumes: () => Promise<ManagedVolume[]>;
  removeVolumeForJob: (jobId: string) => Promise<void>;
}

export interface DesiredStateCleanupResult {
  skipped: boolean;
  removedContainers: number;
  removedVolumes: number;
  residualContainers: number;
  residualVolumes: number;
  failures: number;
}

export function shouldCleanupManagedResources(runtime: { agentMode: string; provider: string }): boolean {
  return runtime.agentMode === "real";
}

function defaultDependencies(volumeManager: SharedAssetsVolumeManager): DesiredStateCleanupDependencies {
  return {
    loadActiveResources: async () => {
      const rows = await sql<Array<{ job_id: string; attempt_id: string | null }>>`
        SELECT j.id AS job_id, a.id AS attempt_id
        FROM jobs j
        LEFT JOIN job_attempts a ON a.job_id = j.id AND a.status = 'active'
        WHERE j.status = ANY(${[...ACTIVE_JOB_STATUSES]})`;
      return rows.map((row) => ({
        jobId: String(row.job_id).toLowerCase(),
        attemptId: row.attempt_id ? String(row.attempt_id).toLowerCase() : null,
      }));
    },
    listContainers: async () => (await runner.listResources()).map((resource) => ({
      containerId: resource.resourceId,
      jobId: resource.jobId,
      attemptId: resource.attemptId,
      state: resource.state ?? "",
    })),
    removeContainer: (containerId) => runner.destroyResource({ resourceId: containerId, jobId: "", attemptId: "" }),
    listVolumes: () => volumeManager.listManaged(),
    removeVolumeForJob: (jobId) => volumeManager.removeForJob(jobId),
  };
}

let cleanupRunning = false;
let consecutiveFailures = 0;

/**
 * DB Job/Attempt state is desired state; exact managed labels/names are observed state.
 * No prune or prefix-only container ownership inference is permitted here.
 */
export async function cleanupManagedResourcesOnce(
  dependencies: DesiredStateCleanupDependencies = defaultDependencies(sharedAssetsVolumeManager),
): Promise<DesiredStateCleanupResult> {
  if (cleanupRunning) {
    return {
      skipped: true,
      removedContainers: 0,
      removedVolumes: 0,
      residualContainers: 0,
      residualVolumes: 0,
      failures: 0,
    };
  }
  cleanupRunning = true;
  try {
    const active = await dependencies.loadActiveResources();
    const activeJobIds = new Set(active.map((row) => row.jobId));
    const activeAttempts = new Set(
      active
        .filter((row): row is { jobId: string; attemptId: string } => Boolean(row.attemptId))
        .map((row) => `${row.jobId}:${row.attemptId}`),
    );
    const [containers, volumes] = await Promise.all([
      dependencies.listContainers(),
      dependencies.listVolumes(),
    ]);
    const orphanContainers = containers.filter(
      (container) => !activeAttempts.has(`${container.jobId.toLowerCase()}:${container.attemptId.toLowerCase()}`),
    );
    const orphanVolumes = volumes.filter((volume) => !activeJobIds.has(volume.jobId.toLowerCase()));

    let removedContainers = 0;
    let removedVolumes = 0;
    let containerFailures = 0;
    let volumeFailures = 0;
    for (const container of orphanContainers) {
      try {
        await dependencies.removeContainer(container.containerId);
        removedContainers += 1;
      } catch (error) {
        containerFailures += 1;
        inc("deepsonar_sandbox_cleanup_failed_total");
        inc("deepsonar_desired_state_cleanup_failures_total", { resource: "container" });
        console.error(
          `[cleanup] container removal failed ${container.containerId}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
    for (const volume of orphanVolumes) {
      try {
        await dependencies.removeVolumeForJob(volume.jobId);
        removedVolumes += 1;
      } catch (error) {
        volumeFailures += 1;
        inc("deepsonar_shared_assets_cleanup_failed_total");
        inc("deepsonar_desired_state_cleanup_failures_total", { resource: "volume" });
        console.error(
          `[cleanup] volume removal failed ${volume.volumeName}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }

    const failures = containerFailures + volumeFailures;
    consecutiveFailures = failures > 0 ? consecutiveFailures + 1 : 0;
    setGauge("deepsonar_cleanup_residual_containers", containerFailures);
    setGauge("deepsonar_cleanup_residual_volumes", volumeFailures);
    setGauge("deepsonar_cleanup_consecutive_failures", consecutiveFailures);
    return {
      skipped: false,
      removedContainers,
      removedVolumes,
      residualContainers: containerFailures,
      residualVolumes: volumeFailures,
      failures,
    };
  } catch (error) {
    consecutiveFailures += 1;
    inc("deepsonar_desired_state_cleanup_failures_total", { resource: "reconcile" });
    setGauge("deepsonar_cleanup_consecutive_failures", consecutiveFailures);
    throw error;
  } finally {
    cleanupRunning = false;
  }
}

export function resetResourceCleanupStateForTests(): void {
  cleanupRunning = false;
  consecutiveFailures = 0;
}
