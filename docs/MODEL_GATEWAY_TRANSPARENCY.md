# Model Gateway 透明传输（#923）

> 状态：as-built；#928 已合入 main 616d7a36，工程证据见下文；后续 SHA 另验，不代表真实模型、生产或性能验收。
> 同步日期：2026-11-12

## Managed proxy 的逐跳连接策略（#1097）

Sandbox → managed proxy → Scheduler 是不同 HTTP 连接。代理双向消费固定逐跳字段和 `Connection` 动态点名字段，由各跳生成自身 Host、连接策略与 framing；不能把后端 `Keep-Alive` 的寿命广告送给客户端。普通 Job Authorization 和 `x-deepsonar-*` 字段仍须到达 Scheduler，除非被入站 Connection 明确点名；此边界不同于 Scheduler → Provider 对认证和控制字段的消费。

内容字节与 Content-Encoding 保持不变，流式及背压使用原生 HTTP 管道。支持的 chunked framing 在每跳重建，合法 trailers 在正常结束时过滤转发；禁止把连接级字段或认证/路由/内容处理字段夹进 trailer。未知 Transfer-Encoding 在请求侧拒绝、响应侧返回网关错误，不删除编码头后把仍带 transfer coding 的字节当普通内容。发头前失败为 502，发头后中断销毁响应，不生成成功结束或透明重试；既有固定路由及 CONNECT 限制不扩展。

历史现场只读诊断曾观察到代理响应 `Keep-Alive: timeout=72`，而连接在响应结束后约 6000ms 关闭；实际 Node v22.23.2 的默认 keep-alive 与 buffer 合计与之吻合。两个旧 Pi Job 的 allowance/工具结束/error 时间与该窗口高度相关，但原异常 cause/phase 已丢失，不能认定实际命中关闭/复用竞态；第三个 Job 缺对应宿主日志。修复已确认的协议缺陷，不回填历史根因，也不承诺消除所有正常连接关闭竞态。旧诊断丢失由 #1083 单独治理。

回归直接运行真实 `GATEWAY_PROXY_SCRIPT`，覆盖广告归属、双向动态字段、认证/控制头、定长/chunked/GET/HEAD/gzip 内容、trailers、首段流式与异常中断，接既有 `pnpm ci:unit:runtime-sandbox`。最终 SHA Actions 另验；未重跑生产 Job、未部署或重建现场代理。

## 边界与入口

[Gateway](../apps/scheduler/src/gateway.ts) 保留 Job/token/Attempt、冻结模型、workload、deadline、预算和 effect/usage ledger 准入。获准请求只替换认证和服务器绑定目标，不通过业务头白名单、JSON 重序列化或模型参数改写改变业务内容。账号池和自动路由治理不在 #923 范围。

[HTTP 传输](../apps/scheduler/src/gateway-transparent-http.ts) 使用 Node HTTP/HTTPS 单次交换，不隐式重试、跟随重定向或自动解压；[策略](../apps/scheduler/src/gateway-transparent-policy.ts) 只观察副本并在请求不满足预算时明确拒绝。内核纯数据库 admission 重试仍只发生在事务已回滚、尚未请求上游时，不代表重放外部调用。

## Pi 模型上下文凭据投影（#1032 首片）

2026-11-09 源码候选：Pi 主请求在已有 provider `streamSimple` 中，OM 在受审 registry 的 SDK 调用前，共用 [精确替换函数](../packages/runtime-sandbox/src/pi-main-request-budget.ts)。它只投影本次 SDK context 内的字符串值，把当前 main Gateway、Control、OM Gateway token 替换为 `[REDACTED]`；main/Control 取实际运行 env，OM 不在 env 中，主请求与 OM worker 均经现有模型注册表解析其认证值。主请求无法读取已配置 OM 的认证时明确拒绝，不为方便脱敏新增可继承的 secret env。工具 stdout、认证文件内容、工具错误、历史消息和 OM 来源文本因此走同一出口。原 Session 对象、认证选项、工具 ID、错误状态、额度、回执及冻结快照不改写；同次恢复调用重用同一个安全投影，而不是要求该投影与原 Session 对象引用相同。Gateway 的原字节 `credential_in_business_data` 守卫保留，不在代理、`onPayload` 或已序列化 body 上静默修复。

这是模型输入防泄漏，不是操作系统身份隔离：凭据仍用于 CLI 认证，工具进程仍能读取同身份的 env / `auth.json`；搬到同 UID 的 0600 文件不能冒充隔离。任意编码、二进制/图像携密、字段名携密，以及扩展绕过已登记 SDK 出口不在本片替换保证内；现有 Gateway 拒绝边界仍独立生效（拒绝留痕见下节）。#1032 的 A1/A2 认证隔离、稳定终态诊断与 deny 指标、Skill 提示仍未由此片交付，Issue 不据此关闭。

OM 直接加载镜像内现有 request-budget 源码的共享函数，启动 guard 同时核验 wrapper 与该源码的完整 SHA-256；旧/缺损/被替换内容拒绝，不能只核 wrapper 或沿用旧镜像声明。没有新增依赖、配置、状态机、数据库或授权通道，不增加用户操作。Pi 专属替换函数位于 DSH installer 复用的 SDK 政策前缀之外，避免不同 TypeScript 加载器的函数序列化改变 DSH helper 内容身份；不修改 DSH 的固定 vendor/artifact pin。

验收分层：`pnpm ci:unit:runtime-sandbox` 覆盖三协议 SDK 边界、无限/有限政策、env/文件/错误/OM 文本、Unicode、前缀重叠、原历史不变与双内容 guard；`pnpm ci:integration:request-budget-sdk` 用锁定 Pi AI 1.5.2 到 loopback 对照真正生成的请求与认证；已有 `pnpm ci:integration:om-provider-headers` 原生双架构专项改由真实 Pi bash 读取真实物化 env 和 `auth.json`，要求 main/observer 只收到替换结果、原 Gateway/Control 完成及用量归属仍通过。相关脚本已在核心/Reverse Actions 接线，未本机测试/build/typecheck，最终 SHA Actions 待验；未执行生产、真实厂商模型或声明质量收益。

