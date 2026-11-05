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

原始入站与最终出站 target 同时检查原文和一次百分号解码结果；非法百分号编码明确拒绝；按 octet 观察保留合法的非 UTF-8 URI 字节，不退回未解码原文，避免无关参数使 token 检查失效。该边界不宣称检测任意多重编码或业务自定义变换。

## 响应与旁路记账

上游状态、端到端响应头、普通/错误正文和 SSE 数据按原始字节送达。3xx、429 和 5xx 不因代理重试或跟随跳转消失；未知事件不经业务解析后重组。收到头即刷新，写缓冲满则等 drain；客户端取消、deadline 与上游断流中止传输并保守结算，不把截断响应补成成功。

usage scanner 只观察副本，压缩响应仍按原压缩字节转发；无法完整观察、缺 terminal usage 或持久结算失败不能成为已知零成本。账本与已发生的外部效果不因客户端已收到数据而删除。Gateway 自身准入/无上游网络错误使用平台错误，已有上游响应保留上游语义。

绑定真实 key 在上游响应头/trailer 回显时中止；原始响应 body 通过跨 chunk 前缀观察阻断明文 key 回显。gzip、deflate、br 响应在转发每段压缩字节前通过独立解码观察检查回显，原压缩字节不替换；解码超限、非法或不支持的 Content-Encoding 明确断流，限制以 [响应守卫](../apps/scheduler/src/gateway-response-guard.ts) 为准。该检查不代表任意业务自定义编码/变换后的秘密检测。透明内容与秘密回显之间的安全例外必须如实记录，不能把原字节透传承诺扩张为放行已识别凭据。

## 预算与 OM 迁移

[输出预算](../apps/scheduler/src/gateway-transparent-policy.ts) 不再给已放行 body 补写或压低输出参数。受预算约束的调用者必须显式提供剩余额度内的输出上限，以及该协议要求的 terminal usage（例如 Chat SSE `stream_options.include_usage`）；否则出站前返回 `GATEWAY_OUTPUT_BUDGET_REQUIRED`。输入/缓存成本仍在响应后确认，累计熔断不等于精确调用前总成本上限。

`GET /gateway/_allowance` 接受当前有效的 main 或 observational_memory token 与活动 Attempt，返回 `{ remaining_tokens: null | number, policy_required: boolean }`，禁止缓存。查询在 Job 锁内读取原预算，不预留、不增加模型请求计数；main 取 Job 总量或 OM main-workload 额度与修正链余额的交集，后台保持自身额度。pending/unknown 拒绝；返回提示后最终出站仍须锁内重验，不能扩大授权。

主执行的 Pi、DSH、Claude start/resume 命令由显式[请求准入适配器](../packages/runtime-sandbox/src/model-request-policy.ts)包装，运行器上传自包含 Node 脚本，生命周期与 CLI 绑定。Scheduler 仅将运行时主 Provider 配置、DSH profile 与 env 的 endpoint 指向沙箱 loopback `http://127.0.0.1:38127/gateway`（核对基线 2026-11-05），不改冻结历史；OM 后台配置仍直连真实 Gateway。

该适配器收到已形成的模型 HTTP 请求后，只读取真实 Gateway allowance 并检查现有 cap/usage。合规请求保留原始 Buffer、摘要与签名头，包括大整数、未知字段、转义和空白。不合规则明确拒绝，不能自动修改任何已形成 body；参与模型/预算/usage 准入的重复键明确拒绝，未知业务重复键保留。有限额度下 opaque/压缩或不支持形状也明确拒绝。

### 锁定 CLI 的请求生成前入口与剩余阻塞

核对日期 2026-11-05；只读锁定包源码与官方文档，不代表真实 CLI/模型验收。新增合成回归接入 `ci:unit:runtime-sandbox`。

