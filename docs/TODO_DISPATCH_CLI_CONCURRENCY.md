# TODO：调度并发应以「Agent CLI 全局并发」为准

> 状态：已修复（Issue #8）
> 类型：bug + 修复方案  
> 相关：`apps/scheduler/src/dispatcher.ts`、`core.ts` `globalRules`、`SettingsPanel`「Agent CLI 全局并发」、`.env` `MAX_GLOBAL_JOBS` / `MAX_JOBS_PER_PROJECT`  
> 现象复现：java-sec-code 全量审计时仅 2 个 Job running、verify 大量 pending

---

## 1. 现象

- 同一项目下仅 **2** 个 Job 处于 `running`（例如 2×`test`），其余 `verify_finding` / `audit` 等大量 **pending**。
- 凭据 `max_concurrent=5`、`model_concurrency.grok-4.5=5` **未顶满**。
- 全局 `MAX_GLOBAL_JOBS=6` **未顶满**。
- 设置页「**Agent CLI 全局并发**」是运维配置并发的主入口，但 claim 行为实际被 **env `MAX_JOBS_PER_PROJECT=2`** 卡住。

## 2. 根因

`dispatchOnce` 的 claim 顺序与权威源不一致（已在 Issue #8 修复）：

| 顺序 | 限制 | 数据源 | 可在 UI 配置？ |
|------|------|--------|----------------|
| 1 | 全局总槽 | `config.limits.maxGlobalJobs` ← **env** | 否 |
| 2 | **每项目总槽** | `config.limits.maxJobsPerProject` ← **env（默认 2）** | **否** |
| 3 | Provider | `globalRules.maxConcurrentByProvider` | 凭据侧/规则 |
| 4 | Credential / Model | 凭据 `public_metadata_json` | 是（凭据页） |
| 5 | Agent CLI | `globalRules.maxConcurrentByAgentCli` | **是（全局规则）** |

代码（`dispatcher.ts`）：

```ts
// 项目上限：硬读 env，与 global_settings 无关
if ((projectCounts.get(projectId) ?? 0) >= config.limits.maxJobsPerProject) continue;
// ...
// CLI 上限：读全局规则，但往往永远走不到「有效放行」
const cliLimit = cliLimits[cli];
if (cliLimit !== undefined && (cliCounts.get(cli) ?? 0) >= cliLimit) continue;
```

UI 文案（`SettingsPanel`）：

> 按 Agent CLI 限制全局并发。…**留空只受全局/项目总并发限制**

产品意图：**运维以「Agent CLI 全局并发」为操作面**。  
实现却让 **不可配置的 env 项目上限（默认 2）优先且更严**，导致：

1. 用户在「Agent CLI 全局并发」填 5 / 留空期望按 CLI 或全局 6 跑，实际每项目只跑 2。  
2. CLI 配额、凭据配额形同虚设（被项目 2 卡死）。  
3. 「配置落库」纪律被破坏：关键吞吐旋钮应在 `global_settings.rules`，却藏在 `.env`。

**Bug 定性**：调度 claim 的权威并发源错误——**应以全局规则中的 Agent CLI 全局并发为准**，env 仅作安全兜底/默认值，不应在未暴露到全局规则时静默压死吞吐。

## 3. 预期行为（第一性）

1. **操作面权威**：设置 → 全局规则 → **Agent CLI 全局并发**（`maxConcurrentByAgentCli`）为运维主旋钮。  
2. **Claim 优先级（建议）**：  
   - 平台安全顶：`maxGlobalJobs`（可进全局规则，env 作默认）  
   - **Agent CLI 全局并发**（有配置则强制执行；0 = 暂停该 CLI）  
   - Provider / Credential / Model（资源保护）  
   - `maxJobsPerProject`：若保留，**必须进入全局规则并可 UI 配置**；默认值应与产品叙事一致（不宜默默 2 卡死审计场景）  
