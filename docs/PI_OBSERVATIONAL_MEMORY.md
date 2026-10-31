# 沙箱 Pi 观测内存扩展（`pi-observational-memory`）设计评审（#815 A 片）

> 状态：**待评审；本文件只有语义与判定标准，没有运行时代码改动，也未启用任何扩展。**
> 同步日期：2026-10-31。静态核对基线：main `e0eef249`，schema 65，pi `@earendil-works/pi-coding-agent` 1.4.0。
> 关联 issue：[#815](https://github.com/SummerSec/DeepSonar/issues/815)。本片通过前，B 片之后一律不启动。

## 0. 本片交付

| # | 交付 | 章节 |
| --- | --- | --- |
| 1 | memory 内容分类与脱敏规则 | §3 |
| 2 | `requires_egress` / `requires_gateway` 契约语义与断网行为 | §4 |
| 3 | 后台模型预算与优先级规则、账本来源维度 | §5 |
| 4 | RPC 纯净性判定标准与验证方法 | §6 |
| 5 | 与现有上下文治理（compaction / context window / 流截断）的关系 | §7 |

结论先行：**A 片可以否决整个接入，但不能被跳过。** §8 列出必须先由人拍板的 6 个决策点；§9 是尚未验证项。

## 1. 动机与现状事实

- 沙箱 Pi 以 `pi --mode rpc --no-approve --no-extensions -e <准入 stub>` 启动（[runtime-adapters.ts:611](../packages/runtime-sandbox/src/runtime-adapters.ts)），项目 `.pi` 目录不会自动加载，扩展只能来自平台注册表（[pi-extensions.ts:30](../packages/shared-types/src/pi-extensions.ts)）。
- 因此当前 Job 内的上下文压缩完全由 pi 自身 compaction 完成，逐级 summary 化；Scheduler 侧只有两条兜底：`context_window_exceeded` 自动重试 1 次、`pi_stream_truncated` 自动重试 1 次（[context-window-exceeded.ts](../apps/scheduler/src/context-window-exceeded.ts)、[pi-stream-truncation.ts](../apps/scheduler/src/pi-stream-truncation.ts)）。
- `pi-observational-memory`（MIT，v3.1.4）把记忆工作提前到 `turn_end` 后台完成，使 compaction 变成渲染步骤。它的后台 worker（observer / reflector / dropper）通过 `agentLoop` 发起**真实模型请求**，默认 `agentMaxTurns: 16`、`agentMaxTokens: 32_000`，在 DeepSonar 里这些请求只能走 Gateway。
- 扩展入口是 `./src/index.ts`（不是 `index.ts`），纯 TS 源码分发，peerDependencies 全为 `*`，运行期外部依赖只有宿主提供的 `@earendil-works/pi-ai/compat` 与 `pi-agent-core`；`typebox` 仅作为类型导入（编译期擦除）。
- 配置来自 `.pi/agent/settings.json` 的 `observational-memory` 段；**该文件由平台重写**（[provider-settings.ts:236-244](../apps/scheduler/src/provider-settings.ts) 先过滤原文件，再只写 `retry`）。

## 2. 为什么不能直接注册（硬门复述）

| # | 门禁 | 位置 | 本片给出 |
| --- | --- | --- | --- |
| G4 | `requires_egress` 语义把「业务出网」与「模型出网」混为一谈 | [executor-real.ts:1097-1099](../apps/scheduler/src/executor-real.ts) → `materializeFrozenPiExtensions(frozen, allowEgress)` | §4 |
| G5 | 扩展配置无处声明 | [provider-settings.ts:236-244](../apps/scheduler/src/provider-settings.ts) | §5.3 冻结段语义 |
| G6/G7 | 后台 worker 抢主会话请求额度、账本无来源维度 | [config.ts:262](../apps/scheduler/src/config.ts)、[gateway.ts:719-730](../apps/scheduler/src/gateway.ts) | §5 |
| G9 | 未知 RPC 帧直接判失败，`extension_error` 让整个 Job 失败 | [runtime-adapters.ts:228-243,580-582](../packages/runtime-sandbox/src/runtime-adapters.ts) | §6 |
| G10 | memory 内容落在 session 文件里 = 自动进归档 | [cli-session-adapters.ts:94-120](../packages/runtime-sandbox/src/cli-session-adapters.ts) | §3 |
| G11 | 快照冻结 version/entry，扩展升级后旧快照拒绝重放 | `parseFrozenPiExtensions` | §7.4 |

## 3. 交付 1：memory 内容分类与脱敏规则

### 3.1 关键事实（决定规则形状）

Pi session 归档导出的是**session 文件原样字节**：只要 `sessionFile` 落在 `/workspace/.deepsonar-home/.pi/agent/` 且小于 32 MiB，就直接作为 artifact 归档（[cli-session-adapters.ts:94-120](../packages/runtime-sandbox/src/cli-session-adapters.ts)），当前没有字段级过滤。

因此 **om 的 memory ledger / observations / reflections 一旦写进 session 文件，就已经在归档里**，事后无法"选择不入库"。规则只能是"先别写进去"+"导出前脱敏"，不能设计成"归档时丢弃某类条目"。

### 3.2 分类矩阵

| 数据类 | 产生者 | 典型内容 | 落点（as-built） | 目标规则 |
| --- | --- | --- | --- | --- |
| L1 observation | observer worker | 本轮发生了什么、执行了什么命令、得到什么结果 | session 文件（ledger） | 允许存在；**禁止写入凭据明文、token、key、完整上游错误正文** |
| L2 reflection | reflector worker | 用户决策、约束、目标、偏好等持久事实 | session 文件（ledger） | 允许存在；**禁止把 shared asset 正文或 evidence 文件内容粘贴进来**；只允许短句摘要 |
| L3 worker prompt / response 原文 | observer/reflector/dropper | 送给 worker 的上下文、模型返回 | 仅进程内存 | 不得写入 workspace 其他路径、不得进 evidence、不得进 RPC 帧 |
| L4 memory 索引/状态（`om:status` 输出、debug log） | 扩展 | 阈值、池大小、token 估算 | 默认 stdout（TUI） | **冻结关闭**：`debugLog: false`、`showWorkerNotifications: false` |
| L5 session 文件整体 | pi | 全部会话行（含 L1/L2） | evidence 冷存储 archive | 沿用现状（原样字节，32 MiB 上限）；本片不新增过滤，但要求 §3.3 的导出期脱敏门槛 |

### 3.3 规则（供 C/E 片实现）

1. **写入侧优先**：L1/L2 由扩展生成，平台无法逐字审计。因此 C 片必须在冻结配置里关闭 `debugLog` 与 `showWorkerNotifications`，并显式设置 `passive` 语义（见 §8 决策 2）。
2. **导出侧兜底**：若 E 片发现归档中出现 L3 或凭据明文，必须停止接入；修复方式是收紧扩展配置或加导出期脱敏，**不是**放宽归档正则。
3. **不得投影**：L1/L2 不进入 Finding、Fact、Artifact、Evidence、报告、质量指标。memory 是模型的上下文治理产物，不是证据。任何"从 memory 生成 Finding/知识"的路径都超出本 issue 范围。
4. **UI 边界**：Web session viewer 只按现有 pi 行格式解析（[parseAgentSession.ts](../apps/web/src/session-viewer/parseAgentSession.ts)）；不得为 memory 条目新增展示面板，除非先通过 G10 脱敏评审。
5. **撤权语义**：memory 是 Job 内产物，Job 归档与权限沿用现有 evidence 读取边界；不因 memory 提供跨 Job 可读性。

## 4. 交付 2：`requires_egress` / `requires_gateway` 契约语义

### 4.1 现状事实

- `materializeFrozenPiExtensions(frozen, allowEgress)` 对 `requires_egress: true` 的扩展在 `allowEgress === false` 时**直接跳过**（不进 `paths`，记入 `skipped`）。
- `allow_egress` 只控**目标网络**：提示词写明「本任务禁止访问模型网关之外的网络」（[executor-real.ts:897](../apps/scheduler/src/executor-real.ts)），env 侧是 `DEEPSONAR_ALLOW_EGRESS=0/1`（[executor-real.ts:837](../apps/scheduler/src/executor-real.ts)）。
- Gateway 在两种模式下都可达（受限网络就是靠 Gateway 出模型，[provider-settings.ts](../apps/scheduler/src/provider-settings.ts) 的 gateway rewrite 路径）。

也就是说：**现有 `requires_egress` 是"业务出网"语义，而 om 需要的是"模型出网"，两者被一个字段混在一起。**

### 4.2 提议契约（待评审）

注册行增加两个正交必填字段，二者都缺省即拒绝加载注册表（fail closed，不留推断分支）：

| 字段 | 含义 | 值为 true 时物化条件 |
| --- | --- | --- |
| `requires_egress` | 扩展自身要访问目标/外部网络 | 需要 `allow_egress === true`，否则跳过并记录 `skipped` |
| `requires_gateway` | 扩展会产生模型请求（走 Gateway） | 恒满足（Gateway 在受限网络下仍可达），但必须写入快照与运行记录，供审计与成本归因使用 |

行为矩阵：

| `requires_egress` | `requires_gateway` | `allow_egress=true` | `allow_egress=false` |
| --- | --- | --- | --- |
| false | false | 注入 | 注入 |
| false | true | 注入，记「后台模型请求」 | 注入，记「后台模型请求」 |
| true | false | 注入 | 跳过（`skipped`，原因 `egress_required`） |
| true | true | 注入，记「后台模型请求」 | 跳过（`skipped`，原因 `egress_required`） |

`pi-web-access` 迁移为 `requires_egress: true` / `requires_gateway: false`（它不产生模型请求），行为与今天一致——这是本片要求的唯一既有语义证明点。

### 4.3 拒绝的替代方案

- **不采用**「om 标 `requires_egress: false` 蒙过去」：断网 Job 里后台请求会打到不可达地址，表现为 worker 反复失败，而平台记录里看不出原因。
- **不采用**「断网时静默降级为无 om」：同一快照在不同网络策略下行为不同，且与 §6 的失败语义冲突，无法审计。

## 5. 交付 3：后台模型预算与优先级

### 5.1 现状事实

- Job Token 额度：`job_tokens.max_requests`（默认 500，`0` 表示不限，[config.ts:262](../apps/scheduler/src/config.ts)）由 `runtime_knobs.job_token_max_requests` 冻结（[executor-real.ts:775](../apps/scheduler/src/executor-real.ts)）；超限直接对调用方 429 `quota_exhausted`（[gateway.ts:719-730](../apps/scheduler/src/gateway.ts)）。
- 用量账本 `job_usage_ledger` 的 `source` 只有 `gateway_response` / `gateway_stream` / `gateway_error`（[schema.sql](../database/schema.sql)），**没有"谁发起的请求"维度**。

因此现状下：om 的后台请求和主会话共用同一个计数器；后台跑满后，主 Agent 下一次请求就会 429 —— 这是把"记忆功能失败"升级成"任务失败"。

### 5.2 提议语义（待评审）

1. **主会话保底**：后台记忆请求只能使用"主会话预留之后"的额度。定义 `reserve = max(ceil(max_requests * 0.2), 20)`（数值待定，见 §8 决策 4），后台可用额度 = `max_requests - reserve`。
2. **超限降级而不是失败**：后台请求超限时，扩展必须**跳过本轮** observe/reflect（可观测为一次明确记录的降级），**不得**让主会话收到 `quota_exhausted`。
3. **额度耗尽可见**：降级要落到可查记录（事件或账本字段），不能只在沙箱内沉默。状态语义：`skipped_budget_exhausted`，与 `failed` 分开。
4. **来源归因**：账本需要能区分主会话与后台记忆。最小实现是新增请求来源维度（如 header 或独立 token），在 `job_usage_ledger` 上体现；**本片只定语义，不选具体 schema 方案**（属 D 片）。
5. **成本口径**：后台记忆的 token 不得计入 Finding 单位成本、质量指标与项目用量看板的任务画像，必须单列。

### 5.3 冻结配置段（G5 语义）

C 片由 Scheduler 从 Job 快照生成 `.pi/agent/settings.json` 的 `observational-memory` 段，至少冻结：

- `compactAfterTokensMode` + `compactAfterTokensRatio`（或 `calibrated` 阈值）
- `observeAfterTokens` / `reflectAfterTokens`
- `agentMaxTurns` / `agentMaxTokens`（必须显式给值，不用扩展默认的 16 / 32_000）
- `showWorkerNotifications: false`、`debugLog: false`
- `passive`（见 §8 决策 2）

约束：只接受注册表声明过的 knob；越界或未知字段 fail closed；Agent、Job 内容、项目配置一律不得覆盖该段（需要稳定 error code 与 RepairFeedback 分类）。

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

验证方法（E 片执行，本片只定标准）：

1. `pnpm ci:smoke:pi-rpc`（现有离线 RPC 夹具，[test-pi-rpc.mjs](../agent-harness/test-pi-rpc.mjs)）。
2. 新增录制夹具：在同镜像、`--no-extensions -e <om stub>` 下跑一次最小会话 + 一次大输出，把 stdout 落 JSONL，断言 C1–C6。夹具必须进仓库并有测试入口（`ci-test-hook` 棘轮）。
3. 断言实现应复用 `parsePiJsonlRecord`，**不允许**在测试里写"宽松版解析器"，否则验证的是另一个协议。

## 7. 交付 5：与现有上下文治理的关系

### 7.1 三层职责（必须保持分离）

| 层 | 谁负责 | 现状 | 接入 om 后 |
| --- | --- | --- | --- |
| 会话内记忆与压缩触发 | pi + 扩展 | pi 内建 compaction | om 提前完成 observe/reflect，compaction 变渲染 |
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

## 8. 必须由人拍板的决策点

| # | 决策 | 选项 | 建议 |
| --- | --- | --- | --- |
| 1 | `requires_egress` / `requires_gateway` 是否按 §4.2 拆字段（含注册表 fail closed） | 拆 / 保持单字段并把 om 判为不兼容断网 Job | 拆；单字段会留下不可审计的静默跳过 |
| 2 | om 是否允许 `passive: false`（即主动触发后台模型请求） | 只允许 passive / 允许主动但受额度约束 | 首版允许主动，但必须在 §5.2 额度与降级全部落地之后；否则只上 passive |
| 3 | 后台 worker 失败是否可接受 Job 失败（现状 `extension_error` 会失败） | 接受 / 必须降级 | 必须降级；把记忆功能失败放大成任务失败不可接受 |
| 4 | 主会话预留比例的具体数值 | 20% / 绝对值 50 / 不做预留 | 先按 `max(20%, 20)`，用 F 片实测再定 |
| 5 | 账本来源维度实现方式 | header / 独立 token / 新列 | 待 D 片评审；本片只要求"可区分" |
| 6 | 压缩身份链与 om 的关系 | 以 DeepSonar 身份为准并在无法表达时降级 / 扩展新 policy 表达 om | 先降级（诚实），有真实需求再扩契约 |

## 9. 未验证项（不得当作已通过）

1. 沙箱 `--mode rpc` 下 om 是否真正可用：本机 Linux + pi 1.4.0 TUI 模式可加载，**rpc 模式未跑**。
2. om 的 worker 是否会把通知/debug 写到 stdout（C5 的实际结论）。
3. om 是否会触发 `extension_error`（C2 的实际结论）。
4. om 的 compaction hook 是否产出与 pi 原生一致的 `compaction_end` 结果（C3）。
5. 后台 worker 的请求量级与对上游限流的影响（`agentMaxTurns: 16` × 3 类 worker）。
6. memory ledger 对 session 体积、32 MiB 归档上限与 `BLOB_DIR` 的挤压程度。
7. 剪贴板路径在无 X/Wayland 沙箱中的失败是否只影响 TUI 命令（不影响 rpc）。
8. 质量收益：压缩效果、上下文丢失率、`context_window_exceeded` 发生率——需冻结数据集与对照试验，本 issue 不做承诺。

## 10. A 片验收

- 本文件评审通过，或 §8 决策以书面结论记录（含否决时明确"停止在预装不启用"）。
- `pnpm ci:unit:docs-freshness` 通过（版本字面量、命令存在性、链接、已删机制残留）。
- `pnpm ci:unit:file-size` 通过。
- 本片不修改 schema、不修改运行时行为、不新增依赖；`git diff --check` 干净。

## 11. 后续切片依赖

| 切片 | 依赖本片的产出 |
| --- | --- |
| B 准入材料化 | §4.2 新字段（否则注册行无法定义断网行为） |
| C 配置冻结 | §5.3 冻结段清单与越界 fail closed 语义 |
| D 预算与归因 | §5.2 保底、降级、来源归因三条语义 |
| E 归档脱敏 + RPC | §3.3 导出期兜底规则、§6.2 判定表 |
| F 灰度 | §7 三层职责不变、§8 决策 4 的实测数值 |