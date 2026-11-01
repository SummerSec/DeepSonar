# 沙箱 Pi 观测内存扩展（`pi-observational-memory`）设计评审（#815 A 片）

> 状态：**A/B/C 运行时实现、定向回归及实际本地镜像 RPC/生产启动守卫已验证；最终组合 CI 和发布证据待完成。** 本文件保留评审语义与判定标准，当前镜像证据集中见 [RPC 专题](PI_OBSERVATIONAL_MEMORY_RPC.md#2026-10-31-主线程-built-image-验收)。
> 同步日期：2026-10-31。代码核对基线：当前根工作树，schema 以[源码编号](../apps/scheduler/src/schema-version.ts)为准；镜像验收身份见上述专题。
> 关联 issue：[#815](https://github.com/SummerSec/DeepSonar/issues/815)。A 的设计硬门仍约束 B/C/D/E；当前只记录已验证实现与剩余启用门禁。

## 0. 本片交付

| # | 交付 | 章节 |
| --- | --- | --- |
| 1 | memory 内容分类与脱敏规则 | §3 |
| 2 | `requires_egress` / `requires_gateway` 契约语义与断网行为 | §4 |
| 3 | 后台模型预算与优先级规则、账本来源维度 | §5 |
| 4 | RPC 纯净性判定标准与验证方法 | §6 |
| 5 | 与现有上下文治理（compaction / context window / 流截断）的关系 | §7 |

结论先行：**A 片的七项决策仍是接入硬约束，不能被跳过。** C/D/E 已有实际本地镜像 RPC/独立生产内容守卫、Session HTTP 出口和 Gateway/账本证据；§9 区分已验证工程、最终 CI/发布证据与未评估的质量/成本收益。

## 1. 动机与现状事实

- 沙箱 Pi 以 `pi --mode rpc --no-approve --no-extensions -e <准入 stub>` 启动（[runtime-adapters.ts:611](../packages/runtime-sandbox/src/runtime-adapters.ts)），项目 `.pi` 目录不会自动加载，扩展只能来自平台注册表（[pi-extensions.ts:30](../packages/shared-types/src/pi-extensions.ts)）。
- 因此当前 Job 内的上下文压缩完全由 pi 自身 compaction 完成，逐级 summary 化；Scheduler 侧只有两条兜底：`context_window_exceeded` 自动重试 1 次、`pi_stream_truncated` 自动重试 1 次（[context-window-exceeded.ts](../apps/scheduler/src/context-window-exceeded.ts)、[pi-stream-truncation.ts](../apps/scheduler/src/pi-stream-truncation.ts)）。
- `pi-observational-memory`（MIT，v3.1.4）把记忆工作提前到 `turn_end` 后台完成，使 compaction 的主要路径变成渲染步骤；存在同步 observer catch-up 和委托 Pi 原生压缩的 fallback 例外，不能保证压缩阶段零模型调用。它的后台 worker（observer / reflector / dropper）通过 `agentLoop` 发起**真实模型请求**，上游默认 `agentMaxTurns: 16`、`agentMaxTokens: 32_000`，在 DeepSonar 里这些请求只能走 Gateway。
- 准入对象必须是**发布物**，不是上游源码分支。本次实测 npm 发布包 `pi-observational-memory@3.1.4`（`npm pack` 下载后自行计算 sha512，不采信 registry 自报）。

  发布包接口面（同样取自该 3.1.4 tarball，非上游 master 推断）：

  | 项 | 发布包实测值 |
  | --- | --- |
  | 工具名 | **`recall`**（`src/tools/recall-observation.ts:16` `RECALL_OBSERVATION_TOOL_NAME = "recall"`；**文件名与工具名不同**，不能按文件名写工具名） |
  | 命令 | `om:status`、`om:view` |
  | hooks 事件 | `session_before_compact`、`agent_settled`、`agent_start`、`turn_end`（不止 `turn_end`） |
  | 配置键 | `observeAfterTokens`、`reflectAfterTokens`、`observerChunkMaxTokens`、`compactAfterTokens`、`compactAfterTokensMode`、`compactAfterTokensRatio`、`observationsPool*`、`agentMaxTurns`、`agentMaxTokens`、`model`、`passive`、`showWorkerNotifications`、`debugLog` |
  | 宿主导入 | `@earendil-works/pi-agent-core`、`pi-ai`、`pi-ai/compat`、`pi-coding-agent`、**`pi-tui`（值导入 `Text`，用于工具结果渲染）** |

  因此准入清单不能只看 `entry`：工具名与 schema、hooks 事件、配置键、宿主导入 API 均需按固定 tarball 核验（§2）。

  | 项 | 发布包 3.1.4（实测） | 上游 master `022da5e`（源码核对） |
  | --- | --- | --- |
  | `pi.extensions` | `["./src/index.ts"]` | `./dist/index.ts` |
  | `files` | `["src/","LICENSE","README.md"]` | 含 `dist/` |
  | 顶层目录 | `LICENSE` / `README.md` / `package.json` / `src`（无 `dist/`） | 含 `dist/` 与 `scripts/build.js` |
  | `dist.integrity` | `sha512-jgQbFyLMs4wWhkf6F0voOgzMwtIXsb8+ks0MsPKpPxkdpyMX5E/el6Mk/vJ40m8GlKwBIsCKjL1r7Z2U8dCtmA==`（自算值与 registry 声明一致） | — |
  | peerDependencies | 全为 `*` | 同 |

  两端不是同一对象：3.1.4 的发布物是 `src/` 形态，master 之后改为 `dist` 构建产物。**因此 `entry` 必须按 tarball 逐版核对，不得从上游源码或上一版本推断。** 宿主临时包 RPC 与实际本地构建镜像的已安装 canonical Pi/OM RPC 分别留证；镜像内容预检、新 Job 专属版本准入及独立生产内容守卫也已验证，见 [RPC 专题](PI_OBSERVATIONAL_MEMORY_RPC.md#2026-10-31-主线程-built-image-验收)。
- 上游 `src/config.ts:396-424` 按 **defaults → 全局 `getAgentDir()/settings.json` → 项目 `<cwd>/.pi/settings.json` → 环境变量** 合并 `observational-memory` 配置（环境变量当前覆盖 passive）；还单独读取项目优先的 `compaction.enabled`。平台重写全局文件（[provider-settings.ts](../apps/scheduler/src/provider-settings.ts)）并不阻止扩展自己读取项目文件，`--no-extensions` 也不隔离这条配置路径。

## 2. 为什么不能直接注册（硬门复述）

| # | 门禁 | 位置 | 本片给出 |
| --- | --- | --- | --- |
| G4 | `requires_egress` 语义把「业务出网」与「模型出网」混为一谈 | [executor-real.ts:1097-1099](../apps/scheduler/src/executor-real.ts) → `materializeFrozenPiExtensions(frozen, allowEgress)` | §4 |
| G5 | 扩展配置无处声明 | [provider-settings.ts:236-244](../apps/scheduler/src/provider-settings.ts) | §5.3 冻结段语义 |
| G6/G7 | 后台 worker 抢主会话请求额度、账本无来源维度 | [config.ts:262](../apps/scheduler/src/config.ts)、[gateway.ts:719-730](../apps/scheduler/src/gateway.ts) | §5 |
| G9 | 未知 RPC 帧直接判失败，`extension_error` 让整个 Job 失败 | [runtime-adapters.ts:228-243,580-582](../packages/runtime-sandbox/src/runtime-adapters.ts) | §6 |
| G10 | memory 内容可能随 session 导出，需持久化前过滤 | [cli-session-adapters.ts:94-120](../packages/runtime-sandbox/src/cli-session-adapters.ts) | §3 |
| G11 | 快照冻结 version/entry，扩展升级后旧快照拒绝重放 | `parseFrozenPiExtensions` | §7.4 |

> 准入依据必须同时覆盖**入口**与**接口面**，缺任一项不得写入注册表：
>
> 1. 来源 registry（canonical 源需复核，镜像只能作为副本）；
> 2. tarball 的 `dist.integrity`；
> 3. tarball 内 `pi.extensions` / `files` / 实际`entry`（逐版核对）；
> 4. tarball 内工具名与参数 schema、hooks 事件、配置键、宿主导入 API（见 §1）。
>
> 只核 `entry` 是不够的：工具名、hooks 与宿主导入决定它是否能被现有 adapter 解析、是否会触发 `PI_RPC_UNEXPECTED_EVENT` 或 `extension_error`。当前接口面已按 canonical tarball 核对，并通过实际本地构建镜像的已安装插件 RPC；封装身份与独立内容守卫证据见 [RPC 专题](PI_OBSERVATIONAL_MEMORY_RPC.md#2026-10-31-主线程-built-image-验收)。

## 3. 交付 1：memory 内容分类与脱敏规则

### 3.1 关键事实（决定规则形状）

Pi adapter 读取符合路径与 32 MiB 大小要求的 session 全文（[cli-session-adapters.ts](../packages/runtime-sandbox/src/cli-session-adapters.ts)）。但这只是导出阶段：随后 [runtime-agent.ts:1787-1805](../packages/runtime-sandbox/src/runtime-agent.ts) 已对 `rawSession` 调用 `redactRuntimeSecrets`，再交给宿主持久化。因此“整文件导出”不等于“不能在入库前过滤”。现有秘密值替换也不等于已实现 memory 结构化分类过滤。

C/E 片可以在持久化前解析 JSONL，按结构化条目策略保留、脱敏或删除，并验证 session 引用完整性、viewer 和恢复语义；不能只扩大字符串正则。物理 session archive 与供 Verify 消费的权威 Evidence 是两种语义：归档存储不授予 memory 事实或验证证据地位。
### 3.2 分类矩阵

| 数据类 | 产生者 | 典型内容 | 落点（as-built） | 目标规则 |
| --- | --- | --- | --- | --- |
| L1 observation | observer worker | 本轮发生了什么、执行了什么命令、得到什么结果 | session 文件（ledger） | 允许存在；**禁止写入凭据明文、token、key、完整上游错误正文** |
| L2 reflection | reflector worker | 用户决策、约束、目标、偏好等持久事实 | session 文件（ledger） | 允许存在；**禁止把 shared asset 正文或 evidence 文件内容粘贴进来**；只允许短句摘要 |
| L3 worker prompt / response 原文 | observer/reflector/dropper | 送给 worker 的上下文、模型返回 | worker 内存；debug/错误/通知出口需逐项验证 | 不得写入 workspace 其他路径、不得进 evidence、不得进 RPC 帧 |
| L4 memory 索引/状态（`om:status` 输出、debug log） | 扩展 | 阈值、池大小、token 估算 | debug 默认关闭；启用后写 agent 目录下 NDJSON 文件；状态/通知走 UI API | **冻结关闭**：`debugLog: false`、`showWorkerNotifications: false` |
| L5 session 文件整体 | pi | 全部会话行（含 L1/L2） | evidence 冷存储 archive | `readSessionArtifact` 按 Pi header/manifest 选择并在 preview/download 前执行 §3.4 脱敏及结构化过滤；保留不可变 archive metadata |

### 3.3 出口矩阵（重复副本必须逐项声明）

同一段记忆正文会出现在多个出口上，任何一个未覆盖都等同于未脱敏。下表为必须逐项验收的出口清单；「目标语义」必须在 C/E 片实现，本片只定要求。

| # | 出口 | 具体内容（发布包 3.1.4 核实） | as-built 行为 | 目标语义 |
| --- | --- | --- | --- | --- |
| E1 | session 文件与 evidence archive | 全部会话行，含 L1/L2 与工具结果 | `readSessionArtifact` 按 Pi header/manifest 选择归档，先按结构化规则脱敏，再交给 preview/download；保留不可变归档 metadata | 已闭合 Pi OM memory 正文出口；projection bytes/SHA 单独报告，密钥精确值脱敏不得当作内容分类脱敏 |
| E2 | recall 工具结果正文 | 工具名 `recall`，参数只有 `id`；`details.sourceEntries[].content` 为**整条源条目正文且无截断**（`renderSourceEntryContentOnly`）。`includeSourceContent` 是**内部函数参数**（`recall-observation.ts:152,263`），**既不是工具参数也不是公开 settings 配置项**（发布包 `src/config.ts` 无此键），唯一调用点未传第二参数 → 恒为 `true`（`:291`） | wrapper 在 Pi 序列化前做有界投影，renderer 再接收脱敏投影；身份、状态和 source metadata 保留 | **冻结配置无法关闭正文返回**；固定 wrapper 的有界脱敏已通过实际本地镜像 RPC 复核，见 [RPC 专题](PI_OBSERVATIONAL_MEMORY_RPC.md) |
| E3 | compaction summary / fold | `session_before_compact` hook 产出的压缩结果与 memory fold | 作为 session 内容与 `context.compacted` 身份链的一部分 | 按 E1 过滤；身份字段不得因过滤而失真（否则降级为 `context.compaction_unknown`） |
| E4 | 大 RPC 事件的落盘副本与返回预览（**两者不同，不能混同**） | 帧 > 1 MiB 时：落盘 `/workspace/.deepsonar-rpc-output/*.json` 并归档为 runtime artifact（[pi-rpc-output.ts:54-70](../packages/runtime-sandbox/src/pi-rpc-output.ts)） | **落盘与预览均先过 OM 脱敏**；`PiRpcOutputCapture` 保留 control identity/framing 并另报 projection hash，预览仍只是返回事件的有界投影 | 必须分别声明：落盘副本的保留/过滤/读取权限与存储预算；预览只是事件降噪，**不得作为存储或敏感边界的依据** |
| E5 | 普通工具结果在 Web viewer 的展示 | 现有 `parseAgentSession` 就把 tool result 渲染出来（[parseAgentSession.ts](../apps/web/src/session-viewer/parseAgentSession.ts)） | 已展示会话内 tool 结果；E1/E2 在归档/返回前投影 | **不开 memory 面板 ≠ 正文不显示**；过滤必须先于 viewer 展示，不靠「不新增 UI」代替 |
| E6 | 配置、日志、通知、debug 文件 | `debugLog`（启用后写 agent 目录 NDJSON）、错误/fallback 通知、`om:status` 输出 | 默认关；catch-up 错误通知不完全受 `showWorkerNotifications` 控制 | 冻结关闭；出现记录即按敏感出口验收 |

撤权与删除语义（必须分开写，不得混用）：

- **撤销读取权限**：只保证按当前权限不再可读；不意味着历史副本已消失。
- **dropper 删除**：只是把 observation 移出 active memory，**不是**撤权，也不是历史擦除（ledger 仍保留）。
- **历史擦除**：本 issue **不承诺**任何擦除能力；若将来要做，需单独设计（含 session 归档、evidence blob、RPC 导出文件三处副本）。

### 3.4 规则（供 C/E 片实现）

1. **写入侧优先**：L1/L2 由扩展生成，平台无法逐字审计。关闭 `debugLog` 与 `showWorkerNotifications` 只减少输出，不是敏感正文脱敏保证；wrapper 已冻结这些配置，并对 session/RPC/archive 出口执行结构化过滤。上游 `src/debug-log.ts` 写文件而非默认 stdout；catch-up 错误通知也不完全受 `showWorkerNotifications` 控制，故仍需保留 host/image 复核。
2. **导出侧兜底**：若 E 片发现归档中出现 L3 或凭据明文，必须停止接入；修复方式是收紧扩展配置或加导出期脱敏，**不是**放宽归档正则。
3. **不得投影**：L1/L2 不投影为 Finding、Fact、业务 Artifact、验证 Evidence、报告或质量指标；受控 session archive 中的物理存储不构成这种投影。memory 是模型的上下文治理产物，不是证据。任何"从 memory 生成 Finding/知识"的路径都超出本 issue 范围。
4. **UI 边界**：Web session viewer 只按现有 pi 行格式解析（[parseAgentSession.ts](../apps/web/src/session-viewer/parseAgentSession.ts)）；不得为 memory 条目新增展示面板，除非先通过 G10 脱敏评审。
5. **撤权语义**：memory 是 Job 内产物，Job 归档与权限沿用现有 evidence 读取边界；不因 memory 提供跨 Job 可读性。

## 4. 交付 2：`requires_egress` / `requires_gateway` 契约语义

### 4.1 历史问题与当前边界

- `materializeFrozenPiExtensions(frozen, allowEgress)` 对 `requires_egress: true` 的扩展在 `allowEgress === false` 时**直接跳过**（不进 `paths`，记入 `skipped`）。
- `allow_egress` 只控**目标网络**：提示词写明「本任务禁止访问模型网关之外的网络」（[executor-real.ts:897](../apps/scheduler/src/executor-real.ts)），env 侧是 `DEEPSONAR_ALLOW_EGRESS=0/1`（[executor-real.ts:837](../apps/scheduler/src/executor-real.ts)）。
- 两种模式均设计为只经获准 Gateway 出模型；这不保证当前路由、凭据、模型授权或服务健康恒满足（[provider-settings.ts](../apps/scheduler/src/provider-settings.ts) 的 gateway rewrite 路径）。这是 A 片提出字段拆分前的边界事实，保留用于解释准入动机。

历史问题是：**旧 `requires_egress` 只表达业务出网，而 om 还需要表达模型 Gateway 要求。** 当前注册行已用下节两个正交字段分别表达并在加载/启动时校验，不再用单字段推断。

### 4.2 已落地契约与剩余准入核对

注册行已增加两个正交字段，二者都按冻结 Job 在加载与启动时校验，缺失或不满足即拒绝（fail closed，不留推断分支）：

| 字段 | 含义 | 值为 true 时物化条件 |
| --- | --- | --- |
| `requires_egress` | 扩展自身要访问目标/外部网络 | 需要 `allow_egress === true`，否则跳过并记录 `skipped` |
| `requires_gateway` | 扩展会产生模型请求（走 Gateway） | 核验 Job 获准的 Gateway-only 路由、短期凭据及模型白名单；不满足则拒绝物化并记录原因，运行中不可用按受控降级处理，禁止直连 fallback |

行为矩阵（含 `requires_gateway=true` 的“注入”均以前述授权/路由校验通过为前提；不通过则拒绝并记录 `gateway_required`，不是恒满足）：

| `requires_egress` | `requires_gateway` | `allow_egress=true` | `allow_egress=false` |
| --- | --- | --- | --- |
| false | false | 注入 | 注入 |
| false | true | 注入，记「后台模型请求」 | 注入，记「后台模型请求」 |
| true | false | 注入 | 跳过（`skipped`，原因 `egress_required`） |
| true | true | 注入，记「后台模型请求」 | 跳过（`skipped`，原因 `egress_required`） |

`pi-web-access` 迁移为 `requires_egress: true` / `requires_gateway: false`（它不产生模型请求），行为与今天一致——这是本片要求的唯一既有语义证明点。

### 4.3 拒绝的替代方案

- **不采用**「om 标 `requires_egress: false` 蒙过去」：单独标 false 不能证明其模型请求仅走获准 Gateway，也不能证明模型白名单与归因成立；问题不是受限网络必然无法访问 Gateway。
- **不采用**「断网时静默降级为无 om」：同一快照在不同网络策略下行为不同，且与 §6 的失败语义冲突，无法审计。

## 5. 交付 3：后台模型预算与优先级

### 5.1 现状事实（截至 2026-10-31）

- Job Token 额度（**同步 main `2b76ac25` 后已变**）：`runtime_knobs.job_token_max_requests` 由 Job 快照冻结（[executor-real.ts:775](../apps/scheduler/src/executor-real.ts)），允许区间 `0–1_000_000`（[runtime-knobs.ts:10](../apps/scheduler/src/runtime-knobs.ts)）；env 未设置或空 → **0 = 不限**，正数才受限（[config.ts:44-54,256](../apps/scheduler/src/config.ts)，见 [USAGE_LIMITS.md](USAGE_LIMITS.md)）；超限对调用方 429 `quota_exhausted`（[gateway.ts:719-730](../apps/scheduler/src/gateway.ts)）。
- Gateway 已为 OM 签发独立的 `observational_memory` workload token；请求来源由 `job_tokens.workload` 和 `job_token_id` 绑定，不能由 header/body/model 自报。`job_usage_ledger` 按 workload 分账，并保留原有 `gateway_response` / `gateway_stream` / `gateway_error` source 语义（[gateway.ts](../apps/scheduler/src/gateway.ts)、[gateway-om-budget.ts](../apps/scheduler/src/gateway-om-budget.ts)）。

因此在**显式配置了有限额度**的 Job 上，main/background 必须在冻结对象中显式分配，后台不会取得未分配的剩余额度，也不会侵占 main reservation；默认不限的 Job 保持 unlimited，但仍记账并执行权限、模型和效果结算。

### 5.2 已落地语义与剩余核对

1. **默认不限**：请求数默认不限（`usageLimit` 未设置即 0，见 [USAGE_LIMITS.md](USAGE_LIMITS.md)）；不得隐式套用上游轮数、token 或比例预留。显式 token/request cap 才受限，协议大小、权限和防死循环保护不属于配额。
2. **显式有限分配**：冻结对象必须同时表达 `total_requests`、`main_requests`、`background_requests`；总额须等于 Job 总额，main/background 之和不得超额，剩余额度不自动转移。可选后台 request/token cap 只能进一步收紧分配。
3. **可信并发与结算**：Gateway/Job 锁内原子检查并占额；请求发出后按真实效果 settlement。`pending` / `unknown` 或账本失败不得当作零返还，必须阻断后续后台出站；终态撤销 token 不删除已开始请求的账本。
4. **降级边界**：已知 quota exhausted，或已知请求在上游启动前未开始（`gateway_transient` + `effect_status=not_started`）可见降级并回到 native compaction；provider 5xx 文本本身不构成“未开始”权威。`pending`、`unknown`、权限、协议、配置/完整性错误保持硬失败。
5. **可信归因**：后台 workload 由内核 token 绑定并经 Gateway 校验；observer、reflector、dropper、fallback、compaction catch-up、retry 均覆盖同一冻结模型、额度与归因规则。请求与 token/memory usage 分账，成本可按 workload 对账。
6. **当前证据**：Gateway OM unit + 真实 SQL/HTTP 及内核已知请求前 transport/持久零用量结算、provider 防冒充回归已通过，最新范围与分母集中见 [Gateway 专题](PI_OBSERVATIONAL_MEMORY_GATEWAY.md)。

### 5.3 冻结配置段（G5 语义）

C 片已由 Scheduler 从 Job 快照生成 `.pi/agent/settings.json` 的 `observational-memory` 段，至少冻结：

- `compactAfterTokensMode` + `compactAfterTokensRatio`（或 `calibrated` 阈值）
- `observeAfterTokens` / `reflectAfterTokens`
- `agentMaxTurns` / `agentMaxTokens`：只有管理员显式配置才有限额；未配置表达不限，不能让上游默认 16 / 32_000 悄悄生效
- `showWorkerNotifications: false`、`debugLog: false`
- `passive`（见 §8.1 第 2 项）

约束：覆盖整个 defaults → global → project → env 链，以及独立 `compaction.enabled` 读取；wrapper 已通过私有 settings、环境恢复、session 绑定和 sticky failure 守卫隔离项目 settings 与相关 env 覆盖，加载后校验有效配置与冻结快照一致（包括模型/fallback）。只接受注册表声明过的 knob；越界或未知字段 fail closed；Agent、Job 内容、项目配置一律不得覆盖该段（需要稳定 error code 与 RepairFeedback 分类）。该配置隔离路径已通过实际本地镜像 RPC 复核，证据见 [RPC 专题](PI_OBSERVATIONAL_MEMORY_RPC.md)。

### 5.4 后台模型与 Gateway 冻结模型守卫

- Gateway 对请求模型执行 Job 冻结白名单校验：[gateway-guard.ts:66](../apps/scheduler/src/domains/provider-adapter/gateway-guard.ts) `assertGatewayRequestModelAllowed`（出口在 [gateway.ts](../apps/scheduler/src/gateway.ts)），不匹配抛 `GATEWAY_FROZEN_MODEL_MISMATCH`（同文件 `:24`）。适配器未声明 `enforce_frozen_model`、`passthrough` 或白名单为空时软放行（历史快照语义）。
- wrapper/Gateway 只允许当前 Job 冻结的 model/provider/route；模型不匹配和权限响应进入硬失败，不能借后台错误 marker 绕过 `extension_error`。
- 已知 quota 或 known-never-started transient 才能返回可见 `native_compaction` 降级；`workload_usage_unknown`、`workload_usage_pending`、provider 5xx 未证明无效果，均不能降级。

规则：首版**不允许 observer 独立模型**——当前 wrapper/Gateway 已强制等于冻结模型。若后续要支持独立模型，必须先在独立决策中证明同一冻结白名单、额度与归因，且不得为接入放宽既有 `enforce_frozen_model` 权限。

## 6. 交付 4：RPC 纯净性判定标准

### 6.1 现状事实（严格白名单）

- 每行 stdout 必须是 JSON 对象，`type` 必须命中 `PI_RPC_EVENT_TYPES` 白名单，否则抛 `PI_RPC_UNEXPECTED_EVENT`（[runtime-adapters.ts:228-243](../packages/runtime-sandbox/src/runtime-adapters.ts)）。
- 单帧上限默认 8 MiB，可由 `DEEPSONAR_PI_RPC_MAX_EVENT_BYTES` 在 1–64 MiB 调整（[runtime-adapters.ts:174-187](../packages/runtime-sandbox/src/runtime-adapters.ts)）。
- `error` 与 **`extension_error` 都会 `failRuntime("Pi runtime failed")`**（[runtime-adapters.ts:580-582](../packages/runtime-sandbox/src/runtime-adapters.ts)）→ **扩展内部错误 = 整个 Job 失败**。
- `compaction_end` 且 `result === null` 也直接失败（[runtime-adapters.ts:532-533](../packages/runtime-sandbox/src/runtime-adapters.ts)）。
- 白名单里没有观测内存相关事件类型；om 的 `om:status` / `om:view` 是 TUI 命令，`showWorkerNotifications` 默认 true。

### 6.2 判定标准（可直接验收）

| ID | 判定 | 判为不合格即停止 |
| --- | --- | --- |
| C1 | 启用 om 后，stdout 每行 `type` 均在白名单内，无 `PI_RPC_UNEXPECTED_EVENT` | 出现任一白名单外帧 |
| C2 | 后台 worker 失败不得把 Job 判失败：不得出现 `extension_error`，或该错误必须被扩展自身吞掉并记降级 | 出现 `extension_error` 导致 failed |
| C3 | 不因 om 出现 `compaction_end` + `result === null` | 出现即视为与 pi compaction 契约冲突 |
| C4 | 大事件路径（`cat` 大文件 / `curl` 整页）下仍只输出合法帧，且单帧不超上限 | 违反任一 |
| C5 | 非 JSON 行数为 0（`showWorkerNotifications`/`debugLog` 若写 stdout 即不合格） | 出现任一非 JSON 行 |
| C6 | 关闭 om 与开启 om 的帧序列在协议层等价（除 compaction 相关时序差异） | 出现白名单内但字段契约变化的帧（例如 `context.compacted` 身份字段缺失） |
| C7 | recall 返回完整 `details` 时不因结构超限而失败 | 出现 `PI_RPC_UNSUPPORTED_LARGE_STRUCTURE` |

### 6.3 C7 的代码反例与已验证出口

`recall` 默认带源条目正文，而大帧保护存在结构盲区：

- 帧字节 > `PI_RPC_INLINE_BYTES`（1 MiB）时进入捕获投影（[pi-rpc-output.ts:4](../packages/runtime-sandbox/src/pi-rpc-output.ts)、[runtime-agent.ts:1531-1532](../packages/runtime-sandbox/src/runtime-agent.ts)）。
- 投影只对 `PAYLOAD_KEYS = {text, delta, output, result, error, errorMessage, message}` 做 4 KiB 预览（[pi-rpc-output.ts:6](../packages/runtime-sandbox/src/pi-rpc-output.ts)）；**`content` 不在其中**。
- 投影后仍 > 1 MiB 即抛 `PI_RPC_UNSUPPORTED_LARGE_STRUCTURE`（同文件 `:60`），该错误从帧循环抛出，**不是降级**。

因此「一帧约 1.1 MiB 且体积压在 `details.sourceEntries[].content` 上的 recall 结果」若直接进入旧投影会硬失败。当前 wrapper 已在 Pi 序列化前收紧 recall；宿主与实际本地构建镜像 RPC 均覆盖超过 1 MiB 的原始 source 并通过有界结果/脱敏检查，身份与场景集中见 [RPC 专题](PI_OBSERVATIONAL_MEMORY_RPC.md#2026-10-31-主线程-built-image-验收)。

验收要求：离线夹具必须包含带完整 `details` 的 `recall` 用例（不只 `cat` / `curl`），覆盖 4 KiB 预览键与非预览键两种结构。当前实际本地镜像已通过该大 `content` 场景；修法只能是收紧扩展输出或为 `content` 类结构增加明确处理，**不得**把该错误改成静默降级。

验证方法与主线记录（2026-10-31；实际本地镜像已按此复核）：

1. `pnpm ci:smoke:pi-rpc`（现有离线 RPC 夹具，[test-pi-rpc.mjs](../agent-harness/test-pi-rpc.mjs)）。
2. 在同镜像、固定上游产物、`--no-extensions -e <om stub>` 下使用离线 fake provider 和受控 Gateway 替身，禁止真实模型及外部网络；记录所有调用、stdout/stderr、通知、debug 文件、session 与最终 archive。覆盖最小会话、大输出、主动 workers、passive 下恢复已有 observations 后的 compaction catch-up、fallback/retry、异常通知、kill/resume、取消与并发额度竞争。夹具须进仓库并有测试入口（`ci-test-hook` 棘轮）。
3. 以现有 harness 的 `StrictJsonlReader` 检查逐字节 framing、非 JSON 行与尾部残留，再通过生产 `parsePiJsonlRecord` 验证事件语义；不得以宽松解析器替代。
4. 注入恶意项目 `.pi/settings.json`、环境变量及恢复 session，证明冻结值不可覆盖；用可识别秘密标记覆盖正文、错误、通知、日志、session/archive 和模型请求出口，检查结构化过滤后的引用完整性。实际本地镜像 RPC 已覆盖配置漂移、恢复同一 session、超大 recall、禁用 OM 及 quota/transient/hard-failure 分支；历史 session preview/download 也已在混合 CLI header、超大 canary、不可变字节、路径越界和 native quote preservation 夹具中通过。有限预算的并发/未知用量、已知请求前 transport 持久结算及 provider 防冒充证据见 [Gateway 专题](PI_OBSERVATIONAL_MEMORY_GATEWAY.md)。

2026-10-31 的实际本地构建镜像 RPC、生产启动守卫及版本准入/适配器回归证据集中见 [RPC 专题](PI_OBSERVATIONAL_MEMORY_RPC.md#2026-10-31-主线程-built-image-验收)；host 分支仍单独标记。wrapper 的 Runtime.js module identity、SDKHTTP 冒号/innerJSON 分类回归及 S3 类型/runtime build、Scheduler/Web tsc 也已有通过记录；类型/构建不证明外部存储已实测。

## 7. 交付 5：与现有上下文治理的关系

### 7.1 三层职责（必须保持分离）

| 层 | 谁负责 | 现状 | 接入 om 后 |
| --- | --- | --- | --- |
| 会话内记忆与压缩触发 | pi + 扩展 | pi 内建 compaction | om 提前完成 observe/reflect，compaction 主要为渲染；同步 catch-up / 原生 fallback 仍可能调用模型 |
| 压缩事件的身份与审计 | DeepSonar adapter（`context.compacted`，要求 `event_id` / `context_id` / `context_revision` / `transform_chain_digest` 等，[runtime-adapters.ts:267-296](../packages/runtime-sandbox/src/runtime-adapters.ts)） | adapter 提供 identity，字段齐全才认作已压缩 | **om 若改变了 transform 链，仍以 DeepSonar 身份字段为准；无法表达时必须降级为 `context.compaction_unknown`，不得伪装成已知链** |
| 失败与重试预算 | Scheduler（`context_window_exceeded` 1 次、`pi_stream_truncated` 1 次） | 按 Job 累计，不看 attempt | 不变；om 的失败**不得**被记成 `context_window_exceeded` 或消耗这两笔预算 |

### 7.2 明确不做

- 不新增第二套压缩状态机，不在 Scheduler 再来一遍摘要。
- 不改 `context.compacted` 的身份要求来"适配" om。
- 不把 om 的降级状态伪装成"未压缩"或"已压缩"；`context.compaction_unknown` 就如实记录。

### 7.3 验收影响

Web 与质量投影仍以 `context.compacted` / `context.compaction_unknown` 为准；本片不新增视图，若 E 片发现压缩时序改变影响任务工作台「运行」视图，需单独评估，不在本 issue 顺手改。

### 7.4 快照回放（G11）

`parseFrozenPiExtensions` 会拒绝与当前注册表不一致的 `version` / `entry_path`。因此：

- om 升级后，**旧 Job 快照不可按现注册表重放**（既有语义，不新增兼容分支）。
- 升级必须在 release note 记录，并接受"旧 Job 不能 resume/rerun 到新扩展"。

### 7.5 移除与回滚语义（F 片承诺的边界）

从角色能力组合移除扩展**只影响之后创建的 Job**：冻结在 Job 创建期（[role-runtime-snapshot/application.ts:637,819](../apps/scheduler/src/domains/role-runtime-snapshot/application.ts)），执行期只读快照（[executor-real.ts:1097-1099](../apps/scheduler/src/executor-real.ts)）。

| Job 状态 | 移除组合后行为 | 要求 |
| --- | --- | --- |
| 新建 / 新排队（尚未冻结） | 不带 om | 无额外要求 |
| 已排队且已冻结带 om | **仍按快照加载 om** | 不得暗改 `agent_snapshot_json`；如需强停，走既有 cancel 路径并记录原因 |
| 运行中 | 不中断；继续带 om 到终态 | 可选：新推送的人工指令无法关闭扩展，需在 UI/文档如实说明 |
| `resume-frozen`（恢复旧冻结快照） | **仍带 om**；快照身份漂移时返回 `SNAPSHOT_STALE` 而不重解析 | 不因组合变更而视为快照失效（[rerun.ts:349-357](../apps/scheduler/src/domains/job-control/rerun.ts)） |
| `rerun-current`（按当前配置重跑） | **重解析当前配置并重新冻结** → 移除后**不再带 om**；同时重建 shared asset 版本 | 属于显式选择重解析，不是暗改历史快照（[rerun.ts:341-376](../apps/scheduler/src/domains/job-control/rerun.ts)） |

因此 **F 片不得承诺「移除即回到旧行为、无残留」**。可承诺的只有：新 Job 不再冻结该扩展、`resume-frozen` 仍按旧快照、`rerun-current` 按当前配置重新冻结、历史快照不被暗改、已冻结 Job 仍可审计。

验收（离线）：先创建并冻结一个带 om 的 Job，再从组合移除 om，随后分别验证：`resume-frozen` 仍带 om 且快照字节未变；`rerun-current` 按当前配置重算（不带 om）且重建 shared asset。两者不得写成同一个承诺。

撤销读取权限与擦除历史内容严格分开（见 §3.3）：移除组合不是撤权，也不是擦除；dropper 删除更不能当作历史擦除。

## 8. 决策点与已选方案

### 8.1 2026-10-31 设计取舍记录（已选定方向）

issue [#815 设计取舍记录](https://github.com/SummerSec/DeepSonar/issues/815#issuecomment-6538810106) 已按推荐方案选定 7 项方向。下表「已选」列即该记录，它**只是产品/设计原则选择，不是运行时验证**。

| # | 决策 | 已选方向 | 仍待定或阻断 |
| --- | --- | --- | --- |
| 1 | 网络契约 | 分开表示业务出网与 Gateway 访问要求 | 准入仍须校验路由/凭据/模型许可，Gateway 可达 ≠ 授权 |
| 2 | 调用边界 | 接受后台记忆需要模型调用；主动/passive/恢复 catch-up 全部经 Gateway 治理 | passive 不得作为免治理入口 |
| 3 | 失败策略 | worker 失败可见、受控降级，不拖垮主任务 | 权限违规/协议损坏不得吞错或伪装成功 |
 | 4 | 预算 | 未配置不限，不隐式加预留；显式有限总额时冻结 `total_requests`、`main_requests`、`background_requests`，不推导比例或自动转移剩余额度 | token/成本维度按各自账本证据核对；请求前 transport 的持久零用量结算不退还请求次数，见 [Gateway 专题](PI_OBSERVATIONAL_MEMORY_GATEWAY.md) |
| 5 | 归因 | 后台用量单列且与总账可对账，由可信服务端绑定 | `observational_memory` token、workload ledger 与终态撤销已有实现；不得扩大凭据或模型权限 |
| 6 | 压缩身份 | 沿用 DeepSonar 身份和追踪契约，不能表达时如实标 unknown | 暂不扩新 policy |
| 7 | 模型 | 首版后台仅使用当前 Job 已冻结模型 | 不新增独立模型权限；放宽需 D 片单独评审 |

该记录同时明确：canonical 发布物、宿主兼容、配置冻结、RPC、多出口脱敏、预算隔离等验收必须逐项留证。实际本地镜像 RPC、独立生产内容守卫、OM 专属版本准入和 Gateway/Session 工程证据已取得；最终组合 CI 与发布通道/平台、registry/catalog 仍待完成，**不能据此宣称完整发布验收通过**。

### 8.2 决策依据（供复核）

| # | 选项 | 建议与理由 |
| --- | --- | --- |
| 1 | 拆 / 保持单字段 | 拆；单字段会留下不可审计的静默跳过 |
| 2 | 均经治理 / 拒绝接入 | passive 不是零模型调用保证（`compaction-hook.ts` 可调 catch-up 的 `runObserver`） |
| 3 | 接受 / 必须降级 | 必须降级；`extension_error` 会把记忆失败放大成 Job 失败 |
| 4 | 预留 / 后台隔离 | 两种都须可证有效；选定后须书面冻结数值并按 §5.2 验收 |
| 5 | 内核绑定 token / 可信上下文 | 拒绝自报 header，保留原结算 `source`、模型白名单与出口治理 |
| 6 | 以本仓身份为准 / 扩新 policy | 先降级（诚实），有真实需求再扩契约 |
| 7 | 冻结模型 / 允许独立模型 | 首版只允许冻结模型，不得为接入放宽 `enforce_frozen_model` |

## 9. 审查状态：静态已核 vs 仍需实测

本节把「已能从固定发布物 3.1.4 tarball 或本仓代码静态判定」与「必须实测才能定论」分开。**静态已核不等于运行验证**；它只是把不可测的模糊项收敛成可判定的具体命题。

### 9.1 静态已核（可从发布包 / 仓库代码直接判定）

| # | 结论 | 证据 |
| --- | --- | --- |
| S1 | om 自身**不发 HTTP**，模型请求只能经宿主 `streamSimple` → 支持 §4 的 `requires_gateway` 论证 | 全仓无 `fetch` / `undici` / `node:http` |
| S2 | 子进程 `spawn` **只出现在剪贴板**，且只在 `om:view` 命令路径使用；但 `commands/view.ts` 存在直接 copy/notify 路径，无 `hasUI` guard，其在 `--mode rpc` 下的可达性**仍待验证** | `src/clipboard.ts:1,49`、`src/commands/view.ts:43-74` |
| S3 | 多数 UI 通知受 `ctx.hasUI` 约束；`commands/view.ts:43-74` 仍有无 `hasUI` guard 的路径，但实际本地镜像 Pi RPC 已复核 `hasUI=true` 且 OM notification subprotocol 被抑制 | `runtime.ts:132,306,316-324`、`consolidation-trigger.ts:113,146`、`commands/view.ts:43-74` |
| S4 | 上游后台 worker 任务被捕获并记录；wrapper 另行追踪实际任务并将权限/协议/unknown 等 sticky failure 交给宿主 `extension_error` | `runtime.ts:310-329` `launchTrackedTask` 全程 try/catch；`agent-harness/pi-observational-memory-governed.ts` |
| S5 | `passive` 只关闭 `agent_start` / `turn_end` 触发，**不关闭 `session_before_compact`** → passive 仍可能触发 catch-up 模型调用 | `compaction-trigger.ts:11`、`consolidation-trigger.ts:175` 有 passive 早退；`compaction-hook.ts` 无 |
| S6 | 压缩 hook 在 summary 为空时**主动让出所有权**交回 pi 原生摘要，在并发压缩时返回 `{cancel:true}` | `compaction-hook.ts:26-45` |
| S7 | memory **活跃投影**受 `observationsPoolMaxTokens`（默认 20k）约束，不是无界增长；但 ledger 历史、recall 原始正文及其在 session/RPC 中的副本仍会持续累积 | `compaction-hook.ts:14-22`、`buildCompactionProjection` 参数 |
| S8 | `recall` 的源正文**无法通过调用参数关闭**（参数只有 `id`，唯一调用点用默认 `true`） | `recall-observation.ts:126-141,291` |
| S9 | 大帧 4 KiB 预览只覆盖固定 payload 键，`content` 不在其中；超限抛错不降级 | `pi-rpc-output.ts:4,6,60`、`runtime-agent.ts:1531-1532` |

### 9.2 已验证与仍需实测（不得把局部证据扩张为镜像/生产结论）

1. **rpc/UI 行为**：实际本地镜像 RPC 已复核 `hasUI=true`、OM notification subprotocol 抑制及 status message 不新增模型 turn。
2. **`extension_error` 的实际触发面**：实际镜像 RPC 已覆盖 permission/unknown/protocol/config-drift 硬失败，quota/transient 只在精确可降级条件下 fallback；不把已覆盖场景外的所有 hook 推定为通过。
3. **compaction 契约一致性（C3/C6）**：实际镜像 RPC 已通过 success/native fallback；独立生产内容守卫在已安装、缺包、缺 wrapper 的 Docker 场景及适配器回归均通过。
4. **数据出口过滤实现**：wrapper recall、RPC 大帧、Session preview/download 已脱敏；历史 archive metadata 保留，projection bytes/SHA/Content-Digest 另报；不推定未运行的全量浏览器交互或外部存储实测。
5. **C7 反例**：实际镜像 real-RPC 已覆盖超过 1 MiB source 与 bounded recall，详见 [RPC 专题](PI_OBSERVATIONAL_MEMORY_RPC.md#2026-10-31-主线程-built-image-验收)。
6. **canonical / 镜像来源**：实际 installed package-lock、包/entry、manifest/wrapper 与 Pi manifest/bin/version 预检通过；新 Job 的 OM 专属版本准入已验证，发布通道/平台、registry/catalog 仍另验。
7. **配置覆盖隔离**：实际镜像 RPC 已覆盖 home/project settings、passive env、config drift、session recovery 和 frozen model override。
8. **额度与归因**：Gateway unit + SQL/HTTP 已验证显式分配、workload ledger、pending/unknown hard failure 和终态撤销；内核请求前 transport、持久零用量结算及 provider 防冒充见 [Gateway 专题](PI_OBSERVATIONAL_MEMORY_GATEWAY.md)。
9. **后台请求量级**：实际镜像日志的 main/background 及 observer/reflector 计数集中见 [RPC 专题](PI_OBSERVATIONAL_MEMORY_RPC.md#2026-10-31-主线程-built-image-验收)，不作容量、SLA 或价格收益结论。
10. **session 体积**：host recall 与历史大 canary 已通过有界投影；长 Job 的长期 ledger、外部 BLOB/S3 余量仍未测。
11. **质量收益**：压缩效果、上下文丢失率、`context_window_exceeded` 发生率和成本收益仍需冻结数据集与对照试验，本 issue 不做承诺。

## 10. A 片验收

- **A 的七项设计取舍保持有效；工程证据不等于完整发布验收。** 实际本地镜像 Pi/OM RPC、独立生产 guard、Session 脱敏、Gateway/账本和定向回归均已有证据；显式有限预算不使用比例预留，unknown/pending 仍硬失败。
- canonical 包/lock/manifest/wrapper、OM 专属版本准入、配置隔离、§6 RPC、§3 Session/RPC 出口和 Gateway 预算已分别核验；最终当前 PR/最终 main CI、发布通道/平台与 registry/catalog 证据尚未完成，质量与成本收益保持 `unknown`。
- 在上述镜像与发布门禁闭合前，扩展仍不得被表述为已通过发布验收；新 Job 默认不启用，旧 released digest 不得由兼容 key 推断含 OM。
- `pnpm ci:unit:docs-freshness` 通过（版本字面量、命令存在性、链接、已删机制残留）。
- `pnpm ci:unit:file-size` 通过。
- 本次文档核对不修改 schema、版本或发布目标；运行时实现与测试证据来自当前根代码，`git diff --check` 由主线程统一执行。

## 11. 历史切片分工（不是当前未实现清单）

下表保留 A 片当时对 B–F 的依赖关系，记录历史分工与验收来源；当前未闭合门禁以 §9.2、§10 及各专题状态为准，不应把下表标题解释为这些切片尚未实现。

| 切片 | 依赖本片的产出 |
| --- | --- |
| B 准入材料化 | §4.2 新字段（否则注册行无法定义断网行为） |
| C 配置冻结 | §5.3 冻结段清单与越界 fail closed 语义 |
| D 预算与归因 | §5.2 保底、降级、来源归因三条语义 |
| E 归档脱敏 + RPC | §3.4 导出期兜底与 §3.3 出口矩阵、§6.2 判定表与 §6.3 C7 反例 |
| F 移除与回滚 | §7.5（新 Job / 旧冻结 Job / 运行中 / 恢复各自行为，不承诺无残留） |
| F 灰度 | §7 三层职责不变、§8 决策 4 的实测数值 |