3. 修改规则只影响后续 claim，不杀已运行 Job（与现 UI 一致）。  
4. 有效规则可在 `GET /global-settings` 的 `effective_rules` 中看到 **maxGlobalJobs / maxJobsPerProject / maxConcurrentByAgentCli** 的最终值。

## 4. 修复方案（已落地）

### 4.1 数据与规则模型

在 `ProjectRules` / `global_settings.rules_json` 增加（或对齐）：

```ts
maxGlobalJobs?: number;      // 可选，默认来自 env MAX_GLOBAL_JOBS
maxJobsPerProject?: number;  // 可选，默认来自 env MAX_JOBS_PER_PROJECT
// 已有
maxConcurrentByAgentCli: Record<string, number>;
maxConcurrentByProvider: Record<string, number>;
```

- `globalRules()`：库中有值用库；否则 fallback env。  
- **禁止** claim 路径只读 `config.limits` 而忽略 `globalRules`。

### 4.2 dispatcher claim

```text
slots = rules.maxGlobalJobs - totalActive   // 来自 globalRules
for each pending job (priority, created_at):
  if projectActive >= rules.maxJobsPerProject: skip   // 来自 globalRules
  if provider over limit: skip
  if credential/model over limit: skip
  if cliLimits[cli] defined && cliActive >= cliLimits[cli]: skip
  claim
```

**权威说明（产品）**：

- 未配置 CLI 限额时：受全局总并发 +（可配置的）项目总并发约束。  
- **配置了 CLI 限额时：以 CLI 为准做该 CLI 的吞吐上限**；项目/全局顶只作安全 cap，不应默认严于 CLI 且不可见。  
- 建议默认 `maxJobsPerProject` 提高到与 `maxGlobalJobs` 同量级，或 UI 显式展示并允许改。

### 4.3 前端

1. 全局规则页「Agent CLI 全局并发」旁展示 **effective**：当前运行数 / 限额。  
2. 增加或展示 **全局总并发 / 每项目总并发**（读 effective_rules，可编辑写入 rules_json）。  
3. 文案改为：  
   > 调度 claim 以本页 Agent CLI 全局并发与全局/项目总并发的 **effective 值** 为准；`.env` 仅作启动默认。

### 4.4 文档

- `ARCHITECTURE` / 运维文档：并发权威源 = `global_settings` + 凭据 metadata；env 默认。  
- 删除「只有 env 控制项目并发」的隐含假设。

### 4.5 验收

1. 全局规则设置 `maxConcurrentByAgentCli["claude-code"]=4`，`maxJobsPerProject` effective ≥4 时，同项目可同时 running 最多 4 个 claude-code Job（受凭据限制时取更严）。  
2. CLI 限额留空、仅 `maxJobsPerProject=2` 时行为与现网一致（回归）。  
3. `GET /global-settings` 的 effective 含三项并发，与 claim 实际一致。  
4. 改规则不重启进程即可影响后续 claim（已是 DB 读路径则自然满足）。  
5. 单测/冒烟：mock active counts，断言 CLI 限额先生效、项目限额可配置。

实现补充：pending claim 使用 `priority/created_at/id` keyset 分页扫描，每页 500
条，直到槽位填满或 pending 耗尽；因此前 500 个因项目/CLI/凭据配额不合格时，
后续可运行任务仍会被扫描，不再发生头部饥饿。

## 5. 分期

| 阶段 | 内容 |
|------|------|
| P0 | dispatcher 改为 `globalRules` 读 maxGlobal/maxPerProject；默认仍 env fallback；**Settings 展示 effective** |
| P1 | UI 可编辑 maxGlobalJobs / maxJobsPerProject；文案与 ARCHITECTURE 更新 |
| P2 | 冒烟/指标：`deepsonar_dispatch_skip_total{reason=project|cli|credential|...}` |

## 6. 非目标

- 不在本 bug 中改 verify 派生逻辑。  
- 不强制取消已运行 Job。  
- 不引入按 Job 类型（verify vs audit）的独立队列（可另开 issue）。
