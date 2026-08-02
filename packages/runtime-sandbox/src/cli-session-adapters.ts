/** Agent CLI 原始 Session 发现适配器；不同 CLI 不共享目录假设。 */

export type SupportedAgentCli = "claude-code" | "codex" | "open-code";

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
  exportSession(runtime: SessionDiscoveryRuntime, sessionId: string): Promise<SessionBundle>;
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
      `find /root/.claude/projects -type f \\( -name ${sh(`${sessionId}.jsonl`)} ` +
      `-o -path ${sh(`*/${sessionId}/subagents/*.jsonl`)} \\) -print 2>/dev/null`;
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
      `base=\"\${CODEX_HOME:-/root/.codex}/sessions\"; ` +
      `if [ -d \"$base\" ]; then find \"$base\" -type f -name '*.jsonl' ` +
      `\\( -name ${sh(`*${sessionId}*.jsonl`)} -o -exec grep -l -m1 -- ${sh(sessionId)} {} \\; \\) 2>/dev/null; fi`;
    const result = await runtime.run(command);
    if (result.exitCode !== 0 && !result.stdout.trim()) {
      return { cli: "codex", sessionId, artifacts: [], captureError: result.stderr.trim() || "Codex Session 扫描失败" };
    }
    return readDiscovered(runtime, "codex", sessionId, result.stdout.split("\n"));
  },
};

const openCodeAdapter: AgentCliSessionAdapter = {
  cli: "open-code",
  async exportSession(runtime, sessionId) {
    // OpenCode 官方提供按 session 导出的 JSON；不复制可能混有其它会话与凭据的共享数据库。
    const result = await runtime.run(`opencode export ${sh(sessionId)} 2>/dev/null`);
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

export const CLI_SESSION_ADAPTERS: Record<SupportedAgentCli, AgentCliSessionAdapter> = {
  "claude-code": claudeAdapter,
  codex: codexAdapter,
  "open-code": openCodeAdapter,
};
