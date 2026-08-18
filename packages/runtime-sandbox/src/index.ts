/**
 * runtime-adapter：调度器与沙箱之间的唯一接口（ARCHITECTURE §5）
 * 实现可替换：noop（骨架）→ agentbox-sdk local-docker → e2b/daytona 云端
 */

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
  cancelProvision?(input: { jobId: string; attemptId: string }): Promise<void>;
  destroy(handle: RunHandle): Promise<void>;
  /** Reaper 探测：控制通道是否存活（§3.3 lease 依据） */
  isAlive(handle: RunHandle): Promise<boolean>;
  /** Optional, provider-backed PTY in the existing Job sandbox. */
  openTerminal?(handle: RunHandle, input: TerminalOpenInput): Promise<SandboxTerminalSession>;
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
}

export {
  AgentboxRunner,
  cleanupUnhealthyManagedGateway,
  createSemanticToolState,
  CONTAINER_REMOVE_MAX_ATTEMPTS,
  CONTAINER_REMOVE_RETRY_BASE_DELAY_MS,
  CONTAINER_REMOVE_TIMEOUT_MS,
  DEFAULT_GATEWAY_CREATE_TIMEOUT_MS,
  discardPendingSemanticTools,
  forceRemoveContainer,
  gatewayCreateTimeoutMs,
  gatewayProxyReuseAction,
  listDeepSonarContainers,
  materializationPathCollisions,
  normalizeRuntimeErrorDetails,
  parseDeepSonarContainerRows,
  preheatManagedGateway,
  removeContainerWithRetry,
  redactRuntimeSecrets,
  parseRuntimeLine,
  resetManagedGatewayStateForTests,
  runRealAgent,
  shouldRemoveGatewayLeftover,
  assertSharedAssetsContainerMount,
  assertSharedAssetsVolumeOwnership,
  isDeepsonarGatewayNetwork,
  isDeepsonarRestrictedNetwork,
  SHARED_ASSETS_MOUNT_PATH,
  SHARED_ASSETS_JOB_LABEL,
  SHARED_ASSETS_VOLUME_LABEL,
  sharedAssetsVolumeBinds,
} from "./agentbox.js";
export { RuntimeImageContractError } from "./agentbox.js";
export type { DeepSonarContainer, RealAgentResult, RealAgentSpec, ReasoningEffort, RuntimeErrorDetails } from "./agentbox.js";
export type { SemanticToolState } from "./agentbox.js";
export { DEFAULT_SHARED_ASSETS_HELPER_IMAGE, DockerSharedAssetsVolumeManager, NoopSharedAssetsVolumeManager } from "./shared-assets-volume.js";
export type { SharedAssetsVolumeManager, SharedAssetVolumeFile } from "./shared-assets-volume.js";
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
