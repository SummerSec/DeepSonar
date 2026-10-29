// Structural parity with production dsh-profile.ts is checked by runtime-adapters.test.ts.
export const DSH_VERSION = "0.2.1-rc.2";
export const DSH_HOME = "/workspace/.deepsonar-home/.dsh";
export const DSH_PROFILE = "deepsonar";
export const DSH_BIN = "/opt/deepsonar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js";
export const DSH_PROFILE_MANIFEST = JSON.stringify({ private: true, dsh: { profile: { bundles: [] } } });

/** A closed plugin tree, never the SDK/base defaults: no UI, credentials, uploads,
 * native provider, plugin manager, arbitrary bundles or configuration watching. */
export function buildDshProfilePatch(options) {
  const home = options.home ?? DSH_HOME;
  const rows = [];
  const add = (id, name = id, config, inject) => {
    rows.push({ id, name: `@deepseek-ai/dsh-${name}`, ...(config ? { config } : {}), ...(inject ? { inject } : {}) });
  };
  add("sdk-app-startup", "sdk-app", { profile: DSH_PROFILE });
  add("sdk-jsonrpc-server", "sdk-jsonrpc-server", { maxTokensAsSuccess: true }, ["sdkAppStartup", "loader"]);
  rows.push({ id: "timer", name: "@deepseek-ai/cordis-plugin-timer" });
  for (const id of ["llm", "session", "session-projection", "agent", "llm-retry", "mcp-resources"]) add(id);
  add("jobs", "jobs-local");
  add("invariants");
  for (const id of ["session", "agent", "scope", "agent-loop"]) add(`${id}-invariant`, `${id}/invariant`);
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
  return JSON.stringify([{ insert: rows.map(row => row.id === "system-prompt" ? { ...row, config: { ...row.config, personaPrefix: "DeepSonar isolated SDK smoke" } } : row) }], null, 2);
}

export const DSH_SMOKE_PROVIDER = "deepsonar-smoke";
export const DSH_SMOKE_MODEL = "cordis-smoke";
export function buildDshCordisSmokeConfig({ cwd = "/workspace", home = DSH_HOME, taskMode = "standard", baseURL = "http://127.0.0.1:1/gateway" } = {}) {
  return buildDshProfilePatch({ cwd, home, taskMode, providerConfig: {
    providers: { [DSH_SMOKE_PROVIDER]: { api: "openai-completions", apiKeyEnv: "DEEPSONAR_GATEWAY_TOKEN", baseURL, reasoning: "high", models: [{ id: DSH_SMOKE_MODEL, reasoningEfforts: { high: "high" } }] } },
  } });
}