### 凭据拒绝的审计留痕（#1032 观测片）

Gateway 原有的原字节 `credential_in_business_data` 拒绝保留，行为不变；新增的是每次拒绝都写一条审计。审计走 `recordSystemAudit`（request_id / IP / User-Agent 一律为空），而不是会持久化请求元数据的 `audit()`：最多 300 字符的原始 User-Agent 和 IP 都可能正好携带被拒绝的凭据。`action=gateway.credential_denied`、`result=denied`、`error_code=credential_in_business_data`，`resource_type=job_token`、`resource_id` 为该 token 行 ID，`after_json` 只含固定键 `surface`（`request_target` / `body` / `upstream_target` / `upstream_data` / `trailers`）、`job_id`、`attempt_id`。不写请求体、错误原文、header 原文或任何凭据片段。

回归接 `pnpm ci:integration:platform-api` 的 [透明 Gateway 集成测试](../apps/scheduler/src/gateway-transparent.integration.test.ts)：同一 mock 内制造 body、请求目标与业务 header 三处凭据命中，要求三次拒绝各留一条审计、`actor_type=system`、三项请求元数据为 null、`after_json` 键集合精确匹配且整表不出现 token 明文。本片只交付拒绝留痕；稳定终态诊断（把 `credential_in_business_data` 保留为不可重试的固定终态码）、deny 指标与 Skill 提示仍未交付，A1/A2 认证隔离同样未交付，#1032 不据此关闭。

## Job-scoped model recovery (#1002 P1-9)

Pi 的 SDK 生成前扩展为每次 main 调用签发独立 UUID，并禁用不透明 SDK 内部重试。只有本次没有模型内容/工具输出、认证的原 `/_settlement/:id` 返回 `not_started/gateway_transient`，才在原存活 Job/Attempt/Session 内准备新的、关联原 UUID 的模型调用；未运行那次的空 start/error 不提交给 Agent，成功仍只有一个 message start/终态。没有进程重启、Job 入队或旧业务输入/工具效果重放。Provider 429/5xx 文案、timeout、partial output、pending/unknown、查询失败与策略拒绝均不是权限。

新的 `x-deepsonar-retry-of` 是被消费的精确内部请求元数据，不转给 Provider。Gateway 在原 Job 锁/admission 事务内重新检查最新唯一活动未取消 owner、lease/deadline、当前请求/Token/修正预算，以及原同 Job/Attempt/token/main 回执或严格零用量 never_started settlement。已建立 effect 的调用还须同 provider/model/method/path/input digest；原引用最多消费一次。任何其他未知效果或外来 pending run 都阻断；原 effect/replay policy、快照、已接受效果与账本不重写，新调用正常消耗请求额度，不退款。

新 Job 在 `runtime_knobs.gateway_model_retries` 冻结内核恢复许可，上限只见 [runtime knobs](../apps/scheduler/src/runtime-knobs.ts)，不新增用户配置。实际已准入恢复次数由原 `job_attempt_effects.intent_json.gateway_retry_of` 跨 token/Attempt 汇总；每次调用的 `recovery_policy_version` 标明完整计数来源。缺许可、旧历史缺计数来源或耗尽明确拒绝，不因换 key、token、Attempt、重新配置或解析历史而补造额度。事务回滚不能留下仅计数/仅 effect 的半成品。Gateway HTTP 交换仍单次且原字节透明；恢复发生在显式 SDK 生成/准入边界，不借代理重放未知请求。

[SQL/HTTP/扩展回归](../apps/scheduler/src/gateway-model-recovery.integration.test.ts)接既有 `pnpm ci:integration:platform-api`；[SDK 边界回归](../packages/runtime-sandbox/src/pi-main-request-budget.test.ts)接 `pnpm ci:unit:runtime-sandbox`。包含真实闭端口→可信零用量→同 Job 模型生成成功、跨代际累计许可、重复/错 scope/未知/取消/期限及历史拒绝。SDK delegate 和上游是受控替身，不声称 native Pi 进程、真实 Provider、质量或容量；源码接线不等于通过，最终 SHA Actions 待验。本切片不新增 Claude/DSH 自动进程重启，未知效果仍走原受治理对账。

### #1036 D：原生 Pi 恢复链的离线回归

2026-11-09 新增[原生 RPC 夹具](../agent-harness/fixtures/pi-main-recovery-rpc.mjs)，接入既有 `pnpm ci:smoke:pi-rpc` 的 built-image 分支；核心 `runtime-images (base)` 的 `Pi RPC real Docker smoke` 在原生 amd64 执行，镜像缓存命中也不跳过。先验证镜像内 main policy 与当前 checkout 的完整 SHA，再原样物化其生成扩展，由固定 Pi 1.5.2 的真实 loader/SDK 调用 loopback。无 host SDK delegate、导入替换或关闭 Pi 原生 retry；容器沿用断网、只读根、受限资源与定向清理。

新增场景要求：同一存活 PID/Session 内 503 → 带原认证及精确请求 UUID 的 no-start 查询 → 新 UUID/原 retry-of → 唯一成功助手 message_start/message_end；再将测试 allowance 设为耗尽，下一轮不得新增模型 HTTP 请求。相同 503 正文在查询 unknown、错误 reason 或查询拒绝时都不能授权第二个模型请求；原 SDK 失败必须成为 CLI 的首个助手失败，allowance 查询次数必须等于首次请求加显式 `auto_retry_start` 次数，不能被后续 allowance 拒绝掩盖错误的内部恢复。输出仅保留版本/源码摘要、场景状态、计数和请求关联，不输出消息正文。

额外的测试用 mutation 对照在独立临时扩展副本中故意放宽 settlement HTTP/status/reason 校验，仍执行真实 Pi/SDK 与查询，并保留 unknown-usage allowance 拒绝；上述负例断言必须检出它。每次精确验证替换位置，报告单独标记 `settlement-acceptance-mutant`、扩展摘要及 `rejected-as-expected`。这不是生产扩展通过证据，不修改镜像内文件、不安装到生产，也不替代未改写扩展的原生场景。

