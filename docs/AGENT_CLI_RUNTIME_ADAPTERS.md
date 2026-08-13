# Governed Agent CLI Runtime Adapters

Issue #100 defines the boundary between Scheduler-owned execution policy and
provider-specific CLI protocols.

## Contract

`packages/runtime-sandbox/src/runtime-adapters.ts` is the single registry for
real Agent CLIs. Each registered adapter declares:

- a stable adapter id and installed CLI version;
- required capabilities (`streamEvents`, `completionGate`, `sessionCapture`,
  and `contextCompaction`), plus explicit control-channel capabilities and optional
  incremental messaging and reasoning support;
- the governed runtime image keys on which it may run;
- a fixed command invocation and structured input/output codec.
- 显式的同 session 恢复操作，用于进程级故障恢复。运行中 stdin 增量消息与
  进程退出后的恢复是两个独立能力：即使 CLI 支持 stdin 更新，也必须能在
  临时上游故障导致进程退出后恢复已捕获的 session。

The adapter owns only protocol translation and provider configuration
materialization. The host still owns sandbox lifecycle, semantic control MCP,
event validation, completion gates, leases, and all state transitions. Output
is consumed as structured JSON events; terminal text is never scraped.

The current registry contains:

| Adapter | CLI | Protocol | Incremental messages | Context policy | `context_window_tokens` materialization | Structured reasoning |
| --- | --- | --- | --- | --- | --- | --- |
| `claude-code` | Claude Code 2.1.220 | `stream-json` + governed `--include-partial-messages` | yes | Automatic compaction; defaults `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` to `70`, with an explicit environment value taking precedence | 无受支持的绝对窗口落点；只冻结/展示，不注入伪造 flag/env | `stream_event` thinking/text deltas and complete assistant blocks |
| `codex` | Codex CLI 0.147.0 | `codex exec --json` JSONL | no | Codex's documented built-in automatic-compaction default | `model_context_window` | Official reasoning summary/item events when emitted |
| `open-code` | OpenCode 1.18.15 | `opencode run --format json --thinking` | no | Materialization defaults `compaction.auto` to `true`, preserving explicit values and all other compaction keys | selected model `limit.context` | Structured `reasoning`/`thinking` parts when emitted |
| `pi` | Pi Coding Agent 0.84.1 | `pi --mode rpc --no-approve` 严格 LF JSONL | yes | 自动上下文策略由 Pi 管理；恢复只接受 `get_state` 返回的精确 `sessionFile` | `models.json` model `contextWindow` | `message_update` 的结构化文本/思考事件 |

四个适配器均声明 `contextCompaction: true` 和 Job 级 HTTP `platformControlApi: true`，
只有上下文策略受支持时才准入。Claude Code、Codex 与 OpenCode 同时保留 `controlMcp: true`，
每次逻辑操作由 Agent 自行在 MCP 与 API 中选择一个通道，不得重复提交；HTTP API 是长期统一控制面，MCP 仅作为待淘汰的过渡通道。Pi 不依赖 MCP，只使用 HTTP Capability API。

通用 `context_window_tokens` 范围为 1024–10000000。Credential 顶层值是客户端基准，RoleConfig 同名值优先；两者为空时保留 Provider / CLI 默认，建 Job 时冻结解析结果。它只控制客户端预算/压缩落点，不提高 Provider、模型 ID 或账号实际开放的上游窗口；模型目录也只登记 ID，不根据名称或营销标签推断长上下文能力。

宿主只恢复明确的临时上游故障（HTTP 408/429/500/502/503/504、timeout 和
network）。它在同一沙箱内按已捕获的精确 session ID 最多恢复三次，并使用
有界退避。永久 HTTP 错误、缺少 session ID、适配器不支持以及次数耗尽均
fail closed；宿主绝不选择 latest session，也不创建新的兜底会话。

## New adapter onboarding checklist

Every new CLI must declare and test automatic context compaction before it can
be registered or admitted:

1. Add `contextCompaction: true` and document the exact upstream or adapter
   policy, including defaults and explicit overrides.
2. Add adapter tests that exercise the automatic-compaction behavior and verify
   that unsupported provider flags or environment variables are not injected.
3. If the upstream CLI has no automatic compaction, the adapter must implement
   a bounded summary/new-session handoff and declare the
   `bounded-session-summary` policy.
