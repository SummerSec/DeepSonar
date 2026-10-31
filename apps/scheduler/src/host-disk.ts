import { statfs } from "node:fs/promises";
import { config } from "./config.js";
import { inc, setGauge } from "./metrics.js";

export type HostDiskPressureLevel = "ok" | "warning" | "error" | "unknown";

export interface HostDiskPressureStatus {
  level: HostDiskPressureLevel;
  path: string;
  usedPercent: number | null;
  warningPercent: number;
  errorPercent: number;
  checkedAt: string | null;
  error: string | null;
}

type StatFs = (path: string, options: { bigint: true }) => Promise<{
  blocks: bigint;
  bavail: bigint;
}>;

let current: HostDiskPressureStatus = {
  level: "unknown",
  path: config.hostDisk.path,
  usedPercent: null,
  warningPercent: config.hostDisk.warningPercent,
  errorPercent: config.hostDisk.errorPercent,
  checkedAt: null,
  error: "not_checked",
};
let refreshRunning: Promise<HostDiskPressureStatus> | null = null;

export function hostDiskPressureStatus(): HostDiskPressureStatus {
  return { ...current };
}

export function hostDiskAllowsDispatch(status: HostDiskPressureStatus = current): boolean {
  return status.level === "ok" || status.level === "warning";
}

export function shouldNotifyDiskRecovery(
  previous: HostDiskPressureStatus,
  next: HostDiskPressureStatus,
): boolean {
  return !hostDiskAllowsDispatch(previous) && hostDiskAllowsDispatch(next);
}

export async function refreshHostDiskPressure(
  readStatFs: StatFs = statfs as StatFs,
): Promise<HostDiskPressureStatus> {
  if (refreshRunning) return refreshRunning;
  refreshRunning = (async () => {
    const checkedAt = new Date().toISOString();
    try {
      const stats = await readStatFs(config.hostDisk.path, { bigint: true });
      if (stats.blocks <= 0n || stats.bavail < 0n || stats.bavail > stats.blocks) {
        throw new Error("invalid statfs capacity");
      }
      const usedBasisPoints = Number(((stats.blocks - stats.bavail) * 10_000n) / stats.blocks);
      const usedPercent = usedBasisPoints / 100;
      const level: HostDiskPressureLevel = usedPercent >= config.hostDisk.errorPercent
        ? "error"
        : usedPercent >= config.hostDisk.warningPercent
          ? "warning"
          : "ok";
      current = {
        level,
        path: config.hostDisk.path,
        usedPercent,
        warningPercent: config.hostDisk.warningPercent,
        errorPercent: config.hostDisk.errorPercent,
        checkedAt,
        error: null,
      };
      setGauge("deepsonar_host_disk_used_percent", usedPercent);
      setGauge("deepsonar_host_disk_pressure", level === "error" ? 2 : level === "warning" ? 1 : 0);
    } catch (error) {
      inc("deepsonar_host_disk_check_failures_total");
      current = {
        level: "unknown",
        path: config.hostDisk.path,
        usedPercent: null,
        warningPercent: config.hostDisk.warningPercent,
        errorPercent: config.hostDisk.errorPercent,
        checkedAt,
        error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
      };
      setGauge("deepsonar_host_disk_pressure", 2);
    }
    return hostDiskPressureStatus();
  })().finally(() => {
    refreshRunning = null;
  });
  return refreshRunning;
}

export function startHostDiskMonitor(onRecovered: () => void): () => void {
  let running = false;
  const check = () => {
    if (running) return;
    running = true;
    const previous = hostDiskPressureStatus();
    void refreshHostDiskPressure()
      .then((status) => {
        if (shouldNotifyDiskRecovery(previous, status)) {
          console.warn(`[host-disk] pressure recovered at ${status.usedPercent?.toFixed(2)}%; waking dispatcher`);
          onRecovered();
        } else if (status.level === "error") {
          console.error(`[host-disk] HOST_DISK_PRESSURE ${status.usedPercent?.toFixed(2)}% at ${status.path}`);
        } else if (status.level === "warning") {
          console.warn(`[host-disk] warning ${status.usedPercent?.toFixed(2)}% at ${status.path}`);
        }
      })
      .catch((error) => console.error("[host-disk]", error))
      .finally(() => {
        running = false;
      });
  };
  const timer = setInterval(check, config.hostDisk.checkIntervalSec * 1000);
  return () => clearInterval(timer);
}

export function setHostDiskPressureStatusForTests(status: HostDiskPressureStatus): void {
  current = { ...status };
}
