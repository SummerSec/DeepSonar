# 运行证据、图谱可操作性与执行治理落地方案

> 状态：**历史方案稿**（证据冷存储、Job 详情、图筛选等多项已 as-built）。  
> 冲突时以 `DESIGN.md`、代码与 OpenAPI 为准；下文「现状问题」描述的是 2026-08-02 样本，勿当当前缺陷清单。
> 日期：2026-08-02

## 1. 现状与已复现问题

以项目 `java-sec-code 全量审计`、画布 `fed8e97c-fe00-4b24-b81f-c47dd21815df` 为样本：

- 画布已有 36 条 Finding，severity 分布为 critical 5 / high 19 / medium 9 / low 3。
- `/findings?severity=...` 后端查询结果正确，但页面缺少稳定、可验证的详情交互；列表点击只回到任务画布，不能直接打开指定 Finding。
- “本次运行”只有不可点击表格；Job 详情 API 虽返回语义事件，但任务页没有历史执行过程入口。
- 所有既有 Job 的 `transcript_uri` 均为空。原始 Agent 流只保存在 Scheduler 进程内 WebSocket 环形缓冲，运行结束或进程重启后无法追溯。
- 当前 Agentbox 容器内能确认 Claude Code 原始文件位于 `/root/.claude/projects/-workspace/<session_id>.jsonl`，CLI 初始化事件也包含 `session_id`，但销毁沙箱前未归档。
- 图上 root / Hub / intent / Finding / role job 大量复用同一视觉卡片，只靠小号文字区分；节点数量上升后无法快速辨认，也没有类型、角色、状态或 severity 筛选。
- Credential 只能配置 `base_url` 等公共元数据，不能限制可用模型 ID。
- Dispatcher 只有全局与项目并发上限，没有按 `agent_cli` 的全局并发配额。

## 2. 决策摘要

### 2.1 证据采用“双轨制”

1. **原始 Session 证据**：保留各 Agent CLI 的原生 Session 内容，供查看、下载和审计取证。
2. **统一运行遥测**：实时流、工具调用、进度和运行状态统一为平台事件；CLI 原生支持时可通过 OTLP 自动上报，不支持时由 CLI Adapter 转换。

OTLP 不替代原始 Session。OTLP 适合检索、聚合、指标、trace 和实时展示；原始 Session 负责忠实留档与问题复盘。

### 2.2 引入 CLI Adapter，而不是硬编码一个目录

运行时新增统一适配接口：

```ts
interface AgentCliAdapter {
  cli: "claude-code" | "codex" | "open-code";
  buildInvocation(...): CliInvocation;
  mapStreamEvent(raw: unknown): NormalizedRunEvent[];
  discoverSession(runtime: SandboxAccess, identity: SessionIdentity): Promise<SessionArtifact[]>;
  exportSession(runtime: SandboxAccess, identity: SessionIdentity): Promise<SessionBundle>;
  configureTelemetry(context: JobTelemetryContext): WorkspaceAndEnvPatch;
}
```

各 CLI 的策略：

| Agent CLI | Session 身份 | 原始证据发现与导出 | OTLP 路径 |
|---|---|---|---|
| Claude Code | `system/init.session_id` | 在 Claude home 的 `projects/**/<session_id>.jsonl` 精确查找；同时收集该 session 的 subagent JSONL | 原生 OTLP logs / metrics / traces；由 Job 级 endpoint、header 与 resource attributes 关联 |
| Codex | JSON 流中的 thread/session id | 在 `$CODEX_HOME/sessions/**` 按 id 精确发现 rollout JSONL；不依赖日期目录猜测 | 原生 `[otel]` exporter；配置由冻结快照生成并指向平台 Collector |
| OpenCode | Server/SSE 返回的 session id | 通过官方 Session / Message API 导出该 session 的 vendor-native JSON；不复制包含其它会话的共享数据库 | Adapter 消费 SSE event 并转换为 OTLP/统一事件；未来原生支持后可切换 |

约束：路径只是 Adapter 的候选规则，必须同时以本次运行返回的 session identity 校验；找不到时记录 `session_capture_error`，不得误归档其它 Job 的文件。

### 2.3 OTLP 的部署边界