| CLI / 锁定版本 | 已接能力 | 边界 |
| --- | --- | --- |
| Pi `@earendil-works/pi-coding-agent` 1.4.0、pi-ai 1.4.0 | runtime-owned [扩展](../packages/runtime-sandbox/src/pi-main-request-budget.ts)通过正式 `registerProvider(provider,{api,streamSimple})`，在 SDK 构造请求前逐次读取 allowance，设置请求局部 `options.maxTokens` 与 `model.maxTokens`；由 SDK 生成 Chat usage。start/resume 均加载 | 不使用已有 payload 的 `before_provider_request`；显式不支持 streaming usage、Responses 最小输出不满足或 sampling 冲突则拒绝。非 adaptive Anthropic thinking 必须在额度及 SDK 上下文夹紧后仍至少有 2048 token，否则生成前拒绝，不关闭 thinking。Gateway 始终原字节重验。已新增锁定真实 SDK 到 loopback 上游的非 adaptive/adaptive 阈值回归，真实 Pi 进程加载链仍待验收 |
| Claude Code `@anthropic-ai/claude-code` 2.1.312 | start/resume 启动器先读取 allowance，再通过原生 `CLAUDE_CODE_MAX_OUTPUT_TOKENS` 与 `--settings` 设置正整数上限，保留更严格既有设置；零余额不启动 | 只保证启动时配置。stdin `update_environment_variables` 白名单不包含该变量；settings 热更新无逐请求同步屏障。工具循环、压缩及子任务的动态余额仍未闭合；managed settings 优先级更高，冲突由 Gateway 拒绝 |
| DSH / dsh-llm / dsh-llm-pi-ai / dsh-agent-loop 0.2.1-rc.2、pi-ai 1.4.0 | 镜像构建期验证锁定 vendor bundle SHA256，生成独立 `deepsonar-index.js`，保留官方 apply/Config/消息/附件/签名/usage 转换；唯一 llm-pi-ai profile 条目指向该产物。共用 streamWithSnapshot 的 SDK 调用前读取 allowance 并使用与 Pi 相同的 SDK 输入政策 | 原包不改，运行时不安装或写包。导入时校验 artifact/helper/vendor 摘要及 SDK 版本；认证应用后的真实 provider 分派再次核对冻结目标与 token。prepared 主调用与 direct stream（compaction/子调用所用服务）走同一 adapter。跨进程 resume 仍明确不支持；真实 Cordis/SDK 合成上游回归待 Actions |

