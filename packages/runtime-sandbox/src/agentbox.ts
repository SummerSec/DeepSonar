/**
 * agentbox-sdk（TwillAI, MIT）真实实现 —— ARCHITECTURE §5/§8
 *
 * 要点：
 * - agentbox 只作沙箱（容器生命周期 + exec + 文件上下行）；Agent 由 claude CLI
 *   以 stream-json 模式直接在沙箱内驱动，不走 SDK daemon/relay。
 * - 语义事件由宿主从 Claude stream-json 的 assistant tool_use 块捕获；
 *   不经过沙箱目标网络，也不依赖 Agent 可写文件。
 */
import { Sandbox } from "agentbox-sdk";
import type {
  AgentCommandConfig,
  AgentMcpConfig,
  AgentSkillConfig,
  AgentSubAgentConfig,
} from "agentbox-sdk";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { CLI_SESSION_ADAPTERS, type SessionBundle } from "./cli-session-adapters.js";
import type { ProvisionInput, RunHandle, SandboxRunner } from "./index.js";

const execFileP = promisify(execFile);

/** docker CLI 兜底（进程重启后内存注册表丢失，按持久化 sandboxId 直查引擎） */
async function docker(...args: string[]): Promise<string> {
  const { stdout } = await execFileP("docker", args, { timeout: 15000 });
  return stdout.trim();
}

// --- agentbox-sdk 0.1.501 Windows 宿主兼容性补丁 ---
// SDK 用宿主 path.join 拼沙箱内的 POSIX 路径，Windows 上产出反斜杠，传进容器后路径全毁。
// 运行时补丁：join 的首参数是 POSIX 绝对路径（"/" 开头）时改用 posix.join。
// Windows 宿主路径只会以盘符或 \\ 开头，不会误判；SDK 的路径拼接全部发生在运行时。
// TODO: 向上游提 issue，修复后移除此补丁。
const origJoin = path.join.bind(path);
if (process.platform === "win32") {
  path.join = ((...args: string[]) =>
    args[0]?.startsWith("/") ? path.posix.join(...args) : origJoin(...args)) as typeof path.join;
}

/** jobId → Sandbox 注册表（isAlive/destroy 用；进程重启即丢，靠 docker CLI 兜底） */
const sandboxes = new Map<string, Sandbox>();
const RESTRICTED_NETWORK = "deepsonar-restricted";
const GATEWAY_PROXY = "deepsonar-gateway-proxy";
let restrictedNetworkReady: Promise<void> | null = null;
let gatewayProxyReady: Promise<void> | null = null;

const GATEWAY_PROXY_SCRIPT = String.raw`
const http = require("node:http");
const https = require("node:https");
const upstream = new URL(process.env.DEEPSONAR_GATEWAY_UPSTREAM);
const prefix = upstream.pathname.replace(/\/$/, "");
const client = upstream.protocol === "https:" ? https : http;
const server = http.createServer((req, res) => {
  const incoming = new URL(req.url || "/", "http://proxy.local");
  if (incoming.pathname === "/_deepsonar_health") {
    res.writeHead(200).end("ok");
    return;
  }
  if (incoming.pathname !== prefix && !incoming.pathname.startsWith(prefix + "/")) {
    res.writeHead(404).end("not found");
    return;
  }
  const headers = { ...req.headers, host: upstream.host };
  delete headers.connection;
  delete headers["proxy-authorization"];
  const target = client.request({
    protocol: upstream.protocol,
    hostname: upstream.hostname,
    port: upstream.port || (upstream.protocol === "https:" ? 443 : 80),
    method: req.method,
    path: incoming.pathname + incoming.search,
    headers,
  }, (reply) => {
    res.writeHead(reply.statusCode || 502, reply.headers);
    reply.pipe(res);
  });
  target.on("error", () => res.writeHead(502).end("gateway unavailable"));
  req.pipe(target);
});
server.on("connect", (_req, socket) => socket.destroy());
server.listen(3100, "0.0.0.0");
`;

/**
 * Docker internal bridge 不做外网 NAT；模型请求由另一个固定目标 sidecar 转发。
 * 网络是宿主级共享资源，创建操作幂等，并发首次 provision 共用同一 Promise。
 */
async function ensureRestrictedNetwork(): Promise<void> {
  restrictedNetworkReady ??= (async () => {
    const validate = async () => {
      const state = await docker(
        "network", "inspect", "--format",
        "{{.Internal}}|{{.Driver}}|{{index .Labels \"deepsonar.managed\"}}",
        RESTRICTED_NETWORK,
      );
      if (state !== "true|bridge|true") {
        throw new Error(`Docker 网络 ${RESTRICTED_NETWORK} 存在但不是 DEEPSONAR 管理的 internal bridge`);
      }
    };
    try {
      await validate();
      return;
    } catch {
      await docker(
        "network", "create", "--driver", "bridge", "--internal",
        "--label", "deepsonar.managed=true", RESTRICTED_NETWORK,
      ).catch(async (e) => {
        await validate().catch(() => { throw e; });
      });
      await validate();
    }
  })();
  return restrictedNetworkReady;
}

