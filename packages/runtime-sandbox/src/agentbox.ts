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
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { ProvisionInput, RunHandle, SandboxRunner } from "./index.js";

const execFileP = promisify(execFile);

/** docker CLI 兜底（进程重启后内存注册表丢失，按持久化 sandboxId 直查引擎） */
async function docker(...args: string[]): Promise<string> {
  const { stdout } = await execFileP("docker", args, { timeout: 15000 });
  return stdout.trim();
}

// --- agentbox-sdk 0.1.501 Windows 宿主兼容性补丁 ---
// SDK 用宿主 path.join 拼沙箱内的 POSIX 路径（如 /tmp/agentbox/claude-code/.claude），
// Windows 上产出反斜杠，传进容器后路径全毁（Claude Code 报 settings.json not found）。
// 运行时补丁：join 的首参数是 POSIX 绝对路径（"/" 开头）时改用 posix.join。
// Windows 宿主路径只会以盘符或 \\ 开头，不会误判；SDK 的路径拼接全部发生在运行时。
// TODO: 向上游提 issue，修复后移除此补丁。
const origJoin = path.join.bind(path);
path.join = ((...args: string[]) =>
  args[0]?.startsWith("/") ? path.posix.join(...args) : origJoin(...args)) as typeof path.join;

/** jobId → Sandbox 注册表（isAlive/destroy 用；进程重启即丢，靠 docker CLI 兜底） */
const sandboxes = new Map<string, Sandbox>();

/** dockerode createContainer 调用签名（只需要我们注入 HostConfig 的部分） */
interface CreateContainerOptions {
  Labels?: Record<string, string>;
  HostConfig?: Record<string, unknown>;
}

/**
 * SEC-03 容器硬限制：agentbox-sdk 只透传 cpu/memory，PidsLimit/CapDrop/SecurityOpt
 * 需要包住 dockerode 的 createContainer 注入。按实例包装（不碰全局原型），
 * 只对带 dfh.job 标签的容器生效，SDK 升级也不影响其他调用方。
 * TODO(SEC-03 余项)：non-root 运行 + read_only_rootfs 需镜像侧配合（/workspace、/tmp 可写卷），留待 OPS。
 */
function hardenCreateContainer(sandbox: Sandbox, limits: ProvisionInput["limits"]): void {
  const adapter = (sandbox as unknown as { adapter?: { client?: {
    createContainer: (opts: CreateContainerOptions) => Promise<unknown>;
  } } }).adapter;
  const client = adapter?.client;
  if (!client || typeof client.createContainer !== "function") return; // SDK 内部结构变化时静默跳过（不阻断）

  const orig = client.createContainer.bind(client);
  const pidsLimit = limits?.pidsLimit ?? 512;
  const capDropAll = limits?.capDropAll ?? true;
  const noNewPrivileges = limits?.noNewPrivileges ?? true;
  client.createContainer = (opts: CreateContainerOptions) => {
    if (opts.Labels?.["dfh.job"]) {
      opts.HostConfig = {
        ...opts.HostConfig,
        PidsLimit: pidsLimit,
        ...(capDropAll ? { CapDrop: ["ALL"] } : {}),
        ...(noNewPrivileges ? { SecurityOpt: ["no-new-privileges:true"] } : {}),
      };
    }
    return orig(opts);
  };
}

export class AgentboxRunner implements SandboxRunner {
  async provision(input: ProvisionInput): Promise<RunHandle> {
    const sandbox = new Sandbox("local-docker", {
      image: input.image,
      workingDir: "/workspace",
      env: input.env,
      tags: { "dfh.job": input.jobId },
      // SEC-03：CPU/内存硬限制（SDK 原生透传 NanoCpus/Memory）
      resources: {
        cpu: input.limits?.cpu ?? 2,
        memoryMiB: input.limits?.memoryMiB ?? 2048,
      },
      provider: {
        name: `dfh-${input.jobId.slice(0, 8)}`,
        // none=彻底断网；restricted MVP 先给 bridge（agent 需访问 LLM 端点）
        // TODO(Phase 3): restricted → squid 白名单代理（§9.2）
        networkMode: input.network === "none" ? "none" : "bridge",
        autoRemove: true,
      },
    });
    hardenCreateContainer(sandbox, input.limits);
    await sandbox.findOrProvision();
    const id = sandbox.id ?? `unknown-${input.jobId}`;
    sandboxes.set(id, sandbox);
    return { sandboxId: id };
  }

  async destroy(handle: RunHandle): Promise<void> {
    const s = sandboxes.get(handle.sandboxId);
    sandboxes.delete(handle.sandboxId);
    await s?.delete().catch(() => {});
    // 兜底：内存注册表没有（进程重启后）或 SDK 删除失败，按持久化 sandboxId 强删
    await docker("rm", "-f", handle.sandboxId).catch(() => {});
  }

  async isAlive(handle: RunHandle): Promise<boolean> {
    const s = sandboxes.get(handle.sandboxId);
    if (s) {
      try {
        await s.run("true", { timeoutMs: 5000 });
        return true;
      } catch {
        return false;
      }
    }
    // 兜底：重启后按容器 id 直查引擎状态
    try {
      const out = await docker("inspect", "-f", "{{.State.Running}}", handle.sandboxId);
      return out === "true";
    } catch {
      return false;
    }
  }

  /** 供 executor 取沙箱实例（上传种子文件 / 跑 agent / 读结果） */
  static sandboxOf(handle: RunHandle): Sandbox | undefined {
    return sandboxes.get(handle.sandboxId);
  }
}

// ---------- 重启 reconcile 用的引擎直查（JOB-04） ----------

export interface DfhContainer {
  containerId: string;
  jobId: string;
  state: string;
}

/** 枚举所有带 dfh.job 标签的容器（含已退出；autoRemove 的通常不留尸体） */
export async function listDfhContainers(): Promise<DfhContainer[]> {
  try {
    // 注意：docker ps 的 .Labels 是字符串（非 map），不能直接 index，取回后自行解析
    const out = await docker(
      "ps", "-a",
      "--filter", "label=dfh.job",
      "--format", "{{.ID}}\t{{.Labels}}\t{{.State}}",
    );
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [containerId, labels, state] = l.split("\t");
        const jobId = labels
          .split(",")
          .map((kv) => kv.trim())
          .find((kv) => kv.startsWith("dfh.job="))
          ?.slice("dfh.job=".length);
        return { containerId, jobId: jobId ?? "", state };
      })
      .filter((c) => c.containerId && c.jobId);
  } catch (e) {
    console.error("[reconcile] docker ps 失败（跳过容器侧核对）:", e instanceof Error ? e.message : e);
    return [];
  }
}

/** 强删容器（孤儿回收） */
export async function forceRemoveContainer(containerId: string): Promise<void> {
  await docker("rm", "-f", containerId);
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