- 采用固定目标 Collector/Gateway，不允许 Worker 自选 OTLP 目的地。
- Job 注入关联属性：`deepsonar.job.id`、`deepsonar.project.id`、`deepsonar.canvas.id`、`agent.cli`、`agent.role`、`session.id`。
- 禁止出网的 Worker 只可通过现有 internal bridge 上的固定 sidecar 到达 Collector；不得破坏“控制事件不走目标网络”的安全边界。
- prompt、assistant response、工具输入/输出属于敏感内容，默认只进入本地受控存储；外部 exporter 默认关闭内容字段。启用外部内容上报必须显式配置。
- Collector 不直接改变 Job、Finding 或画布状态；语义事件仍通过本地控制 MCP 进入 Scheduler，避免形成第二个决策入口。

### 2.4 宿主持久化布局

不改表结构，复用 `jobs.transcript_uri`，文件根由 `BLOB_DIR` 控制：

```text
data/blobs/
  jobs/<job_id>/
    manifest.json
    sessions/<cli>-<session_id>.<jsonl|json>
    sessions/<cli>-<session_id>-subagents/*.jsonl
    stream.ndjson.gz
    otlp-logs.ndjson.gz
```

`manifest.json` 保存 CLI、session id、原始文件列表、sha256、字节数、捕获时间、格式版本与捕获错误。`jobs.transcript_uri` 指向 manifest 的相对 URI。写入采用临时文件 + 原子 rename；路径必须由 Job ID 和服务端生成文件名组成，API 不接受任意文件路径。

现有已销毁沙箱的原始 Session 无法伪造回填；仍在运行的容器允许按 `deepsonar.job` label 做一次安全回填，校验 session identity 后归档。

## 3. API 与前端交互

### 3.1 Job 运行详情

新增：

- `GET /jobs/:id/evidence`：manifest、是否有原始 Session、流/OTLP 可用性、文件元数据。
- `GET /jobs/:id/evidence/session`：查看主 Session 的安全文本响应。
- `GET /jobs/:id/evidence/session/download`：下载原始 Session 文件。
- `GET /jobs/:id/evidence/stream`：读取历史 normalized stream；活动 Job 仍用 WebSocket 追增量。

任务页“本次运行”和全局 Jobs 页面每一行都可打开 Job 详情。详情包含：概览、实时/历史过程、语义事件、原始 Session、关联 Finding、错误与时间信息。历史过程不再依赖节点是否恰好可点击。

### 3.2 Finding 详情与筛选

- `GET /findings/:id` 返回完整字段，包括 `raw_json`、来源 Job/画布、验证链与关联事件摘要。
- Finding 列表行与卡片用 `finding=<id>` 深链打开详情侧栏；任务内列表同样支持。
- Severity 继续由 URL query 驱动，并显示当前筛选结果数量；筛选控件增加稳定的可访问标签与自动化测试标识。
- 任务内 Finding 也提供 severity 和 verify status 筛选，不只在项目/全局页提供。

### 3.3 图谱视觉语义

节点视觉以“类型为主色、状态为辅色”，避免状态色覆盖角色含义：

| 节点语义 | 主色 | 图标/形状 |
|---|---|---|
| root / 任务 | 青绿 | Target，较宽根卡片 |
| Hub / 中枢 Job | 紫罗兰 | Brain/Circuitry，双层描边 |
| intent / 意图 | 天蓝 | Signpost/Path，pending 保留虚线 |
| Finding | 风险色 | Bug/ShieldWarning，severity 决定色阶 |
| role / 子 Agent Job | 琥珀 | Robot/Terminal，显示 role 名称 |
| fact / 子 Agent 产出 | 青色 | Note/Database，显示 verification 状态 |
| verify system Job | 绿色 | SealCheck，显示验证状态 |
| report | 靛蓝 | FileText |

新增图上筛选条：

- 类型：任务 / 中枢 / 意图 / Finding / 子 Agent / Fact / 验证 / 报告。
- 角色：从节点 `body_json.role`、Job type 与快照中的 role 动态聚合，不维护固定角色枚举。
- 状态：active / pending / running / succeeded / failed / verifying 等。
- Severity：critical / high / medium / low。
- 关键字：标题、位置、角色。

