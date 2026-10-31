# 0001. 新契约不保留向后兼容窗口

> 状态：**已采纳（历史回填）**。本文只把既有工程结论整理为 ADR，不扩展其适用范围。
> 决策日期：原决策日期未核实（本次回填：2026-10-15）
> 同步日期：2026-10-15
> 来源：[`DESIGN.md`](../../../DESIGN.md)「不向后兼容」/ [#690](https://github.com/SummerSec/DeepSonar/issues/690)；实现核验见 Scheduler schema、快照和配置解析代码

## 背景

DeepSonar 的权限、镜像、Provider/model、CLI、能力和 Job 生命周期共同组成一次可审计执行。保留旧输入的双读、fallback 或自动转换会让同一个 Job 在不同配置下得到不同权限和证据语义，也会把已经删除的边界重新带回运行时。

当前代码把创建期运行配置冻结到 Job snapshot；启动时对 schema 版本/结构、能力、镜像和 CLI 兼容性做 fail-closed 校验。历史 Job 的 snapshot、Evidence、审计记录和历史投影仍是不可变事实，不被重写为新契约输入。依据与 as-built 摘要见 [`DESIGN.md`](../../../DESIGN.md) §1、§7–§8，schema 启动校验见 [`migration-runner.ts`](../../../apps/scheduler/src/migration-runner.ts)。

这条规则是新运行时的目标边界；当前 [`runtime-image-registry-contract.ts`](../../../apps/scheduler/src/runtime-image-registry-contract.ts) 仍有 schema v1 兼容解析和历史投影，已登记为 [`12-risks-and-tech-debt.md` 的 D-07](../12-risks-and-tech-debt.md)。该实现债务不能被当作新契约的受支持输入或输出。

## 决策

1. 新 API、schema、UI、配置和运行时只支持当前目标契约。
2. 废弃契约必须从新运行路径删除；不得新增双读双写、fallback、shim、legacy 模式、旧配置自动迁移或兼容窗口。尚未物理清扫的历史解析/投影路径必须登记债务，且不得成为新运行时的依赖。
3. 输入无法满足当前契约时必须 fail closed，并返回可操作的稳定错误；不得静默沿用旧语义。
4. 已创建 Job 的冻结 snapshot、Evidence、审计记录和历史结果保持为不可变历史，不作为新运行时的兼容输入。
5. 尚未删除的旧路径只能登记为实现债务，不得在架构文档中写成受支持能力。

## 状态

当前状态为已采纳。本文件是 2026-10-15 的历史回填；原始决策日期和完整讨论过程未在本次工作中核实。runtime image registry 的 schema v1 兼容解析和旧投影仍是 D-07 实现债务，不代表本 ADR 已全部物理清扫旧路径。后续如需改变此边界，必须新开 ADR 说明取代关系，不能改写本 ADR 的决策段。

## 后果

- 正面：权限、快照、审计和执行结果只有一套当前语义；发现旧配置或结构漂移时立即停止，避免静默越权或错误重放。
- 代价：升级需要备份、按当前契约重新配置或重建；历史数据的读取与新运行时输入必须分开处理。
- 实现约束：配置解析、schema 启动、Job 重跑和能力/镜像准入都必须明确区分历史只读与新执行路径。
- 验收：[`migration-runner.test.ts`](../../../apps/scheduler/src/migration-runner.test.ts) 覆盖版本/结构不匹配拒绝；[`credential-compatibility.test.ts`](../../../apps/scheduler/src/credential-compatibility.test.ts)、[`role-config-project-scope.integration.test.ts`](../../../apps/scheduler/src/role-config-project-scope.integration.test.ts) 和快照测试覆盖不兼容配置的拒绝或清理边界。

## 替代方案

以下替代方案是本次回填基于当前实现的分析，不声称它们是历史讨论中逐字出现的方案：

- 保留旧契约一段时间并双读双写：会让权限和状态来源分叉，无法保证 Job snapshot 与运行时输入一致，因此不选。
- 自动把旧配置转换为新配置：转换规则本身会改变用户意图，且难以为历史配置补齐权限、镜像和审计依据，因此不选。
- 运行时遇到新字段不识别就忽略：会把安全边界错误降级为静默成功，因此不选。