本夹具的 Gateway/allowance/settlement 是受控 HTTP 服务，不是实际 Scheduler 账本证明，也不补造 Job/Attempt 或用量结算；原 SQL/HTTP 准入、跨代际预算、取消/撤权、重复引用与未知效果回归继续独立保留。源码接线不等于通过：最终 SHA Actions 待验，未执行本机测试或生产。失败/退出的 Job、Claude/DSH 自动重启及没有可信 usage 的历史记录仍保持原人工/对账边界，#1036 其余条款不据此关闭。

## 删除凭据与历史预算（#1002 P1-7A）

凭据删除仍拒绝未结束 Job、活动镜像扫描和任何项目配置引用，不替操作者清理白名单或选择替代账号。允许删除时，在原事务内撤销该凭据的全部 Gateway token，再删除秘密凭据；`job_tokens.credential_id` 由外键置空，只有 `revoked` 行允许没有凭据。历史 token 的身份、workload、已用请求/Token 数和有限上限继续保留，`job_usage_ledger` 的 token/Attempt/effect 引用及用量原样保留，Job 冻结快照不改写。既有 `revoked_job_token_count` 仍只统计本次从 active 撤销的行。

凭据详情的 impact 与独立 `/credentials/:id/impact` 返回 `usage_history.token_generations` / `ledger_entries`：包含全部状态的历史 token 生成和精确同 Job/项目的账本引用，按 actor 项目过滤；单个 token 的多条账本不重复计 token。无历史返回零，不暴露 token、账本内容或其他项目计数。只读计数不改变删除保护或历史保留。HTTP/PG 回归覆盖多账本引用、详情与独立入口、删除后的完整历史及项目隔离；项目隔离负例复用已接线的引用查询夹具 `ci:integration:credential-delete`，最终 SHA Actions 另验。

删除不是预算退款、效果结算或旧 Job 恢复授权：跨 token/Attempt 的历史有限额度继续参与准入，失去凭据的 token 不能恢复为活动状态；未知效果和历史缺损仍按原规则拒绝。schema 目标与非空库重建要求见[数据架构](architecture/08-data-architecture.md)。新增 HTTP/PG 回归接既有 `pnpm ci:integration:credential-delete`，精确旧基线重建、真实备份恢复接 `pnpm ci:unit:migrations`；本次未运行本地测试、数据库重建、构建或 typecheck，最终 SHA Actions 待验。

## 路径、方法与字节

`/gateway/` 后的原始路径和 query 传给绑定 base URL。唯一前缀规则是：请求路径已经等于完整 base path，或以完整 base path 加 `/` 开头时不再拼接；否则在前面添加该 base path。比如 base `/relay/v1` 与请求 `/messages` 得到 `/relay/v1/messages`，请求 `/relay/v1/messages` 保持不变；不猜测或删除版本段。重复 query、空值、百分号编码和点路径字节不经过 URL 路径规范化。目标 authority 只取服务器 base URL，不允许用户信息、绝对目标注入或重定向改目标。

注册 GET、HEAD、OPTIONS、POST、PUT、PATCH、DELETE。请求流先按 [body limit](../apps/scheduler/src/gateway.ts) 有界收全，再完成鉴权/模型/预算准入及原始 Buffer 转发；支持分块上传，但不是边收边发的无限流或全双工隧道。HEAD/GET 的合法 body 也不由 fetch 限制静默丢弃。非法 framing 明确拒绝；协议升级不支持，不能脱离 Job 取消和记账。

JSON（包括扩展字段）、非 JSON 和二进制转发字节不重建。压缩 JSON 只对观察副本进行有界解码，用于模型与预算校验；实际 Content-Encoding 和原始压缩字节保留。支持的观察编码及上限以策略源码为准，非法 JSON 可在不要求模型观测的普通请求中原样转发；受冻结模型或预算约束而无法观察时明确拒绝，不能绕过准入。OTLP 是单独的平台控制入口，不套用模型请求观测规则。Claude alias 在 [executor](../apps/scheduler/src/executor-real.ts) 的请求生成层映射到冻结上游 ID，不由代理改写 model。

## 头与认证

入站 raw header 对保留合法重复字段和未知端到端业务头，包括 User-Agent、Accept、版本/beta 与自定义标签。服务器默认值只补缺；同目标的凭据配置头高于协议默认，客户端头高于配置，真实认证最后由绑定凭据产生。目录发现和推理探测共用 [配置解析器](../apps/scheduler/src/provider-custom-headers.ts)；#921 的 endpoint/profile 关联不变，另一目标的配置头不得串用。

所有 Job token 认证载体在边界消费，不转给上游；重复认证字段明确拒绝，未知业务字段含入站 Job token 时也拒绝整次请求，不能借业务头外发短期凭据。Host 从绑定目标生成；逐跳头及 Connection 点名字段被消费，长度与实际字节核验，分块 framing 由当前连接重新生成。平台只消费源码列出的精确控制字段（包括 `x-deepsonar-request-id`），不保留整个 `x-*` 或协议前缀。配置中的非法 HTTP 名称/值、资源超限和大小写冲突明确拒绝，不以部分配置继续调用。

原始入站与最终出站 target 同时检查原文和一次百分号解码结果；非法百分号编码明确拒绝；按 octet 观察保留合法的非 UTF-8 URI 字节，不退回未解码原文，避免无关参数使 token 检查失效。该边界不宣称检测任意多重编码或业务自定义变换。

## Provider 配置绑定与旧 Job 出口（#918 联动）

