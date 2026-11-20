# 0025. 人工续做受限导入原生会话文字

> 状态：已采纳；原生行为等待最终 SHA Actions
> 决策日期：2026-11-19
> 同步日期：2026-11-19
> 来源：#1074；需求 FR-JOB-008、FR-CTRL-006

## 决策

在 ADR 0022 的持久请求、原额度、可信回收和唯一 successor 内，增加固定 Pi/Claude adapter 的受限主会话文字导入。仅取同 Job 原 Attempt 的唯一主归档，核验 session、冻结快照、bytes/SHA-256，过滤后绑定原 request 保存。没有可验证归档或未知/变换格式时明确 structured 与稳定原因，DSH unsupported。已绑定 blob 的损坏和身份变化拒绝执行。

原生会话是历史上下文，执行 authority 属于新 Attempt。系统提示、配置、秘密、扩展与 Control 身份重新生成，旧工具提案/结果转为历史文字。Pi/Claude 仅保留已验证的文字与会话 ID，不能从归档恢复执行权限。能力选择和原因写入持久 Evidence 与 Job 执行流。完整条件在[人工续做专题](../../HUMAN_CONTINUATION.md)。

## 取舍与验证

直接复制 CLI home 会带入旧凭据、控制身份与插件状态，因此不采用。恢复完整压缩/分支/扩展状态需要逐格式独立证据，本片遇到这些格式使用 structured，原因保留。原 ADR 的预算、期限、未知效果和历史 failed 不自动复活仍适用。

固定 CLI 的隔离网络 Actions 检查原 home 导出、过滤后新 home 导入与原生 resume。真实 PostgreSQL 回归检查归档绑定、请求/Attempt/快照/hash 不匹配，正常 runRealAgent 入口回归检查新配置与 resume 选择。生产续跑未执行。
