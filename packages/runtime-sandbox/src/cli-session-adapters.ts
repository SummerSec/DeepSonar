/**
 * Agent CLI 原始 Session 发现适配器；不同 CLI 不共享目录假设。
 *
 * 新增 CLI 时：在此扩展 SupportedAgentCli + CLI_SESSION_ADAPTERS，并同步
 * apps/web/src/session-viewer/parseAgentSession.ts（Job Session 时间线/统计）。
 * 完整清单：docs/AGENT_CLI_RUNTIME_ADAPTERS.md「Session 归档 + Web 查看器」。
 */

export type SupportedAgentCli = "claude-code" | "codex" | "open-code" | "pi" | "dsh";

export interface SessionDiscoveryRuntime {
  run(command: string): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  readText(path: string): Promise<string | null>;
}

export interface SessionArtifact {
  name: string;
  sourcePath: string;
  content: string;
  kind: "main" | "subagent" | "vendor_export";
}

export interface SessionBundle {
  cli: SupportedAgentCli;
  sessionId: string;
  artifacts: SessionArtifact[];
  captureError?: string;
}

export interface AgentCliSessionAdapter {
  cli: SupportedAgentCli;
  exportSession(runtime: SessionDiscoveryRuntime, sessionId: string, sessionFile?: string): Promise<SessionBundle>;
}

const MAX_SESSION_BYTES = 32 * 1024 * 1024;

