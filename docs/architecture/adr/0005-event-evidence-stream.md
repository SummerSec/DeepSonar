# 0005. events、Evidence 与 stream-bus 分担三种职责

> 状态：**已采纳（历史回填）**。本文记录三流职责和过程流可见性边界，不引入新的消息中间件。
> 决策日期：原决策日期未核实（本次回填：2026-10-15）
> 同步日期：2026-10-15
> 来源：[Issue #388](https://github.com/SummerSec/DeepSonar/issues/388)；实现核验见 [`process-stream-policy.ts`](../../../apps/scheduler/src/process-stream-policy.ts)

## 背景

语义事件需要事务、顺序、幂等和副作用审计；CLI/工具过程流需要保留原始执行证据；Web/WS 又需要低延迟推送。把三者写入同一个实时队列会让重启、回放、跨副本可见性和权限边界混在一起。当前代码已经把三种载体分开：PostgreSQL `events` 是语义账本，`BLOB_DIR` 下的 Evidence NDJSON/manifest 是过程证据，stream-bus 是进程内投递缓存。

## 决策

1. `events` 是唯一可以触发 Control API 领域副作用的语义账本，写入遵守同 Job 顺序、event id 幂等和事务边界。
2. Evidence 文件保存规范化过程流、Session、产物和 manifest；`JobEvidenceWriter.appendNormalized` 完成落盘才算确认帧，补读始终读取 Evidence。
3. stream-bus 只作已持久化帧的进程内实时投递，不是事实源、补读源或控制队列；重启、环形淘汰、背压和跨进程都可能丢失其缓存帧。
4. 过程流使用 `attempt_id:seq` 作为游标/去重键，并显式返回 `unpersisted` 和 `visibility`。本副本看不到期望 Evidence 时返回 `visibility=unavailable`，WS 使用 4415 `STREAM_UNAVAILABLE` 关闭。
5. 单 Scheduler 本地卷和多 Scheduler 共享卷可以补读已确认 Evidence；多 Scheduler 独立本地卷不宣称过程流连续性。没有共享可见性证据时不引入跨副本 file-tail 或消息中间件。

## 状态

当前状态为已采纳。本文件于 2026-10-15 回填，原始决策日期未核实。过程流的 live 低延迟是可用性优化，不能提高语义事件或 Evidence 的权威级别。改变三流职责必须新开 ADR。

## 后果

- 正面：语义回放、证据补读和实时体验互不替代；重启和跨副本异常可以显式报告，避免把空页当作零丢失。
- 代价：客户端必须处理 cursor gap、unpersisted、unavailable 和 WS 4415，并在需要时走 HTTP Evidence 补读；共享卷是多副本补读的部署前提。
- 运行时边界：`publishStream` 必须等待 Evidence 写入 Promise；stream-bus 不得重新触发 Control API 或副作用。
- 验收：[`evidence-stream.test.ts`](../../../apps/scheduler/src/evidence-stream.test.ts)、[`process-stream-boundary.test.ts`](../../../apps/scheduler/src/process-stream-boundary.test.ts)、[`stream-bus.test.ts`](../../../apps/scheduler/src/stream-bus.test.ts) 和 [`ws-send-queue.test.ts`](../../../apps/scheduler/src/ws-send-queue.test.ts) 覆盖落盘确认、背压、游标、缓存和不可见副本。

## 替代方案

以下替代方案是本次回填的当前分析，不声称是历史讨论原文：

- 只用 stream-bus 作为事实源：重启和跨副本会丢失数据，无法审计或补读，因此不选。
- 把所有过程帧写入 PostgreSQL `events`：会把大体量原始流与语义账本耦合，放大存储和查询压力，也会混淆副作用边界，因此不选。
- 引入跨副本消息中间件并让它承担回放：会建立第二事实源和新的确认/重放语义，当前问题不需要，因此不选。
