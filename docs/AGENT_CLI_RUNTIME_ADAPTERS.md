# Governed Agent CLI Runtime Adapters

> **Status: as-built (Issue #100 + Pi #140; DSH 0.2.1-rc.2 migration).** Pinned
> CLI versions live in `agent-harness/runtime-images.json` and
> `packages/runtime-sandbox/src/runtime-adapters.ts`. New CLI onboarding must also
> cover Session archive + Web session viewer (below). Index: [`README.md`](README.md).

Issue #100 defines the boundary between Scheduler-owned execution policy and
provider-specific CLI protocols.

### DSH 异步子代理完成边界（#766）

DSH 0.2.1-rc.2 的 `subagent` 立即返回 activation，父会话首次 idle 不表示任务结束。适配器只接受已知父会话的 `subagent.started`，并记录子会话谱系；活跃子会话的 `session.status=idle` 不能释放完成门，必须收到对应父子关系的 `subagent.finished`。可继续的子会话再次 running 会重新进入活跃集合。全部子代理完成后，仍等待父会话处理回传并再次 idle，才允许执行 `mark_job_done` 完成门及最多三次催促。父会话显式错误仍立即失败；取消、超时与清理由原 Job/RuntimeHost 边界负责。

`dsh-0.2.1-rc.2.subagent-lifecycle.json` 是新版真实 SDK + governed profile + 本地 mock Gateway 的协议投影，用于 `runtime-dsh-recovery.test.ts` 回放真实 `runRealAgent`。录制命令为 `DEEPSONAR_DSH_CAPTURE=<path> node agent-harness/dsh-sdk-smoke-driver.mjs <pinned-dsh-bin>`；initial 保留子代理阶段的 session status、started/finished、assistant/user message、turn/end，移除 timestamps、stream、source 和 reasoning，归一化父子 ID 与临时 workspace 路径。followup 来自同一版本的真实 SDK 催促回合（本地 mock 不提交完成回执），不是手写协议。夹具不宣称覆盖全部模型输出或生产任务。

真实 SDK smoke 以父 idle 事件释放子响应，确定性覆盖父先 idle 的顺序，不使用固定 sleep；验证 child finished、子结果内容、父收到结果并再次 idle 后才 shutdown。旧版本夹具保留历史格式证据，新运行时子代理结算只使用上述新版夹具。

## Contract

`packages/runtime-sandbox/src/runtime-adapters.ts` is the single registry for
real Agent CLIs. Adapters talk only to the provider-neutral `RuntimeHost`
(`run` / `runAsync` / `uploadFile`); they must not import Agentbox or
OpenSandbox SDK types. Each registered adapter declares:

- a stable adapter id and installed CLI version;
- required capabilities (`streamEvents`, `completionGate`, `sessionCapture`,
  `contextCompaction`, and `interactiveTerminal`), plus explicit control-channel capabilities and optional
  incremental messaging and reasoning support; Provider-owned reasoning is projected per CLI (`effortLevel`, `model_reasoning_effort`, `--variant`, `--thinking`, or Pi-AI profile reasoning) instead of copied as a fictitious shared config key;
- the governed runtime image keys on which it may run;
- a fixed command invocation and structured input/output codec.
- 显式的同 session follow-up / 恢复能力声明。运行中增量消息、同进程 follow-up
  与进程退出后的持久会话恢复是三个独立能力；适配器必须把不支持的持久恢复
  显式报告为终态错误，不能静默创建新会话或重放。

The adapter owns only protocol translation and provider configuration
materialization. The host still owns sandbox lifecycle, the Job-level HTTP
control API, event validation, completion gates, leases, and all state
transitions. Output is consumed as structured JSON events; terminal text is
never scraped.

DSH vendor dialect (official `settings.yaml` parse, secret-key reject, single
route/profile rewrite onto the Job Gateway, pi-compatible `input[0]` frame, and
Cordis composition) lives in `packages/runtime-sandbox/src/dsh-pi-ai.ts` plus
the DSH adapter. Scheduler management APIs call that parse/project for write
validation and snapshot freeze; `executor-real` only calls
`adapter.projectRuntime`. Generic dispatcher / Hub / job-lifecycle code must
not import DSH wire schema. DSH/Pi decode contracts (#389) live in
`decodePi` / `decodeDsh`, session adapters, and the Web session-viewer;
they do not re-parse vendor YAML.

The current registry (`AGENT_CLI_RUNTIME_ADAPTERS`) contains three write/run CLIs. Leftover `codex` / `open-code` adapters are retired from new RoleConfig/Job writes; historical snapshots and Session archives stay readable. Official images no longer install leftover `@openai/codex` / `opencode-ai`. Adding a later CLI still follows the onboarding checklist below and registers in the same table.

| Adapter | CLI | Protocol | Incremental messages | Context policy | `context_window_tokens` materialization | Structured reasoning |
| --- | --- | --- | --- | --- | --- | --- |
| `claude-code` | Claude Code 2.1.312 | `stream-json` + governed `--include-partial-messages` | yes | Automatic compaction; defaults `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` to `70`, with an explicit environment value taking precedence | 无受支持的绝对窗口落点；只冻结/展示，不注入伪造 flag/env | `stream_event` thinking/text deltas and complete assistant blocks |
| `pi` | Pi Coding Agent 1.1.0 | `pi --mode rpc --no-approve` 严格 LF JSONL | yes | 自动上下文策略由 Pi 管理；恢复只接受 `get_state` 返回的精确 `sessionFile` | `models.json` model `contextWindow` | `message_update` 的结构化文本/思考事件 |
| `dsh` | DeepSeek Harness 0.2.1-rc.2 | 官方 `dsh --profile` SDK JSON-RPC launcher，严格 LF JSONL；RoleConfig 可冻结 Standard（native tools）或 PTC（`run_code`） | yes | `compaction-basic` 自动压缩；同进程 `session/prompt` follow-up；跨进程持久 Session resume 不支持 | DSH profile / Gateway model 配置 | `session.event` 的结构化 reasoning 事件 |

DSH 的首条 system 消息由适配器通过 `DSH_SYSTEM_PROMPT` 投影到 pi-compatible
`input[0]`，以兼容会按客户端身份过滤的 OpenAI-compatible Gateway；平台 system prompt
追加在身份前缀之后，`includeHarnessIdentity` / runtime context 均关闭。失败时 `turn/end`
会尽量抽出嵌套 JSON 的 `message`，避免只剩通用错误。

当前三类适配器均声明 `contextCompaction: true` 与 `platformControlApi: true`，只有上下文
策略受支持时才准入。语义事件只走 Job 级 HTTP Control API，不注入控制 MCP，也不把伪造
MCP tool call 映射为语义事件。DSH 的 `dsh_task_mode` 不是 JSON-RPC 初始化参数：适配器在
Job 启动前按冻结值物化 `deepsonar` profile，`standard` 配置 native tools，`ptc` 配置 PTC
并挂载 `@deepseek-ai/dsh-ptc-runtime-node`，使用 `run_code`。Provider YAML 按官方
`settings.yaml` 形状解析为一个 Gateway route/model，沙箱只得到短期
`DEEPSONAR_GATEWAY_TOKEN`；原生 DeepSeek routes、设置/credential discovery、plugin-manager
和遥测不进入治理 profile。Skills 只从 Scheduler 物化的 `${DSH_HOME}/skills` 根发现，仓库
不能添加 discovery root。

官方 CLI 的 package closure 统一固定为 `@deepseek-ai/dsh@0.2.1-rc.2`，锁在
`agent-harness/dsh-runtime/package-lock.json`，镜像在 `/opt/deepsonar/dsh` 执行
`npm ci --omit=dev --ignore-scripts --no-audit --no-fund`。profile manifest 明确
`bundles: []`，`packages/runtime-sandbox/src/dsh-profile.ts` 显式列出 core/services,
Gateway LLM, bash/filesystem, skills, subagents, sessions/token-meter 和 compaction；旧
agent-spine、UI/web、settings/credential、native-provider、plugin-manager 和
`dsh-reasoning-settings` 不是运行时依赖。安装包虽包含 dormant UI 依赖，profile 不会启动 UI
或 web server，也不读取 home-level overrides；每次 Job 都重物化 profile/home 配置。

截至 2026-10-10，选择的是官方 [`dsh-v0.2.1-rc.2`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.2)；`0.2.1-alpha.2`（Oct 9）存在但未选。官方源码入口为
[`apps/cli`](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-rc.2/apps/cli)、
[`server.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/sdk/server/src/server.ts)
和 [`protocol/types.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/sdk/protocol/src/types.ts)。
此前的 `dsh-sdk-jsonrpc-demo` entrypoint 已退休；唯一 launcher 是官方 `dsh --profile`。历史纠偏：旧 `0.1.1-rc.2` 路径同样总是调用 `agents.create`，并不支持已持久 Session 的跨进程恢复；此前把它写成“恢复复用精确 session ID”是错误的历史描述。当前 adapter 已明确 `persistentSessionResume: false`，终态返回 `CONTEXT_RESUME_UNSUPPORTED`。

通用 `context_window_tokens` 范围为 1024–10000000。Credential 顶层值是客户端基准，RoleConfig 同名值优先；两者为空时保留 Provider / CLI 默认，建 Job 时冻结解析结果。它只控制客户端预算/压缩落点，不提高 Provider、模型 ID 或账号实际开放的上游窗口；模型目录也只登记 ID，不根据名称或营销标签推断长上下文能力。

宿主只恢复明确的临时上游故障（HTTP 408/429/500/502/503/504、timeout 和
network）。支持持久恢复的适配器在同一沙箱内按已捕获的精确 session identity 最多恢复三次，
并使用有界退避；DSH `persistentSessionResume: false`，跨进程恢复直接返回
`CONTEXT_RESUME_UNSUPPORTED`，不能静默创建新会话或重试。永久 HTTP 错误、缺少身份、适配器
不支持以及次数耗尽均 fail closed。

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
| **Session 查看器** | `apps/web/src/session-viewer/`（`parseAgentSession.ts` 当前三类；`legacy-session/` leftover Codex/OpenCode；`SessionViewer.tsx`） | 客户端解析归档文本 → 时间线 / 用量（归档 usage + Gateway 账本） / 工具统计 / 原始；可切换 `main` / `subagent` 归档；**保留下载所选原始文件** |

当前三类 CLI 的归档边界如下；它们是独立格式，不承诺共用 schema。leftover `codex` / `open-code` 归档仍由 Web 查看器只读解析，不再作为新 Job 的运行时 adapter。

| CLI | 归档来源/格式 | 明确边界 |
| --- | --- | --- |
| `claude-code` | 本次沙箱 `HOME/.claude/projects` 下匹配 `sessionId` 的 JSONL（含主会话与 `subagents`） | 发现/读取错误或累计超过 32 MiB 时显式 `captureError` |
| `pi` | runtime 返回且位于 `/workspace/.deepsonar-home/.pi/agent/` 的受治理 `sessionFile` JSONL | 缺失/路径越界/读取错误或超过 32 MiB 时显式 `captureError` |
| `dsh` | 当前运行时只发现 `/workspace/.deepsonar-home/.dsh/sessions/<project>/<sessionId>/session.v4.jsonl`；历史 v0–v3 由 Web 查看器读取 | 非法或多项目匹配、发现/读取错误或累计超过 32 MiB 时显式 `captureError`；live capture 不回退旧代 |
| leftover `codex`（retired） | 历史 `CODEX_HOME/sessions` rollout JSONL | 只读归档；新 RoleConfig/Job 拒绝 |
| leftover `open-code`（retired） | 历史 `opencode export` vendor export | 只读归档；新 RoleConfig/Job 拒绝 |

查看器为每种 CLI 分别归一化消息、reasoning、tool call/result、usage；仅当对应 CLI 的归档实际持久化了 DeepSonar 注入文本时，才生成 `broadcast` 条目。归档内 malformed 行不伪造结构，保留 `skipped` 计数；原始归档始终可下载。

画布上的广播徽标与连线是 `canvas_broadcasts` 投递账本的派生视觉 overlay，不写入 `canvas_nodes` / `canvas_edges`；Session 页的 `broadcast` 则来自 CLI 实际持久化的注入文本，只作为账本旁证，也不是读取或 ACK 回执。`injected` 只表示 Scheduler/adapter 已成功把文本写入 Agent session 输入。当前三类 CLI 中声明 `incrementalMessages` 的才会订阅运行时广播。

接入新 CLI 的强制清单（与 compaction 并列 fail-closed 心智）：

1. **扩展 `SupportedAgentCli`**，并实现 `AgentCliSessionAdapter.exportSession`：只依赖本次运行的 session identity（及 Pi 的受治理 `sessionFile`），禁止扫共享 DB / latest / 跨 Job 路径；malformed identity/path、超大体积与导出/读取错误显式 fail closed（见现有 Claude/Pi/DSH 适配器）。
2. **runtime adapter** 声明 `sessionCapture: true`，并保证流里能捕获稳定 `sessionId`（Pi 还要 `sessionFile`），否则归档永远空。
3. **扩展 Web 解析**：在 `parseAgentSession.ts` 增加该 CLI 的行/文档解析（或 `cli` hint 下的专用路径），更新 `normalizeSessionCli` / `sessionCliLabel`，并补 `parseAgentSession.test.ts` 样例（至少：用户消息、助手、一次 tool_call + tool_result、Token 若可得）。leftover Codex/OpenCode 只改 `legacy-session/`，不回到热路径。
4. **不要假设**「Codex 目录结构」或「Claude JSONL」可复用；每种 CLI 的 on-disk / export 形态单独适配。参考外部 [agent-session-viewer](https://github.com/cuteribs/agent-session-viewer) 仅作 UX/格式灵感，**不 vendor 整站**。
5. **验收**：真实或 fixture 归档经 `GET /jobs/:id/evidence/session` 可读；有 subagent 时 `artifacts` 可切换且 `?path=` 能读到对应文件；Job 详情 Session 标签出现时间线/统计；「下载原始文件」仍指向未改写的所选归档字节；解析失败时仍可看「原始」与下载。
6. 若暂不支持归档：显式保持 `sessionCapture: false`，并在 UI/空态文案中可区分「未实现」与「运行失败」；**禁止**半吊子路径猜测冒充归档。

当前运行时注册表对齐 `claude-code`、`pi`、`dsh`。leftover `codex` / `open-code` 仅保留查看器只读解析。后续每加一个 adapter，**同步 PR 应包含 session adapter + parseAgentSession + 测试**，不要拆成「先跑起来以后再做 Session」。

`reasoningEffort` is an input/configuration capability; it does not guarantee
that a provider exposes its internal reasoning in output. The runtime only
normalizes an explicitly structured reasoning event (`reasoning.delta`) and
never infers or fabricates reasoning from ordinary text, tool output, or
terminal lines. If the selected CLI/model does not emit a supported reasoning
event, the live and archived stream simply contains no reasoning block.

Claude partial frames are enabled only for the pinned 2.1.312 governed minimum
above. `content_block_delta` `thinking_delta`/`text_delta` frames are
normalized to `reasoning.delta`/`text.delta`; the later complete assistant
message remains accepted for compatibility but is de-duplicated against those
frames. leftover Codex/OpenCode session archives still de-duplicate complete
item/part frames when they repeat an official reasoning delta.

## Snapshot and admission

At Job creation, Scheduler resolves the adapter against the frozen runtime
image and stores `adapter_id`, `adapter_version`, and the complete capability
object in `agent_snapshot_json`. The executor passes that snapshot unchanged
to the sandbox runner. Runtime execution rejects a changed snapshot,
unregistered adapter, missing required capability, or incompatible image before
starting a CLI process.

The image manifests in `agent-harness/runtime-images.json` and
`agent-harness/kali-minimal-runtime.json` declare the installed CLI package,
version, and `agent_cli` identity. DSH additionally uses the isolated
`agent-harness/dsh-runtime/package-lock.json` closure and the official `dsh --profile`
launcher; `agent-harness/check-dsh-runtime.mjs` checks the lock/profile/Docker contract.
The Dockerfiles install those exact versions, and `agent-harness/check-runtime-image-consistency.mjs`
checks the general manifest/Dockerfile contract.

## Security boundaries

CLI commands are adapter-owned fixed invocations. User, task, and Agent input
is passed as data through the CLI's supported prompt or stdin interface; no
arbitrary command template is accepted. Semantic events are accepted only through
the Job-level HTTP Control API and its frozen operation allowlist; ordinary output,
forged tool calls, and Session text cannot release semantic events. Provider
credentials remain outside the snapshot and are not emitted by adapter codecs.

DSH JSON-RPC stdin is exclusively Scheduler-owned. The adapter sends only the frozen
admitted provider/model in `initialize`; neither prompt text nor child tools can choose
another route. The upstream SDK can dynamically install its native DeepSeek adapter
for an arbitrary `deepseek-official` initialization, so exposing this stdin as an
untrusted general-purpose RPC endpoint is unsupported.

### 上游客户端识别（#321 / #736）

部分 new-api 架构的第三方中转按协议分别识别客户端，两个开关互不替代：

- **OpenAI-responses（#321）**：按 body `input[0]` 的首条 system 消息识别；DSH 由 `dsh-request-frame.ts` 投影为 pi 兼容帧。
- **Anthropic Messages（#736）**：只按 `User-Agent` 是否以 `claude-cli` 开头识别，否则 401 `unauthorized client detected`。真实 Job 由 Claude CLI 自带该 UA 并经网关透传；Scheduler 自发的推理探测 / 模型目录发现与网关 `upstreamAuthHeaders` 统一注入 `user-agent: claude-cli/<pin> (external, cli)` + `x-app: cli`，版本取 claude-code adapter pin（`apps/scheduler/src/claude-cli-fingerprint.ts`），不得另写第二个版本号。

## Pi Coding Agent RPC（#140）

Pi 的启动命令由适配器固定为 `pi --mode rpc --no-approve --no-extensions`，使用
隔离 HOME `/workspace/.deepsonar-home` 下默认的 `.pi/agent/sessions/<cwd>/` 会话布局；
不覆盖 `--session-dir`，避免 Pi 1.4.0 返回的会话路径与实际写入路径不一致而在恢复时新建会话。
每次启动或重启均先发送带请求 ID 的 `get_state`，取得并校验 `sessionId` 与精确
`sessionFile` 后才允许输入；恢复时两者必须与已绑定身份一致。

初始提示、运行中增量消息和完成门 nudge 统一发送 `prompt` 加
`streamingBehavior: "steer"`：由 Pi 原子地决定在空闲时启动新回合，或在运行时排队，
不依赖宿主观测状态发送裸 `steer` / `follow_up`。驱动串行写入、匹配响应 ID 和 command，
成功响应的 `disposition` 必须为 `started` 或 `queued`；ACK 与新回合 `agent_start`
均有 10 秒等待上限，未确认输入不会自动重放。新回合清空前一回合的临时失败/输出状态；
输入 ACK 未返回时，不把并发到达的 `agent_settled` 当成可关闭输入或追加 nudge 的边界。

每个输入块都交给同一个持久 `TextDecoder`，再按 LF 分帧；CRLF 会去掉回车，
U+2028/U+2029 仍保留为数据。
半帧、非法 UTF-8、空行、超过硬上限的行和未知事件均 fail closed，`finish()` 会显式拒绝尾部残帧。

### Pi 大输出与证据（#765）

Framer 按 LF 逐帧累计字节，惰性消费每帧；单次 SDK chunk 再大也只按 16Ki 字符/字节切片扫描。
帧硬上限默认 8MiB，`DEEPSONAR_PI_RPC_MAX_EVENT_BYTES` 可配置 1–64MiB；parser 使用同一实例上限。
缓冲只保留一帧，JSON 解析和保存时会有有界副本（硬上限不是进程 RSS 承诺）。SDK 已分配的输入 chunk 不计入 framer 缓冲。
不根据前缀、正则或嵌套 `type` 猜类型，不丢弃合法控制事件。

超过 1MiB 且在硬上限内的完整帧先通过 JSON/事件类型校验，保存完整**脱敏后的 JSON 事件**到
`/workspace/.deepsonar-rpc-output/pi-rpc-<run UUID>-<sequence>.json`，同时在 Scheduler 写入
`attempts/<attempt>/runtime/` evidence 文件，成功后才向适配器交付预览投影。
`text/delta/output/result/error/errorMessage/message` 字符串各保留至 4096 字节完整码点边界并加截断提示；
身份、响应 ID、command、stopReason、isError、toolCallId 及对象/数组结构保持。
投影仍超过 1MiB、深度超过 64 或无法保存时明确失败，不以省略结构绕过控制校验。
小于等于 1MiB 的帧保持既有行为。这里不改变 Pi 内部或模型上下文；模型原有工具输出仍由 Pi 处理。

每次运行（含恢复）最多保存 128 个文件、合计 128MiB 脱敏 JSON；workspace 与 evidence 各一份。
诊断包含 `truncated: true`、`original_bytes`（原始帧，不含 CRLF）、`retained_bytes`、
`sha256`、`hash_scope: redacted_json`、`path`、`evidence_path`、`capture_complete: true`。
hash 对应实际存储的完整脱敏 JSON，不是原始秘密或 UTF-8 预览。诊断不包含原始内容。
workspace 文件可用现有 shell/read 工具按字节/行读取；清理沙箱前 evidence 已持久化，按现有 Job 权限下载。
写盘必须 await，形成输出消费背压；每次 workspace/evidence 写入分别有 15 秒超时，期间暂停 Provider ACK/start 计时。超时不声称底层 I/O 已取消，迟到写入不能再发布捕获完成。无法归档、超额、损坏或超硬上限均发出 `capture_complete: false` 并失败，
即使之前出现过结算也不能掩盖捕获失败。超限帧不声称拥有完整 hash/字节数。
生产 SecureDrop 17 个 Job 的重跑、覆盖完成与真实沙箱验收仍须单独执行，单元测试不能替代。


`agent_end`、进程退出和普通响应都不能宣告成功，只有 `agent_settled` 提供 Agent 侧静止
信号；Scheduler 仍要求已授权的 `mark_job_done` 通过完成门。临时网络错误在同一沙箱内最多
按原会话恢复三次，恢复必须使用 `get_state` 返回并经过路径校验的精确 `sessionFile`。

`agent-harness/test-pi-rpc.mjs` 使用确定性 mock provider 驱动真实 Pi 进程，覆盖首次回合、
空闲 nudge、无效 RPC、SIGKILL 后精确会话恢复及恢复后的回合；同时确认显式扩展生命周期
与项目 `.pi` 扩展禁止自动加载。可用 `DEEPSONAR_PI_BINARY` 指定本地 Pi 1.4.0 二进制运行，
未指定时使用官方镜像。2026-10-10 已通过本地真实 CLI 路径；这不代替容器构建、镜像体积、
沙箱网络隔离或真实厂商模型 E2E。

Pi 不物化 MCP 配置，也不调用 `pi.registerTool`。平台静态 `deepsonar-control` Skill 固定物化到
`~/.pi/agent/skills/deepsonar-control/SKILL.md`，引导调用
`GET $DEEPSONAR_API_BASE_URL/agent/capabilities_list`；返回的每个获准 operation 直接携带输入 JSON Schema，后续请求由短期 Job token 和
冻结 operation allowlist 再次鉴权。Provider 配置物化为 `.pi/agent/models.json` 与
`.pi/agent/auth.json`。`--model` 使用 Provider 目录中的模型 `id`（例如 `grok-4.6`），
不是 DeepSonar 默认路由前缀 `deepsonar/<id>`；adapter 会把已冻结的 `provider/model`
映射为 `--provider <route> --model <id>`。裸 id 若落在 Pi 内置多 provider
目录中，必须带上冻结的已认证路由（通常是 Gateway `deepsonar`），否则 Pi 会报
ambiguous。模型请求统一改写到 Gateway，
长期密钥不进入 snapshot、workspace、运行清单或 evidence。空 content / 零 usage 视为协议错误。

项目 `.pi` 目录不会自动加载。`--no-extensions` 始终保留。Pi 扩展由 Hub 角色能力组合提案
`pi_extension_ids`（#690；不再是 `RoleConfig.pi_extensions`），只接受
`packages/shared-types` 注册表中的已注册扩展 id（当前 pilot：`pi-web-access`）；Job
创建时 Scheduler 校验 trust/CLI/镜像兼容并把 selector/digest 冻结进快照。Executor 把平台生成的 stub 写到
`/workspace/.deepsonar-home/.pi/agent/extensions/<id>.ts`，适配器仅对此外前缀追加 `-e`。
未注册 id、用户上传的扩展源码、以及镜像目录外的 `-e` 路径一律拒绝。出网扩展服从任务
`allow_egress`；本路径不向快照或工作区写入长期密钥。已注册扩展预置到兼容镜像的
`/opt/deepsonar/pi-extensions/node_modules/`（pilot `pi-web-access` 只进 audit / kali-minimal，
不进 size-gated 的 base），与 `@earendil-works/pi-coding-agent@1.4.0` 一样按 version + integrity 校验。

## Verification

Contract tests cover registry admission, capability and image rejection,
Claude/Pi/DSH lifecycle normalization, leftover Codex/OpenCode session-archive
read paths, tool completion, stdin behavior, DSH Cordis field shape, and
bounded stderr evidence. Base image
CI always runs the official DSH SDK profile smoke, including when the immutable
`src-*` image is reused. Docker uses `--network none`; a loopback-only mock Gateway
inside the container verifies native bash, PTC, native subagent route/token/reasoning
inheritance, same-process follow-up, v4 persistence, rejected cross-process resume,
and bounded shutdown. No real model endpoint or credential is used. CI failure annotation retains
at most the last 8 KiB of smoke stderr. Runtime CLI stderr is separately written
as exact-secret-redacted `runtime.stderr` chunks in normalized evidence with a
1 MiB total cap and explicit truncation record; the Job error remains a short
tail summary. Full model-turn OpenSandbox vendor E2E
(`pnpm ci:smoke:opensandbox-cli-control`) still requires the corresponding
provider credentials; credential-unavailable results must be reported
separately from adapter or parser failures. Mock LLM is not a substitute.

## DSH/Pi 解码契约（#389）

「解码」不是一件事。下列三类契约分开，互不替代；#320 / #321 已关，不能当作完整解码已实现或必须重做的证据。#390 已把 DSH YAML/Gateway/Cordis 归到 `dsh-pi-ai.ts` + adapter；本文件只记录解码范围，不另写第二份解析器。

| 契约 | 输入 | 输出 | 家 | 钉死版本 | 状态 |
| --- | --- | --- | --- | --- | --- |
| 请求兼容投影 | 平台 system prompt | 进入上游 `input[0]` 的 pi-compatible 首帧 | `dsh-request-frame.ts` | DSH `0.2.1-rc.2` | **已完整**。证据：`projectDshSystemPrompt` + `runtime-adapters.test.ts`「DSH request frame」 |
| 运行事件解码 | CLI 结构化 stdout（Pi RPC JSONL / DSH JSON-RPC） | 宿主归一化事件（`assistant` / `user` / `result` / `unknown_runtime` / `agent_settled`） | `runtime-adapters.ts` `decodePi` / `decodeDsh` | Pi `1.4.0` · DSH `0.2.1-rc.2` | **产品字段已齐**。错误、未知帧、独立 `tool/call` / `tool/result` 均保留可诊断结果 |
| Session 归档 / 查看器 | 沙箱内本次 session artifact | 时间线 / usage / 工具统计 / 原始下载 | `cli-session-adapters.ts` + `apps/web/src/session-viewer/` | 同上 | **已完整**。归档失败显式 `captureError`；查看器 `skipped` + `other` 诊断未知/损坏行；「下载原始文件」不改写字节 |

产品必需字段与真实缺口（只填缺口，已齐层不重写）：

| 字段 | 运行解码 Pi | 运行解码 DSH | Session 查看器 Pi | Session 查看器 DSH |
| --- | --- | --- | --- | --- |
| 文本 / 增量 | `message_update` text_delta · **已齐** | `assistant/chunk` text-delta · **已齐** | persisted `message` / RPC · **已齐** | `user/message` `assistant/message` `assistant/chunk` · **已齐** |
| 思考 | thinking/reasoning_delta · **已齐** | reasoning-delta · **已齐** | thinking/reasoning 块 · **已齐** | `reasoning` 块 · **已齐** |
| 工具调用 / 结果 | `tool_execution_*` · **已齐** | 消息内 `tool-call`/`tool-result`，以及独立 `tool/call`/`tool/result` · **#389 补独立事件** | toolCall / tool_execution_* · **已齐** | 独立 `tool/call` + 消息内嵌去重 · **已齐** |
| 错误 | `error` / `extension_error` 抽内层 JSON · **#320 已齐** | JSON-RPC error + `turn/end` · **#320/#321 已齐** | `error` 行进 `other`，不丢后续行 · **已齐** | `turn/end` 进 system/`other` · **已齐** |
| usage | 运行流不记账；Gateway ledger 才是用量真相 · **不做第二套** | 同左 · **不做第二套** | persisted usage · **已齐** | message usage · **已齐** |
| Session 身份 | `get_state` → `sessionId`/`sessionFile` · **已齐** | 同进程固定 `session-${context_id}`；跨进程持久 resume 明确拒绝 · **已齐** | session 行 · **已齐** | v4 session 行 · **已齐**；旧 v0–v3 只读 |
| 未知 / 损坏帧 | 未知类型 `unknown_runtime`；非法 JSONL fail closed · **已齐** | 未知 method/event → `unknown_runtime`（#389 前静默丢弃）· **已齐** | `skipped` + `other` · **已齐** | `skipped` + `other` · **已齐** |

版本锁定脱敏夹具：

- 运行事件（录制时 CLI 为 Pi 1.1.0 / DSH 0.2.0-rc.2；当前钉版本已抬到 Pi 1.4.0 / DSH 0.2.1-rc.2，格式证据沿用，真机录制待重取）：
  `packages/runtime-sandbox/src/fixtures/cli-decode/pi-0.84.4.runtime.jsonl`、`dsh-0.2.0-rc.2.runtime.jsonl`
- Session 归档：`apps/web/src/session-viewer/fixtures/cli-decode/pi-0.84.4.session.jsonl`、`dsh-0.2.0-rc.2.session.jsonl`
- 历史 DSH 夹具 `dsh-0.1.1-rc.2.*` 仅用于旧归档/解码回归，不代表当前 launcher 或 live capture。

夹具覆盖文本/增量、工具调用结果、错误、usage、Session 身份、未知/损坏帧，以及伪造 `mcp__deepsonar-control__*` 工具名。普通输出或伪造 tool call **不会**变成控制语义事件；语义写入只走 Job 级 HTTP API。不承诺识别任意上游私有客户端策略。

运行时 smoke：本地 `agent-harness/dsh-sdk-smoke-driver.mjs` 已用官方 package 验证 native bash、PTC `run_code`、原生子代理的 Gateway/model/reasoning 继承、Gateway token、同进程 follow-up、v4 capture、跨进程 resume 拒绝和 shutdown；`agent-harness/dsh-cordis-smoke-config.mjs` 是 profile smoke helper，`agent-harness/check-dsh-runtime.mjs`、`agent-harness/test-dsh-cordis.mjs` 与 `packages/runtime-sandbox/src/runtime-adapters.test.ts` 验证 lock/profile/Docker 与 adapter 契约。Docker 在当前环境不可用，因此容器启动与既有镜像 size budgets 仍由 CI gate 负责；本地只记录 npm closure 约 505 MiB unpacked、约 139 MiB gzip，不把它们写成镜像体积。完整 `pnpm ci:smoke:opensandbox-cli-control` 仍需要对应 Provider 凭据。
