/**
 * agentbox-sdk（TwillAI, MIT）真实实现 —— ARCHITECTURE §5/§8
 *
 * 要点：
 * - Agent 以 server 进程模式跑在沙箱内（claude-code provider，approvalMode "auto"）
 * - 事件经 SDK 控制通道回传（stream），不经沙箱网络
 * - 文件契约（harness v1）：findings → /workspace/findings.jsonl；总结 → /workspace/done.json
 *   （MVP 用文件契约代替 MCP 注入：断网/中转环境下最稳；MCP 化留作 Phase 3 优化）
 */
import { Agent, Sandbox } from "agentbox-sdk";
import type {
  AgentCommandConfig,
  AgentMcpConfig,
  AgentSkillConfig,
  AgentSubAgentConfig,
} from "agentbox-sdk";
import path from "node:path";
import type { ProvisionInput, RunHandle, SandboxRunner } from "./index.js";

// --- agentbox-sdk 0.1.501 Windows 宿主兼容性补丁 ---
// SDK 用宿主 path.join 拼沙箱内的 POSIX 路径（如 /tmp/agentbox/claude-code/.claude），
// Windows 上产出反斜杠，传进容器后路径全毁（Claude Code 报 settings.json not found）。
// 运行时补丁：join 的首参数是 POSIX 绝对路径（"/" 开头）时改用 posix.join。
// Windows 宿主路径只会以盘符或 \\ 开头，不会误判；SDK 的路径拼接全部发生在运行时。
// TODO: 向上游提 issue，修复后移除此补丁。
const origJoin = path.join.bind(path);
path.join = ((...args: string[]) =>
  args[0]?.startsWith("/") ? path.posix.join(...args) : origJoin(...args)) as typeof path.join;

/** jobId → Sandbox 注册表（isAlive/destroy 用） */
const sandboxes = new Map<string, Sandbox>();

export class AgentboxRunner implements SandboxRunner {
  async provision(input: ProvisionInput): Promise<RunHandle> {
    const sandbox = new Sandbox("local-docker", {
      image: input.image,
      workingDir: "/workspace",
      env: input.env,
      tags: { "dfh.job": input.jobId },
      provider: {
        name: `dfh-${input.jobId.slice(0, 8)}`,
        // none=彻底断网；restricted MVP 先给 bridge（agent 需访问 LLM 端点）
        // TODO(Phase 3): restricted → squid 白名单代理（§9.2）
        networkMode: input.network === "none" ? "none" : "bridge",
        autoRemove: true,
      },
    });
    await sandbox.findOrProvision();
    const id = sandbox.id ?? `unknown-${input.jobId}`;
    sandboxes.set(id, sandbox);
    return { sandboxId: id };
  }

  async destroy(handle: RunHandle): Promise<void> {
    const s = sandboxes.get(handle.sandboxId);
    sandboxes.delete(handle.sandboxId);
    await s?.delete().catch(() => {});
  }

  async isAlive(handle: RunHandle): Promise<boolean> {
    const s = sandboxes.get(handle.sandboxId);
    if (!s) return false;
    try {
      await s.run("true", { timeoutMs: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  /** 供 executor 取沙箱实例（上传种子文件 / 跑 agent / 读结果） */
  static sandboxOf(handle: RunHandle): Sandbox | undefined {
    return sandboxes.get(handle.sandboxId);
  }
}

// ---------- 真实 Agent 运行（§8 事件通道 + 文件契约） ----------

export interface RealAgentSpec {
  provider: "claude-code" | "open-code" | "codex";
  model?: string;
  env: Record<string, string>;
  prompt: string;
  /** Agent 配置下发（agentbox setup 差量上传，见 §8.1 agent_profiles） */
  skills?: AgentSkillConfig[];
  commands?: AgentCommandConfig[];
  mcps?: AgentMcpConfig[];
  subAgents?: AgentSubAgentConfig[];
  /** 种子文件：沙箱绝对路径 → 内容（如 /workspace/src/auth/login.php） */
  seedFiles?: Record<string, string>;
  /** 运行后要读回的文件 */
  resultFiles?: string[];
  /** 流式进度回调（已节流） */
  onProgress?: (message: string) => void;
  /** 全量规范化事件回调（text.delta / tool.call.* / run.* 等，未节流，供实时流转发） */
  onEvent?: (event: Record<string, unknown>) => void;
}

export interface RealAgentResult {
  text: string;
  files: Record<string, string>;
  error?: string;
}

export async function runRealAgent(handle: RunHandle, spec: RealAgentSpec): Promise<RealAgentResult> {
  const sandbox = AgentboxRunner.sandboxOf(handle);
  if (!sandbox) throw new Error(`沙箱 ${handle.sandboxId} 不在注册表（可能已被回收）`);

  // 1. 种子文件上传
  for (const [path, content] of Object.entries(spec.seedFiles ?? {})) {
    const dir = path.split("/").slice(0, -1).join("/");
    if (dir) await sandbox.run(`mkdir -p ${dir}`);
    await sandbox.uploadFile(content, path);
  }

  // 2. 起 agent（server 进程模式，权限完全开放 §16）
  // skills/commands/mcps/subAgents 随 setup() 差量上传进沙箱（动态下发，§8.1）
  const agent = new Agent(spec.provider, {
    sandbox,
    cwd: "/workspace",
    env: spec.env,
    approvalMode: "auto",
    ...(spec.skills?.length ? { skills: spec.skills } : {}),
    ...(spec.commands?.length ? { commands: spec.commands } : {}),
    ...(spec.mcps?.length ? { mcps: spec.mcps } : {}),
    ...(spec.subAgents?.length ? { subAgents: spec.subAgents } : {}),
  });

  // setup() 必须显式调用：上传 agent 配置 + 启动沙箱内 relay/server
  // （缺了会在 stream 时报 daemon-token missing）；幂等，重复调用 ≈ 一次探活
  await agent.setup();

  const run = agent.stream({
    input: spec.prompt,
    model: spec.model,
  });

  // 3. 事件流 → 全量事件回调（实时流）+ 节流进度回调（§6.2：原始流不进 events 表）
  let lastPush = 0;
  let buffer = "";
  try {
    for await (const event of run) {
      const e = event as { type?: string; delta?: string };
      spec.onEvent?.(event as unknown as Record<string, unknown>);
      if (e.type === "text.delta" && e.delta) buffer += e.delta;
      const now = Date.now();
      if (buffer.length > 0 && now - lastPush > 4000) {
        lastPush = now;
        spec.onProgress?.(buffer.slice(-200));
        buffer = "";
      }
    }
  } catch (e) {
    return { text: "", files: {}, error: e instanceof Error ? e.message : String(e) };
  }

  const result = await run.finished.catch((e: unknown) => ({
    text: "",
    error: e instanceof Error ? e.message : String(e),
  }));

  // 4. 读回结果文件
  const files: Record<string, string> = {};
  for (const path of spec.resultFiles ?? []) {
    try {
      const buf = await sandbox.downloadFile(path);
      files[path] = buf.toString("utf8");
    } catch {
      // 文件不存在 = agent 没写，容忍
    }
  }

  return {
    text: (result as { text?: string }).text ?? "",
    files,
    error: (result as { error?: string }).error,
  };
}
