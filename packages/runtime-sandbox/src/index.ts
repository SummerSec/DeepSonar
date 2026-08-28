/**
 * runtime-adapter：调度器与沙箱之间的唯一接口（ARCHITECTURE §5 / #162）
 * 实现可替换：noop（骨架）→ OpenSandbox（real 默认）。
 */

import type { RuntimeHost, RuntimeResource } from "./runtime-host.js";

export interface ProvisionInput {
  jobId: string;
  /** Scheduler 持久 Attempt 的稳定标识，所有外部资源必须带上该标签。 */
  attemptId: string;
  /** 仅允许 Scheduler 生成的低基数资源标签。 */
  resourceLabels?: Record<string, string>;
  image: string;
  env?: Record<string, string>;
  /** Scheduler-owned per-Job volume mounted read-only at /workspace/.deepsonar/shared. */
  sharedAssetsMount?: SharedAssetsMount;
  /** none=完全断网；restricted=仅平台必要通道；egress=允许 Worker 自主访问外网。 */
  network: "none" | "restricted" | "egress";
  /** restricted 模式由固定目标 sidecar 代理的调度器模型 Gateway。 */
  gatewayUpstreamUrl?: string;
  /** 市场准入时冻结的镜像契约与工具清单摘要；provision 后再次复核。 */
  expectedContract?: string;
  expectedToolsManifestSha256?: string | null;
  /** 沙箱资源/权限硬限制（SEC-03）；缺省由实现给安全默认 */
  limits?: SandboxLimits;
  /**
   * Kubernetes ResourceName 不接受 Docker 专有的 `pids`。
   * 仍要求冻结 pidsLimit；只是不要写进 Pod resources。
   */
  kubernetesResources?: boolean;
  /** provision 超时/取消时必须中止外部资源创建。 */
  signal?: AbortSignal;
}

export interface SharedAssetsMount {
  /** Must be an opaque Docker named volume created by the trusted host. */
  volumeName: string;
}

export interface SandboxLimits {
  /** CPU 核数（NanoCpus） */
  cpu?: number;
  /** 内存上限 MiB */
  memoryMiB?: number;
  /** PID 数上限（防 fork 炸弹） */
  pidsLimit?: number;
  /** 去掉全部 Linux capability（默认 true） */
  capDropAll?: boolean;
  /** no-new-privileges（默认 true） */
  noNewPrivileges?: boolean;
}

export interface RunHandle {
  sandboxId: string;
}

export interface TerminalOpenInput {
  cols: number;
  rows: number;
}

export interface SandboxTerminalSession {
  id: string;
  output: AsyncIterable<string>;
  write(data: string): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  close(): Promise<void>;
}

export interface SandboxRunner {
  provision(input: ProvisionInput): Promise<RunHandle>;
  /** 取消尚未返回句柄的 provision，必须销毁已创建或正在创建的资源。 */
  cancelProvision(input: { jobId: string; attemptId: string }): Promise<void>;
  destroy(handle: RunHandle): Promise<void>;
  /** Reaper 探测：控制通道是否存活（§3.3 lease 依据） */
  isAlive(handle: RunHandle): Promise<boolean>;
  /** Optional, provider-backed PTY in the existing Job sandbox. */
  openTerminal(handle: RunHandle, input: TerminalOpenInput): Promise<SandboxTerminalSession>;
  /** Sync cache only. Missing after process restart until ensureHost reconnects. */
  hostOf(handle: RunHandle): RuntimeHost | undefined;
  /** Reconnect a persisted provider resource so Scheduler restart can resume exec/PTY. */
  ensureHost(handle: RunHandle): Promise<RuntimeHost>;
  listResources(filter?: { jobId?: string; attemptId?: string }): Promise<RuntimeResource[]>;
  destroyResource(resource: RuntimeResource): Promise<void>;
}

/** Phase 0 骨架：不起真实沙箱，只走状态机 */
export class NoopRunner implements SandboxRunner {
  async provision(input: ProvisionInput): Promise<RunHandle> {
    if (input.signal?.aborted) throw new Error("provision 已取消");
    return { sandboxId: `noop-${input.jobId}` };
  }
  async cancelProvision(): Promise<void> {}
  async destroy(_handle: RunHandle): Promise<void> {}
  async isAlive(_handle: RunHandle): Promise<boolean> {
    return true;
  }
  async openTerminal(): Promise<SandboxTerminalSession> {
    throw new Error("TERMINAL_PROVIDER_UNSUPPORTED");
  }
  hostOf(): RuntimeHost | undefined {
    return undefined;
  }
  async ensureHost(): Promise<RuntimeHost> {
    throw new Error("NOOP_HOST_UNSUPPORTED");
  }
  async listResources(): Promise<RuntimeResource[]> {
    return [];
  }
  async destroyResource(): Promise<void> {}
}

