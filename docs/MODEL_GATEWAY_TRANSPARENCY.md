# Model Gateway 透明传输（#923）

> 状态：当前分支实现与验收契约；最终 SHA 的 GitHub Actions 尚待验证，不代表真实模型、生产或性能验收。
> 同步日期：2026-11-05

## 边界与入口

[Gateway](../apps/scheduler/src/gateway.ts) 保留 Job/token/Attempt、冻结模型、workload、deadline、预算和 effect/usage ledger 准入。获准请求只替换认证和服务器绑定目标，不通过业务头白名单、JSON 重序列化或模型参数改写改变业务内容。账号池和自动路由治理不在 #923 范围。

[HTTP 传输](../apps/scheduler/src/gateway-transparent-http.ts) 使用 Node HTTP/HTTPS 单次交换，不隐式重试、跟随重定向或自动解压；[策略](../apps/scheduler/src/gateway-transparent-policy.ts) 只观察副本并在请求不满足预算时明确拒绝。内核纯数据库 admission 重试仍只发生在事务已回滚、尚未请求上游时，不代表重放外部调用。

## 路径、方法与字节

`/gateway/` 后的原始路径和 query 传给绑定 base URL。唯一前缀规则是：请求路径已经等于完整 base path，或以完整 base path 加 `/` 开头时不再拼接；否则在前面添加该 base path。比如 base `/relay/v1` 与请求 `/messages` 得到 `/relay/v1/messages`，请求 `/relay/v1/messages` 保持不变；不猜测或删除版本段。重复 query、空值、百分号编码和点路径字节不经过 URL 路径规范化。目标 authority 只取服务器 base URL，不允许用户信息、绝对目标注入或重定向改目标。

注册 GET、HEAD、OPTIONS、POST、PUT、PATCH、DELETE。请求流先按 [body limit](../apps/scheduler/src/gateway.ts) 有界收全，再完成鉴权/模型/预算准入及原始 Buffer 转发；支持分块上传，但不是边收边发的无限流或全双工隧道。HEAD/GET 的合法 body 也不由 fetch 限制静默丢弃。非法 framing 明确拒绝；协议升级不支持，不能脱离 Job 取消和记账。

JSON（包括扩展字段）、非 JSON 和二进制转发字节不重建。压缩 JSON 只对观察副本进行有界解码，用于模型与预算校验；实际 Content-Encoding 和原始压缩字节保留。支持的观察编码及上限以策略源码为准，非法 JSON 可在不要求模型观测的普通请求中原样转发；受冻结模型或预算约束而无法观察时明确拒绝，不能绕过准入。OTLP 是单独的平台控制入口，不套用模型请求观测规则。Claude alias 在 [executor](../apps/scheduler/src/executor-real.ts) 的请求生成层映射到冻结上游 ID，不由代理改写 model。

## 头与认证

入站 raw header 对保留合法重复字段和未知端到端业务头，包括 User-Agent、Accept、版本/beta 与自定义标签。服务器默认值只补缺；同目标的凭据配置头高于协议默认，客户端头高于配置，真实认证最后由绑定凭据产生。目录发现和推理探测共用 [配置解析器](../apps/scheduler/src/provider-custom-headers.ts)；#921 的 endpoint/profile 关联不变，另一目标的配置头不得串用。

所有 Job token 认证载体在边界消费，不转给上游；重复认证字段明确拒绝，未知业务字段含入站 Job token 时也拒绝整次请求，不能借业务头外发短期凭据。Host 从绑定目标生成；逐跳头及 Connection 点名字段被消费，长度与实际字节核验，分块 framing 由当前连接重新生成。平台只消费源码列出的精确控制字段（包括 `x-deepsonar-request-id`），不保留整个 `x-*` 或协议前缀。配置中的非法 HTTP 名称/值、资源超限和大小写冲突明确拒绝，不以部分配置继续调用。

## 响应与旁路记账

