import {
  AgentboxRunner,
  DockerSharedAssetsVolumeManager,
  NoopRunner,
  NoopSharedAssetsVolumeManager,
  type SandboxRunner,
  type SharedAssetsVolumeManager,
} from "@deepsonar/runtime-sandbox";
import { config } from "./config.js";

/**
 * 全局唯一 runner 实例（dispatcher 与 reaper 共享——沙箱注册表在实例内，
 * reaper 回收必须打到同一个实例上）
 */
export const runner: SandboxRunner =
  config.runtime.agentMode === "real" ? new AgentboxRunner() : new NoopRunner();

export const sharedAssetsVolumeManager: SharedAssetsVolumeManager =
  config.runtime.agentMode === "real"
    ? new DockerSharedAssetsVolumeManager(config.sharedAssets.helperImage)
    : new NoopSharedAssetsVolumeManager();
