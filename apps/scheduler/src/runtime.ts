import {
  DockerSharedAssetsVolumeManager,
  KubernetesSharedAssetsVolumeManager,
  NoopRunner,
  NoopSharedAssetsVolumeManager,
  OpenSandboxRunner,
  bindGatewayProxyToKubernetesService,
  bindGatewayProxyToOpenSandboxNetwork,
  createSdkOpenSandboxClient,
  readOpenSandboxPin,
  type SandboxRunner,
  type SharedAssetsVolumeManager,
} from "@deepsonar/runtime-sandbox";
import { config } from "./config.js";

function kubernetesSharedAssetsManager(): SharedAssetsVolumeManager {
  const kubeconfig = process.env.OPEN_SANDBOX_KUBECONFIG?.trim() || process.env.KUBECONFIG?.trim();
  if (!kubeconfig) {
    throw new Error("OPEN_SANDBOX_KUBECONFIG 或 KUBECONFIG 在 OPEN_SANDBOX_KUBERNETES=1 时必填");
  }
  return new KubernetesSharedAssetsVolumeManager({
    helperImage: config.sharedAssets.helperImage,
    kubeconfig,
    namespace: process.env.OPEN_SANDBOX_K8S_NAMESPACE?.trim() || "deepsonar-opensandbox",
  });
}

async function createRealRunner(): Promise<SandboxRunner> {
  if (config.runtime.provider !== "opensandbox") {
    throw new Error(`SANDBOX_PROVIDER=${config.runtime.provider} 已移除；real 只支持 opensandbox`);
  }
  const pin = readOpenSandboxPin({
    sdk: config.runtime.openSandbox.sdkVersion || undefined,
    serverImage: config.runtime.openSandbox.serverImage || undefined,
    execdImage: config.runtime.openSandbox.execdImage || undefined,
    egressImage: config.runtime.openSandbox.egressImage || undefined,
  });
  return new OpenSandboxRunner(createSdkOpenSandboxClient({
    domain: config.runtime.openSandbox.domain,
    apiKey: config.runtime.openSandbox.apiKey,
    protocol: config.runtime.openSandbox.protocol,
    useServerProxy: config.runtime.openSandbox.useServerProxy,
    pin,
  }), {
    bind: config.runtime.openSandbox.kubernetes
      ? bindGatewayProxyToKubernetesService
      : bindGatewayProxyToOpenSandboxNetwork,
  }, {
    kubernetesResources: config.runtime.openSandbox.kubernetes,
  });
}

/**
 * 全局唯一 runner 实例（dispatcher 与 reaper 共享——沙箱注册表在实例内，
 * reaper 回收必须打到同一个实例上）
 */
export const runner: SandboxRunner =
  config.runtime.agentMode === "real" ? await createRealRunner() : new NoopRunner();

export const sharedAssetsVolumeManager: SharedAssetsVolumeManager =
  config.runtime.agentMode !== "real"
    ? new NoopSharedAssetsVolumeManager()
    : config.runtime.openSandbox.kubernetes
      ? kubernetesSharedAssetsManager()
      : new DockerSharedAssetsVolumeManager(config.sharedAssets.helperImage);