筛选采用“保留匹配节点 + 必要上下文节点/连边”的方式，避免命中 Finding 后失去来源链；提供“仅显示命中”开关满足纯列表式排查。

## 4. Credential 模型白名单

在 `credentials.public_metadata_json.allowed_model_ids` 保存非敏感字符串数组，不新增表列：

- 仅 `kind=llm_provider` 接受该字段；去重、去空白、限制数量和单项长度。
- 空数组表示不额外限制；非空表示严格白名单。
- RoleConfig 保存/绑定 Credential 时，如果已填写 `model` 且不在白名单，返回 409 并指出 Credential 与模型。
- 创建 Job 冻结快照时再次校验，防止旧配置或绕过 UI。
- Executor 铸造 Job Token 时，`allowed_models` 使用 Credential 白名单与快照模型的交集；模型为空时沿用 Credential 白名单。
- Gateway 对请求 `model` 做最终强制校验；当白名单非空而请求缺少 `model` 时拒绝，不能以省略字段绕过。
- Credential 编辑页可创建/修改模型白名单，并在列表中显示“全部模型”或具体数量/名称。

## 5. 按 Agent CLI 的全局并发限制

全局设置新增：

```json
{
  "maxGlobalJobs": 6,
  "maxJobsPerProject": 2,
  "maxConcurrentByAgentCli": {
    "claude-code": 2,
    "codex": 1,
    "open-code": 1
  }
}
```

- 缺失 CLI key 表示只受 effective `maxGlobalJobs` / `maxJobsPerProject` 限制；这两个 cap 缺失时才回落到 `MAX_GLOBAL_JOBS` / `MAX_JOBS_PER_PROJECT`。0 表示暂停该 CLI 新 claim。
- Scheduler 按 `jobs.agent_snapshot_json->>'agent_cli'` 统计 `claimed/provisioning/running`。
- claim 必须在数据库事务/锁内同时检查全局、项目和 CLI 三层配额；不能采用“先 count、后 update”的竞态实现。
- 配额只影响新 claim，不强杀已经运行的 Job。
- 全局设置页展示各 CLI 上限与当前占用；项目设置不允许覆盖，避免出现两套并发真相。

## 6. 实施顺序

1. 抽出 CLI Adapter，并为 Claude/Codex/OpenCode 定义 session identity、发现与导出契约。
2. 实现宿主证据存储、Claude 当前路径归档、Job evidence API；保留其它 CLI 的独立 Adapter，不使用 Claude 路径兜底。
3. 持久化 normalized stream；接入 OTLP 固定目标与关联属性，OpenCode 走 SSE bridge。
4. 完成 Job 详情、Finding 详情、Severity 筛选。
5. 完成画布语义视觉与筛选。
6. 完成 Credential 模型白名单三层校验。
7. 将 Dispatcher claim 改为原子配额判断，并接入 CLI 全局并发设置。
8. 对仍在运行的 `java-sec-code` 容器执行一次 session 安全回填；不可恢复的历史 Job 明确显示“运行时未启用原始证据归档”。

## 7. 验收标准

- 新建的 Claude Job 结束后，`transcript_uri` 非空，manifest 与原始 JSONL sha256 可校验；沙箱销毁后仍可查看和下载。
- Codex/OpenCode Adapter 不依赖 Claude 目录；每种 CLI 的 session identity 与导出策略有独立测试。
- 活动 Job 能看实时流，完成 Job 能看历史 stream、语义事件和原始 Session。
- 点击任意 Finding 可直接看到完整 summary、location、raw、来源 Job 与验证状态。
- `java-sec-code` 的 severity 四档筛选分别得到 5 / 19 / 9 / 3 条。
- 图上不读文字也能区分 Hub、意图、Finding、子 Agent；类型/角色/状态/severity/关键字筛选均生效且保留必要上下文链。
- Credential 白名单外模型在 RoleConfig 保存或 Job 冻结时失败；伪造请求也被 Gateway 403。
- CLI 配额达到上限时不再 claim 同 CLI Job，但其它 CLI 和已运行 Job 不受影响；并发调度下不超配。
- `pnpm typecheck`、`pnpm build`、API 冒烟和真实浏览器流程全部通过。