export type {
  RuntimeAsyncRunOptions,
  RuntimeCommandResult,
  RuntimeHost,
  RuntimeProcess,
  RuntimeProcessChunk,
  RuntimeResource,
  RuntimeRunOptions,
} from "./runtime-host.js";
export { assertWorkspaceWritePath, shellQuote } from "./runtime-host.js";
export type {
  AgentCommandConfig,
  AgentMcpConfig,
  AgentSkillConfig,
  AgentSubAgentConfig,
} from "./runtime-agent-config.js";
export {
  OpenSandboxRunner,
  awaitProvisionSession,
  createSdkOpenSandboxClient,
  evaluateOpenSandboxAlive,
  mapOpenSandboxCreateInput,
  mapOpenSandboxNetworkPolicy,
  requireOpenSandboxLimits,
} from "./opensandbox.js";
export type { OpenSandboxGatewayBinder, OpenSandboxRunnerOptions } from "./opensandbox.js";
export {
  OPENSANDBOX_POC_ADAPTER_IDS,
  OPENSANDBOX_POC_CLI_IDS,
  OPENSANDBOX_POC_CONTRACT,
  OPENSANDBOX_POC_IMAGE,
  OPENSANDBOX_POC_REQUIRED_IMAGE_KEYS,
  isOpenSandboxCliMissing,
  listOfficialOpenSandboxRuntimeImages,
  runOpenSandboxArchPoc,
  runOpenSandboxAssetsPoc,
  runOpenSandboxCliLaunchPoc,
  runOpenSandboxCancelPoc,
  runOpenSandboxContractFailPoc,
  runOpenSandboxHostPoc,
  runOpenSandboxImageContractPoc,
  runOpenSandboxOfficialImagesPoc,
  runOpenSandboxInfrastructurePoc,
  runOpenSandboxRecoveryPoc,
  runOpenSandboxRestrictedPoc,
  runOpenSandboxRetryPoc,
  shouldRunOpenSandboxPoc,
} from "./opensandbox-poc.js";
export {
  OPENSANDBOX_K8S_NAMESPACE,
  OPENSANDBOX_KATA_RUNTIME_CLASS,
  findKataWorkload,
  probeKataCluster,
  runOpenSandboxK8sPoc,
  shouldRunOpenSandboxK8sPoc,
} from "./opensandbox-k8s-poc.js";
export {
  runOpenSandboxK8sAssetsPoc,
  sharedAssetsClaimName,
  shouldRunOpenSandboxK8sAssetsPoc,
} from "./opensandbox-k8s-assets-poc.js";
export {
  AGENT_SANDBOX_CRD,
  OPENSANDBOX_GVISOR_RUNSC_URL,
  OPENSANDBOX_GVISOR_RUNSC_VERSION,
  readAgentSandboxCrd,
  readGvisorNatProbe,
  runOpenSandboxGvisorPoc,
  shouldRunOpenSandboxGvisorPoc,
} from "./opensandbox-gvisor-poc.js";
export {
  OPENSANDBOX_EGRESS_IMAGE,
  OPENSANDBOX_EXECD_IMAGE,
  OPENSANDBOX_PIN_SCHEMA,
  OPENSANDBOX_SDK_VERSION,
  OPENSANDBOX_SERVER_IMAGE,
  assertOpenSandboxImmutableRef,
  assertOpenSandboxSdkVersion,
  readOpenSandboxPin,
} from "./opensandbox-version.js";
export type { OpenSandboxPin } from "./opensandbox-version.js";
export type { OpenSandboxClient, OpenSandboxConnection, OpenSandboxSession } from "./opensandbox.js";
export {
  CONTAINER_REMOVE_MAX_ATTEMPTS,
  CONTAINER_REMOVE_RETRY_BASE_DELAY_MS,
  CONTAINER_REMOVE_TIMEOUT_MS,
  forceRemoveContainer,
  listDeepSonarContainers,
  parseDeepSonarContainerRows,
  readDockerWorkspaceFile,
  removeContainerWithRetry,
  writeDockerHumanInboxFile,
  isDeepsonarGatewayNetwork,
  isDeepsonarRestrictedNetwork,
} from "./runtime-docker.js";
export {
  cleanupUnhealthyManagedGateway,
  DEFAULT_GATEWAY_CREATE_TIMEOUT_MS,
  gatewayCreateTimeoutMs,
  gatewayProxyReuseAction,
  bindGatewayProxyToOpenSandboxNetwork,
  preheatManagedGateway,
  resetManagedGatewayStateForTests,
  shouldRemoveGatewayLeftover,
} from "./runtime-gateway.js";
export {
  bindGatewayProxyToKubernetesService,
  gatewayServiceManifest,
  readServiceClusterIP,
} from "./kubernetes-gateway.js";
export {
  DEEPSONAR_GATEWAY_PROXY_HOST,
  HUMAN_INBOX_WRITER_SCRIPT,
  RuntimeImageContractError,
  SHARED_ASSETS_JOB_LABEL,
  SHARED_ASSETS_MOUNT_PATH,
  SHARED_ASSETS_VOLUME_LABEL,
  WORKSPACE_RESERVED_ROOTS,
  assertReadableWorkspacePath,
  assertSharedAssetsContainerMount,
  assertSharedAssetsVolumeOwnership,
  bindProvisionAbortSignal,
  buildTerminalShellCommand,
  parseHumanInboxWorkspacePath,
  parseToolManifest,
  sharedAssetsVolumeBinds,
  terminalShellCommand,
  writeTerminalInput,
} from "./runtime-shared.js";
export {
  createSemanticToolState,
  discardPendingSemanticTools,
  materializationPathCollisions,
  normalizeRuntimeErrorDetails,
  parseRuntimeLine,
  redactRuntimeSecrets,
  runRealAgent,
  runtimeCliEnv,
  skillMaterializationPath,
} from "./runtime-agent.js";
export type { DeepSonarContainer } from "./runtime-docker.js";
export type { RealAgentResult, RealAgentSpec, ReasoningEffort, RuntimeErrorDetails, SemanticToolState } from "./runtime-agent.js";
export { DEFAULT_SHARED_ASSETS_HELPER_IMAGE, DockerSharedAssetsVolumeManager, NoopSharedAssetsVolumeManager, managedSharedAssetsVolumeName } from "./shared-assets-volume.js";
export type { SharedAssetsVolumeManager, SharedAssetVolumeFile } from "./shared-assets-volume.js";
export { KubernetesSharedAssetsVolumeManager, readDefaultStorageClass } from "./kubernetes-shared-assets-volume.js";
export { CLI_SESSION_ADAPTERS } from "./cli-session-adapters.js";
export type {
  AgentCliSessionAdapter,
  SessionArtifact,
  SessionBundle,
  SupportedAgentCli,
} from "./cli-session-adapters.js";
export {
  AGENT_CLI_RUNTIME_ADAPTERS,
  CONTROL_RUNTIME_CAPABILITIES,
  PiJsonlFramer,
  applyRuntimeOutput,
  applyRuntimeOutputText,
  parsePiJsonlRecord,
  REQUIRED_RUNTIME_CAPABILITIES,
  freezeAgentCliRuntime,
  getAgentCliRuntimeAdapter,
  requireAgentCliRuntimeAdapter,
} from "./runtime-adapters.js";
export type {
  AgentCliCapabilities,
  AgentCliId,
  AgentCliRuntimeSnapshot,
  AdapterRuntimeState,
  AdapterResumeContext,
  AdapterStartContext,
  RuntimeAdapter,
} from "./runtime-adapters.js";
export {
  CONTEXT_CONTRACT_VERSION,
  CONTEXT_MAX_COMPACTIONS,
  CONTEXT_MAX_EVENT_IDS,
  CONTEXT_MAX_JSON_BYTES,
  CONTEXT_MAX_TRANSFORMS,
  appendContextTransform,
  applyContextCompactedEvent,
  assertContextResume,
  contextCompactionEventFromRuntime,
  contextDigest,
  contextIdentity,
  contextTextDigest,
  createContextState,
  markContextCompactionUnobservable,
  stableContextJson,
  validateContextResume,
  validateContextState,
} from "./context-contract.js";
export type {
  ContextBoundary,
  ContextBudget,
  ContextCompactionEvent,
  ContextCompactionStatus,
  ContextIdentity,
  ContextObservation,
  ContextOmission,
  ContextResumeMatch,
  ContextResumeMismatch,
  ContextSource,
  ContextState,
  ContextTransformManifest,
  ContextTransformStage,
} from "./context-contract.js";