4. Do not admit the adapter until the declaration, tests, and bounded-session
   behavior (when needed) are complete.

`reasoningEffort` is an input/configuration capability; it does not guarantee
that a provider exposes its internal reasoning in output. The runtime only
normalizes an explicitly structured reasoning event (`reasoning.delta`) and
never infers or fabricates reasoning from ordinary text, tool output, or
terminal lines. If the selected CLI/model does not emit a supported reasoning
event, the live and archived stream simply contains no reasoning block.

Claude partial frames are enabled only for the pinned 2.1.220 governed minimum
above. `content_block_delta` `thinking_delta`/`text_delta` frames are
normalized to `reasoning.delta`/`text.delta`; the later complete assistant
message remains accepted for compatibility but is de-duplicated against those
frames. Codex and OpenCode complete item/part frames are likewise de-duplicated
when they repeat an official reasoning delta.

## Snapshot and admission

At Job creation, Scheduler resolves the adapter against the frozen runtime
image and stores `adapter_id`, `adapter_version`, and the complete capability
object in `agent_snapshot_json`. The executor passes that snapshot unchanged
to the sandbox runner. Runtime execution rejects a changed snapshot,
unregistered adapter, missing required capability, or incompatible image before
starting a CLI process.

The image manifests in `agent-harness/runtime-images.json` and
`agent-harness/kali-minimal-runtime.json` declare the installed CLI package,
version, and `agent_cli` identity. The Dockerfiles install those exact
versions, and `agent-harness/check-runtime-image-consistency.mjs` checks the
manifest/Dockerfile contract.

## Security boundaries

CLI commands are adapter-owned fixed invocations. User, task, and Agent input
is passed as data through the CLI's supported prompt or stdin interface; no
arbitrary command template is accepted. The existing host MCP control flow is
unchanged: only validated `tool_use`/`tool_result` pairs can release semantic
events, with bounded pending state and redacted telemetry. Provider credentials
remain outside the snapshot and are not emitted by adapter codecs.

## Pi Coding Agent RPC（#140）

Pi 的启动命令由适配器固定为 `pi --mode rpc --no-approve --no-extensions
--session-dir /workspace/.deepsonar-home/.pi/agent`。初始提示通过 RPC 输入发送；运行中
消息使用 `steer` 或 `follow_up`，启动后先发送 `get_state` 获取会话身份。每个输入块都交给
同一个持久 `TextDecoder`，再按 LF 分帧；CRLF 会去掉回车，U+2028/U+2029 仍保留为数据。
半帧、非法 UTF-8、空行、超大行和未知事件均 fail closed，`finish()` 会显式拒绝尾部残帧。

`agent_end`、进程退出和普通响应都不能宣告成功，只有 `agent_settled` 提供 Agent 侧静止
信号；Scheduler 仍要求已授权的 `mark_job_done` 通过完成门。临时网络错误在同一沙箱内最多
按原会话恢复三次，恢复必须使用 `get_state` 返回并经过路径校验的精确 `sessionFile`。

Pi 不物化 MCP 配置，也不调用 `pi.registerTool`。平台静态 `deepsonar-control` Skill 固定物化到
`~/.pi/agent/skills/deepsonar-control/SKILL.md`，引导调用
`GET $DEEPSONAR_API_BASE_URL/agent/capabilities_list`；返回的每个获准 operation 直接携带输入 JSON Schema，后续请求由短期 Job token 和
冻结 operation allowlist 再次鉴权。Provider 配置物化为 `.pi/agent/models.json`，模型请求
统一改写到 Gateway，长期密钥不进入 snapshot、workspace、运行清单或 evidence。

项目 `.pi` 目录不会自动加载。RoleConfig 只能冻结受治理的 `.pi/agent/extensions/` 文件；
默认保留 `--no-extensions`，批准的扩展才通过单独的 `--extension` 参数加载。运行镜像清单
和 Dockerfile 固定 `@earendil-works/pi-coding-agent@0.84.1` 及其 integrity，构建阶段会
实际查询 npm integrity 并在不匹配时失败。

## Verification

Contract tests cover registry admission, capability and image rejection,
Claude compatibility, Codex/OpenCode lifecycle normalization, tool completion,
and stdin behavior. Full local-docker CLI smokes additionally require the
corresponding provider credentials; credential-unavailable results must be
reported separately from adapter or parser failures.
