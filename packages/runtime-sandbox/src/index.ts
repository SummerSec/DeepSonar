/**
 * runtime-adapter：调度器与沙箱之间的唯一接口（ARCHITECTURE §5）
 * 实现可替换：noop（骨架）→ agentbox-sdk local-docker → e2b/daytona 云端
 */

export interface ProvisionInput {
  jobId: string;
  image: string;
  env?: Record<string, string>;
  /** 断网（审计默认）或受限出网（验证） */
  network: "none" | "restricted";
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

export { AgentboxRunner } from "./agentbox.js";
