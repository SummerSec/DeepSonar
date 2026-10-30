# Finding 证据追踪与留存完整性（#767）

> 状态：as-built，已完成定向与组合行为验收；只读诊断，不是命令执行证明。
> 同步日期：2026-10-30

管理 `GET /findings/:id/evidence-trace` 及 Finding 详情诊断追踪确认记录引用的 Fact。用途是核验来源与当前留存字节，不执行复现命令，不改变 Verify verdict、Plan、提交资格或历史记录。

## 来源与字节核验

Artifact 的 source_event 精确绑定事件和来源 Attempt；不能用最新 Attempt 冒充产生证据的 Attempt。项目、Canvas、Job、Artifact 与事件身份必须匹配，并检查来源是当前最新成功执行、没有未知/未结算效果、Fact 未被 rejected。来源缺失或不一致明确为不可用，不猜测或拼接替代来源。

文件由既有 inspectCriterionEvidence 在宿主侧读取实际留存内容，共享 8MiB 读取预算。URI 必须精确匹配，不按路径后缀凑匹配；核对本 Attempt manifest、文件大小和实际摘要，拒绝符号链接及无效路径。manifest 声明的摘要只是期望值，不得伪装成 observed 摘要。缺失、篡改、超限或读取失败不降级为通过。

## 诊断字段与边界

每个 Fact 分开暴露：

- `execution_assurance: not_attested`：没有宿主命令 receipt，未证明实际执行语义；
- `runtime_claim_structured`：Agent 声明是否有结构化运行字段，不是执行已获认证；
- `retained_bytes_verified`：当前留存字节是否通过完整性核验，不能推出原命令确实执行或漏洞可复现。

trace 的 `runtime_proof` 保持 false；`replay.kind` 是 `evidence_integrity_check`，不是重跑命令。Verify 的结构化 runtimeProof 仍为 agent-declared 信息，不能与该只读诊断字段混为宿主认证。expected/actual、exit_code 或摘要声明齐全，都不自动建立独立复现和完整攻击链。

knownness helper 尚未接入运行时决策，不能当作 novel 权威。该修复既不证明未发现等于不存在，也不证明程序资格或奖励。

## 验收与剩余范围

本片已通过[真实路由/PostgreSQL 测试](../apps/scheduler/src/fact-evidence-trace.integration.test.ts) 11/11：包括跨 Finding/角色/Job Canvas、8MiB 多 Fact 共享预算、101/invalid refs、鉴权和历史不改写。`ci:integration:verify-eligibility` 合计 12/12；`ci:unit:verify-eligibility` 157/157 与 `ci:unit:authz` 78/78 合计 235 项单元通过；真实文件系统 helper 3 项已计入 157，不重复加总。完整构建已通过。最终 Scheduler TypeScript 检查、文档门禁 10/10、文件体量门禁 10/10 均通过；真实 FS helper 已实测拒绝 Job 内外符号链接，仍计 3 项，不增加总数。

真正独立复现、宿主命令 receipt、攻击链与 knownness 权威接线仍属未交付能力；不通过改诊断字段宣称完成，也不扩大本片为执行或资格系统。

下一关键工程是宿主治理的命令执行 receipt 绑定及可复核攻击链，不是继续增加 Agent 声明字段。knownness 查验需有明确来源、覆盖范围、查询时间及目标版本适用性；没有这些输入不能给出 novel/eligible。当前修复仅管理 evidence-trace/详情诊断，Verify 判决 consumer 未因此改接宿主执行证明。