目录发现只读取选定 provider 默认头；推理探测与 OM 使用授权 model 的生成前默认值。Pi 优先级为 provider → `modelOverrides[id].headers` → `models[].headers`，合法客户端业务头始终优先。局部 `modelOverrides`/custom models 是覆盖集合，不是完整模型白名单；已授权内置模型未命中时使用 provider 默认头。模型许可由独立冻结模型准入决定；重复模型定义、跨 endpoint 的 model override 明确拒绝。冻结层保留合法业务头（包括名称含 key/token 的未知头），消费精确认证/传输控制，原始值中的首尾 CR/LF 和同层大小写重复均拒绝；DSH 只接受锁定原生 profile 支持的 provider headers，不虚构 model 头接口。

新 Job 根快照的 `gateway_provider_binding` 保存版本、credential ID 与非秘密配置摘要，绑定 provider/CLI、目标、provider/model 配置和业务头。密文、认证值、健康状态与目录刷新不参与摘要。mint、allowance 与模型出站重新核对；仅 secret 轮换使用当前新 secret，业务头仍来自冻结默认与客户端原值。route/header/model 配置变化返回 `GATEWAY_PROVIDER_BINDING_CHANGED`，绝不把旧租户头发给新目标或静默替换客户端头。结算查询保留原 scope，不因配置变化丢失已发生效果的回执。

发布后所有缺少绑定、但还要 mint/query allowance/发送模型请求的旧 Job 都被拒绝，包括已有活动 token；历史归档和结算查询不做自动迁移。`resume-frozen` 身份比较纳入绑定，缺失或变化返回 `SNAPSHOT_STALE`，不回填旧快照或活动 Attempt。合法无效果的 failed/timeout/orphan Job 可先修复当前账号配置，再由有 `jobs:control` 权限的操作员使用 Job 详情“当前配置重跑”或 `POST /jobs/:id/rerun-current`：现有受治理路径重新解析配置，锁内关闭旧 Attempt/撤销旧 grant，并显式将 Job 的下一次执行快照置为当前配置；保留同 Job ID、历史 Attempt/usage/effect。活动 pending/claimed/provisioning/running 不支持原地 refreeze；cancelled 也不是该 API 的可恢复状态，不能建议“取消后直接重跑”。

**恢复联合阻塞（核对 2026-11-05）：** 既有 rerun 保留累计 token/ledger，有限模型余额与 pending/unknown 模型 usage 仍由原 Gateway 准入约束；但 `unknown agent_run` 可以被现有 rerun 再入队，旧修正 receipt 还可能触发 `REPAIR_ATTEMPT_CHANGED`，保存历史不等于安全重放。OM 请求次数上限已在本分支按历史有限值求交；main token allowance 的联合口径仍由 #903 核验。当前 `rerun-current` 解析快照未传入原 `piExtensionIds`、未重新物化完整 `runtime_knobs`；其真实恢复入口须由 #903 与创建期冻结规则统一。本分支已提供请求策略持久原语并接 Gateway；未签发 workload 的旧额度由恢复事务在替换快照前调用原语保存，#903 单 Job/批量接线及真实 OM 恢复链仍待联合验收。已经遗失旧策略且无可信回执的数据不从新配置反推。有未知效果或修正链历史的旧 Job 不得把此 API 当通用恢复出口，更不能删除 receipt、重置预算或新建 Job 规避约束；需 #903 的受治理证据对账与恢复决定闭合后验收。#928 仅新增绑定身份检查，不更改该生命周期策略。对应无效果旧 Job 拒绝→显式 refreeze 回归在 `job-rerun.integration.test.ts`，未知效果恢复不据此宣称通过。

## 响应与旁路记账

上游状态、端到端响应头、普通/错误正文和 SSE 数据按原始字节送达。3xx、429 和 5xx 不因代理重试或跟随跳转消失；未知事件不经业务解析后重组。收到头即刷新，写缓冲满则等 drain；客户端取消、deadline 与上游断流中止传输并保守结算，不把截断响应补成成功。

usage scanner 只观察副本，压缩响应仍按原压缩字节转发；无法完整观察、缺 terminal usage 或持久结算失败不能成为已知零成本。账本与已发生的外部效果不因客户端已收到数据而删除。Gateway 自身准入/无上游网络错误使用平台错误，已有上游响应保留上游语义。

绑定真实 key 在上游响应头/trailer 回显时中止；原始响应 body 通过跨 chunk 前缀观察阻断明文 key 回显。gzip、deflate、br 响应在转发每段压缩字节前通过独立解码观察检查回显，原压缩字节不替换；解码超限、非法或不支持的 Content-Encoding 明确断流，限制以 [响应守卫](../apps/scheduler/src/gateway-response-guard.ts) 为准。该检查不代表任意业务自定义编码/变换后的秘密检测。透明内容与秘密回显之间的安全例外必须如实记录，不能把原字节透传承诺扩张为放行已识别凭据。

## 预算与 OM 迁移

请求次数按 Job 跨 token/Attempt 累计，普通 main 与 OM 均适用。首次铸造通过 [请求策略原语](../apps/scheduler/src/gateway-request-policy.ts)将完整 total/main/background 上限写为内核 `control_receipt`（operation=`gateway_request_budget`），包括尚未签发 token 的 workload。后续策略只可追加收紧，重复 ensure 幂等；allowance 查询和每次出站准入结合回执及所有历史 token（包括撤销、过期）的计数及有限上限；当前与历史 total/main/background 请求上限取各自正数最小值，0/未配置不能解除历史有限限制。普通 Job 已冻结的有限 `job_token_max_requests` 同时保留为 total/main 上限，后来启用 OM 也不能扩大旧 Job 总请求数；仅有 token 分量而无原始总额证据时不反推另一维预算。新一代 token 不刷新累计余额；并发请求在同一 Job 锁内重验，拒绝不增加请求计数、不创建模型 effect、不访问上游。token 用量与 pending/unknown effect 的门禁继续独立执行；该规则不授权重放未知效果或修改旧 Attempt/receipt。

