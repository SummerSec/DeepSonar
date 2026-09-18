# Agent Runtime Profiles（#613）

Issue #613 的第一阶段把现有 Provider、Credential、RoleConfig 和 Agent CLI adapter 的最终选择投影为统一的 Job snapshot Profile。机器契约是 `deepsonar.agent-runtime-profile/v1`，源文件是 [`packages/shared-types/src/agent-runtime-profile.ts`](../packages/shared-types/src/agent-runtime-profile.ts)。

Profile 由 Scheduler 在创建 Job 时生成，当前使用已有的 Provider settings、Credential model catalog、RoleConfig、Pi extension registry 和 runtime adapter registry。它不会建立新的 Provider Gateway 或启动路径。

Profile 包含：

- `agent_cli`：`claude-code`、`pi` 或 `dsh`；
- `provider_ref`：Credential id 与 Provider 名称，永不包含密文；
- `model_ref`、`reasoning_effort`、`context_window_tokens`；
- `extensions`：已冻结的扩展 id、版本和 integrity；
- `system_prompt_ref`：角色说明的版本与摘要 hash，不保存原文；
- `env_refs`：环境变量名称和来源，不保存变量值；
- `native_options`：严格分隔的 `claude_code` / `pi` / `dsh` 命名空间；
- `profile_fingerprint`：以上冻结内容的 SHA-256 摘要。

配置选择遵守全局默认 → 项目 → 角色 → 任务 → Job 的优先级。Job 创建后，Dispatcher 不重新读取 RoleConfig、Credential 或 Provider settings。Provider 密钥仍只在 Scheduler-owned Gateway 和 sandbox materialization 的受控边界内使用。

Profile 不能扩大项目已启用的 Provider、模型目录、Agent CLI、镜像、网络、预算或并发权限。Credential 不可用、模型不在目录、CLI 与镜像不兼容、扩展不兼容或 native 配置不支持时，沿现有 snapshot resolution 错误边界 fail-closed；不得静默忽略字段或回退到未登记 CLI。

项目设置页的 Provider 面板通过 Scheduler 的 Credential 测试与模型目录 API 展示结构化模型能力（上下文、工具、流式和结构化输出支持、推理等级、健康状态与 catalog revision）。项目可以启用 Provider/CLI 白名单，设置默认模型、按顺序的 fallback 模型，并显式开启目录直通；关闭直通时默认和 fallback 引用必须来自已观测目录。Credential 的 `agent_cli` 只保留为兼容提示，RoleConfig 的 CLI 选择不会改写共享 Credential。

Hub 在派发 intent 前调用 `list_available_providers`，Scheduler 在 preflight 和事务内再次校验 `model_ref` 与 `model_requirements`，再把最终 Provider、模型描述和 adapter 版本冻结进 Job snapshot。任务创建也可以提交受限的 `runtime_profile` 覆盖（模型、推理等级、上下文预算）；覆盖只在 Job 创建边界合并，运行中的 Job 不重新读取项目设置。

三种 adapter 的物化和启动仍由 [`packages/runtime-sandbox/src/runtime-adapters.ts`](../packages/runtime-sandbox/src/runtime-adapters.ts) 与 Scheduler executor 负责。Profile 只描述最终冻结输入，不能被 Agent、Hub 或运行中 Job 修改。

验证入口：

```bash
pnpm ci:unit:agent-runtime-profile
pnpm ci:unit:capability-pack
pnpm --filter @deepsonar/scheduler typecheck
```
