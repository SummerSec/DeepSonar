# 0003. Agent 语义控制只通过 Job-scoped Control API

> 状态：**已采纳（历史回填）**。本文把既有 API-only 控制边界记录为 ADR，不扩大 operation 集合。
> 决策日期：原决策日期未核实（本次回填：2026-10-15）
> 同步日期：2026-10-15
> 来源：[Issue #100](https://github.com/SummerSec/DeepSonar/issues/100)、[#135](https://github.com/SummerSec/DeepSonar/issues/135)、[#145](https://github.com/SummerSec/DeepSonar/issues/145)、[#152](https://github.com/SummerSec/DeepSonar/issues/152)；实现核验见 [`platform-api/routes.ts`](../../../apps/scheduler/src/domains/platform-api/routes.ts)

## 背景

Agent 需要提交 progress、Fact、Finding、Hub decision、human request 和 done 等语义事件，但模型输出、未治理的 CLI/MCP 输出和工作区文件都可能被不可信输入影响。受治理的普通 MCP/CLI 工具可以执行业务操作；若平台从普通文本或第二条控制队列猜测语义，仍无法统一做项目 scope、Job 状态、权限、幂等和审计校验。

当前实现提供 `/control/v1/jobs/:jobId` 的 capability discovery、OpenAPI 和 operation 路由；所有 POST operation（包括 readonly discovery）都要求短期 Job capability token 和必填 `Idempotency-Key`。同一 Job 内，同一 key 搭配同一 operation 和同一输入返回既有结果；同一 key 搭配不同 operation 或不同输入返回 409 冲突。只读 discovery 的请求级结果复用与语义事件的 durable identity 分开，进程内缓存不是通用 durable receipt API。入口与契约见 [`routes.ts`](../../../apps/scheduler/src/domains/platform-api/routes.ts)、[`operations.ts`](../../../apps/scheduler/src/domains/platform-api/operations.ts)、[`platform-api.test.ts`](../../../apps/scheduler/src/domains/platform-api/platform-api.test.ts) 和 [`control-input.ts`](../../../apps/scheduler/src/control-input.ts)。

## 决策

1. Agent 对 DeepSonar 的语义写入必须走当前 Job 授权的 Control API；operation 必须在本轮 capability projection 和 Job snapshot allowlist 中。受治理普通 MCP/CLI 仍可作为业务工具执行，但不得绕过该 API 写入语义状态。
2. 所有 POST operation（包括 readonly discovery）都必须带 `Idempotency-Key`。同一 Job 内，同一 key、operation 和输入返回既有结果；key 已用于不同 operation 或不同输入时返回 409。只读 discovery 的请求级幂等不等同于事件/效果的 durable receipt。
3. 语义事件不得从普通文本、未治理的 CLI/MCP 输出、Session 标题或控制文件推断；伪造 tool call 不能绕过 API，失败不得回退到另一套控制通道。
4. `accepted` 必须表示 Scheduler 已接收并建立可查询的 durable receipt 语义；模型完成须由显式的受治理 operation 和 Job 状态收口证明。当前具体操作依赖事件/效果持久化身份，完整统一协议仍是技术债，进程内缓存不能替代此规范要求。
5. Control API 只负责受治理提案和事件接收，最终状态、Evidence 来源、副作用结算、权限和资源清理仍由 Scheduler 持有。

## 状态

当前状态为已采纳。本文件为 2026-10-15 历史回填，原始决策日期未核实。现有实现仍允许对过程流做实时展示，但实时流不是语义控制通道，也不能触发副作用。若未来改变控制入口，必须新开 ADR 并保留本条的替代关系。

## 后果

- 正面：所有语义写入共享一套鉴权、schema、scope、幂等、审计和事务边界；模型不能以输出格式变化绕过平台规则。
- 代价：新增 Agent 能力必须先注册 operation、共享 schema、权限和测试；调试时需查看 durable event/effect，而不能依赖模型日志。
- 运行时边界：`deepsonar-control` 只提供 API 说明和调用方式，不动态授予权限；能力 discovery 只是目录，不是授权。
- 验收：[`platform-api.test.ts`](../../../apps/scheduler/src/domains/platform-api/platform-api.test.ts)、[`platform-api.integration.test.ts`](../../../apps/scheduler/src/domains/platform-api/platform-api.integration.test.ts)、[`authorization.integration.test.ts`](../../../apps/scheduler/src/domains/event-ingestion/authorization.integration.test.ts) 和 [`control-input.test.ts`](../../../apps/scheduler/src/control-input.test.ts) 覆盖路由、token、幂等、错误反馈、权限和事务边界。

## 替代方案

以下替代方案是本次回填的当前分析，不宣称是历史 issue 中的完整讨论记录：

- 从 Agent 文本或 CLI 输出解析约定标记：无法证明来源、scope 和幂等，且容易被不可信仓库内容伪造，因此不选。
- 通过未治理的 MCP 或工作区控制文件直接写事件：会绕过统一的 Job token、事务和审计边界，因此不选；受治理的普通 MCP 业务工具仍可使用，但语义写入必须回到 Control API。
- 让 Agent 直接写 PostgreSQL 或调用沙箱控制面：会把状态机、凭据和副作用权限交给不可信执行方，因此不选。
