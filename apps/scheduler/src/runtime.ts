import {
  AgentboxRunner,
  DockerSharedAssetsVolumeManager,
  NoopRunner,
  NoopSharedAssetsVolumeManager,
  OpenSandboxRunner,
  createSdkOpenSandboxClient,
  type SandboxRunner,
  type SharedAssetsVolumeManager,
} from "@deepsonar/runtime-sandbox";
import { config } from "./config.js";

function createRealRunner(): SandboxRunner {
  if (config.runtime.provider === "opensandbox") {
    return new OpenSandboxRunner(createSdkOpenSandboxClient(config.runtime.openSandbox));
  }
  return new AgentboxRunner();
}

/**
 * 全局唯一 runner 实例（dispatcher 与 reaper 共享——沙箱注册表在实例内，
 * reaper 回收必须打到同一个实例上）
 */
export const runner: SandboxRunner =
  config.runtime.agentMode === "real" ? createRealRunner() : new NoopRunner();

export const sharedAssetsVolumeManager: SharedAssetsVolumeManager =
  config.runtime.agentMode === "real"
    ? new DockerSharedAssetsVolumeManager(config.sharedAssets.helperImage)
    : new NoopSharedAssetsVolumeManager();
