# 0017. 透明模型数据面与持久结算确认分离

> 状态：**已采纳契约；当前分支实现待最终 SHA Actions 验收**
> 决策日期：2026-11-05
> 同步日期：2026-11-05
> 来源：#923 的用户完整透传要求；Gateway、预算策略与 OM wrapper
> 关联需求：FR-CRED-003 / FR-CRED-004 / FR-CAP-009 / NFR-PERF-004

## 背景

原 Gateway 通过业务头过滤、JSON/body 改写、隐式重试和 OM 响应缓冲承担适配与结算。这改变了已授权请求及上游可观察语义；直接移除预算和结算又会破坏 [ADR 0013](0013-governed-pi-memory.md) 的未知效果边界。

## 决策

获准模型请求必须保留原始业务字节、端到端头及响应，只在明确认证、绑定目标和 HTTP 传输边界转换。模型 alias 必须在请求生成层完成；预算不符必须在出站前明确拒绝，不能静默改写 body。透明传输不得隐式重试或跟随重定向。

主执行三 CLI 的 loopback 适配器只对已形成 HTTP 请求查询 allowance 并检查准入，合规原字节转发，不合规明确拒绝，绝不补写 cap/usage。main 使用当前 token/Attempt 的 Job 或 main-workload 与修正预算交集。Pi 通过原生 provider streamSimple hook 设置请求局部 SDK 上限；Claude 通过启动/resume 的原生 env/settings 设置静态上限。DSH 通过构建期锁版本/摘要的独立 vendor adapter 覆盖共用 SDK 调用前路径；Claude 动态余额仍是未闭合兼容阻塞。OM 受审 wrapper 在 SDK 调用前读取 allowance 并设置 SDK 选项，属于实际请求形成前的准备；无法满足 SDK 最小输出要求则拒绝。查询不预留、不消耗请求配额，pending/unknown 不准入；数据面仍在 Job 锁内重验，提示不扩大权限。

OM 的严格持久结算保持，但确认从数据面迁移到原 Gateway 的 scoped 只读查询。已准入请求 UUID 作为原 effect intent 的关联字段；未准入的 quota/已回滚 DB 冲突拒绝在独立事务保存原 events 的 kernel `control_receipt/gateway_admission`。完整 Job/Attempt/token/workload/UUID scope、dedup 与事件限流不变，不新增模型计数、usage 或 schema。相同 UUID 禁止重发；回执持久失败不得降级，不成为另一套授权或账本。受审 wrapper 在当前 Job/Attempt/token/workload 对应的 durable settled 状态确认前不得提交模型终止结果。pending/unknown、撤销、查询失败和 timeout 均不能推定成功；Provider 的 JSON、SSE 或错误文案不构成平台回执。

Job 锁下的额度预留、usage/effect 原子结算、终态撤销与主后台隔离不变。请求流有界收全再准入；响应流及时转发并遵守背压、取消与 deadline。绑定 key 的 header/trailer、原始 body 及 gzip/deflate/br 解码观察回显必须在传输边界阻断；未知编码和解码观察超限断流，不改写或重编码合法原始响应。任意业务编码/变换后的秘密检测不在此保证内。具体协议限制集中在 [透明传输专题](../../MODEL_GATEWAY_TRANSPARENCY.md)。

## 状态

2026-11-05 根据 #923 迁移实现；补充 ADR 0013 的传输与确认机制，不取代其准入、权限、未知效果和记忆非 authority 决策。旧已采纳决策正文保留；历史测试证据不代表本次实现已通过。

## 后果

业务协议扩展不需增加 Gateway 白名单，客户端能看到真实上游错误。代价是请求生成层须提供显式预算参数，OM wrapper 和 Gateway 须同时支持 scoped 结算查询；旧 wrapper 不能绕过此确认。分块请求仍受有界缓冲限制，不宣称无限流或全双工支持。

验证复用传输/隔离数据库/OM wrapper/主请求准入适配器回归和现有 Actions 门禁；CLI 形状合成请求不等于实际三 CLI 已运行，最终证据须明确区分，最终 SHA 结果独立记录；本轮不做真实模型或生产验证，收益 unknown。

## 替代方案

以下为本次分析，不追溯冒充历史讨论：继续扩展业务头白名单不能满足未知协议透传；保留 Gateway 的 OM 缓冲会破坏 SSE 首段和错误透传；直接删除结算门会让未知外部效果被提交为成功。故选择透明数据面加现有账本的 scoped 确认，不新增外部执行通道或账号路由策略。


## 配置身份与恢复补充（2026-11-05）

#918 联动以根快照的非秘密 provider 配置摘要约束 mutable Credential：认证 secret 可轮换，目标/业务头/model 配置变化要求显式受治理 refreeze。目录使用 provider 头，推理与 OM 使用授权 model 默认；客户端已形成业务字段始终优先，不改 body。旧 Job 不自动回填；无效果 Job 可用现有 rerun-current 显式准备下一次执行，活动 Job 和未知效果/repair 链的安全恢复须与 #903 联合闭合。具体限制、操作路径与未完成项见[配置绑定与旧 Job 出口](../../MODEL_GATEWAY_TRANSPARENCY.md#provider-配置绑定与旧-job-出口918-联动)。

## 累计请求策略补充（2026-11-05）

原始完整请求策略使用既有 Job 级内核 control receipt 保存，不修改活动快照或新建预算表。首次 mint 一次冻结所有 workload，恢复在旧快照仍可读且 Job 锁持有时保存它；所有后代对回执、历史 token 与当前有限上限取交集。只读预检与持久 ensure 分离，后者必须包含在调用方恢复事务中，后续失败整体回滚。缺失/非法冻结输入或已经遗失且不可证明的历史策略阻塞，不能当作无限。Gateway 请求次数政策与 #903 的模型 token allowance、生命周期及 unknown-effect 决策保持独立。
