# 沙箱 Pi 观测内存：A 片决策记录

> 状态：**原则已定，核心工程及本地构建镜像 RPC/启动拒绝已有证据；最终 CI 与发布门禁仍未闭合**。7 项设计原则已由用户于 2026-10-31 确认（见 [#815 决策评论](https://github.com/SummerSec/DeepSonar/issues/815#issuecomment-6538810106)）；本文件把这些原则、已验证实现与剩余启用门禁分开记录，避免把局部证据扩张为发布结论。
> 同步日期：2026-10-31

## 1. 这份文件解决什么

`docs/PI_OBSERVATIONAL_MEMORY.md`（#815 / PR #816）§8 列出 7 个决策点，§10 要求 A 通过须有明确书面决定。

书面决定已由 [#815 决策评论](https://github.com/SummerSec/DeepSonar/issues/815#issuecomment-6538810106)承载——**可追溯的 issue 评论同样构成书面记录，文件格式不是通过 A 的必要条件**。本文件的作用是把这些原则拆成「已定」「条件适用时必填」「后续工程实现」「启用门禁」四类，避免用一句话概括掩盖仍未闭合的部分。

## 2. 七项已定原则

以下为已确认结论，不再是待选项。来源：上述决策评论。

| # | 原则 | 已定内容 |
| --- | --- | --- |
| 1 | 网络契约 | 业务出网与 Gateway 访问要求**分开表示**；实际准入仍须校验路由、凭据、模型许可。Gateway 网络可达不等于授权 |
| 2 | 调用边界 | 接受后台记忆需要模型调用；主动、passive、恢复 catch-up 等全部模型路径统一经 Gateway 治理；passive 不是免治理入口 |
| 3 | 失败策略 | 记忆 worker 失败**可见且受控降级**，不拖垮主任务；权限违规与协议损坏不得吞错或伪装成功 |
| 4 | 预算 | 未配置时不限，不隐式增加预留或后台限额。显式有限总额时主任务优先，须明确保底/后台分配契约并通过并发验收 |
| 5 | 归因 | 后台用量单列且与总账可对账，由可信服务端绑定，不依赖客户端自报身份 |
| 6 | 压缩身份 | 沿用 DeepSonar 身份与追踪契约；无法表达时如实标 `unknown`，不伪造已知变换链；暂不扩新 policy |
| 7 | 模型 | 首版后台**仅使用当前 Job 已冻结模型**，不新增独立模型权限 |

### 原则 3 的当前实现

wrapper 只对 exact quota 或内核确认未开始的 transient 记录可见降级并交回 native compaction；宿主收到 `extension_error` 仍失败。内核负责 transport 证明与持久结算，已验证边界见 [Gateway 专题](PI_OBSERVATIONAL_MEMORY_GATEWAY.md)和 [RPC 专题](PI_OBSERVATIONAL_MEMORY_RPC.md#2026-10-31-主线程-built-image-验收)。

无论放在哪一层，都必须守住边界：不得因此放宽全部 `error` / `extension_error` 处理，不得吞掉权限违规与协议损坏，也不得把降级记录伪装成成功。

### 原则 7 不等于扩权许可

「首版只用冻结模型」是**收窄**，不是为后续独立模型预留授权。后续若需要独立模型，只能在既有授权集合内选择；不满足即拒绝，权限变更另行评审，不能用本记录倒推授权。

同时，「不写 `model` 键」须以项目配置、环境变量与 fallback 覆盖已被隔离为前提，否则写与不写都可能被外部配置改写。

## 3. 条件适用时必填

这些项**只在对应条件下**才必须填写，未触发条件时不构成 A 的阻塞。

| 项 | 触发条件 | 当前状态 |
| --- | --- | --- |
| 有限总额的分配契约 | 仅在管理员显式配置有限总额时 | 已实现显式 `total_requests` / `main_requests` / `background_requests`；不推导比例、不自动转移剩余额度 |
| 并发占额与 unknown/pending 验收 | 同上 | Gateway unit + 真实 SQL/HTTP 及已知请求前 transport/结算、防冒充回归已通过，范围见 [Gateway 专题](PI_OBSERVATIONAL_MEMORY_GATEWAY.md) |
| 独立 workload 归因的具体实现（独立 token / 可信调用上下文） | D 片 | `observational_memory` token、workload ledger 与终态撤销已实现；不授权创建凭据或扩权 |

## 4. 后续工程实现（不阻塞 A 结论，阻塞启用）

- 原则 1 的字段拆分已落到 `PiExtensionRegistration` 的 `requires_egress` / `requires_gateway`，并由 wrapper/Gateway 分别校验。
- 原则 3 的降级实现已限制为 exact quota 或 known-never-started `gateway_transient`；provider 5xx/error prose、pending/unknown、权限和协议错误保持硬失败。
- 原则 5 的归因机制已落到可信 `observational_memory` token、workload ledger 和终态撤销；本地 built-image 验收已通过，最终组合 CI 与发布证据另行核对。

以上均须在启用前完成，不能以「原则已定」代替实现。

## 5. 未决风险：可延期与不可豁免

`docs/PI_OBSERVATIONAL_MEMORY.md` §9 列出的未验证项**不是一揽子接受或拒绝**，须分层：

| 层级 | 内容 | 处理 |
| --- | --- | --- |
| 已取得工程证据、仍需最终 CI/发布核对 | 实际本地构建镜像的 canonical Pi/OM RPC、独立生产启动守卫正负例；Session preview/download 脱敏、Gateway 预算/ledger | 镜像身份、场景和分母见 [RPC 专题](PI_OBSERVATIONAL_MEMORY_RPC.md#2026-10-31-主线程-built-image-验收)，已发布通道/平台与 registry/catalog 仍另验 |
| 可延期（不阻塞继续整合） | 质量收益、成本收益、真实模型和生产容量 | 保持 `unknown`；**不得**用本地替身、CI 或静态门禁代替 |
| 不可豁免（注册前硬门） | canonical 发布物来源、tarball integrity、实际 `entry` 核验 | 无论风险是否延期，注册前必须完成 |
| 不可豁免（启用前硬门） | 固定宿主兼容、RPC 纯净性、配置隔离、额度与归因、数据出口脱敏 | 无论风险是否延期，启用前必须完成 |

不得用「接受风险进入下一设计阶段」豁免上述两个硬门；也不得用「已接受全部风险」这类一揽子表述替代逐项分层。

## 6. A 结论

A 的结论需要明确写出，并区分「原则已定」与「工程契约闭合」：

- ☐ 原则已定（见 §2），工程契约按 §3–§5 分层闭合，允许进入 B 设计
- ☐ 原则已定，但工程契约未闭合，暂不进入 B
- ☐ A 否决，停止：不注册、不预装、不启用

当前记录：设计原则已定；核心 wrapper/RPC、Session archive、Gateway 预算及本地构建镜像 RPC/生产启动守卫已有工程证据。本文件不替用户签署 A 正式通过，最终组合 CI 与发布证据仍未完成。

签署：

| 项 | 内容 |
| --- | --- |
| 填写人 | 待填 |
| 日期 | 待填 |
| 依据 | [#815 决策评论](https://github.com/SummerSec/DeepSonar/issues/815#issuecomment-6538810106) |

## 7. 边界

本文件记录的是产品/设计原则的选择，也回填截至 2026-10-31 的工程验证状态，不授予发布或生产启用权限。canonical 包、配置冻结、RPC、Session 多出口脱敏、Gateway 预算隔离、新 Job 的 OM 专属版本准入及本地镜像内容守卫均已有对应证据；最终组合 CI 与发布证据未完成，质量与成本收益仍为 `unknown`，剩余门禁不能被本文件跳过。
