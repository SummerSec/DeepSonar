---
name: architecture-doc-sync
description: 在 DeepSonar 开发中，当功能域、API、schema、状态机、运行时、权限或安全边界变化时，核对并同步架构视图、追溯矩阵、ADR、专题文档和顶层索引。
---

> 状态：**as-built（仓库开发 Skill）**。本 Skill 只治理 DeepSonar 仓库的开发文档同步，不参与 Agent 运行时，也不授予额外外部操作权限。
> 同步日期：2026-10-15

# Architecture Document Sync

## 适用范围

当一次代码、功能域、schema、OpenAPI、配置、状态机、运行时镜像、权限或安全删除/收敛变更可能改变系统事实时使用本 Skill。纯局部实现且没有改变外部契约、边界、不变量、测试接线或已有 as-built 描述时，可以不改架构文档，但交付摘要必须写明核对过的文件和不更新的理由。

本 Skill 服务仓库开发。不要把它注入生产 Job，不把架构文档当作运行时能力目录，也不因文档同步请求修改运行时、schema、OpenAPI、依赖、个人技能配置或外部系统。

## 事实与变更面

先读 [`AGENTS.md`](../../../AGENTS.md) 的事实入口，再以 [`docs/architecture/README.md`](../../../docs/architecture/README.md)、受影响的 `01-system-specification.md` / `traceability.md` / `02`–`12` 视图和 `adr/` 为新架构权威，随后核对 [`DESIGN.md`](../../../DESIGN.md)、[`docs/README.md`](../../../docs/README.md)、[`docs/AI_NATIVE_TRUSTED_KERNEL.md`](../../../docs/AI_NATIVE_TRUSTED_KERNEL.md)、代码、`database/schema.sql`、OpenAPI 和测试。`docs/ARCHITECTURE.md` 仅作历史迁移对照；代码、schema、OpenAPI 与行为测试优先于历史计划、旧 issue 摘要或角色名称。

把完整变更面映射到下面的位置；只更新实际受影响的权威正文，避免复制同一事实：

| 变更面 | 文档映射 |
| --- | --- |
| 需求、功能域、质量属性、接口或约束 | `docs/architecture/01-system-specification.md`；`docs/architecture/traceability.md` 的同一需求行 |
| 系统上下文、范围、原则、质量、安全 | `02-context-and-scope.md`、`03-constraints-and-principles.md`、`04-quality-attributes.md`、`10-security-and-trust-boundaries.md` |
| 构件、运行时、部署、数据、接口 | `05-building-blocks.md`、`06-runtime-view.md`、`07-deployment-view.md`、`08-data-architecture.md`、`09-interface-specs.md` |
| 工程规范或风险债务 | `11-engineering-specs.md`、`12-risks-and-tech-debt.md` |
| 已定案的内核边界、数据真相、控制通道、恢复或准入取舍 | `docs/architecture/adr/` 中已有 ADR；决策改变时新增 ADR，不能改写已采纳 ADR 的决策段 |
| 目录状态、专题状态、顶层入口 | `docs/architecture/README.md`、`docs/README.md`、`DESIGN.md`；按仓库协作边界同步 `AGENTS.md` / `CLAUDE.md` |

需求 ID 必须全局唯一且不可复用。已有需求直接从 `01-system-specification.md` 引用，并在 `traceability.md` 保持该 ID 恰好一行；若完整变更面确认确有新的真实需求，可在 `01-system-specification.md` 新建一个未使用的唯一 ID，并在同一变更中补一行 trace。禁止为方便复用旧 ID、复制已有 ID 或在其他文档重新定义；只在归属或语义仍不清楚时升级协作确认，不固化具体 Agent 或需求负责人的分工。

## 执行规则

1. 先记录当前 as-built 事实和证据路径，再写规范要求。规范违约登记到风险/技术债，不为迎合 bug 修改规范。
2. 每个架构文档前 12 行保留 `> 状态：...` 和 `> 同步日期：YYYY-MM-DD`。同步日期表示最近一次事实核对；只改措辞、链接或排版时不要机械更新日期。
3. ADR 只回填或记录已经定案的长期取舍。历史原决策日期未知时明确写“原决策日期未核实”和本次回填日期；替代方案没有历史证据时标注为当前分析，不假冒历史讨论。
4. 把已完成的能力留在 as-built，只有真实缺口、风险和暂缓设计进入风险文档；不要把历史已完成事项重新列为待办。
5. 新文档沿用当前仓库术语和实际路径，不引入第二套权限、状态机、事件、镜像或能力概念；不要写入已删除机制的旧 token 字面量。
6. 本 Skill 自身不授予 PR、tag、release、部署或外部消息权限；是否执行这些动作由当前用户/会话授权和仓库门禁决定。没有相应授权时不发送外部消息或执行外部写入；本 Skill 的验收输出只写本地文件和命令证据。

## 验证与交付

根据变更面运行必要门禁，并把“已执行、跳过、未执行及原因”分开记录：

- 文档结构、状态日期、相对链接、脚本字面量和已删除机制门禁：`pnpm ci:unit:docs-freshness`；
- 文件体量门禁：`pnpm ci:unit:file-size`；
- 需求/追溯与架构结构相关测试：由 `01`/`traceability` 所属测试入口决定；不要只用 typecheck 代替行为测试；
- API、schema、状态机、镜像、运行时或安全变更：补跑对应的 `ci:unit:*`、`ci:integration:*`、`ci:smoke:*` 或 `pnpm ci:images`；测试数据库和真实沙箱前置条件必须写清；
- 所有变更：`git diff --check`，人工核对 `.github/workflows/ci.yml` 是否真正调用相关脚本，以及文档中的 as-built 叙述是否与代码相符。

交付摘要至少包含：变更文件与完整映射、事实来源和未核实日期、需求/trace/ADR 引用、运行过的命令及环境、通过/跳过/未执行结果、风险或暂缓项、以及无需更新文档时的具体理由。完成前不要声称未运行的测试、未验证的 SLA 或未完成的长期方案已经落地。
