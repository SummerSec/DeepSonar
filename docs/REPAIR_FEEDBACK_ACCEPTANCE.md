# #776 实现验收与关闭条件

> 状态：实现与离线证据已合入 main；#776 已按限定验收范围关闭。
> 同步日期：2026-10-31

#801 与 #805 已合入；后续组合 main `3964f738` 的 [CI](https://github.com/SummerSec/DeepSonar/actions/runs/41089528099) 与 [reverse-runtime](https://github.com/SummerSec/DeepSonar/actions/runs/41089528092) 均通过。用户明确真实模型效果实验不作为该 issue 的验收门；本记录不把模型质量、费用收益或人工介入率写成已验证。

## 交付范围

| 切片 | 实现与证据 | 合入状态 |
| --- | --- | --- |
| A 错误矩阵与冻结回放 | [历史基线](REPAIR_FEEDBACK_BASELINE.md)，8 个实际格式合成样本、真实 Control HTTP/PG 接线，明确非生产日志 | #781 已合入 |
| B 一个完成场景的持久闭环 | mark_job_done revision/key、Job 锁、8 次拒绝/无进展停止、可查询 receipt、未知效果对账与同 key 恢复；[完成回执](REPAIR_FEEDBACK_DONE_REPAIR.md) | #783 已合入 |
| B 并发保护 | 实际 executeReal 的 human/Hub 异步预检竞态、完成预留及迟到输入互斥 | #787/#789 已合入 |
| C 引用与完成门扩展 | C0 当前授权 graph_query 指引、无效/删除引用重校验；C1 既有 Hub complete 门有界缺失项反馈、最终事务重校验与一次落地 | #790/#792 已合入 |
| CLI 活动会话协议 | Claude/Pi/DSH 的 adapter/framer/runRealAgent 与 Control HTTP/PG；成功、修正、丢响应恢复三类九流程 | #788 已合入 |
| 独立 token 用量与额度 | 原 effect/usage ledger、冻结限额、单请求预留、可信协议计数、未知停止、Gateway 新进程累计、另一 Attempt 停止 | #801 已合入 |
| 最后生命周期证据 | 三 CLI 的无进展/修正次数耗尽/提前退出九流程；旧回执可查，退出后移除 handler，迟到新提交不得接受 | #805 已合入 |

C 在原 issue 中的要求是“扩展引用与完成门，并补各 CLI 行为验证”，随后**按收益决定是否扩展**更多 Hub/Artifact/Verify 表面。C0/C1 与 CLI 矩阵满足这个限定交付；通用完成门、所有 operation 的持久修正链、完整 Plan/Pack 生命周期不是本 issue 必须无限追踪的范围。C1 反馈是当前完成门的缺失类别/计数，不是完整图清单；不虚构已接受效果。新增完成接受以持久 receipt 为依据，原有语义效果以原事件/Attempt 记录为依据。

## 对照原七项验收

