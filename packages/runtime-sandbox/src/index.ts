/**
 * runtime-adapter：调度器与沙箱之间的唯一接口（ARCHITECTURE §5）
 * 实现可替换：noop（骨架）→ agentbox-sdk local-docker → e2b/daytona 云端
 */

export interface ProvisionInput {
  jobId: string;
  image: string;
  env?: Record<string, string>;
  /** none=完全断网；restricted=仅平台必要通道；egress=允许 Worker 自主访问外网。 */
  network: "none" | "restricted" | "egress";
  /** restricted 模式由固定目标 sidecar 代理的调度器模型 Gateway。 */
  gatewayUpstreamUrl?: string;
  /** 市场准入时冻结的镜像契约与工具清单摘要；provision 后再次复核。 */
  expectedContract?: string;
  expectedToolsManifestSha256?: string | null;
  /** 沙箱资源/权限硬限制（SEC-03）；缺省由实现给安全默认 */
  limits?: SandboxLimits;
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

export interface SandboxRunner {
  provision(input: ProvisionInput): Promise<RunHandle>;
  destroy(handle: RunHandle): Promise<void>;
  /** Reaper 探测：控制通道是否存活（§3.3 lease 依据） */
  isAlive(handle: RunHandle): Promise<boolean>;
}

/** Phase 0 骨架：不起真实沙箱，只走状态机 */
export class NoopRunner implements SandboxRunner {
  async provision(input: ProvisionInput): Promise<RunHandle> {
    return { sandboxId: `noop-${input.jobId}` };
  }
  async destroy(_handle: RunHandle): Promise<void> {}
  async isAlive(_handle: RunHandle): Promise<boolean> {
    return true;
  }
}

export {
  AgentboxRunner,
  createSemanticToolState,
  discardPendingSemanticTools,
  forceRemoveContainer,
  listDeepSonarContainers,
  materializationPathCollisions,
  normalizeRuntimeErrorDetails,
  parseRuntimeLine,
  runRealAgent,
} from "./agentbox.js";
export { RuntimeImageContractError } from "./agentbox.js";
export type { DeepSonarContainer, RealAgentResult, RealAgentSpec, ReasoningEffort, RuntimeErrorDetails } from "./agentbox.js";
export type { SemanticToolState } from "./agentbox.js";
export { CLI_SESSION_ADAPTERS } from "./cli-session-adapters.js";
export type {
  AgentCliSessionAdapter,
  SessionArtifact,
  SessionBundle,
  SupportedAgentCli,
} from "./cli-session-adapters.js";