锁定 Pi 源码证据：`dist/core/provider-composer.js` 的 provider streamSimple 分派、`dist/core/sdk.js` 的 modelRuntime；默认 auto/manual compaction 与 branch summary 经 `agent-session` 传同一 agent.streamFunction，因此在注册成功且仍为绑定 provider/model/API 时重查额度。外部扩展直接调用 SDK 不在该保证内。loader 的 jiti aliases/virtual modules 解析 compat import，不依赖 workspace 安装包；session_start 异常本身会被上游捕获，运行器检查扩展错误且 Gateway 保留最终准入。DSH：`dsh-agent-loop/lib/index.js:1191`、`dsh-compaction-basic/lib/index.js:323`、`dsh-llm-pi-ai/lib/index.js:1983`。Claude 原生包静态检查与[环境变量](https://code.claude.com/docs/en/env-vars)、[settings 优先级](https://code.claude.com/docs/en/settings)、[hooks](https://code.claude.com/docs/en/hooks)一致：静态 cap 不能冒充逐请求余额协商。Anthropic SSE 自带 usage，无需 OpenAI Chat 的 include_usage。

**发布阻塞仍在：** Claude 动态余额缺少受支持的逐模型请求生成前 hook。DSH 的完整受治理 adapter 补丁已接入但尚待最终 Actions 验收。无法合规的已形成请求继续明确拒绝；不扩大预算、不降准入、不自动改 body。不能宣称三 CLI 有限额度全部兼容或 #923 完成。

OM 在受审 wrapper 的请求生成层读取相同 allowance。wrapper 在生成请求前将 `options.maxTokens` 限制到该 allowance；Responses SDK 的最小输出值无法容纳时明确拒绝（当前 SDK 下限为 16，核对基线 2026-11-05）。pending/unknown 不允许协商下一次请求。此结果只是生成参数的提示，Gateway 出站前仍在 Job 锁内重核额度和冻结权限，竞态不能扩大 allowance。

OM 响应不再由 Gateway 缓冲后换成结算错误。受审 [wrapper](../agent-harness/pi-observational-memory-governed.ts) 为每次后台请求生成 UUID 放入 `x-deepsonar-request-id`；Gateway 消费该头并在原 effect intent 中登记。wrapper 收到模型终止结果后，必须从冻结 Gateway 的 `GET /gateway/_settlement/:id` 读取同 Job、当前 Attempt、同 token/workload 的持久状态，确认 settled 才提交该结果。pending 有界等待；unknown、查询不可用或超时硬失败。内核证明 never_started 的结果与普通 Provider 文案分离。读取回执不创建模型请求、不消耗新的模型请求配额、不授予跨 scope 权限。详见 [OM Gateway](PI_OBSERVATIONAL_MEMORY_GATEWAY.md) 和 [ADR 0017](architecture/adr/0017-transparent-gateway-settlement.md)。

配额拒绝及已回滚的 admission 数据库冲突耗尽，也必须有持久的宿主无外部效果回执才允许 OM 可见降级。[admission receipt helper](../apps/scheduler/src/gateway-admission-receipt.ts) 在确认未发上游、且失败 admission 已回滚后，另开事务复用 `events` 的 `control_receipt`：`operation=gateway_admission`、`authority=kernel`，按 Job/Attempt/token/workload/请求 UUID 绑定，复用事件限流与 dedup。它不创建模型 effect、不增加模型请求计数或 usage，不改 schema。查询同 scope 回执得到 `not_started` 才能按已知 quota/transient 降级；保存失败、缺失或不匹配保持 unknown。相同 UUID 不得重新发起上游请求。请求前 transport 的原 effect/零用量结算路径保持独立，不能与未准入回执混淆。

## 验收范围

合成凭据、合成 Job token、隔离 PostgreSQL 和 loopback 假上游是本轮证据来源，不访问真实模型或生产。新增 [传输测试](../apps/scheduler/src/gateway-transparent-http.test.ts)、[端到端测试](../apps/scheduler/src/gateway-transparent.integration.test.ts)，并更新已有 provider、budget、OM 与 wrapper 回归；[主 CLI 请求准入测试](../packages/runtime-sandbox/src/model-request-policy.test.ts)验证适配器与 CLI 形状的合成请求，不能冒充实际三 CLI 运行证据；实际 Actions 接线以 [package scripts](../package.json) 和 [工作流](../.github/workflows/ci.yml) 为准。

验收分别核对直连/Gateway 请求字节与重复头/query、错误/重定向单次送达、SSE 首段/取消/背压、压缩/framing、凭据和 scope 负例、预算拒绝及持久结算查询。当前文档只记录实现和检查入口；通过/失败/未运行、精确 head 与检查链接由 PR 记录，历史 #918/#831 的通过结果不覆盖 #923。质量、成本收益及 SLA 保持 unknown。

端到端回归另外对照不受模型观测限制的无效 JSON 原始字节，并检查业务头/body 携带 Job token 时出站前拒绝、响应头回显绑定 key 时断开，以及跨 chunk 明文 key 回显不完整送达。慢消费者用例证明字节完整性，不证明进程内存上界；gzip/deflate/br 的回显防护由响应守卫及相关合成回归覆盖范围单独核对，任意业务编码/变换后的 key 回显不在保证内。新增用例尚未在本地执行，须以该提交的 Actions 结果验收。

### DSH vendor 产物与 SDK 验收

[构建器](../agent-harness/dsh-request-budget-install.mjs)只生成同目录独立产物，不修改 npm 安装的官方 bundle；原源码摘要或唯一补丁点不匹配即构建失败。[helper](../packages/runtime-sandbox/src/dsh-request-budget.ts)共享 Pi 的 SDK 生成前政策，不使用 onPayload 修复参数。两类官方 runtime Dockerfile 均执行生成器，三个基础镜像 fingerprint 包含生成器与政策源码；旧镜像缺少产物时不能回退到无预算 hook 的 provider。

`ci:integration:request-budget-sdk` 从现有 dsh-runtime lockfile 安装固定依赖，运行[真实 Pi SDK 阈值回归](../agent-harness/pi-main-budget-sdk-regression.test.ts)与[真实 DSH LlmRuntime/adapter 回归](../agent-harness/dsh-request-budget-sdk.mjs)。后者覆盖 prepared 与 direct 公共服务调用、逐次额度下降、usage、耗尽和身份拒绝，全部使用合成凭据及 loopback；不是生产模型或真实 DSH CLI 启动验收。新增源与测试尚未在本地执行，最终 SHA Actions 另验。