| 原验收项 | 实现/离线证据 | 判定 |
| --- | --- | --- |
| 首次拒绝、同会话修正、错误重放、旧 revision、接受后丢响应、无进展、预算耗尽 | [completion integration](../apps/scheduler/src/domains/platform-api/completion.integration.test.ts)：三 CLI 六类共 18 个流程；HTTP/PG 另覆盖 token/次数/事件/Job 时间边界 | 实现满足；最后九个停止流程已随 #805 合入 |
| 事件/效果至多一次；并发、重启、退出、取消、超时、迟到输入 | completion 配额与 key 归属集成验证真实 done 只入库一次；实际 executor 交错测试及 runner 抛错后的 finally 注销/迟到 commit 拒绝；#801 Gateway 子进程累计；CLI 退出后旧 key 只读、新提交拒绝 | 实现满足；#801 与 #805 已合入。没有把缓存清空冒充完整 CLI 崩溃恢复 |
| 未知效果、权限/项目错误、恶意反馈 fail closed，秘密不泄漏 | 原 repair-feedback / reference-refresh / completion-feedback 集成、unknown/pending 及 scope 测试；严格 usage 不读 assistant/tool 自报；异常/缺报/写失败保留未结算 | 实现满足；#801 用量分支已合入 |
| 首次提交不增加修复轮次；真实分母统计效果/成本 | 每 CLI 首次有效提交仅一次 prompt/prepare/commit；协议分母 18，不将九个预期停止算成模型修复失败。持久成本以 Gateway token 记录为依据 | 首次路径满足；真实模型恢复率、收益和人工介入率按用户要求豁免，不伪造分母 |
| 运行器模拟与模型理解评测分开 | 合成 RuntimeProcess + 实际运行器/adapter/framer + HTTP/PG；模型内容由脚本产生，未调用模型 | 离线实现满足；真实模型理解评测豁免 |
| 所有本切片新增 accepted 有持久查询依据，接收不等于结算 | receipt_status=persisted_deferred；GET 只读，原活动 handler 原 key POST 恢复；终态依赖原 ingestion；C0/C1 没有新增接受通道 | 满足；不泛化为所有历史 API 已有统一 receipt |
| shared schema、宿主、事务、adapter、文档一致并接 CI | shared RepairFeedback、实际 handler/PG/三 CLI 流程；package scripts 被 workflow gate 调用；类型、文档、体量及测试接线门禁 | 满足；最终组合 main 检查通过（链接见上文） |

无进展的精确语义：同一无效内容第三次提交被 COMPLETION_NO_PROGRESS 拒绝并提示人工介入，不把 Attempt/Job 写成终态。不同内容仍可在原 revision 与剩余预算内修正；整链由持久 8 次拒绝上限及 token/时间/事件限制约束。这里的“停止”不代表宿主立即杀死 CLI 或新增全局终态门。

实际执行层次不能混称：CLI 矩阵运行生产运行器，但 RuntimeProcess 是合成协议；handler 移除由夹具调用生产 unregister 操作，未宣称测试了完整调度器进程崩溃。另有生产 executeReal 在替身 runner 抛错后执行真实 finally、注销真实 registry 并拒绝迟到 commit 的测试；其存储/runner 为替身，不冒充完整 CLI 进程崩溃。原 executor 并发测试、数据库事务测试与 Gateway 子进程测试各自保留真实/替身边界。DSH 不支持持久 resume 时由已有 recovery 测试明确停止；不要求为本 issue 伪造续接能力。

## 明确保留的限制

- token 限额是累计结算熔断，宿主同时限制单次生成输出；输入/缓存成本只能在响应后确认，单次可能超额，实际超额不截断并禁止继续。不是绝对调用前费用上界，也不是币种计费系统。
- 新修正链未设置或显式 0 的 DEEPSONAR_REPAIR_MAX_TOKENS 不限额度；历史冻结 null/缺失仍保持关闭。当前普通 executor 不自动设置 Job max_tokens，明确配置的总额度在普通与修正准入中优先。
- 非修正请求 503→200 保留最终业务响应，但完整成本未知，要求对账；权威零用量与未知分开。首次 PowerShell XML CI 异常的根因未明，#801 后续同一测试实际通过，原证据保留在 PR。
- 真实模型修复效果、费用收益和人工介入率均未验证；按用户最新要求，这些不阻塞实现验收或成为无限保留 issue 的理由。

## 关闭条件与完成记录

以下条件已完成，#776 已关闭；保留条件供后续复核。

1. #801 以及 #805 生命周期/验收切片正常合入 main，保持已有修复祖先；不以 draft 或分支存在替代合入。
2. 最终组合精确 head 的适用 CI 成功，核对上述集成与协议测试实际执行，未因缺 TEST_DATABASE_URL 或 CLI 能力被静默跳过。
3. 在 issue 收口说明中列出已合入 PR、合入 SHA/CI 和上面的明确限制；真实模型效果项记录为用户豁免，不写成通过。

满足这些条件后，本 issue 的限定实现可以关闭；若未来要求绝对调用前费用上界、通用 Hub/Artifact/Verify 修正或真实效果研究，应作为明确的新需求继续，不在本 issue 中追加未经约定的无限范围。本文不授权自动合并或关闭。