/**
 * internal bridge 不能直达 Docker Desktop 宿主。共享 sidecar 同时连普通 bridge 和
 * internal bridge，但代码只允许把 /gateway 路径转发到唯一上游，不提供 CONNECT 或任意目标代理。
 *
 * 返回 sidecar 在 restricted 网上的 IPv4，供沙箱 ExtraHosts 注入：rootless Podman 的
 * internal bridge 常无嵌入式 DNS，容器名 `deepsonar-gateway-proxy` 解析失败会表现为
 * Claude Code `Unable to connect to API (ENOTIMP)` / curl Could not resolve host。
 */
async function ensureGatewayProxy(upstreamUrl: string, image: string): Promise<string> {
  gatewayProxyReady ??= (async () => {
    const parsed = new URL(upstreamUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`Gateway sidecar 不支持上游协议: ${parsed.protocol}`);
    }
    if (!parsed.pathname.startsWith("/gateway")) {
      throw new Error("Gateway sidecar 上游 URL 必须以 /gateway 为路径");
    }
    const upstreamHash = createHash("sha256").update(upstreamUrl).digest("hex").slice(0, 16);
    let exists = true;
    try {
      const state = await docker(
        "inspect", "--format",
        "{{index .Config.Labels \"deepsonar.gateway-upstream\"}}|{{.State.Running}}",
        GATEWAY_PROXY,
      );
      const [configuredHash, running] = state.split("|");
      if (configuredHash !== upstreamHash) {
        throw new Error(`${GATEWAY_PROXY} 已指向其他 Gateway，拒绝复用`);
      }
      if (running !== "true") await docker("start", GATEWAY_PROXY);
    } catch (e) {
      const listed = await docker("ps", "-a", "--filter", `name=^/${GATEWAY_PROXY}$`, "--format", "{{.ID}}");
      exists = Boolean(listed);
      if (exists) throw e;
    }
    if (!exists) {
      await docker(
        "run", "-d", "--name", GATEWAY_PROXY, "--restart", "unless-stopped",
        "--network", "bridge", "--add-host", "host.docker.internal:host-gateway",
        "--label", "deepsonar.managed=true", "--label", `deepsonar.gateway-upstream=${upstreamHash}`,
        "-e", `DEEPSONAR_GATEWAY_UPSTREAM=${upstreamUrl}`,
        "--entrypoint", "node", image, "-e", GATEWAY_PROXY_SCRIPT,
      );
    }
    const inspect = JSON.parse(await docker("inspect", "--format", "{{json .NetworkSettings.Networks}}", GATEWAY_PROXY)) as Record<string, unknown>;
    if (!(RESTRICTED_NETWORK in inspect)) {
      // --alias 让 Docker 嵌入 DNS 能解析容器名；Podman rootless 仍可能无 DNS，见 ExtraHosts。
      try {
        await docker("network", "connect", "--alias", GATEWAY_PROXY, RESTRICTED_NETWORK, GATEWAY_PROXY);
      } catch {
        await docker("network", "connect", RESTRICTED_NETWORK, GATEWAY_PROXY);
      }
    }
    let ready = false;
    for (let i = 0; i < 20; i++) {
      try {
        await docker(
          "exec", GATEWAY_PROXY, "node", "-e",
          "fetch('http://127.0.0.1:3100/_deepsonar_health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
        );
        ready = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    if (!ready) throw new Error(`${GATEWAY_PROXY} 启动后未通过健康检查`);
  })();
  await gatewayProxyReady;
  const nets = JSON.parse(await docker("inspect", "--format", "{{json .NetworkSettings.Networks}}", GATEWAY_PROXY)) as Record<
    string,
    { IPAddress?: string }
  >;
  const ip = nets[RESTRICTED_NETWORK]?.IPAddress?.trim();
  if (!ip) throw new Error(`${GATEWAY_PROXY} 未接入 ${RESTRICTED_NETWORK} 或缺少 IPv4`);
  return ip;
}

/**
 * 解析运行时 tool-manifest。部分已发布 OH 镜像在合法 JSON 后多了字面量 `\n`
 *（Dockerfile 单引号里写了 +"\\n"），严格 parse 会报
 * "Unexpected non-whitespace character after JSON"。
 */
function parseToolManifest(raw: string): { contract?: string } {
  const text = raw.replace(/^\uFEFF/, "").trim();
  try {
    return JSON.parse(text) as { contract?: string };
  } catch (first) {
    // 去掉尾部孤立的 \n / 多余空白后再试
    const stripped = text.replace(/(?:\\n)+\s*$/g, "").trim();
    if (stripped !== text) {
      try {
        return JSON.parse(stripped) as { contract?: string };
      } catch {
        /* fall through */
      }
    }
    // 取第一个完整 JSON 值（从首个 { 起 brace-match）
    const start = text.indexOf("{");
    if (start >= 0) {
      let depth = 0;
      let inString = false;
      let escape = false;
      for (let i = start; i < text.length; i++) {
        const ch = text[i]!;
        if (inString) {
          if (escape) escape = false;
          else if (ch === "\\") escape = true;
          else if (ch === "\"") inString = false;
          continue;
        }
        if (ch === "\"") {
          inString = true;
          continue;
        }
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) {
            return JSON.parse(text.slice(start, i + 1)) as { contract?: string };
          }
        }
      }
    }
    throw first instanceof Error ? first : new Error(String(first));
  }
}

/** dockerode createContainer 调用签名（只需要我们注入 HostConfig 的部分） */
interface CreateContainerOptions {
  Labels?: Record<string, string>;
  HostConfig?: Record<string, unknown>;
}

