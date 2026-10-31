# 沙箱 Pi 观测内存扩展（`pi-observational-memory`）设计评审（#815 A 片）

> 状态：**待评审；本文件只有语义与判定标准，没有运行时代码改动，也未启用任何扩展。**
> 同步日期：2026-10-31。静态核对基线：PR 基线 `b655bed1543fc7377b6c1cc877c11b2be82925b1`，schema 65，pi `@earendil-works/pi-coding-agent` 1.4.0。
> 关联 issue：[#815](https://github.com/SummerSec/DeepSonar/issues/815)。本片通过前，B 片之后一律不启动。

## 0. 本片交付

| # | 交付 | 章节 |
| --- | --- | --- |
| 1 | memory 内容分类与脱敏规则 | §3 |
| 2 | `requires_egress` / `requires_gateway` 契约语义与断网行为 | §4 |
| 3 | 后台模型预算与优先级规则、账本来源维度 | §5 |
| 4 | RPC 纯净性判定标准与验证方法 | §6 |
| 5 | 与现有上下文治理（compaction / context window / 流截断）的关系 | §7 |

结论先行：**A 片可以否决整个接入，但不能被跳过。** §8 列出必须先由人拍板的 7 个决策点；§9 是尚未验证项。

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

  两端不是同一对象：3.1.4 的发布物是 `src/` 形态，master 之后改为 `dist` 构建产物。**因此 `entry` 必须按 tarball 逐版核对，不得从上游源码或上一版本推断。** 本次实测走本机配置的 npmmirror 镜像（字节已用自算哈希核过），canonical 源仍需复核；宿主兼容性、运行时行为均未验证，不能据源码推断发布产物已准入。
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
> 只核 `entry` 是不够的：工具名、hooks 与宿主导入决定它是否能被现有 adapter 解析、是否会触发 `PI_RPC_UNEXPECTED_EVENT` 或 `extension_error`。当前这些接口面仅在 npm 3.1.4 tarball 上核对过，**canonical 来源仍未证实**。

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
| L5 session 文件整体 | pi | 全部会话行（含 L1/L2） | evidence 冷存储 archive | 保留大小与读取权限边界；持久化前执行 §3.4 脱敏及结构化过滤要求（待实现） |

### 3.3 出口矩阵（重复副本必须逐项声明）

同一段记忆正文会出现在多个出口上，任何一个未覆盖都等同于未脱敏。下表为必须逐项验收的出口清单；「目标语义」必须在 C/E 片实现，本片只定要求。

| # | 出口 | 具体内容（发布包 3.1.4 核实） | as-built 行为 | 目标语义 |
| --- | --- | --- | --- | --- |
| E1 | session 文件与 evidence archive | 全部会话行，含 L1/L2 与工具结果 | 读全文 → `redactRuntimeSecrets`（密钥精确值）→ 归档；无内容分类过滤 | 持久化前按结构化条目过滤；密钥精确值脱敏不得当作内容分类脱敏 |
| E2 | recall 工具结果正文 | 工具名 `recall`，返回 observation/reflection 正文；`details.sourceEntries[].content` **默认就带**（`includeSourceContent` 默认 `true`）：上游 `src/tools/recall-observation.ts:152,263` | 作为普通 tool result 进入 session 与 RPC 帧；无专门过滤 | 与 E1 同策略；默认关闭或受限 `content` 需先改冻结配置并验收 |
| E3 | compaction summary / fold | `session_before_compact` hook 产出的压缩结果与 memory fold | 作为 session 内容与 `context.compacted` 身份链的一部分 | 按 E1 过滤；身份字段不得因过滤而失真（否则降级为 `context.compaction_unknown`） |
| E4 | 大 RPC 事件的落盘副本 | 超 1 MiB 帧投影后写入`/workspace/.deepsonar-rpc-output/*.json` 并归档为 runtime artifact（[pi-rpc-output.ts](../packages/runtime-sandbox/src/pi-rpc-output.ts)） | 已有密钥脱敏；但只对固定 payload 键做 4 KiB 预览，`content` 不在其中 | 与 E1 同策略；新增出口时必须显式声明保留/过滤规则（见 §6.3） |
| E5 | 普通工具结果在 Web viewer 的展示 | 现有 `parseAgentSession` 就把 tool result 渲染出来（[parseAgentSession.ts](../apps/web/src/session-viewer/parseAgentSession.ts)） | 已展示会话内 tool 结果 | **不开 memory 面板 ≠ 正文不显示**；E1/E2 的过滤规则必须先落地，不靠「不新增 UI」代替 |
| E6 | 配置、日志、通知、debug 文件 | `debugLog`（启用后写 agent 目录 NDJSON）、错误/fallback 通知、`om:status` 输出 | 默认关；catch-up 错误通知不完全受 `showWorkerNotifications` 控制 | 冻结关闭；出现记录即按敏感出口验收 |

撤权与删除语义（必须分开写，不得混用）：

- **撤销读取权限**：只保证按当前权限不再可读；不意味着历史副本已消失。
- **dropper 删除**：只是把 observation 移出 active memory，**不是**撤权，也不是历史擦除（ledger 仍保留）。
- **历史擦除**：本 issue **不承诺**任何擦除能力；若将来要做，需单独设计（含 session 归档、evidence blob、RPC 导出文件三处副本）。

### 3.4 规则（供 C/E 片实现）

1. **写入侧优先**：L1/L2 由扩展生成，平台无法逐字审计。关闭 `debugLog` 与 `showWorkerNotifications` 只减少输出，不是敏感正文脱敏保证；写入 session 的 observations/reflections、错误通知仍需检查。C 片须冻结这些配置与 `passive` 语义（见 §8 决策 2），E 片须用含秘密的夹具验证各出口。上游 `src/debug-log.ts` 写文件而非默认 stdout；catch-up 错误通知也不完全受 `showWorkerNotifications` 控制。
2. **导出侧兜底**：若 E 片发现归档中出现 L3 或凭据明文，必须停止接入；修复方式是收紧扩展配置或加导出期脱敏，**不是**放宽归档正则。
3. **不得投影**：L1/L2 不投影为 Finding、Fact、业务 Artifact、验证 Evidence、报告或质量指标；受控 session archive 中的物理存储不构成这种投影。memory 是模型的上下文治理产物，不是证据。任何"从 memory 生成 Finding/知识"的路径都超出本 issue 范围。
4. **UI 边界**：Web session viewer 只按现有 pi 行格式解析（[parseAgentSession.ts](../apps/web/src/session-viewer/parseAgentSession.ts)）；不得为 memory 条目新增展示面板，除非先通过 G10 脱敏评审。
5. **撤权语义**：memory 是 Job 内产物，Job 归档与权限沿用现有 evidence 读取边界；不因 memory 提供跨 Job 可读性。

## 4. 交付 2：`requires_egress` / `requires_gateway` 契约语义

### 4.1 现状事实

- `materializeFrozenPiExtensions(frozen, allowEgress)` 对 `requires_egress: true` 的扩展在 `allowEgress === false` 时**直接跳过**（不进 `paths`，记入 `skipped`）。
- `allow_egress` 只控**目标网络**：提示词写明「本任务禁止访问模型网关之外的网络」（[executor-real.ts:897](../apps/scheduler/src/executor-real.ts)），env 侧是 `DEEPSONAR_ALLOW_EGRESS=0/1`（[executor-real.ts:837](../apps/scheduler/src/executor-real.ts)）。
- 两种模式均设计为只经获准 Gateway 出模型；这不保证当前路由、凭据、模型授权或服务健康恒满足（[provider-settings.ts](../apps/scheduler/src/provider-settings.ts) 的 gateway rewrite 路径）。

也就是说：**现有 `requires_egress` 是"业务出网"语义，而 om 需要的是"模型出网"，两者被一个字段混在一起。**

### 4.2 提议契约（待评审）

注册行增加两个正交必填字段，二者都缺省即拒绝加载注册表（fail closed，不留推断分支）：

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

### 5.1 现状事实

- Job Token 额度：`job_tokens.max_requests`（本 PR 基线默认 500，`0` 表示不限；这是待独立修复的基线事实，不是本设计目标，[config.ts:262](../apps/scheduler/src/config.ts)）由 `runtime_knobs.job_token_max_requests` 冻结（[executor-real.ts:775](../apps/scheduler/src/executor-real.ts)）；超限直接对调用方 429 `quota_exhausted`（[gateway.ts:719-730](../apps/scheduler/src/gateway.ts)）。
- 用量账本 `job_usage_ledger` 的 `source` 只有 `gateway_response` / `gateway_stream` / `gateway_error`（[schema.sql](../database/schema.sql)），**没有"谁发起的请求"维度**。

因此若直接接入现有有限额度路径：om 的后台请求和主会话共用同一个计数器；后台跑满后，主 Agent 下一次请求就会 429 —— 这是把"记忆功能失败"升级成"任务失败"。

### 5.2 提议语义（待评审）

1. **默认不限**：按用户最新要求，预算、请求数、token、轮数等额度只有显式配置才限制；未配置归一化为 `unlimited`，不得隐式套用 500、16、32_000 或预留比例。本 PR 不实现该代码改动，也不改写既有 Job 冻结配置；协议大小、权限和防死循环保护不属于预算配额。
2. **显式有限额度的主会话保底契约**：若管理员配置总请求数 `N > 0`，启用 OM 前必须书面选择并冻结可执行的主会话预留或后台隔离契约，D 片证明其在共享总账下仍有效。未选择契约不得启用 OM，不能将缺失预留 `R` 自动当作 0 后宣称保底，也不得偷偷补默认配额。预留方案要求显式 `0 < R ≤ N`，保证后台不能消耗尚未被主会话使用的预留；这不是主会话无限调用保证。后台隔离若仍共享有限总额，必须证明后台无法耗尽主会话承诺的份额，单有独立后台计数器不够。若选择比例预留，其示例值为 `R = min(N, max(ceil(N * 0.2), 20))`，不是默认策略。`N=1/19/20` 在该显式策略下后台额度为 0，`N=21` 为 1。`N=0`（现有不限哨兵）或未配置走 `unlimited` 分支，不做减法，也不因此要求有限额度契约；独立后台限额只有显式配置才生效。其他显式有限 token/成本总额同样必须说明主会话保底/隔离口径，不能借请求数不限绕过。
3. **并发预留**：有限额度下在可信 Gateway/Job 锁内原子检查已用量与在途预留后再准入；主会话与后台共用总账，后台另受显式后台额度/主会话保底约束，计算时扣除主会话尚未使用的预留份额。不得用客户端读数先检查后递增；失败/取消按真实请求效果结算，未知用量不得当作零返还。无限额度不做配额拒绝，但继续记账与权限校验。请求数、token 与成本不得混用单位；调用前 token 上界及未知用量策略仍需 D 片证明。
4. **超限降级可见**：后台额度耗尽跳过本轮 observe/reflect，记录 `skipped_budget_exhausted`；不得把后台耗尽冒充主会话失败。主会话自己达到显式总限额仍受限制。恢复、重试不得重置冻结额度或已有用量。
5. **可信归因**：新增独立 workload 维度区分主会话与后台，身份必须由可信内核绑定并经 Gateway 校验；沙箱自报 header 不可信。保留现有结算 `source` 的 `gateway_response` / `gateway_stream` / `gateway_error` 语义，不能覆盖。独立 token/可信调用上下文的具体方案留 D 片评审，不能扩大 Job 权限或模型白名单；observer、reflector、dropper、fallback、compaction catch-up、retry 均覆盖同一鉴权、额度与归因规则。
6. **成本口径**：后台成本单列，不冒充 Finding 质量收益或主会话成本；项目/Job 总用量仍包含这些真实请求，明细可按 workload 分解且总账可对账。

### 5.3 冻结配置段（G5 语义）

C 片由 Scheduler 从 Job 快照生成 `.pi/agent/settings.json` 的 `observational-memory` 段，至少冻结：

- `compactAfterTokensMode` + `compactAfterTokensRatio`（或 `calibrated` 阈值）
- `observeAfterTokens` / `reflectAfterTokens`
- `agentMaxTurns` / `agentMaxTokens`：只有管理员显式配置才有限额；未配置必须表达不限，不能让上游默认 16 / 32_000 悄悄生效。上游是否支持不限及如何适配尚未验证，未满足不得启用
- `showWorkerNotifications: false`、`debugLog: false`
- `passive`（见 §8 决策 2）

约束：覆盖整个 defaults → global → project → env 链，以及独立 `compaction.enabled` 读取；不能只重写全局 settings。需受控适配层消费冻结值，并隔离/拒绝项目 settings 和相关 env 的覆盖，加载后校验有效配置与冻结快照一致（包括模型/fallback）。具体实现待 C 片验证。只接受注册表声明过的 knob；越界或未知字段 fail closed；Agent、Job 内容、项目配置一律不得覆盖该段（需要稳定 error code 与 RepairFeedback 分类）。

### 5.4 后台模型与 Gateway 冻结模型守卫

- Gateway 对请求模型执行 Job 冻结白名单校验：[gateway-guard.ts:66](../apps/scheduler/src/domains/provider-adapter/gateway-guard.ts) `assertGatewayRequestModelAllowed`（出口在 [gateway.ts](../apps/scheduler/src/gateway.ts)），不匹配抛 `GATEWAY_FROZEN_MODEL_MISMATCH`（同文件 `:24`）。适配器未声明 `enforce_frozen_model`、`passthrough` 或白名单为空时软放行（历史快照语义）。
- 上游 `normalizeSettingsConfig` 接受 `model` 键，即 observer / reflector / dropper 可以指定与会话冻结模型**不同的模型**。
- 与 §6 的 `extension_error` → `failRuntime` 语义叠加后，后台 403 / 模型不匹配可能不是「记忆功能降级」，而是**整个 Job 失败**。

规则：首版**不允许 observer 独立模型**——C 片冻结配置不写入 `model`（或强制等于冻结模型）。若后续要支持独立模型，必须先在 D 片证明它满足同一冻结白名单、同一额度与同一归因，且不得为接入放宽既有 `enforce_frozen_model` 权限。E 片夹具必须覆盖「后台模型 ≠ 冻结模型」这一例，并断言失败时是受控降级而不是 Job 失败。

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

### 6.3 C7 的代码条件反例（未复现运行故障）

`recall` 默认带源条目正文，而大帧保护存在结构盲区：

- 帧字节 > `PI_RPC_INLINE_BYTES`（1 MiB）时进入捕获投影（[pi-rpc-output.ts:4](../packages/runtime-sandbox/src/pi-rpc-output.ts)、[runtime-agent.ts:1531-1532](../packages/runtime-sandbox/src/runtime-agent.ts)）。
- 投影只对 `PAYLOAD_KEYS = {text, delta, output, result, error, errorMessage, message}` 做 4 KiB 预览（[pi-rpc-output.ts:6](../packages/runtime-sandbox/src/pi-rpc-output.ts)）；**`content` 不在其中**。
- 投影后仍 > 1 MiB 即抛 `PI_RPC_UNSUPPORTED_LARGE_STRUCTURE`（同文件 `:60`），该错误从帧循环抛出，**不是降级**。

因此「一帧约 1.1 MiB 且体积压在 `details.sourceEntries[].content` 上的 recall 结果」在静态推演下会硬失败，即使原帧小于 8 MiB 上限。此为**代码条件反例**，尚未验证发布版 3.1.4 在真实 rpc 会话中是否产生同形帧，不记作已复现运行故障。

验收要求：离线夹具必须包含带完整 `details` 的 `recall` 用例（不只 `cat` / `curl`），覆盖 4 KiB 预览键与非预览键两种结构；若确认会触发，修法只能是收紧扩展输出或为 `content` 类结构增加明确处理，**不得**把该错误改成静默降级。

验证方法（E 片执行，本片只定标准）：

1. `pnpm ci:smoke:pi-rpc`（现有离线 RPC 夹具，[test-pi-rpc.mjs](../agent-harness/test-pi-rpc.mjs)）。
2. 在同镜像、固定上游产物、`--no-extensions -e <om stub>` 下使用离线 fake provider 和受控 Gateway 替身，禁止真实模型及外部网络；记录所有调用、stdout/stderr、通知、debug 文件、session 与最终 archive。覆盖最小会话、大输出、主动 workers、passive 下恢复已有 observations 后的 compaction catch-up、fallback/retry、异常通知、kill/resume、取消与并发额度竞争。夹具须进仓库并有测试入口（`ci-test-hook` 棘轮）。
3. 以现有 harness 的 `StrictJsonlReader` 检查逐字节 framing、非 JSON 行与尾部残留，再通过生产 `parsePiJsonlRecord` 验证事件语义；不得以宽松解析器替代。
4. 注入恶意项目 `.pi/settings.json`、环境变量及恢复 session，证明冻结值不可覆盖；用可识别秘密标记覆盖正文、错误、通知、日志、session/archive 和模型请求出口，检查结构化过滤后的引用完整性。预算表覆盖未配置、0 不限、1/19/20/21、有限总额、显式后台限额、并发在途与未知用量；额外覆盖反例 `N=1`、`R` 未配置、后台限额未配置：后台先调用和主后台并发抢占时，都应因缺少有限额度契约而不启用 OM，不能让后台消耗唯一额度后再拒绝主会话；另验证显式 `R=1` 时后台不能占用该份额。所有项目均为未来离线验收计划，本次没有运行。

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
| 恢复 / retry / rerun | 按快照仍带 om | 不因组合变更而视为快照失效；除非管理员显式选择重解析 |

因此 **F 片不得承诺「移除即回到旧行为、无残留」**。可承诺的只有：新 Job 不再冻结该扩展、历史快照不被暗改、已冻结 Job 仍可审计。

验收（离线）：先创建并冻结一个带 om 的 Job，再从组合移除 om，随后启动/恢复该旧 Job，断言它仍按快照带 om 且快照字节未变。

撤销读取权限与擦除历史内容严格分开（见 §3.3）：移除组合不是撤权，也不是擦除；dropper 删除更不能当作历史擦除。

## 8. 必须由人拍板的决策点

以下 7 项均为待定方案；本 PR 收录建议不代表这些选项已获批准。A 正式通过所需书面记录见 §10。

| # | 决策 | 选项 | 建议 |
| --- | --- | --- | --- |
| 1 | `requires_egress` / `requires_gateway` 是否按 §4.2 拆字段（含注册表 fail closed） | 拆 / 保持单字段并把 om 判为不兼容断网 Job | 拆；单字段会留下不可审计的静默跳过 |
| 2 | 主动模式与 passive 的实际调用边界 | 均经完整模型治理 / 拒绝接入 | passive 不是零模型调用保证：上游 `src/hooks/compaction-hook.ts` 可调用 `compaction-catch-up.ts:48-114` 的 `runObserver`，恢复已有 observations 后也需验证；治理未落地不得以 passive 替代 |
| 3 | 后台 worker 失败是否可接受 Job 失败（现状 `extension_error` 会失败） | 接受 / 必须降级 | 必须降级；把记忆功能失败放大成任务失败不可接受 |
| 4 | 显式有限总额下的保底契约 | 显式比例/绝对值预留 / 可证明有效的后台隔离 | 默认不限且不预留；有限总额未选契约不得启用 OM，不隐式补额度；选定契约与数值须书面冻结并按 §5.2 验收 |
| 5 | 独立可信 workload 维度实现方式 | 内核绑定的独立 token / 可信调用上下文 | 待 D 片评审；拒绝自报 header，保留原结算 source、模型白名单与全出口治理 |
| 6 | 压缩身份链与 om 的关系 | 以 DeepSonar 身份为准并在无法表达时降级 / 扩展新 policy 表达 om | 先降级（诚实），有真实需求再扩契约 |
| 7 | observer 是否允许独立模型（见 §5.4） | 只允许冻结模型 / 允许但受白名单与额度约束 | 首版只允许冻结模型；放宽需 D 片单独评审，不得放宽 `enforce_frozen_model` |

## 9. 未验证项（不得当作已通过）

1. 沙箱 `--mode rpc` 下 om 是否真正可用：原设计曾报告本机 TUI 可加载，本次未复现，不能替代固定发布产物与 RPC 验收；**rpc 模式未跑**。
2. debug 默认关且开启写 NDJSON 文件已静态核对；RPC 下通知/错误实际出口及 C5 仍未验证。
3. om 是否会触发 `extension_error`（C2 的实际结论）。
4. om 的 compaction hook 是否产出与 pi 原生一致的 `compaction_end` 结果（C3）。
5. 后台 worker 的请求量级与对上游限流的影响（上游默认轮数不等于请求总量，fallback/catch-up/retry 也需计数）。
6. memory ledger 对 session 体积、32 MiB 归档上限与 `BLOB_DIR` 的挤压程度。
7. 剪贴板路径在无 X/Wayland 沙箱中的失败是否只影响 TUI 命令（不影响 rpc）。
8. npm tarball/integrity（现已核 3.1.4 的发布物内容与 integrity；**canonical 来源仍未证实**，npmmirror 副本自算哈希一致不等于 canonical 已验）、宿主兼容、升级到下一版的 `entry` 及 §1 接口面（工具 schema / hooks / 配置键 / 导入 API）仍未验；完整配置覆盖隔离、passive 恢复 catch-up、无限额度适配、可信归因均未验证。
9. 后台 worker 实际发出的模型是否可能落在冻结白名单外，以及 `GATEWAY_FROZEN_MODEL_MISMATCH` 到 Job 终态的传播路径（§5.4）尚未实测。
10. C7 的 1.1 MiB `details…content` 反例是**代码静态推演**，未在 rpc 会话中复现；`includeSourceContent` 默认 `true` 已从发布包源码核实，但默认值是否被冻结配置改变、以及 Web viewer 是否实际渲染大块 `content`（E5）未验。
11. 质量收益：压缩效果、上下文丢失率、`context_window_exceeded` 发生率——需冻结数据集与对照试验，本 issue 不做承诺。

## 10. A 片验收

- **合并本 PR 仅收录待决设计草案，不构成 A 正式通过，也不授权启动 B。** A 通过必须另有明确书面决策记录，逐项列出 §8 的 7 项选定方案、有限总额下保底/隔离契约与未决项处理，并明确写出 A 通过结论。未决阻断项未解决不得进入 B，不能把文档 review、CI 成功或合并状态当作该结论。
- 注册前必须完成 canonical 发布物来源、tarball integrity 与实际 entry 的核验；启用前必须完成固定宿主兼容、§6 RPC、配置隔离、额度/归因和 §3 数据出口验收。A 的设计决策通过不代替后续实证验收。
- 若 A 否决则停止，**不注册、不预装、不启用**。只有 A 已通过并进入后续切片、E 再失败时，才可能已有预装产物；此时默认关闭并停止启用，不能以预装倒推通过 A。
- `pnpm ci:unit:docs-freshness` 通过（版本字面量、命令存在性、链接、已删机制残留）。
- `pnpm ci:unit:file-size` 通过。
- 本片不修改 schema、不修改运行时行为、不新增依赖；`git diff --check` 干净。

## 11. 后续切片依赖

| 切片 | 依赖本片的产出 |
| --- | --- |
| B 准入材料化 | §4.2 新字段（否则注册行无法定义断网行为） |
| C 配置冻结 | §5.3 冻结段清单与越界 fail closed 语义 |
| D 预算与归因 | §5.2 保底、降级、来源归因三条语义 |
| E 归档脱敏 + RPC | §3.4 导出期兜底与 §3.3 出口矩阵、§6.2 判定表与 §6.3 C7 反例 |
| F 移除与回滚 | §7.5（新 Job / 旧冻结 Job / 运行中 / 恢复各自行为，不承诺无残留） |
| F 灰度 | §7 三层职责不变、§8 决策 4 的实测数值 |