`inspectGatewayRequestBudget` 只读；`ensureGatewayRequestBudget` 依赖调用方已持有 Job 锁并处于同一事务，本身不提供事务原子性。恢复先对整批完成只读预检，再以旧冻结快照 ensure，之后才能修改 Attempt、grant、快照或 pending；ensure 后失败必须 throw 回滚而不是 return 提交部分回执。新回执消费既有 control receipt 率限，幂等不收费，写入/率限失败均阻塞。冻结策略经 `frozenRuntimeKnobsFromSnapshot` 与 Pi 扩展契约验证，缺失/null/损坏返回 `GATEWAY_REQUEST_BUDGET_INVALID`；合法数字 0 才是无限。无策略回执且已有多次 Attempt 返回 `GATEWAY_REQUEST_BUDGET_HISTORY_MISSING`，不推测丢失策略。完整合法 OM 在显式总额度 0 下不含 request_budget 的形状沿用创建期 `freezeObservationalMemoryQuota` 契约。

若模型请求准入因上述策略无效或历史缺失而拒绝，Gateway 在已回滚、未建立模型 effect 的前提下，保存同 Job/Attempt/token/workload/request UUID 的 `gateway_admission` 回执，状态为 `policy_rejected`。受审 OM wrapper 只在认证 settlement 查询核验该回执后报告 `PI_OM_REQUEST_POLICY_INVALID` 或 `PI_OM_REQUEST_POLICY_HISTORY_MISSING` 硬失败；它不同于允许配额/瞬态降级的 `not_started`，不允许重试、native-compaction 软降级或清除任何历史 pending/unknown。回执缺失、写失败、错绑定、伪造正文仍保持 unknown/fail-closed。HTTP 409 的原有策略错误正文保持不变。

[输出预算](../apps/scheduler/src/gateway-transparent-policy.ts) 不再给已放行 body 补写或压低输出参数。受预算约束的调用者必须显式提供剩余额度内的输出上限，以及该协议要求的 terminal usage（例如 Chat SSE `stream_options.include_usage`）；否则出站前返回 `GATEWAY_OUTPUT_BUDGET_REQUIRED`。输入/缓存成本仍在响应后确认，累计熔断不等于精确调用前总成本上限。

`GET /gateway/_allowance` 接受当前有效的 main 或 observational_memory token 与活动 Attempt，返回 `{ remaining_tokens: null | number, policy_required: boolean }`，禁止缓存。查询在 Job 锁内读取原预算，不预留、不增加模型请求计数；main 取 Job 总量或 OM main-workload 额度与修正链余额的交集，后台保持自身额度。pending/unknown 拒绝；返回提示后最终出站仍须锁内重验，不能扩大授权。

主执行的 Pi、DSH、Claude start/resume 命令由显式[请求准入适配器](../packages/runtime-sandbox/src/model-request-policy.ts)包装，运行器上传自包含 Node 脚本，生命周期与 CLI 绑定。Scheduler 仅将运行时主 Provider 配置、DSH profile 与 env 的 endpoint 指向沙箱 loopback `http://127.0.0.1:38127/gateway`（核对基线 2026-11-05），不改冻结历史；OM 后台配置仍直连真实 Gateway。

该适配器收到已形成的模型 HTTP 请求后，只读取真实 Gateway allowance 并检查现有 cap/usage。合规请求保留原始 Buffer、摘要与签名头，包括大整数、未知字段、转义和空白。不合规则明确拒绝，不能自动修改任何已形成 body；参与模型/预算/usage 准入的重复键明确拒绝，未知业务重复键保留。有限额度下 opaque/压缩或不支持形状也明确拒绝。

### 锁定 CLI 的请求生成前入口与兼容限制

核对日期 2026-11-05；只读锁定包源码与官方文档，不代表真实 CLI/模型验收。新增合成回归接入 `ci:unit:runtime-sandbox`。

| CLI / 锁定版本 | 已接能力 | 边界 |
| --- | --- | --- |
| Pi `@earendil-works/pi-coding-agent` 1.5.2、pi-ai 1.5.2 | runtime-owned [扩展](../packages/runtime-sandbox/src/pi-main-request-budget.ts)通过正式 `registerProvider(provider,{api,streamSimple})`，在 SDK 构造请求前逐次读取 allowance，设置请求局部 `options.maxTokens` 与 `model.maxTokens`；由 SDK 生成 Chat usage。start/resume 均加载 | 不使用已有 payload 的 `before_provider_request`；显式不支持 streaming usage、Responses 最小输出不满足或 sampling 冲突则拒绝。非 adaptive Anthropic thinking 必须在额度及 SDK 上下文夹紧后仍至少有 2048 token，否则生成前拒绝，不关闭 thinking。Gateway 始终原字节重验。已新增锁定真实 SDK 到 loopback 上游的非 adaptive/adaptive 阈值回归，真实 Pi 进程加载链仍待验收 |
| Claude Code `@anthropic-ai/claude-code` 2.1.312 | start/resume 启动器先读取 allowance，再通过原生 `CLAUDE_CODE_MAX_OUTPUT_TOKENS` 与 `--settings` 设置正整数上限，保留更严格既有设置；零余额不启动 | 只保证启动时配置。stdin `update_environment_variables` 白名单不包含该变量；settings 热更新无逐请求同步屏障。用户已接受工具循环、压缩及子任务不逐请求自动适配余额；运行中余额不足时明确拒绝并提示，不修改已形成 body。managed settings 优先级更高，冲突由 Gateway 拒绝。启动读取与逐请求准入共用同一次有界 allowance 查询（15 秒预算，`JOB_TOKEN_USAGE_PENDING`／`REPAIR_USAGE_PENDING` 只重读该投影）；生成前上限只有一个推导入口 `claudeOutputCap`，只在 start/resume 边界重算。单进程内的工具循环、自动压缩与继承环境变量的子任务沿用该上限；余额已下降时由准入层本地零出站拒绝，不改写 body、不中途重启 CLI |
| DSH / dsh-llm / dsh-llm-pi-ai / dsh-agent-loop 0.2.2-rc.1、pi-ai 1.5.2 | 镜像构建期验证锁定 vendor bundle SHA256，生成独立 `deepsonar-index.js`，保留官方 apply/Config/消息/附件/签名/usage 转换；唯一 llm-pi-ai profile 条目指向该产物。共用 streamWithSnapshot 的 SDK 调用前读取 allowance 并使用与 Pi 相同的 SDK 输入政策 | 原包不改，运行时不安装或写包。导入时校验 artifact/helper/vendor 摘要及 SDK 版本；认证应用后的真实 provider 分派再次核对冻结目标与 token。prepared 主调用与 direct stream（compaction/子调用所用服务）走同一 adapter。预算内的调用按引用透传调用方消息/工具与原上限，只有超预算调用被夹到余额并显式要求 Chat usage（合成回归覆盖两种情形）；跨进程 resume 仍明确不支持；真实 Cordis/SDK 合成上游回归待 Actions |