/**
 * SEC-03 容器硬限制：agentbox-sdk 只透传 cpu/memory，PidsLimit/CapDrop/SecurityOpt
 * 需要包住 dockerode 的 createContainer 注入。按实例包装（不碰全局原型），
 * 只对带 deepsonar.job 标签的容器生效，SDK 升级也不影响其他调用方。
 * TODO(SEC-03 余项)：non-root 运行 + read_only_rootfs 需镜像侧配合（/workspace、/tmp 可写卷），留待 OPS。
 */
function hardenCreateContainer(
  sandbox: Sandbox,
  limits: ProvisionInput["limits"],
  extraHosts: string[] = [],
): void {
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
    if (opts.Labels?.["deepsonar.job"]) {
      const prevHosts = Array.isArray(opts.HostConfig?.ExtraHosts)
        ? (opts.HostConfig!.ExtraHosts as string[])
        : [];
      opts.HostConfig = {
        ...opts.HostConfig,
        PidsLimit: pidsLimit,
        ...(capDropAll ? { CapDrop: ["ALL"] } : {}),
        ...(noNewPrivileges ? { SecurityOpt: ["no-new-privileges:true"] } : {}),
        ...(extraHosts.length > 0
          ? { ExtraHosts: [...new Set([...prevHosts, ...extraHosts])] }
          : {}),
      };
    }
    return orig(opts);
  };
}