上游状态、端到端响应头、普通/错误正文和 SSE 数据按原始字节送达。3xx、429 和 5xx 不因代理重试或跟随跳转消失；未知事件不经业务解析后重组。收到头即刷新，写缓冲满则等 drain；客户端取消、deadline 与上游断流中止传输并保守结算，不把截断响应补成成功。

usage scanner 只观察副本，压缩响应仍按原压缩字节转发；无法完整观察、缺 terminal usage 或持久结算失败不能成为已知零成本。账本与已发生的外部效果不因客户端已收到数据而删除。Gateway 自身准入/无上游网络错误使用平台错误，已有上游响应保留上游语义。

绑定真实 key 在上游响应头/trailer 回显时中止；原始响应 body 通过跨 chunk 前缀观察阻断明文 key 回显。gzip、deflate、br 响应在转发每段压缩字节前通过独立解码观察检查回显，原压缩字节不替换；解码超限、非法或不支持的 Content-Encoding 明确断流，限制以 [响应守卫](../apps/scheduler/src/gateway-response-guard.ts) 为准。该检查不代表任意业务自定义编码/变换后的秘密检测。透明内容与秘密回显之间的安全例外必须如实记录，不能把原字节透传承诺扩张为放行已识别凭据。

## 预算与 OM 迁移

[输出预算](../apps/scheduler/src/gateway-transparent-policy.ts) 不再给已放行 body 补写或压低输出参数。受预算约束的调用者必须显式提供剩余额度内的输出上限，以及该协议要求的 terminal usage（例如 Chat SSE `stream_options.include_usage`）；否则出站前返回 `GATEWAY_OUTPUT_BUDGET_REQUIRED`。输入/缓存成本仍在响应后确认，累计熔断不等于精确调用前总成本上限。

OM 响应不再由 Gateway 缓冲后换成结算错误。受审 [wrapper](../agent-harness/pi-observational-memory-governed.ts) 为每次后台请求生成 UUID 放入 `x-deepsonar-request-id`；Gateway 消费该头并在原 effect intent 中登记。wrapper 收到模型终止结果后，必须从冻结 Gateway 的 `GET /gateway/_settlement/:id` 读取同 Job、当前 Attempt、同 token/workload 的持久状态，确认 settled 才提交该结果。pending 有界等待；unknown、查询不可用或超时硬失败。内核证明 never_started 的结果与普通 Provider 文案分离。读取回执不创建模型请求、不消耗新的模型请求配额、不授予跨 scope 权限。详见 [OM Gateway](PI_OBSERVATIONAL_MEMORY_GATEWAY.md) 和 [ADR 0016](architecture/adr/0016-transparent-gateway-settlement.md)。

## 验收范围

合成凭据、合成 Job token、隔离 PostgreSQL 和 loopback 假上游是本轮证据来源，不访问真实模型或生产。新增 [传输测试](../apps/scheduler/src/gateway-transparent-http.test.ts)、[端到端测试](../apps/scheduler/src/gateway-transparent.integration.test.ts)，并更新已有 provider、budget、OM 与 wrapper 回归；实际 Actions 接线以 [package scripts](../package.json) 和 [工作流](../.github/workflows/ci.yml) 为准。

验收分别核对直连/Gateway 请求字节与重复头/query、错误/重定向单次送达、SSE 首段/取消/背压、压缩/framing、凭据和 scope 负例、预算拒绝及持久结算查询。当前文档只记录实现和检查入口；通过/失败/未运行、精确 head 与检查链接由 PR 记录，历史 #918/#831 的通过结果不覆盖 #923。质量、成本收益及 SLA 保持 unknown。

端到端回归另外对照不受模型观测限制的无效 JSON 原始字节，并检查业务头/body 携带 Job token 时出站前拒绝、响应头回显绑定 key 时断开，以及跨 chunk 明文 key 回显不完整送达。慢消费者用例证明字节完整性，不证明进程内存上界；压缩或变换编码的 key 回显不在这些负例覆盖范围。新增用例尚未在本地执行，须以该提交的 Actions 结果验收。