锁定 Pi 源码证据：`dist/core/provider-composer.js` 的 provider streamSimple 分派、`dist/core/sdk.js` 的 modelRuntime；默认 auto/manual compaction 与 branch summary 经 `agent-session` 传同一 agent.streamFunction，因此在注册成功且仍为绑定 provider/model/API 时重查额度。外部扩展直接调用 SDK 不在该保证内。loader 的 jiti aliases/virtual modules 解析 compat import，不依赖 workspace 安装包；session_start 异常本身会被上游捕获，运行器检查扩展错误且 Gateway 保留最终准入。DSH：`dsh-agent-loop/lib/index.js:1191`、`dsh-compaction-basic/lib/index.js:323`、`dsh-llm-pi-ai/lib/index.js:1983`。Claude 原生包静态检查与[环境变量](https://code.claude.com/docs/en/env-vars)、[settings 优先级](https://code.claude.com/docs/en/settings)、[hooks](https://code.claude.com/docs/en/hooks)一致：静态 cap 不能冒充逐请求余额协商。Anthropic SSE 自带 usage，无需 OpenAI Chat 的 include_usage。

**已接受的 Claude 兼容限制（2026-11-06）：** 用户批准 Claude Code 2.1.312 保留 start/resume 的原生启动输出上限；运行中余额不足时明确拒绝并提示，不修改已形成 body，不要求逐请求自动适配。该范围决定不再阻塞发布，也不代表三 CLI 都能自动适应动态余额。支持边界的准确含义：受支持的动态适配点是 start 与每次 `--resume`（每次都用新查询的余额重算上限，例如合成回归中 1000→700 后恢复进程按 700 启动）；单个存活的 CLI 进程内没有可版本受控的逐请求注入点，要在进程内适配只能改写已形成 body 或中途重启重放，两者均不在该范围内，因此也不实现。DSH 的完整受治理 adapter 已接入；#903 恢复联合验收及最终 SHA Actions 仍须闭合。此决定不证明真实 Claude CLI 或真实模型测试通过，不能据此宣称 #923 全部验收完成。 `ci:unit:runtime-sandbox` 中的启动/恢复选项回归与静态 cap→余额下降合成 HTTP 回归分别验证生成前选项、合规原字节（含大整数）、不足额度和耗尽时本地 400 零出站；本地确定预算拒绝返回 `invalid_request_error`、`x-should-retry: false`，稳定标识位于 `error.code`，`error.message` 同时包含标识与行动说明，不修改上游错误正文。这些是合成适配器验收，不是实际 Claude 多轮进程验收。

另增 `ci:integration:claude-request-budget` 的[真实锁定 CLI 验收](../agent-harness/claude-request-budget-cli.test.ts)，由 Reverse 工作流在两种原生架构的当前 base 镜像构建后执行。运行器把编译后的用例与生产策略/输入编码结果放入只读夹具目录，整个测试（CLI、捕获代理、准入服务及假上游）在同一个 `--network none` 容器的 loopback 内执行；不挂载 Docker socket、不使用 host 网络，且用例断言没有非内部网络接口。它使用合成认证，核对 Claude 2.1.312 版本、启动输出上限、工具续轮后余额下降的零上游拒绝与 CLI 可见提示，并对照已准入请求的原始字节；不要求真实账号、不允许跳过替代通过。84da699 双架构已实际进入真实 CLI 工具循环：首请求到达合成上游，随后本地 409 被重复请求，120 秒超时，不能算提示可见或终态通过。84ac8a7 双架构已达到可见错误提示和原生错误终态（退出码 1、无信号），但三次请求与 sentinel 不匹配仍使专项失败。66c3e24 双架构进一步证明三次请求均为 stream，第二/第三 body 逐字节相同；非流式恢复假设已被否定。新增验收保留精确三次和一次上游，捕获受控兼容标记差分以确认具体原生分支，而非泛许重试：只接受锁定 CW/R6 两条单次路径中的一个，第二→第三请求恰好移除 `thinking-token-count-2026-05-13` 或 `mid-conversation-system-clear-at-2026-08-21`，另一标记及其余 beta 集合不变、SDK retry count 均0、body逐字节相同。具体命中分支仍待新 Actions 的header证据；不因body形状相似就宣称已确认。原生 `user.tool_use_result` 已证明 stdout 精确等于合成 sentinel、stderr 为空、未中断，后台/超时/输出持久化标志均未设置。模型侧126字节结果来自38字节 stdout 加完整 `total_tokens` reminder：锁定 CLI 默认15000000扣除合成 input=100/output=32后显示14999868；这是 CLI 提醒，不是 Gateway allowance。完整模板的 `SHA256(JSON.stringify(text))` 为 `66fda44db86f1e63c90083e07dc4d1ee76b4146ad47c6c289e4b02aeec382a5e`，与两架构日志一致。测试对原生 stdout 和完整模型侧模板分别严格比较，不以 is_error=false 或 contains 代替成功证明。原生错误 result 后关闭 stdin，并严格核对退出码 1、无终止信号（锁定 runHeadless 的错误退出契约）；在失败诊断中分别记录工具成功、提示可见与 result 布尔值。修复后的精确 SHA 尚待 Actions，不替代正式 Job/账本或恢复联合验收。

静态核对官方 Claude Code 2.1.312 包及 linux-x64 原生包（ELF SHA256 `4f4178ce41d83e23341ebfbaecdbcf8ea6bf7baea0690025abe49eeec3a5d01d`）：内置 SDK 与 CLI 外层均会重试未标记的 409，均识别 `x-should-retry: false`；CLI 可见文本提取 `error.message`，不提取独立 hint。只有本地已知预算拒绝采用上述不可重试协议，上游及 allowance 查询的状态/正文转发不变。显式配置 fallback model 的 CLI 仍可能形成另一请求，必须重新准入；当前专项未配置 fallback，不声称禁用了原生回退能力。

OM 在受审 wrapper 的请求生成层读取相同 allowance。wrapper 在生成请求前将 `options.maxTokens` 限制到该 allowance；Responses SDK 的最小输出值无法容纳时明确拒绝（当前 SDK 下限为 16，核对基线 2026-11-05）。pending/unknown 不允许协商下一次请求。此结果只是生成参数的提示，Gateway 出站前仍在 Job 锁内重核额度和冻结权限，竞态不能扩大 allowance。

OM 响应不再由 Gateway 缓冲后换成结算错误。受审 [wrapper](../agent-harness/pi-observational-memory-governed.ts) 为每次后台请求生成 UUID 放入 `x-deepsonar-request-id`；Gateway 消费该头并在原 effect intent 中登记。wrapper 收到模型终止结果后，必须从冻结 Gateway 的 `GET /gateway/_settlement/:id` 读取同 Job、当前 Attempt、同 token/workload 的持久状态，确认 settled 才提交该结果。pending 有界等待；unknown、查询不可用或超时硬失败。内核证明 never_started 的结果与普通 Provider 文案分离。读取回执不创建模型请求、不消耗新的模型请求配额、不授予跨 scope 权限。详见 [OM Gateway](PI_OBSERVATIONAL_MEMORY_GATEWAY.md) 和 [ADR 0017](architecture/adr/0017-transparent-gateway-settlement.md)。

配额拒绝及已回滚的 admission 数据库冲突耗尽，也必须有持久的宿主无外部效果回执才允许 OM 可见降级。[admission receipt helper](../apps/scheduler/src/gateway-admission-receipt.ts) 在确认未发上游、且失败 admission 已回滚后，另开事务复用 `events` 的 `control_receipt`：`operation=gateway_admission`、`authority=kernel`，按 Job/Attempt/token/workload/请求 UUID 绑定，复用事件限流与 dedup。它不创建模型 effect、不增加模型请求计数或 usage，不改 schema。查询同 scope 回执得到 `not_started` 才能按已知 quota/transient 降级；保存失败、缺失或不匹配保持 unknown。相同 UUID 不得重新发起上游请求。请求前 transport 的原 effect/零用量结算路径保持独立，不能与未准入回执混淆。

Reverse 工作流将 Claude、Pi/OM 和 Reverse/REA 分为三个独立原生双架构 job 矩阵；各自从同一 checkout 构建 base，不依赖另一专项通过后才启动。Claude 与 Pi/OM 各有独立结果摘要，Pi/OM 保留原有证据附件。最终 `reverse-runtime-acceptance` 汇总必须同时取得三组 success；失败、取消或未运行不能替代通过，未使用 continue-on-error。拆分后的精确 SHA 仍须经 Actions 验证。

## 验收范围

合成凭据、合成 Job token、隔离 PostgreSQL 和 loopback 假上游是本轮证据来源，不访问真实模型或生产。新增 [传输测试](../apps/scheduler/src/gateway-transparent-http.test.ts)、[端到端测试](../apps/scheduler/src/gateway-transparent.integration.test.ts)，并更新已有 provider、budget、OM 与 wrapper 回归；[主 CLI 请求准入测试](../packages/runtime-sandbox/src/model-request-policy.test.ts)验证适配器与 CLI 形状的合成请求，不能冒充实际三 CLI 运行证据；实际 Actions 接线以 [package scripts](../package.json) 和 [工作流](../.github/workflows/ci.yml) 为准。

验收分别核对直连/Gateway 请求字节与重复头/query、错误/重定向单次送达、SSE 首段/取消/背压、压缩/framing、凭据和 scope 负例、预算拒绝及持久结算查询。当前文档只记录实现和检查入口；通过/失败/未运行、精确 head 与检查链接由 PR 记录，历史 #918/#831 的通过结果不覆盖 #923。质量、成本收益及 SLA 保持 unknown。

[provider HTTP 集成](../apps/scheduler/src/gateway-provider-headers.integration.test.ts)分别改变路由、provider 头、model 头，要求旧 token 被拒且两个合成目标均无新增请求；另以相同目标和原始 body 对照指定业务头存在时成功、缺失时上游返回 429，并区分本地额度耗尽的 429 零出站。这只证明合成 fixture 的路由与透明错误行为，不证明现场 TPM/RPM 原因或问题已解决。

`ci:integration:om-provider-headers` 的[真实创建与 launch 专项](../agent-harness/opensandbox/om-provider-headers.e2e.ts)由 [Reverse 工作流](../.github/workflows/reverse-runtime.yml)的原生双架构环境执行，复用隔离 PostgreSQL、固定 OpenSandbox 和本提交构建的 base 镜像。镜像先推送至仅绑定 runner loopback 的临时 registry，校验 manifest 原始字节摘要及其 config ID 等于本地构建，再按真实 repository@manifest-digest 拉取并核对 Docker RepoDigests；隔离目录记录该 manifest 引用，不把裸 config ID 当作 registry digest。临时 registry 随专项清理，不向外部通道发布。被测 Pi 子 Job 必须经 Hub `submit_hub_decision` Control API 正式创建、冻结并由 Dispatcher 启动，真实 Pi/OM 读取物化配置后通过实际 Gateway 向 loopback 合成上游发送所选 provider/model 头。凭据夹具先调用生产目录发现，向同一合成上游执行 provider 层头的 `/v1/models` 请求，另执行生产推理探测并断言所选 model 头后，才保存实际目录及健康结果并核对 Hub 可见目录；目录成功本身不算推理健康证据，两类前置请求与 main/OM 账本计数分开；settings 模型不替代准入目录，不开启 passthrough。创建请求保留原 event/idempotency key，失败时只读查询原事件、去重记录与子 Job，不换 key 重试。夹具只记录 bootstrap preflight/ingest 阶段及受控异常类别、code、字段路径，生产公开错误策略不变。Canvas/root 通过生产 `ensureCanvasForTask` 创建并核对冻结 Finding 协议，避免手写 Canvas 缺少 executor 前置字段；不回填活动快照。失败时先只读保存原 Job/Attempt/effect/token/event 的受控元数据及错误摘要，再清理资源；真实 runner/host 的 provision、ensureHost、upload、run、runAsync 仅增加完整委托的旁路阶段观察，不记录命令、环境或上传内容，runAsync 返回不代表 CLI 已初始化。CLI 启动另取原生流事件；未观察到不证明没启动。SQL 配置准备不替代被测 Job 创建，手工 SDK 请求与 boundary-unit double 不计入本专项证据。专项使用显式无限请求额度（0），检查 OM 无有限 request_budget、extension 与 runtime_profile/launch 中的 OM 配置一致且 profile 指纹匹配；有限 10/8/2 分配属于 #903 联合验收，不由此专项替代。专项逐请求对照合成响应的 input/output/total usage，显式核对账本、token、Attempt、effect 的 Job 归属。真实 `record_observations` 成功回执与当前会话原生 `recall` 的合成来源正文核验分开记录，报告不输出记忆或来源原文。锁定 OM 的 recall 模型可见结果只有来源正文，不含 observation 原文或显式来源 ID；专项不宣称独立读取持久 observation 原文或证明跨进程重启持久性，也不扩大平台 Session 导出的脱敏边界。新增入口的工程证据归属下述 main 验收基线；创建链也不替代 #903 的跨 Attempt 恢复联合验收。

端到端回归另外对照不受模型观测限制的无效 JSON 原始字节，并检查业务头/body 携带 Job token 时出站前拒绝、响应头回显绑定 key 时断开，以及跨 chunk 明文 key 回显不完整送达。慢消费者用例证明字节完整性，不证明进程内存上界；gzip/deflate/br 的回显防护由响应守卫及相关合成回归覆盖范围单独核对，任意业务编码/变换后的 key 回显不在保证内。本地未执行测试；Actions 工程证据见下述 main 验收基线。

### DSH vendor 产物与 SDK 验收

[构建器](../agent-harness/dsh-request-budget-install.mjs)只生成同目录独立产物，不修改 npm 安装的官方 bundle；原源码摘要或唯一补丁点不匹配即构建失败。[helper](../packages/runtime-sandbox/src/dsh-request-budget.ts)共享 Pi 的 SDK 生成前政策，不使用 onPayload 修复参数。两类官方 runtime Dockerfile 均执行生成器，三个基础镜像 fingerprint 包含生成器与政策源码；旧镜像缺少产物时不能回退到无预算 hook 的 provider。

`ci:integration:request-budget-sdk` 从现有 dsh-runtime lockfile 安装固定依赖，运行[真实 Pi SDK 阈值回归](../agent-harness/pi-main-budget-sdk-regression.test.ts)与[真实 DSH LlmRuntime/adapter 回归](../agent-harness/dsh-request-budget-sdk.mjs)。后者覆盖 prepared 与 direct 公共服务调用、逐次额度下降、usage、耗尽和身份拒绝，全部使用合成凭据及 loopback；不是生产模型或真实 DSH CLI 启动验收。本地未执行测试；Actions 工程证据见下述 main 验收基线，后续 SHA 另验。

同一 Actions 命令另外运行[真实 DSH CLI 回归](../agent-harness/dsh-request-budget-cli.mjs)，直接调用生产 `buildDshProfilePatch` 并仅重定位固定 vendor 产物的安装路径。用原生 SDK RPC 驱动工具续轮、多轮余额下降、context-overflow 触发的压缩恢复和实际 subagent，并逐项断言主工具续轮、压缩摘要与子会话接收到的输入/输出/总用量数值；shutdown 清理检查等待中的 allowance 连接关闭、没有模型出站；仅先于进程 close 事件关闭连接不能排除 OS 退出的影响，不证明存活进程内主动 abort 或 SDK 取消信号已被执行。锁定 RPC 没有独立 `session/cancel`，不能把 shutdown 验收表述为会话级取消或跨进程 resume 支持。这些入口的工程证据见下述 main 验收基线；不能仅由 SDK 层通过推断 CLI 全路径通过，后续 SHA 另验。


### Pi 原生模型覆盖与配置头对照

`ci:integration:provider-headers-sdk` 使用独立测试 lockfile 的 Pi coding-agent/pi-ai 1.5.2，通过真实 ModelRuntime、ModelRegistry、内置 catalog 和 SDK 到 loopback 上游对照配置头；不改变生产 DSH 依赖。覆盖单个 override 仍保留其他内置模型、追加 custom model 后内置模型可调用、provider/override/definition 优先级，以及独立 Gateway 冻结模型 guard 对未授权模型的拒绝。测试源码为[原生对照回归](../agent-harness/pi-provider-headers-sdk-regression.test.ts)，已接入核心 Actions，新增行为的工程证据归属下述 main 验收基线。配置解析器负责生成默认值，不以局部覆盖集合取代模型授权。

2026-11-06 工程证据：发布协调者已验收 main `616d7a3651c0e0b89d9457f4f435c02f51f8561b` 的核心与五项专项 Actions 日志，链接集中见[发布基线](RELEASE_RUNTIME_IMAGES.md#v0615-集成证据与升级边界)。后续提交仍须独立检查，不证明正式发布、生产或真实模型结果。
