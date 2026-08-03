# 调度并发以 Agent CLI 全局并发为准

> 状态：后端与 Settings UI 已在隔离工作树实现，待部署；当前运行服务仍使用旧规则。
> 相关：`apps/scheduler/src/dispatcher.ts`、`core.ts`、`config.ts`、`routes.ts`

## 决策

调度 claim 的业务权威来自 `global_settings.rules_json`，通过 `globalRules()` 解析；环境变量只提供首次部署默认值。全局规则返回的 `effective_rules` 与 claim 使用同一份值，避免设置页和执行路径漂移。

Claim 在单次事务 advisory lock 内按以下顺序检查：

1. `maxGlobalJobs - totalActive` 全局安全顶；没有槽位不领取。
2. `maxJobsPerProject` 每项目安全顶；值来自全局规则，不再直接读取 `config.limits`。
3. Provider 总并发。
4. Credential 总并发与其 model 并发元数据。
5. `maxConcurrentByAgentCli[agent_cli]` CLI 全局并发；配置值 `0` 明确暂停该 CLI，未配置表示不增加 CLI 限制。

全局/项目顶是可见的安全 cap；运维应将项目顶设置为不低于期望的 CLI 吞吐（例如 CLI=4、项目 cap≥4），否则安全 cap 仍会按设计生效。修改规则只影响后续 claim，不取消已运行 Job。Provider、Credential、Model 约束始终保留。

`MAX_GLOBAL_JOBS` / `MAX_JOBS_PER_PROJECT` 支持非负整数；省略或非法值回退默认值，`0` 为显式暂停 claim 的语义。CLI 限额 map 也允许 `0`。

## API / 配置契约

- `GET /global-settings` 的 `effective_rules` 返回 `maxGlobalJobs`、`maxJobsPerProject`、`maxConcurrentByAgentCli` 与 `maxConcurrentByProvider`。
- `PATCH /global-settings` 合并保存这些字段；OpenAPI 描述非负整数与 `0` 语义。
- `ProjectRules` 与 `GlobalConcurrencyRules` 是共享类型/解析单源。项目 `config_json.rules` 不得覆盖全局并发字段。

## 验收矩阵

| 场景 | 预期 | 实现/静态证据 |
|---|---|---|
| `claude-code=4`、项目 cap≥4、provider/credential/model 未满 | 同一项目可领取 4 个 | `dispatchOnce` 读取 `globalRules` 的两个 cap 与 CLI map，并在同一 advisory 事务累计 claim |
| CLI 限额留空 | 只受全局/项目 cap 与资源配额 | `cliLimit === undefined` 分支不跳过 |
| CLI 限额为 0 | 该 CLI 不领取新 Job | `cliCounts >= 0` 恒跳过 |
| `maxJobsPerProject=0` 或 `maxGlobalJobs=0` | 暂停对应 claim | 非负解析 + slots/project guard |
| provider/credential/model 已满 | 不超配，即使 CLI 有余量 | 现有 provider/credential/model 检查保持在 CLI 检查之前 |
| 修改 global settings | 后续 claim 使用新值，无需重启 | `globalRules` 每次 `dispatchOnce` 从 DB 读取 |

验证命令（不连接 live DB）：

```text
pnpm --filter @deepsonar/shared-types typecheck
pnpm --filter @deepsonar/scheduler typecheck
git diff --check
```
