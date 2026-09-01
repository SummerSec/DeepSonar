export const DSH_SMOKE_PROVIDER = "deepsonar-smoke";
export const DSH_SMOKE_MODEL = "cordis-boot-only";

/**
 * Standard-mode counterpart of runtime-adapters.ts materializeDsh().
 *
 * This deliberately carries the complete UI-less platform composition so a
 * packaged-bin boot validates every configured plugin against the versions
 * installed in the runtime image. No prompt is sent and the unreachable model
 * endpoint must never be called.
 */
export function buildDshCordisSmokeConfig() {
  const providerConfig = {
    providers: {
      [DSH_SMOKE_PROVIDER]: {
        api: "openai-responses",
        apiKeyEnv: "DEEPSONAR_GATEWAY_TOKEN",
        baseURL: "http://127.0.0.1:1/gateway",
        models: [{ id: DSH_SMOKE_MODEL }],
      },
    },
  };
  return `# DeepSonar governed unattended DSH composition. No UI plugins.
- id: sdk-jsonrpc-server
  name: '@deepseek-ai/dsh-sdk-jsonrpc-server'
  config:
    maxTokensAsSuccess: true

- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config: ${JSON.stringify(providerConfig)}

- id: reasoning-settings
  name: dsh-reasoning-settings
  config:
    subagentRouting: true
    inheritRoute: true
    resolveModelOnly: true
    inheritReasoning: true

- id: sandbox
  name: '@deepseek-ai/dsh-sandbox-local'

- id: sandbox-policy
  name: '@deepseek-ai/dsh-sandbox-policy'
  config:
    mode: danger-full-access
    workspaceRoot: !!js process.env.DSH_CWD ?? process.cwd()

- id: subprocess
  name: '@deepseek-ai/dsh-subprocess-local'

- id: bash-local
  name: '@deepseek-ai/dsh-bash-local'
  config:
    cwd: !!js process.env.DSH_CWD ?? process.cwd()
    timeoutMs: 300000

- id: fs-local
  name: '@deepseek-ai/dsh-fs-local'
  config:
    cwd: !!js process.env.DSH_CWD ?? process.cwd()

- id: agent-spine
  name: '@deepseek-ai/dsh-agent-spine-demo'
  config:
    dshHome: !!js process.env.DSH_HOME ?? '/workspace/.deepsonar-home/.dsh'
    includeHarnessIdentity: false
    includeRuntimeContext: false
    persona: !!js process.env.DSH_SYSTEM_PROMPT ?? 'You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.'
    tools:
      mode: native
    workspaceContext: false
    skills:
      enabled: true
    toolBash:
      enableRunInBackground: true
    toolJobs: false

- id: str-replace-editor
  name: '@deepseek-ai/dsh-tool-str-replace-editor'
  config:
    maxOutputChars: 16000

- id: sessions
  name: '@deepseek-ai/dsh-session-persistence-jsonl'
  config:
    root: !!js process.env.DSH_SESSION_ROOT ?? './.sessions'
    compression: none

- id: session-checkpoints
  name: '@deepseek-ai/dsh-session-checkpoint-policy'

- id: token-meter
  name: '@deepseek-ai/dsh-token-meter'

- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
  config:
    thresholdRatio: 0.8
    retainRatio: 0.16
    maxTokens: 8192
    compactionRetries: 1
`;
}
