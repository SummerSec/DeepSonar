# Issue 741 Implementation Plan

> **For agentic workers:** 使用 subagent-driven-development；按文件所有权并行，主线程验收。

**Goal:** 完成 #741 的十二篇系统规格/架构视图、追溯矩阵、六条 ADR、文档同步 Skill、入口迁移及机检。

**Architecture:** 系统规格定义规范要求并单独记录实现状态；视图按主题拥有正文，专题保留细则，顶层保留摘要。旧架构按章节链接新权威，门禁检查文档结构与引用，不代替语义核查。

**Tech Stack:** Markdown、Mermaid、TypeScript、node:test、pnpm。

**Spec:** [#741](https://github.com/SummerSec/DeepSonar/issues/741) 及其中补充 Review（comment 6186728443）。

## Global Constraints

- 不改产品运行时、schema、OpenAPI，不新增业务能力；无兼容层。
- 代码事实、规范要求、验证证据分开；发现违约登记债务，不改规范迎合 bug。
- 文档日期采用 2026-10-15；不复制真实凭据或个人部署地址。
- 所有需求定义固定为 `### FR-TASK-001 标题` 形式；追溯矩阵首列为同一裸 ID，每条恰好一行。
- 已废弃 ID 保留状态不复用；ADR 不要求连续编号。
- 不宣称执行了未运行的行为测试；验证入口与本次执行证据分开。

## Review Focus

- Windows 路径分隔符：统一仓库相对路径为 POSIX，用两种路径输入验证。
- 同一需求合法多次引用：只从定义标题提取唯一 ID，引用不计为重复定义。
- 重复定义、缺矩阵行、悬空引用：负向夹具必须失败。
- 未实现的长期方案、未验证的 SLA：文档明确边界，不标为已达标。
- 旧架构与新视图：每个旧一级章节就地标注映射，专题细则不重复复制。

## Tasks / ownership

- [x] A：`01-system-specification.md`、`traceability.md`；覆盖所有列出的功能域、NFR、IR、CON，提供真实代码/测试入口与三条关键链路。
- [x] B：`02`–`10` 视图（除 `01`）；按源码核对，包含上下文与信任边界 Mermaid、运行时失败恢复、质量场景及配置出处。
- [x] C：`11`、`12`、六条 ADR 及 ADR 索引、`.agents/skills/architecture-doc-sync/SKILL.md`；回填已定案决策，治理 Skill 只服务仓库开发。
- [x] D（主线程）：文档保鲜路径修复、需求/追溯校验及负向测试；目录 README、DESIGN、旧 ARCHITECTURE、docs/README、AGENTS/CLAUDE 同步。
- [x] E：抽查全部需求与核心状态机/安全边界，运行 docs-freshness、file-size、ci-test-hook、diff-check；独立 review 后修复并复验，形成可审查变更。

## Verification

门禁改动先复现 Windows 基线失败；先写重复/缺失/悬空/合法重复引用的测试，再实现解析。已有测试文件承载新测试，沿用现有脚本和 CI workflow。文档语义人工对照源码、schema、OpenAPI、已有行为测试，完整记录未实际执行的环境测试。

## Coordination rulings

- 用户已要求按 issue 和评审继续完成，采用已讨论方案，不另起设计审批。
- A 定义需求与矩阵，B/C 不独立定义需求 ID，主线程完成引用整合。
- D 独占顶层入口及测试文件；其他作者不编辑这些共享文件。
- 开发 Skill 放 `.agents/skills/`，避免与 `skills/` 中运行时业务 Skill 混淆，AGENTS/CLAUDE 显式绑定入口。

## Integration and verification record

- 已对齐主线 #744 的首批规格与 #745 的平台版本发现；保留已发布需求 ID 原意，扩展需求另用空闲编号。
- 文档门禁基线在 Windows 因路径身份不一致失败；统一 POSIX 相对路径后，白名单和目录检查恢复一致。
- 追溯负例覆盖重复定义、遗漏/重复矩阵行、悬空引用、无效编号、空字段、废弃 ID 复用；合法引用、CRLF 和两类 Markdown 围栏有正例。
- 废弃登记保留历史条目，但必须持续标为已废弃；不会把合法历史引用判成重复定义。
- 独立审查覆盖需求/矩阵、02–10、11/12/ADR/Skill 与门禁实现；发现的事实偏差先核源码再修。
- 本地已执行：全工作区 typecheck；file-size 与 ci-test-hook 共 16 项。整合后的 docs-freshness 10/10 与 diff check 已通过，139 条需求完整覆盖上游 28 个已发布编号。
- 未执行产品行为集成/真实 Provider、OpenSandbox、设备、多副本与发布验收：本次仅改文档及文档门禁，这些入口的列出不代表运行成功。
- 最终 Git 提交作者采用本地 GitHub 登录账号 Barry04 的 noreply 身份；推送与 PR 同样使用 Barry04，命令级覆盖不修改全局 Git 配置。