export class AgentboxRunner implements SandboxRunner {
  async provision(input: ProvisionInput): Promise<RunHandle> {
    const extraHosts: string[] = [];
    if (input.network === "restricted") {
      await ensureRestrictedNetwork();
      if (!input.gatewayUpstreamUrl) throw new Error("restricted Worker 缺少 Gateway 上游 URL");
      const proxyIp = await ensureGatewayProxy(input.gatewayUpstreamUrl, input.image);
      // 固定主机名 → restricted 网 IP，避免 Podman internal 网无 DNS 时 ANTHROPIC_BASE_URL 不可达
      extraHosts.push(`${GATEWAY_PROXY}:${proxyIp}`);
    }
    const sandbox = new Sandbox("local-docker", {
      image: input.image,
      workingDir: "/workspace",
      env: input.env,
      tags: { "deepsonar.job": input.jobId },
      // SEC-03：CPU/内存硬限制（SDK 原生透传 NanoCpus/Memory）
      resources: {
        cpu: input.limits?.cpu ?? 2,
        memoryMiB: input.limits?.memoryMiB ?? 2048,
      },
      provider: {
        name: `deepsonar-${input.jobId.slice(0, 8)}`,
        // restricted=无外网 NAT 的内部 bridge（仅保留 host-gateway 模型通道）；
        // egress=普通 bridge，Worker 可按 prompt 自主取材。
        networkMode:
          input.network === "none" ? "none" : input.network === "restricted" ? RESTRICTED_NETWORK : "bridge",
        autoRemove: true,
      },
    });
    hardenCreateContainer(sandbox, input.limits, extraHosts);
    await sandbox.findOrProvision();
    const id = sandbox.id ?? `unknown-${input.jobId}`;
    sandboxes.set(id, sandbox);
    try {
      const contractResult = await sandbox.run(
        "test -d /workspace && test -x /bin/sh && cat /opt/deepsonar/tool-manifest.json",
        { timeoutMs: 15_000 },
      );
      if (contractResult.exitCode !== 0) {
        throw new RuntimeImageContractError("runtime image missing /workspace, /bin/sh, or tool manifest");
      }
      // 兼容历史 OH 镜像：Dockerfile 误写 +"\\n" 导致 manifest 末尾多字面量 \n，严格 JSON.parse 失败。
      const manifest = parseToolManifest(contractResult.stdout);
      if (input.expectedContract && manifest.contract !== input.expectedContract) {
        throw new RuntimeImageContractError(`runtime contract mismatch: expected ${input.expectedContract}, got ${manifest.contract ?? "missing"}`);
      }
      if (input.expectedToolsManifestSha256) {
        const hashResult = await sandbox.run("sha256sum /opt/deepsonar/tool-manifest.json | cut -d' ' -f1", { timeoutMs: 5_000 });
        if (hashResult.exitCode !== 0 || hashResult.stdout.trim() !== input.expectedToolsManifestSha256.replace(/^sha256:/, "")) {
          throw new RuntimeImageContractError("tool manifest sha256 mismatch");
        }
      }
    } catch (error) {
      sandboxes.delete(id);
      await sandbox.delete().catch(() => {});
      if (error instanceof RuntimeImageContractError) throw error;
      throw new RuntimeImageContractError(error instanceof Error ? error.message : String(error));
    }
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

/** 调度器可据此区分供应链准入失败与普通 provision 故障。 */
export class RuntimeImageContractError extends Error {
  readonly code = "RUNTIME_IMAGE_CONTRACT";
  constructor(message: string) {
    super(message);
    this.name = "RuntimeImageContractError";
  }
}

// ---------- 重启 reconcile 用的引擎直查（JOB-04） ----------

export interface DeepSonarContainer {
  containerId: string;
  jobId: string;
  state: string;
}

/** 枚举所有带 deepsonar.job 标签的容器（含已退出；autoRemove 的通常不留尸体） */
export async function listDeepSonarContainers(): Promise<DeepSonarContainer[]> {
  try {
    // 注意：docker ps 的 .Labels 是字符串（非 map），不能直接 index，取回后自行解析
    const out = await docker(
      "ps", "-a",
      "--filter", "label=deepsonar.job",
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
          .find((kv) => kv.startsWith("deepsonar.job="))
          ?.slice("deepsonar.job=".length);
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

// ---------- 真实 Agent 运行（§8 事件通道 + 动态控制 MCP） ----------

/** 与 agentbox-sdk AgentReasoningEffort 对齐 */
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

export interface RealAgentSpec {
  provider: "claude-code" | "open-code" | "codex";
  /** 模型 ID（如 claude-sonnet-4-5、gpt-5、kimi-k2） */
  model?: string;
  /** 思考/推理强度；缺省由 provider 默认 */
  reasoning?: ReasoningEffort;
  env: Record<string, string>;
  /** Hub 为本 Job 生成的本轮任务消息，等价于各 CLI 的非交互 prompt/input。 */
  input: string;
  /** 平台不可变安全边界；与 /workspace 下的角色说明文件分层。 */
  systemPrompt?: string;
  /** Agent 配置下发（claude CLI 本地组件文件，内容来自冻结 RoleConfig） */
  skills?: AgentSkillConfig[];
  commands?: AgentCommandConfig[];
  mcps?: AgentMcpConfig[];
  subAgents?: AgentSubAgentConfig[];
  /** 本 Job 动态工作区：指令文件、Provider 配置等；只允许 /workspace 下的绝对路径。 */
  workspaceFiles?: Record<string, string>;
  /** 运行后要读回的文件 */
  resultFiles?: string[];
  /** 控制 MCP 工具名到宿主语义事件类型的映射。 */
  semanticToolEvents?: Record<string, string>;
  /** 每条完整语义事件到达时串行调用。 */
  onSemanticEvent?: (event: Record<string, unknown>) => void | Promise<void>;
  /** Run 建立后注册外部增量消息源；消息经 stdin stream-json 注入同一会话。 */
  onRunReady?: (control: { sendMessage(content: string): Promise<void> }) =>
    void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
  /**
   * 完成门禁：result 事件到达时调用。返回 false 表示协议要求的语义事件（如
   * mark_job_done）还没齐，驱动层会用 nudgeMessage 催促同一会话继续，最多 3 次。
   */
  completionGate?: () => boolean;
  /** 门禁未过时的催促消息（executor 按角色协议给出） */
  nudgeMessage?: string;
  /** 流式进度回调（已节流） */
  onProgress?: (message: string) => void;
  /** 全量规范化事件回调（text.delta / tool.call.* / run.* 等，未节流，供实时流转发） */
  onEvent?: (event: Record<string, unknown>) => void;
  /** 非语义运行流告警；告警不会进入控制事件或写库。 */
  onWarning?: (warning: { code: string; detail?: string }) => void;
}

export interface RealAgentResult {
  text: string;
  files: Record<string, string>;
  /** CLI 原始 Session；由 provider 专属 Adapter 在沙箱销毁前读回。 */
  session?: SessionBundle;
  error?: string;
}

/**
 * 读沙箱内文本文件。SDK 的 downloadFile 直接返回 docker getArchive 的原始 tar 字节
 * （首行是 tar 头里的文件名），不能当文件内容用；这里走 exec cat。
 * 文件不存在返回 null（调用方区分「尚未创建」与「读失败」）。
 */
async function readSandboxFileText(sandbox: Sandbox, filePath: string): Promise<string | null> {
  const q = `'${filePath.replace(/'/g, `'\\''`)}'`;
  const res = await sandbox.run(`if [ -f ${q} ]; then cat ${q}; else exit 44; fi`, { timeoutMs: 15000 });
  if (res.exitCode === 44) return null;
  if (res.exitCode !== 0) {
    throw new Error(`读取沙箱文件失败(exit=${res.exitCode}): ${res.stderr.slice(0, 200)}`);
  }
  return res.stdout;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

const RUNTIME_DIR = "/workspace/.deepsonar";
const CLAUDE_DIR = "/workspace/.claude";
const RUNTIME_HOME = `${RUNTIME_DIR}/home`;
const CLAUDE_CONFIG_DIR = `${RUNTIME_DIR}/claude`;

/** 系统拥有的可写 CLI 环境；不依赖镜像继承的 HOME（非 root 镜像常仍错误指向 /root）。 */
export function runtimeCliEnv(env: Record<string, string>): Record<string, string> {
  return {
    ...env,
    HOME: RUNTIME_HOME,
    CLAUDE_CONFIG_DIR,
  };
}

/** claude CLI --mcp-config 格式（与 SDK buildClaudeMcpConfig 等价） */
function buildMcpConfigJson(mcps: AgentMcpConfig[]): string {
  const mcpServers = Object.fromEntries(
    mcps.filter((m) => (m as { enabled?: boolean }).enabled !== false).map((m) => {
      if (m.type === "remote") {
        return [m.name, { type: "http", url: m.url, ...(m.headers ? { headers: m.headers } : {}) }];
      }
      return [
        m.name,
        {
          type: "stdio",
          command: m.command,
          ...(m.args?.length ? { args: m.args } : {}),
          ...(m.env ? { env: m.env } : {}),
        },
      ];
    }),
  );
  return JSON.stringify({ mcpServers }, null, 2);
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;

function safeComponentName(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`拒绝 ${label}：名称不能为空`);
  }
  if (CONTROL_CHAR_RE.test(value)) {
    throw new Error(`拒绝 ${label}：名称含 NUL/control 字符`);
  }
  const slashed = value.replaceAll("\\", "/");
  if (
    slashed.startsWith("/") ||
    path.posix.isAbsolute(slashed) ||
    /^[A-Za-z]:/.test(slashed)
  ) {
    throw new Error(`拒绝 ${label}：名称不能是绝对路径`);
  }
  if (slashed.includes("/")) {
    throw new Error(`拒绝 ${label}：名称不能包含路径分隔符`);
  }
  if (slashed === "." || slashed === "..") {
    throw new Error(`拒绝 ${label}：名称不能是 . 或 ..`);
  }
  return slashed;
}

function safeRelativeSkillFile(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`拒绝 ${label}：文件路径不能为空`);
  }
  if (CONTROL_CHAR_RE.test(value)) {
    throw new Error(`拒绝 ${label}：文件路径含 NUL/control 字符`);
  }
  const slashed = value.replaceAll("\\", "/");
  if (slashed.startsWith("/") || path.posix.isAbsolute(slashed) || /^[A-Za-z]:/.test(slashed)) {
    throw new Error(`拒绝 ${label}：文件路径不能是绝对路径`);
  }
  const segments = slashed.split("/");
  if (segments.some((segment) => segment === "..")) {
    throw new Error(`拒绝 ${label}：文件路径不得包含 ..`);
  }
  if (slashed.endsWith("/")) {
    throw new Error(`拒绝 ${label}：文件路径不能指向目录`);
  }
  const normalized = path.posix.normalize(slashed);
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`拒绝 ${label}：文件路径归一化后越界`);
  }
  return normalized;
}

function strictChildPath(parent: string, child: string, label: string): string {
  const root = path.posix.resolve(parent);
  const resolved = path.posix.resolve(child);
  if (resolved === root || !resolved.startsWith(`${root}/`)) {
    throw new Error(`拒绝 ${label}：归一化后不在 ${root} 子树内`);
  }
  return resolved;
}

function commandMaterializationPath(name: unknown): string {
  const safeName = safeComponentName(name, "command.name");
  return strictChildPath(
    `${CLAUDE_DIR}/commands`,
    path.posix.join(`${CLAUDE_DIR}/commands`, `${safeName}.md`),
    "command.name",
  );
}

function subAgentMaterializationPath(name: unknown): string {
  const safeName = safeComponentName(name, "subAgent.name");
  return strictChildPath(
    `${CLAUDE_DIR}/agents`,
    path.posix.join(`${CLAUDE_DIR}/agents`, `${safeName}.md`),
    "subAgent.name",
  );
}

function skillMaterializationPath(name: unknown, rel: unknown): string {
  const safeName = safeComponentName(name, "embedded skill.name");
  const root = strictChildPath(
    `${CLAUDE_DIR}/skills`,
    path.posix.join(`${CLAUDE_DIR}/skills`, safeName),
    "embedded skill.name",
  );
  const safeRel = safeRelativeSkillFile(rel, "embedded skill file");
  return strictChildPath(root, path.posix.join(root, safeRel), "embedded skill file");
}

function materializationPaths(
  spec: Pick<RealAgentSpec, "commands" | "subAgents" | "skills">,
): string[] {
  const paths: string[] = [];
  for (const command of spec.commands ?? []) {
    paths.push(commandMaterializationPath(command.name));
  }
  for (const sub of spec.subAgents ?? []) {
    paths.push(subAgentMaterializationPath(sub.name));
  }
  for (const skill of spec.skills ?? []) {
    const safeName = safeComponentName(skill.name, "skill.name");
    if (!("files" in skill)) continue; // repo skill is installed by the CLI below
    if (!skill.files || typeof skill.files !== "object" || Array.isArray(skill.files)) {
      throw new Error(`拒绝 embedded skill ${safeName}：files 必须是对象`);
    }
    for (const rel of Object.keys(skill.files)) {
      paths.push(skillMaterializationPath(safeName, rel));
    }
  }
  return paths;
}

function duplicatePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const collisions = new Set<string>();
  for (const target of paths) {
    if (seen.has(target)) collisions.add(target);
    seen.add(target);
  }
  return [...collisions].sort();
}

/** Return duplicate normalized local component paths before any upload happens. */
export function materializationPathCollisions(
  spec: Pick<RealAgentSpec, "commands" | "subAgents" | "skills">,
): string[] {
  return duplicatePaths(materializationPaths(spec));
}

/**
 * claude CLI 的本地组件文件（替代 SDK daemon setup 的产物上传）：
 * commands → .claude/commands/<name>.md；subAgents → .claude/agents/<name>.md；
 * embedded skills → .claude/skills/<name>/<files>；repo skills 需出网安装，尽力而为。
 */
async function materializeAgentFiles(
  sandbox: Sandbox,
  spec: RealAgentSpec,
  cliEnv: Record<string, string>,
): Promise<void> {
  // Validate every component and normalize every target before the first mkdir
  // or upload. A malformed later component therefore cannot cause partial writes.
  const paths = materializationPaths(spec);
  const collisions = duplicatePaths(paths);
  if (collisions.length > 0) {
    throw new Error(`拒绝 materialize 组件路径冲突（不会执行覆盖写入）: ${collisions.join(", ")}`);
  }
  const writes: Array<[string, string]> = [];
  for (const command of spec.commands ?? []) {
    const frontmatter = command.description ? `---\ndescription: ${yamlScalar(command.description)}\n---\n\n` : "";
    writes.push([commandMaterializationPath(command.name), frontmatter + command.template]);
  }
  for (const sub of spec.subAgents ?? []) {
    const lines = [
      `name: ${yamlScalar(sub.name)}`,
      `description: ${yamlScalar(sub.description)}`,
      ...(sub.model ? [`model: ${yamlScalar(sub.model)}`] : []),
      ...(sub.tools?.length ? [`tools: ${sub.tools.join(", ")}`] : []),
    ];
    writes.push([subAgentMaterializationPath(sub.name), `---\n${lines.join("\n")}\n---\n\n${sub.instructions.trim()}\n`]);
  }
  for (const skill of spec.skills ?? []) {
    if (!("files" in skill)) continue; // repo skill 走下方安装命令
    for (const [rel, content] of Object.entries(skill.files)) {
      writes.push([skillMaterializationPath(skill.name, rel), content]);
    }
  }
  for (const [filePath, content] of writes) {
    const dir = path.posix.dirname(filePath);
    await sandbox.run(`mkdir -p -- ${shellQuote(dir)}`);
    await sandbox.uploadFile(content, filePath);
  }
  // repo 形式 skill：需要出网，失败只告警不阻断
  for (const skill of spec.skills ?? []) {
    if ("files" in skill || !skill.repo) continue;
    const res = await sandbox.run(
      `npx -y skills add ${shellQuote(skill.repo)} -g --skill ${shellQuote(skill.name)} --agent claude -y`,
      { timeoutMs: 120_000, env: cliEnv },
    ).catch(() => null);
    if (!res || res.exitCode !== 0) console.warn(`[real-agent] repo skill 安装失败: ${skill.name}`);
  }
}

/** claude stream-json 一行 → 规范化事件（保持 executor/前端既有形状） */
export const DEFAULT_SEMANTIC_TOOL_EVENTS: Record<string, string> = {
  "mcp__deepsonar-control__emit_progress": "progress",
  "mcp__deepsonar-control__emit_fact": "fact",
  "mcp__deepsonar-control__emit_finding": "finding",
  "mcp__deepsonar-control__submit_hub_decision": "hub_decision",
  "mcp__deepsonar-control__mark_job_done": "done",
  "mcp__deepsonar-control__request_human": "human",
};

function semanticEventId(callId: string): string {
  const bytes = createHash("sha256").update(`deepsonar-control:${callId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Parse one CLI stream line without letting malformed/legacy control-file
 * text poison the following structured line. */
export function parseRuntimeLine(line: string): {
  parsed?: Record<string, unknown>;
  warning?: { code: "malformed_runtime_line" | "forbidden_control_file"; detail: string };
} {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { warning: { code: "malformed_runtime_line", detail: `line_length=${line.length}` } };
    }
    return { parsed: parsed as Record<string, unknown> };
  } catch {
    const forbidden = /\.deepsonar[\\/]+control(?:-|\.)|control-events\.jsonl/i.test(line);
    return {
      warning: {
        code: forbidden ? "forbidden_control_file" : "malformed_runtime_line",
        detail: `line_length=${line.length}`,
      },
    };
  }
}

export function mapCliEvent(
  line: Record<string, unknown>,
  emit: (e: Record<string, unknown>) => void,
  semanticToolEvents: Record<string, string> = DEFAULT_SEMANTIC_TOOL_EVENTS,
  seenToolUseIds = new Set<string>(),
): {
  finalText?: string;
  isError?: boolean;
  errorDetail?: string;
  sessionId?: string;
  semanticEvents: Array<Record<string, unknown>>;
} {
  const semanticEvents: Array<Record<string, unknown>> = [];
  const type = line.type as string;
  if (type === "system" && line.subtype === "init") {
    emit({ type: "run.started", sessionId: line.session_id });
    return { sessionId: typeof line.session_id === "string" ? line.session_id : undefined, semanticEvents };
  }
  if (type === "assistant") {
    const content = (line.message as { content?: unknown[] } | undefined)?.content ?? [];
    for (const block of content as Record<string, unknown>[]) {
      if (block.type === "text" && typeof block.text === "string" && block.text) {
        emit({ type: "text.delta", delta: block.text });
      } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
        emit({ type: "reasoning.delta", delta: block.thinking });
      } else if (block.type === "tool_use") {
        emit({ type: "tool.call.started", toolName: block.name, callId: block.id, input: block.input });
        const toolName = typeof block.name === "string" ? block.name : "";
        const callId = typeof block.id === "string" ? block.id : "";
        const eventType = semanticToolEvents[toolName];
        if (eventType && callId && !seenToolUseIds.has(callId)) {
          seenToolUseIds.add(callId);
          semanticEvents.push({
            v: 1,
            event_id: semanticEventId(callId),
            type: eventType,
            payload: block.input && typeof block.input === "object" ? block.input : {},
          });
        }
      }
    }
    return { semanticEvents };
  }
  if (type === "user") {
    const content = (line.message as { content?: unknown[] } | undefined)?.content ?? [];
    for (const block of content as Record<string, unknown>[]) {
      if (block.type === "tool_result") {
        emit({ type: "tool.call.completed", callId: block.tool_use_id });
      }
    }
    return { semanticEvents };
  }
  if (type === "result") {
    const text = typeof line.result === "string" ? line.result : "";
    const isError = line.is_error === true || (line.subtype as string) !== "success";
    emit({ type: "run.completed", text: text || (line.subtype as string) });
    return { finalText: text, isError, errorDetail: isError ? text || `claude result: ${String(line.subtype)}` : undefined, semanticEvents };
  }
  return { semanticEvents };
}

export async function runRealAgent(handle: RunHandle, spec: RealAgentSpec): Promise<RealAgentResult> {
  const sandbox = AgentboxRunner.sandboxOf(handle);
  if (!sandbox) throw new Error(`沙箱 ${handle.sandboxId} 不在注册表（可能已被回收）`);
  if (spec.provider !== "claude-code") {
    throw new Error(`CLI 驱动模式暂只支持 claude-code，收到: ${spec.provider}`);
  }

  // 1. 从冻结快照生成本 Job 的完整 /workspace。目标内容不由 Scheduler 预下载，
  // Worker 根据 Hub prompt 与网络策略自行决定如何取材。
  for (const [filePath, content] of Object.entries(spec.workspaceFiles ?? {})) {
    const normalized = path.posix.normalize(filePath);
    if (
      !normalized.startsWith("/workspace/") ||
      normalized !== filePath ||
      normalized.includes("/../") ||
      normalized.includes("\0")
    ) {
      throw new Error(`拒绝写入 workspace 之外的动态文件: ${filePath}`);
    }
    const dir = path.posix.dirname(normalized);
    if (dir !== "/workspace") await sandbox.run(`mkdir -p -- ${shellQuote(dir)}`);
    await sandbox.uploadFile(content, normalized);
  }

  // 2. agentbox 只当沙箱用：直接驱动 claude CLI（stream-json），不走 SDK daemon/relay。
  //    该路径已在容器内验证：--mcp-config 注册本地控制 MCP，权限模式完全开放（§16）。
  const cliEnv = runtimeCliEnv(spec.env);
  await sandbox.run(`mkdir -p -- ${shellQuote(RUNTIME_HOME)} ${shellQuote(CLAUDE_CONFIG_DIR)}`);
  await materializeAgentFiles(sandbox, spec, cliEnv);
  const mcpConfigPath = `${RUNTIME_DIR}/mcp.json`;
  await sandbox.uploadFile(buildMcpConfigJson(spec.mcps ?? []), mcpConfigPath);
  let systemPromptPath: string | null = null;
  if (spec.systemPrompt) {
    systemPromptPath = `${RUNTIME_DIR}/system-prompt.txt`;
    await sandbox.uploadFile(spec.systemPrompt, systemPromptPath);
  }

  let command =
    `claude -p --input-format stream-json --output-format stream-json --verbose` +
    ` --mcp-config ${shellQuote(mcpConfigPath)} --permission-mode bypassPermissions`;
  if (spec.model) command += ` --model ${shellQuote(spec.model)}`;
  if (spec.reasoning) command += ` --effort ${shellQuote(spec.reasoning)}`;
  if (systemPromptPath) command += ` --append-system-prompt "$(cat ${shellQuote(systemPromptPath)})"`;

  const exec = await sandbox.runAsync(command, { cwd: "/workspace", env: cliEnv });
  // CLI stdin 在 result 后会 closeStdin()；画布增量仍可能异步 sendMessage。
  // agentbox-sdk 的 stream.write 在 ended 流上抛 ERR_STREAM_WRITE_AFTER_END 且未挂 error 监听会打崩整个 scheduler。
  let stdinClosed = false;
  const rawStream = (exec.raw as { stream?: { destroyed?: boolean; writableEnded?: boolean; writable?: boolean } } | undefined)?.stream;
  const writeUserMessage = async (content: string) => {
    if (!exec.write) throw new Error("沙箱 exec 不支持 stdin 写入");
    if (stdinClosed || rawStream?.destroyed || rawStream?.writableEnded || rawStream?.writable === false) {
      throw new Error("agent stdin 已关闭，无法追加消息");
    }
    try {
      await exec.write(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n");
    } catch (error) {
      stdinClosed = true;
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`agent stdin 写入失败: ${msg}`);
    }
  };
  await writeUserMessage(spec.input);
  const disposeMessageSource = await spec.onRunReady?.({ sendMessage: writeUserMessage });
  let semanticError: string | undefined;
  const seenToolUseIds = new Set<string>();
  const semanticToolEvents = spec.semanticToolEvents ?? DEFAULT_SEMANTIC_TOOL_EVENTS;

  // 3. 事件流 → 全量事件回调（实时流）+ 节流进度回调（§6.2：原始流不进 events 表）
  let lastPush = 0;
  let progressBuffer = "";
  let stdoutBuffer = "";
  let stderrTail = "";
  let exitCode = 0;
  let finalText = "";
  let sessionId = "";
  let runError: string | undefined;
  let nudgesLeft = 3;
  // result 到达后 CLI 在 stream-json 输入模式下驻留等 stdin：门禁未过则催促，否则关 stdin 让它退出
  const closeStdin = () => {
    stdinClosed = true;
    const raw = exec.raw as { stream?: { end?: () => void } } | undefined;
    if (raw?.stream?.end) {
      try {
        raw.stream.end();
      } catch {
        /* already ended */
      }
    } else void exec.kill().catch(() => {});
  };
  try {
    for await (const chunk of exec) {
      if (chunk.type === "stderr") {
        stderrTail = (stderrTail + chunk.chunk).slice(-2000);
        continue;
      }
      if (chunk.type === "exit") {
        exitCode = chunk.exitCode ?? 0;
        continue;
      }
      stdoutBuffer += chunk.chunk;
      // stream-json 按行解析，未完成的行留给下一个 chunk
      let idx: number;
      while ((idx = stdoutBuffer.indexOf("\n")) >= 0) {
        const line = stdoutBuffer.slice(0, idx).trim();
        stdoutBuffer = stdoutBuffer.slice(idx + 1);
        if (!line) continue;
        const parsedLine = parseRuntimeLine(line);
        if (!parsedLine.parsed) {
          if (parsedLine.warning) spec.onWarning?.(parsedLine.warning);
          continue; // CLI 的非 JSON 噪音行；后续合法行继续处理
        }
        const parsed = parsedLine.parsed;
        const outcome = mapCliEvent(parsed, (e) => {
          spec.onEvent?.(e);
          if (e.type === "tool.call.started") {
            const input = e.input && typeof e.input === "object" ? e.input as Record<string, unknown> : {};
            const command = typeof input.command === "string" ? input.command : "";
            if (/\.deepsonar[\\/]+control(?:-|\.)|control-events\.jsonl/i.test(command)) {
              spec.onWarning?.({ code: "forbidden_control_file", detail: `command_length=${command.length}` });
            }
          }
          if (e.type === "text.delta" && typeof e.delta === "string") {
            progressBuffer += e.delta as string;
          }
        }, semanticToolEvents, seenToolUseIds);
        if (!["system", "assistant", "user", "result"].includes(String(parsed.type))) {
          spec.onWarning?.({ code: "unknown_runtime_event", detail: "unrecognized_stream_type" });
        }
        for (const event of outcome.semanticEvents) {
          try {
            await spec.onSemanticEvent?.(event);
          } catch (error) {
            semanticError = error instanceof Error ? error.message : String(error);
            throw error;
          }
        }
        if (outcome.sessionId) sessionId = outcome.sessionId;
        if (outcome.finalText !== undefined) {
          finalText = outcome.finalText;
          if (spec.completionGate && !spec.completionGate() && nudgesLeft > 0) {
            nudgesLeft--;
            await writeUserMessage(
              spec.nudgeMessage ??
                "协议要求的系统工具调用还没有完成。请立即通过平台 MCP 工具提交（不要只用文本描述），然后结束本轮。",
            );
          } else {
            closeStdin();
          }
        }
        if (outcome.isError) runError = outcome.errorDetail ?? "claude 执行失败";
        const now = Date.now();
        if (progressBuffer.length > 0 && now - lastPush > 4000) {
          lastPush = now;
          spec.onProgress?.(progressBuffer.slice(-200));
          progressBuffer = "";
        }
      }
    }
  } catch (e) {
    if (!runError) runError = e instanceof Error ? e.message : String(e);
  } finally {
    if (typeof disposeMessageSource === "function") await disposeMessageSource();
  }

  // 结果事件已拿到后，exitCode 只反映我们主动关 stdin/杀进程，不再视为错误
  if (!runError && exitCode !== 0 && finalText === "") {
    runError = `claude CLI 退出码 ${exitCode}${stderrTail.trim() ? `: ${stderrTail.trim().slice(-300)}` : ""}`;
  }

  // 4. 读回结果文件
  const files: Record<string, string> = {};
  for (const path of spec.resultFiles ?? []) {
    try {
      const text = await readSandboxFileText(sandbox, path);
      if (text !== null) files[path] = text;
    } catch {
      // 文件不存在 = agent 没写，容忍
    }
  }
  // 在沙箱销毁前按 CLI 专属规则归档原始 Session。捕获失败不覆盖 Agent 的主运行结果。
  const session = sessionId
    ? await CLI_SESSION_ADAPTERS[spec.provider].exportSession(
        {
          run: (command) => sandbox.run(command, { timeoutMs: 20_000, env: cliEnv }),
          readText: (filePath) => readSandboxFileText(sandbox, filePath),
        },
        sessionId,
      ).catch((error) => ({
        cli: spec.provider,
        sessionId,
        artifacts: [],
        captureError: error instanceof Error ? error.message : String(error),
      }))
    : undefined;
  await sandbox.run(`rm -rf -- ${shellQuote(CLAUDE_CONFIG_DIR)} ${shellQuote(RUNTIME_HOME)}`).catch(() => {});
  // 结果已经进入调度器内存后立即从 Worker 工作区删除；即使后续解析失败也不遗留。
  // 每个 Job 随后还会由 dispatcher 销毁独立沙箱，这是显式清理之外的第二道保障。
  const cleanupPaths = [...(spec.resultFiles ?? [])]
    .filter((p) => p.startsWith("/workspace/"));
  if (cleanupPaths.length > 0) {
    await sandbox.run(`rm -f -- ${cleanupPaths.map((p) => shellQuote(p)).join(" ")}`).catch(() => {});
  }

  return {
    text: finalText,
    files,
    session,
    ...(semanticError
      ? { error: `语义事件处理失败: ${semanticError}` }
      : runError
        ? { error: runError }
        : {}),
  };
}
