/**
 * agentbox-sdk（TwillAI, MIT）封装 —— Phase 1 末/Phase 2 接入真实沙箱
 * 关键能力：local-docker provider、networkMode 断网、server 进程模式跑 claude-code、
 * 事件经 SDK 控制通道回传（不经沙箱网络，见 ARCHITECTURE §8）
 */
import type { ProvisionInput, RunHandle, SandboxRunner } from "./index.js";

export class AgentboxRunner implements SandboxRunner {
  async provision(input: ProvisionInput): Promise<RunHandle> {
    // TODO(Phase 2): new Sandbox("local-docker", { image, env, provider: { networkMode: input.network === "none" ? "none" : "bridge" } })
    //   await sandbox.findOrProvision();
    throw new Error("AgentboxRunner 尚未接入（Phase 2 任务）");
  }
  async destroy(_handle: RunHandle): Promise<void> {}
  async isAlive(_handle: RunHandle): Promise<boolean> {
    return false;
  }
}
