# 0006. 运行镜像由平台目录准入并在 Job 中冻结不可变 digest

> 状态：**已采纳（历史回填）**。本文记录平台镜像目录和 Job 快照边界，不新增镜像产品或发布策略。
> 决策日期：原决策日期未核实（本次回填：2026-10-15）
> 同步日期：2026-10-15
> 来源：[Issue #674](https://github.com/SummerSec/DeepSonar/issues/674)、[#676](https://github.com/SummerSec/DeepSonar/issues/676)、[#691](https://github.com/SummerSec/DeepSonar/issues/691)；实现核验见 [`runtime-image-registry-contract.ts`](../../../apps/scheduler/src/runtime-image-registry-contract.ts)

## 背景

镜像同时决定 CLI、工具、网络、凭据投影和可复现实验环境。任意 OCI 引用、可变标签或仅由 Agent 选择的镜像会绕过扫描、签名/来源、平台与 CLI 兼容性及项目可见性检查。当前基线已经把镜像产品、版本、trust 状态、registry channel、扫描结果、项目可见性和 digest 分开建模。

`apps/image-admission` 负责 registry 引用、签名/扫描和准入夹具；Scheduler 在目录读取、Job 创建和 runtime readiness 阶段重新校验。Hub 只能通过 `list_available_runtime_images` 发现可提案的 `image_key`，不能提交 OCI/digest；运行时最终使用目录返回并冻结的 digest。相关表结构见 [`database/schema.sql`](../../../database/schema.sql) 的 runtime image 段。

## 决策

1. 运行镜像必须先进入平台受信目录；第三方版本先扫描、批准，再按平台可见项目准入。目录中的 trust、enabled、平台、工具、手册和 registry evidence 是执行前提。
2. Agent、Hub 和任务内容不得提交任意 OCI 地址、凭据或可变标签；Hub 只能原样选择本轮目录返回且 readiness=ready、与 Agent CLI 兼容的 `image_key`。
3. Job 创建必须重新校验项目可见性、目录启用、版本 trust、平台/CLI 兼容性、工具清单、digest 一致性和网络策略，并把镜像 key/ref/digest 冻结到 snapshot。
4. 运行中的 Job 不随目录或配置变化切换镜像；新 Job 重新解析。digest、registry channel、扫描或签名证据不一致时 fail closed。
5. 项目只能在平台允许的可见集合内收紧可用性；不能借项目配置绕过平台准入、改变版本来源或扩大网络/凭据权限。

## 状态

当前状态为已采纳。本文件于 2026-10-15 回填，原始决策日期未核实。当前实现已有官方/第三方目录、digest 约束、readiness、Job snapshot 和项目可见性检查；远端 Worker 镜像 inspect/repair 平面仍按风险登记保持 `unsupported`，不在本 ADR 中假定已完成。

## 后果

- 正面：执行环境可由 digest、平台清单、工具 fingerprint 和准入证据追溯；模型不能借镜像选择扩大能力或出网。
- 代价：镜像发布、registry inspect、扫描、准入和拉取需要更多元数据与操作员流程；目录缺失或证据不完整时 Job 会被拒绝。
- 运行时边界：镜像不是 RoleConfig 或任务文本的自由字符串；沙箱只消费冻结 snapshot，缺失能力返回结构化 unavailable/准入错误，不静默安装工具。
- 验收：[`runtime-images.test.ts`](../../../apps/scheduler/src/runtime-images.test.ts)、[`runtime-image-readiness.test.ts`](../../../apps/scheduler/src/runtime-image-readiness.test.ts)、[`runtime-image-platform-min.test.ts`](../../../apps/scheduler/src/runtime-image-platform-min.test.ts)、[`runtime-image-project-availability.test.ts`](../../../apps/scheduler/src/runtime-image-project-availability.test.ts)、[`apps/image-admission` registry tests](../../../apps/image-admission/src/registry-ref.test.ts) 和 `pnpm ci:images` 覆盖目录解析、digest、平台、项目可见性和镜像契约。

## 替代方案

以下替代方案是本次回填的当前分析，不冒充历史 issue 的完整讨论：

- 允许 Agent 直接提交 OCI 引用：无法在 Job 创建前完成来源、扫描、平台和工具兼容性校验，因此不选。
- 使用可变标签并在执行时拉取最新内容：同一任务无法复现，且配置漂移会破坏证据链，因此不选。
- 让项目保存完整镜像版本白名单：会把平台准入和项目授权混在一起，可能绕过平台撤销和目录更新，因此不选。
- 只在镜像拉取后再做检查：副作用已经开始，失败窗口太晚；准入和 digest 一致性必须在 Job 创建和准备阶段先锁定，因此不选。
