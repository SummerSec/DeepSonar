# Governed Agent CLI Runtime Adapters

> **Status: as-built (Issue #100 + Pi #140).** Pinned CLI versions live in
> `agent-harness/runtime-images.json` and `packages/runtime-sandbox/src/runtime-adapters.ts`.
> New CLI onboarding must also cover Session archive + Web session viewer (below).
> Index: [`README.md`](README.md).

Issue #100 defines the boundary between Scheduler-owned execution policy and
provider-specific CLI protocols.

## Contract

`packages/runtime-sandbox/src/runtime-adapters.ts` is the single registry for
real Agent CLIs. Each registered adapter declares:

- a stable adapter id and installed CLI version;
- required capabilities (`streamEvents`, `completionGate`, `sessionCapture`,
  and `contextCompaction`), plus explicit control-channel capabilities and optional
  incremental messaging and reasoning support; Provider-owned reasoning is projected per CLI (`effortLevel`, `model_reasoning_effort`, `--variant`, `--thinking`, or Pi-AI profile reasoning) instead of copied as a fictitious shared config key;
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
| `claude-code` | Claude Code 2.1.231 | `stream-json` + governed `--include-partial-messages` | yes | Automatic compaction; defaults `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` to `70`, with an explicit environment value taking precedence | 无受支持的绝对窗口落点；只冻结/展示，不注入伪造 flag/env | `stream_event` thinking/text deltas and complete assistant blocks |
| `codex` | Codex CLI 0.147.0 | `codex exec --json` JSONL | no | Codex's documented built-in automatic-compaction default | `model_context_window` | Official reasoning summary/item events when emitted |
| `open-code` | OpenCode 1.18.18 | `opencode run --format json --thinking` | no | Materialization defaults `compaction.auto` to `true`, preserving explicit values and all other compaction keys | selected model `limit.context` | Structured `reasoning`/`thinking` parts when emitted |
| `pi` | Pi Coding Agent 0.84.1 | `pi --mode rpc --no-approve` 严格 LF JSONL | yes | 自动上下文策略由 Pi 管理；恢复只接受 `get_state` 返回的精确 `sessionFile` | `models.json` model `contextWindow` | `message_update` 的结构化文本/思考事件 |
| `dsh` | DeepSeek Harness 0.1.0-rc.6 | 官方 SDK JSON-RPC packaged entrypoint，严格 LF JSONL；RoleConfig 可冻结 Standard（native tools）或 PTC（Code Mode `run_code`） | yes | 由 `@deepseek-ai/dsh-compaction-basic` 管理；恢复复用精确 session ID | DSH profile model 配置 | `session.event` 的结构化 reasoning 事件 |

五个适配器均声明 `contextCompaction: true` 和 Job 级 HTTP `platformControlApi: true`，
只有上下文策略受支持时才准入。Claude Code、Codex 与 OpenCode 同时保留 `controlMcp: true`，
每次逻辑操作由 Agent 自行在 MCP 与 API 中选择一个通道，不得重复提交；HTTP API 是长期统一控制面，MCP 仅作为待淘汰的过渡通道。Pi 与 DSH 不依赖 MCP，只使用 HTTP Capability API。DSH 的 `dsh_task_mode` 不是 JSON-RPC 初始化参数：适配器在 Job 启动前按冻结值物化 Cordis composition，`standard` 配置 `dsh-tools mode: native`，`ptc` 配置 `mode: code` 并挂载 `@deepseek-ai/dsh-code-runtime-worker-thread`。LLM composition 固定使用官方 `@deepseek-ai/dsh-llm-pi-ai`；Credential 中的 Provider YAML 按官方 `settings.yaml` 结构保存 `llm-pi-ai.providers` 与 `agent-default-model`，可声明任意安全 route 及单一 OpenAI/Anthropic 兼容 profile。DSH 默认强度只能是 Pi-AI 规范档位，模型 `reasoningEfforts` 把规范档位映射为第三方 wire value。Job 冻结 route/model/Provider-owned `reasoning` 后，运行时将 profile 强制投影到 Job Model Gateway，并以该 route/model 调用 JSON-RPC `initialize`；沙箱只得到短期 `DEEPSONAR_GATEWAY_TOKEN`。Base/Audit/Kali 镜像同时安装按 Git commit 与 tarball SHA-256 固定的 MIT 插件 `dsh-reasoning-settings@0.3.0`；生成的无 UI Cordis composition 只挂载其 host 部分，为已配置的单 route/model 提供 Subagent 按次选择和思考强度继承，不引入 Web client。相关官方 npm 包按版本与 integrity 固定。DSH 动态 Skill 物化到 `${DSH_HOME}/skills/<name>/SKILL.md`，由 `dsh-skill-filesystem` 发现并通过 `dsh-tool-skill` 按需加载；平台内置 `deepsonar-control` Skill 走同一路径。

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

### Session 归档 + Web 查看器（必做，勿只接运行时）

新增或升级 Agent CLI 时，**运行时适配器 ≠ Session 可观测性已完成**。Job 详情
`Session` 页依赖两层独立实现；缺一则前端只能空态或「原始」里看不懂的 dump：

| 层 | 位置 | 职责 |
| --- | --- | --- |
| **Session 归档** | `packages/runtime-sandbox/src/cli-session-adapters.ts`（`SupportedAgentCli` + `CLI_SESSION_ADAPTERS`） | 按 CLI 发现/导出原始 session（JSONL / vendor export），写入 Job evidence；`sessionCapture: true` 才启用 |
| **Session 查看器** | `apps/web/src/session-viewer/`（`parseAgentSession.ts` + `SessionViewer.tsx`） | 客户端解析归档文本 → 时间线 / 工具统计 / Token / 原始；**保留下载原始文件** |

当前五类 CLI 的归档边界如下；它们是独立格式，不承诺共用 schema：

| CLI | 归档来源/格式 | 明确边界 |
| --- | --- | --- |
| `claude-code` | 本次沙箱 `HOME/.claude/projects` 下匹配 `sessionId` 的 JSONL（含主会话与 `subagents`） | 发现/读取错误或累计超过 32 MiB 时显式 `captureError` |
| `codex` | `CODEX_HOME/sessions`（未设置时 `HOME/.codex/sessions`）的 JSONL | 仅按本次 `sessionId` 发现；发现/读取错误或累计超过 32 MiB 时显式 `captureError` |
| `open-code` | `opencode export <sessionId>` vendor export | stdout 超过 32 MiB、导出失败或空结果时显式 `captureError` |
| `pi` | runtime 返回且位于 `/workspace/.deepsonar-home/.pi/agent/` 的受治理 `sessionFile` JSONL | 缺失/路径越界/读取错误或超过 32 MiB 时显式 `captureError` |
| `dsh` | `/workspace/.deepsonar-home/.dsh/sessions/<project>/<sessionId>/session.jsonl` JSONL | 非法或多项目匹配、发现/读取错误或累计超过 32 MiB 时显式 `captureError` |

查看器为每种 CLI 分别归一化消息、reasoning、tool call/result、usage；仅当对应 CLI 的归档实际持久化了 DeepSonar 注入文本时，才生成 `broadcast` 条目。归档内 malformed 行不伪造结构，保留 `skipped` 计数；原始归档始终可下载。

画布上的广播徽标与连线是 `canvas_broadcasts` 投递账本的派生视觉 overlay，不写入 `canvas_nodes` / `canvas_edges`；Session 页的 `broadcast` 则来自 CLI 实际持久化的注入文本，只作为账本旁证，也不是读取或 ACK 回执。`injected` 只表示 Scheduler/adapter 已成功把文本写入 Agent session 输入。当前 Codex/OpenCode 的 `incrementalMessages` 未订阅运行时广播，因此查看器不会暗示它们收到 live broadcast。

接入新 CLI 的强制清单（与 compaction 并列 fail-closed 心智）：

1. **扩展 `SupportedAgentCli`**，并实现 `AgentCliSessionAdapter.exportSession`：只依赖本次运行的 session identity（及 Pi 的受治理 `sessionFile`），禁止扫共享 DB / latest / 跨 Job 路径；malformed identity/path、超大体积与导出/读取错误显式 fail closed（见现有 Claude/Codex/OpenCode/Pi/DSH 适配器）。
2. **runtime adapter** 声明 `sessionCapture: true`，并保证流里能捕获稳定 `sessionId`（Pi 还要 `sessionFile`），否则归档永远空。
3. **扩展 Web 解析**：在 `parseAgentSession.ts` 增加该 CLI 的行/文档解析（或 `cli` hint 下的专用路径），更新 `normalizeSessionCli` / `sessionCliLabel`，并补 `parseAgentSession.test.ts` 样例（至少：用户消息、助手、一次 tool_call + tool_result、Token 若可得）。
4. **不要假设**「Codex 目录结构」或「Claude JSONL」可复用；每种 CLI 的 on-disk / export 形态单独适配。参考外部 [agent-session-viewer](https://github.com/cuteribs/agent-session-viewer) 仅作 UX/格式灵感，**不 vendor 整站**。
5. **验收**：真实或 fixture 归档经 `GET /jobs/:id/evidence/session` 可读；Job 详情 Session 标签出现时间线/统计；「下载原始文件」仍指向未改写的归档字节；解析失败时仍可看「原始」与下载。
6. 若暂不支持归档：显式保持 `sessionCapture: false`，并在 UI/空态文案中可区分「未实现」与「运行失败」；**禁止**半吊子路径猜测冒充归档。

当前已适配查看器的 CLI：`claude-code`、`codex`、`open-code`、`pi`、`dsh`（与 runtime registry 对齐）。后续每加一个 adapter，**同步 PR 应包含 session adapter + parseAgentSession + 测试**，不要拆成「先跑起来以后再做 Session」。

`reasoningEffort` is an input/configuration capability; it does not guarantee
that a provider exposes its internal reasoning in output. The runtime only
normalizes an explicitly structured reasoning event (`reasoning.delta`) and
never infers or fabricates reasoning from ordinary text, tool output, or
terminal lines. If the selected CLI/model does not emit a supported reasoning
event, the live and archived stream simply contains no reasoning block.

Claude partial frames are enabled only for the pinned 2.1.231 governed minimum
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