function sh(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function safeName(filePath: string, sessionId: string, index: number): string {
  const base = filePath.split("/").filter(Boolean).pop() ?? `${sessionId}-${index}.jsonl`;
  return base.replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function readDiscovered(
  runtime: SessionDiscoveryRuntime,
  cli: SupportedAgentCli,
  sessionId: string,
  paths: string[],
): Promise<SessionBundle> {
  const unique = [...new Set(paths.map((p) => p.trim()).filter(Boolean))];
  const artifacts: SessionArtifact[] = [];
  let total = 0;
  for (let i = 0; i < unique.length; i++) {
    const sourcePath = unique[i]!;
    const content = await runtime.readText(sourcePath);
    if (content === null) continue;
    total += Buffer.byteLength(content);
    if (total > MAX_SESSION_BYTES) {
      return { cli, sessionId, artifacts, captureError: "Session 文件合计超过 32 MiB，已停止归档" };
    }
    const subagent = sourcePath.includes("/subagents/");
    artifacts.push({
      name: subagent ? `subagents/${safeName(sourcePath, sessionId, i)}` : safeName(sourcePath, sessionId, i),
      sourcePath,
      content,
      kind: subagent ? "subagent" : "main",
    });
  }
  return {
    cli,
    sessionId,
    artifacts,
    ...(artifacts.length === 0 ? { captureError: `未找到 ${cli} session ${sessionId}` } : {}),
  };
}

const claudeAdapter: AgentCliSessionAdapter = {
  cli: "claude-code",
  async exportSession(runtime, sessionId) {
    const command =
      `base="\${HOME:-/root}/.claude/projects"; ` +
      `if [ -d "$base" ]; then find "$base" -type f \\( -name ${sh(`${sessionId}.jsonl`)} ` +
      `-o -path ${sh(`*/${sessionId}/subagents/*.jsonl`)} \\) -print 2>/dev/null; fi`;
    const result = await runtime.run(command);
    if (result.exitCode !== 0 && !result.stdout.trim()) {
      return { cli: "claude-code", sessionId, artifacts: [], captureError: result.stderr.trim() || "Claude Session 扫描失败" };
    }
    return readDiscovered(runtime, "claude-code", sessionId, result.stdout.split("\n"));
  },
};

const codexAdapter: AgentCliSessionAdapter = {
  cli: "codex",
  async exportSession(runtime, sessionId) {
    const command =
      `base=\"\${CODEX_HOME:-\${HOME:-/root}/.codex}/sessions\"; ` +
      `if [ -d \"$base\" ]; then find \"$base\" -type f -name ${sh(`*${sessionId}*.jsonl`)} -print; fi`;
    // Codex 0.147 把 rollout JSONL 异步落到 sessions/YYYY/MM/DD/；进程刚结束时目录可能还没有。
    for (let attempt = 0; attempt < 8; attempt++) {
      const result = await runtime.run(command);
      if (result.stdout.trim()) {
        return readDiscovered(runtime, "codex", sessionId, result.stdout.split("\n"));
      }
      if (attempt === 7) {
        if (result.exitCode !== 0) {
          return { cli: "codex", sessionId, artifacts: [], captureError: result.stderr.trim() || "Codex Session 扫描失败" };
        }
        return readDiscovered(runtime, "codex", sessionId, []);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return readDiscovered(runtime, "codex", sessionId, []);
  },
};

const openCodeAdapter: AgentCliSessionAdapter = {
  cli: "open-code",
  async exportSession(runtime, sessionId) {
    // OpenCode 官方提供按 session 导出的 JSON；不复制可能混有其它会话与凭据的共享数据库。
    const result = await runtime.run(`opencode export ${sh(sessionId)} 2>/dev/null`);
    if (Buffer.byteLength(result.stdout) > MAX_SESSION_BYTES) {
      return { cli: "open-code", sessionId, artifacts: [], captureError: "OpenCode Session 导出超过 32 MiB，已停止归档" };
    }
    if (result.exitCode === 0 && result.stdout.trim()) {
      return {
        cli: "open-code",
        sessionId,
        artifacts: [{
          name: `${safeName(sessionId, sessionId, 0)}.json`,
          sourcePath: `opencode export ${sessionId}`,
          content: result.stdout,
          kind: "vendor_export",
        }],
      };
    }
    return {
      cli: "open-code",
      sessionId,
      artifacts: [],
      captureError: result.stderr.trim() || `opencode export ${sessionId} 未返回内容`,
    };
  },
};

const piAdapter: AgentCliSessionAdapter = {
  cli: "pi",
  async exportSession(runtime, sessionId, sessionFile) {
    if (!sessionFile || !sessionFile.startsWith("/workspace/.deepsonar-home/.pi/agent/")) {
      return { cli: "pi", sessionId, artifacts: [], captureError: "Pi 未返回受治理的 sessionFile，拒绝猜测会话路径" };
    }
    const normalized = sessionFile.replaceAll("\\", "/");
    if (normalized.includes("/../") || normalized.endsWith("/..")) {
      return { cli: "pi", sessionId, artifacts: [], captureError: "Pi sessionFile 路径越界，拒绝归档" };
    }
    const content = await runtime.readText(normalized);
    if (content === null) {
      return { cli: "pi", sessionId, artifacts: [], captureError: `未找到 Pi sessionFile ${sessionId}` };
    }
    if (Buffer.byteLength(content) > MAX_SESSION_BYTES) {
      return { cli: "pi", sessionId, artifacts: [], captureError: "Pi Session 文件超过 32 MiB，已停止归档" };
    }
    return {
      cli: "pi",
      sessionId,
      artifacts: [{
        name: safeName(normalized, sessionId, 0),
        sourcePath: normalized,
        content,
        kind: "main",
      }],
    };
  },
};

const dshAdapter: AgentCliSessionAdapter = {
  cli: "dsh",
  async exportSession(runtime, sessionId) {
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(sessionId)) {
      return { cli: "dsh", sessionId, artifacts: [], captureError: "DSH session ID 非法，拒绝扫描" };
    }
    const root = "/workspace/.deepsonar-home/.dsh/sessions";
    const command = `base=${sh(root)}; if [ -d "$base" ]; then find "$base" -type f -path ${sh(`*/${sessionId}/session.jsonl`)} -print 2>/dev/null; fi`;
    const result = await runtime.run(command);
    if (result.exitCode !== 0 && !result.stdout.trim()) {
      return { cli: "dsh", sessionId, artifacts: [], captureError: result.stderr.trim() || "DSH Session 扫描失败" };
    }
    const paths = [...new Set(result.stdout.split("\n").map((value) => value.trim()).filter(Boolean))];
    if (paths.length > 1) {
      return { cli: "dsh", sessionId, artifacts: [], captureError: `DSH session ${sessionId} 出现在多个项目目录，拒绝猜测` };
    }
    return readDiscovered(runtime, "dsh", sessionId, paths);
  },
};

export const CLI_SESSION_ADAPTERS: Record<SupportedAgentCli, AgentCliSessionAdapter> = {
  "claude-code": claudeAdapter,
  codex: codexAdapter,
  "open-code": openCodeAdapter,
  pi: piAdapter,
  dsh: dshAdapter,
};
