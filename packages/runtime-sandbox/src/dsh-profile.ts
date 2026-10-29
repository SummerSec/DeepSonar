import { stringify } from "yaml";
import { DSH_PI_COMPAT_SYSTEM_PROMPT } from "./dsh-request-frame.js";

export const DSH_VERSION = "0.2.1-rc.2";
export const DSH_HOME = "/workspace/.deepsonar-home/.dsh";
export const DSH_PROFILE = "deepsonar";
export const DSH_BIN = "/opt/deepsonar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js";
export const DSH_PROFILE_MANIFEST = JSON.stringify({ private: true, dsh: { profile: { bundles: [] } } });

interface Plugin { id: string; name: string; config?: Record<string, unknown>; inject?: string[] }

/** A closed plugin tree, never the SDK/base defaults: no UI, credentials, uploads,
 * native provider, plugin manager, arbitrary bundles or configuration watching. */
export function buildDshProfilePatch(options: {
  providerConfig: Record<string, unknown>;
  taskMode?: "standard" | "ptc";
  cwd: string;
  home?: string;
}): string {
  const home = options.home ?? DSH_HOME;
  const rows: Plugin[] = [];
  const add = (id: string, name = id, config?: Record<string, unknown>, inject?: string[]) => {
    rows.push({ id, name: `@deepseek-ai/dsh-${name}`, ...(config ? { config } : {}), ...(inject ? { inject } : {}) });
  };
  add("sdk-app-startup", "sdk-app", { profile: DSH_PROFILE });
  add("sdk-jsonrpc-server", "sdk-jsonrpc-server", { maxTokensAsSuccess: true }, ["sdkAppStartup", "loader"]);
  rows.push({ id: "timer", name: "@deepseek-ai/cordis-plugin-timer" });
  for (const id of ["llm", "session", "session-projection", "agent", "llm-retry", "mcp-resources"]) add(id);
  add("jobs", "jobs-local");
  // DSH 0.2.1-rc.2 起上游移除了 invariant 插件族（`@deepseek-ai/dsh-invariants` 与
  // dsh-{session,agent,scope,agent-loop} 的 `./invariant` 子路径），声明它们会让
  // profile 启动即失败（required plugin did not activate），因此不再加入。
  add("system-prompt", "system-prompt", {
    includeHarnessIdentity: false, includeRuntimeContext: false, personaPrefix: "__DEEPSONAR_DSH_SYSTEM_PROMPT__",
  });
  add("tools", "tools", { mode: options.taskMode === "ptc" ? "ptc" : "native" });
  add("agent-loop", "agent-loop", { agents: [] });
  add("llm-pi-ai", "llm-pi-ai", options.providerConfig);
  add("sandbox", "sandbox-local");
  add("sandbox-policy", "sandbox-policy", { mode: "danger-full-access", workspaceRoot: options.cwd });
  add("subprocess", "subprocess-local");
  add("shell-env");
  add("bash-local", "bash-local", { cwd: options.cwd, timeoutMs: 300000 });
  add("fs-local", "fs-local", { cwd: options.cwd });
  add("tool-bash", "tool-bash", { enableRunInBackground: true });
  add("fs-observation-policy");
  add("tool-fs");
  add("tool-fs-search", "tool-fs-search", { sampleOverCapGlobResults: false });
  add("str-replace-editor", "tool-str-replace-editor", { maxOutputChars: 16000 });
  add("skill");
  // Only Scheduler-materialized skills; a repository cannot add a discovery root.
  add("skill-filesystem", "skill-filesystem", { includeDefaultRoots: false, customSkillDirs: [`${home}/skills`] });
  add("tool-skill");
  add("subagent");
  add("subagent-spawn-in-process", "subagent-spawn-in-process", { providerName: "spawn" });
  add("subagent-fork-in-process", "subagent-fork-in-process", { providerName: "fork" });
  add("tool-subagent", "tool-subagent", { provider: "spawn", toolName: "subagent", backgroundMode: "continuable" });
  add("tool-subagent-control");
  add("tool-subagent-list-agents", "tool-subagent-control/list-agents");
  add("tool-subagent-fork", "tool-subagent", { provider: "fork", toolName: "subagent_fork", backgroundMode: "one-shot" });
  add("sessions", "session-persistence-jsonl", { root: `${home}/sessions`, compression: "none" });
  add("session-checkpoints", "session-checkpoint-policy");
  add("token-meter");
  add("compaction-basic", "compaction-basic", { thresholdRatio: 0.8, retainRatio: 0.16, maxTokens: 8192, compactionRetries: 1 });
  if (options.taskMode === "ptc") add("ptc-runtime", "ptc-runtime-node");
  return `# DeepSonar governed SDK profile. All plugins are explicit.\n${stringify([{ insert: rows }], { lineWidth: 0 })}`
    .replace("personaPrefix: __DEEPSONAR_DSH_SYSTEM_PROMPT__", `personaPrefix: !!js process.env.DSH_SYSTEM_PROMPT ?? ${JSON.stringify(DSH_PI_COMPAT_SYSTEM_PROMPT)}`);
}
