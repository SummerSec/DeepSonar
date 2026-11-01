# pi-observational-memory 集成

> 状态：A/B/C 实现、定向回归及本地构建镜像内真实 RPC/生产启动守卫正负例已验证；最终组合 CI、发布证据和收益评估分别保留。
> 同步日期：2026-10-31

## 范围

DeepSonar 将 `pi-observational-memory` 作为可选的、已准入 Pi 扩展接入。新 Job 默认不启用。只有当前 Job 的 Hub 能力组合显式声明 `pi-observational-memory` 时，Scheduler 才会把它写入 Job 快照并生成扩展 stub。

扩展版本固定为 `3.1.4`，许可证为 MIT，npm 入口固定为 `src/index.ts`，完整 tarball 的 SHA-512 integrity 固定在 shared registry、runtime image inventory 和两个 Agent Dockerfile 中。Job 运行时不下载 npm 包。

构建先核对 registry integrity，再用 `--ignore-scripts --save-exact` 安装，并核对 npm 实际验证的 lock integrity、canonical tarball URL、安装包名称/版本/MIT 许可证和入口文件。metadata 查询本身不能证明随后安装了同一发布物。未使用 peer override。

## 镜像与加载路径

Agent 镜像预装包到 `/opt/deepsonar/pi-extensions/node_modules/pi-observational-memory`，并把仓库内受审 wrapper 复制到：

`/opt/deepsonar/pi-extensions/deepsonar-observational-memory.ts`

wrapper 的接口是 `createGovernedObservationalMemoryExtension(frozenConfig)`。它加载第三方包的 `src/index.ts`，但第三方 tarball integrity 不覆盖 wrapper；wrapper 的来源路径和 SHA-256 会进入 tool manifest，并进入 base、audit、Kali image fingerprint。

Scheduler 生成的 Job 文件只导入 wrapper factory，并把 Zod 校验过的冻结配置作为字面量传入。Pi 仍以 `--no-extensions` 加显式 `-e` stub 启动。本地 `image.mjs` 直接物化仓库中读取的 wrapper 字节，不假定容器中存在仓库路径。

镜像 key 兼容只表示候选，不证明旧 digest 含有 OM。新 Job 的 OM 专属版本下限以 [Pi registry](../packages/shared-types/src/pi-extensions.ts) 为准；[Scheduler loader](../apps/scheduler/src/pi-extensions.ts) 从快照调用方选定的 `runtimeImage.image_version` 校验，缺失、非法或旧 metadata 均拒绝，非 OM/全局下限与历史冻结快照不变。独立生产守卫在 Pi 启动/恢复及首个 prompt 前检查 installed package/entry/wrapper。本地实际构建镜像的内容预检、真实 RPC 和缺包/缺 wrapper Docker 拒绝均已通过，集中证据见 [RPC 专题](PI_OBSERVATIONAL_MEMORY_RPC.md#2026-10-31-主线程-built-image-验收)；本次不改变产品 release 目标。

## 网络与模型边界

OM 注册项为 `requires_egress: false`、`requires_gateway: true`。这表示扩展没有业务出网权限，但所有 observer、reflector、dropper 和 recall 所需的模型请求仍只能使用 Scheduler Model Gateway。Gateway 不可用时物化或启动拒绝，不静默切换到直连 Provider 或本地默认模型。

Job 快照冻结当前已授权的 Provider、model、thinking level、阈值、observer chunk、compaction 模式、memory pool、worker turns/tokens，以及 `passive=false`、`showWorkerNotifications=false`、`debugLog=false`。RoleConfig、Provider settings 和用户 Job payload 不能写入或覆盖 `observational-memory` 配置。

`model.provider` 使用 Scheduler 的 OM Gateway provider 别名；`source_provider` 和 `source_model` 仅记录当前 Job 解析出的授权来源。wrapper 只允许冻结的 OM provider/model，不能跨 Provider 或跨模型请求。

Runtime Profile 的严格 schema 同时核对 OM 的来源模型、Pi provider route 和已准入扩展的版本/integrity。Provider 物化只为该模型生成独立 Gateway alias，拒绝缺失模型、复用主 token 和不支持的协议；保留模型能力参数，移除 alias 继承的直连地址与自定义 headers。支持 `openai-responses`、`openai-completions`、`anthropic-messages`，后者保留 Gateway Bearer 认证要求。

## 请求配额

没有显式有限的 Job `job_token_max_requests` 时，配额保持 unlimited；不存在隐含的百分比或自动分配。有限总额必须同时提供平台环境变量：

- `DEEPSONAR_PI_OM_MAIN_MAX_REQUESTS`
- `DEEPSONAR_PI_OM_BACKGROUND_MAX_REQUESTS`

两者都是正整数，且和必须不大于冻结的 `job_token_max_requests`。生成的 `request_budget` 严格包含 `total_requests`、`main_requests`、`background_requests`，其中 `total_requests` 必须等于该冻结 Job 总额。缺失、格式错误、总额不匹配或分配超额都会拒绝 OM 激活。

可选的后台限制只接受平台环境变量 `DEEPSONAR_PI_OM_BACKGROUND_REQUEST_LIMIT` 和 `DEEPSONAR_PI_OM_BACKGROUND_TOKEN_LIMIT`。它们是非负整数；未提供或为零表示不增加有限限制。后台请求上限不能超过 `background_requests` 分配。上述字段不是 Agent、RoleConfig 或用户 Job 的输入。

两个维度可以独立省略。为保持 B / C 已使用的 shared schema 不变，只提供一个维度时，另一个在冻结对象中写为数字 `0`。这不是自动分配请求额度。有限总额在 runtime knobs 解析后才写入新 Job；快照、Runtime Profile、launch specification 和 profile fingerprint 一起重建，不改写已准备或历史快照。

## 数据边界与失败语义

Memory 只属于一个冻结 Job/session 的上下文状态。它不产生 DeepSonar Fact、Evidence、Finding、验证结论或跨 Job memory。session ledger、观察、reflection 和 recall 结果不能被当作安全证据写入这些域。

只有已知 quota exhausted 或已知请求在上游启动前未开始的 transient failure（Gateway 返回 `gateway_transient` 且 `effect_status=not_started`）可以在已冻结预算内被 wrapper 记录为可见降级，并让 Pi 原生 compaction 继续承担兜底；provider 5xx/error prose 本身不是未开始证据。协议错误、权限错误、快照/完整性错误、`pending`/`unknown` external effect 必须保持硬失败，不能被 bounded fallback 吞掉或伪装成成功。

## 需求与文档归属

本片对应 `FR-JOB-009`、`FR-IMG-003`、`FR-CRED-002` / `003` / `004`、`NFR-SEC-004` 和 `CON-005` / `008` / `009`。已核对 `DESIGN.md` 的运行时快照、插件和镜像边界，以及 architecture 规格与 traceability 中对应归属；架构视图、可信内核和 ADR 的同步由主线程按本次证据完成。

## 本次验证

已执行并通过（2026-10-31）：

- canonical `3.1.4` tarball：实际 SHA-512 与交接 metadata 和镜像 inventory 一致；直接读取压缩包确认名称、版本、MIT 许可证和 `src/index.ts`，未安装或访问真实模型。
- `node agent-harness/runtime-manuals/generate-catalog.mjs`：14 个官方镜像、973 条目录项。
- `node agent-harness/test-runtime-manuals.mjs`：14 个镜像的手册覆盖；包含 governed wrapper。
- `node agent-harness/check-runtime-image-consistency.mjs`：canonical 安装身份的合法/非法用例、两个 Dockerfile 与本地定义一致、wrapper 字节物化、真实 manifest writer 的三个镜像 provenance/hash、wrapper 字节变化使 fingerprint 变化。
- `pi-extensions.test.ts`、`provider-settings.test.ts`、`agent-runtime-profile.test.ts`：58/58，通过；覆盖未知字段、模型/协议隔离、有限分配、独立省略的后台维度、快照不变及关闭 OM 时的行为。
- `runtime-adapters.test.ts` 中 `Pi RPC 固定启动参数、状态查询和精确 sessionFile 恢复`、`Pi 默认关闭扩展，受治理扩展才通过显式路径加载`：2/2，通过；使用 fake host，不构成真实 RPC 证明。
- wrapper 的 Runtime.js module identity、SDKHTTP 冒号/innerJSON 错误分类及 sticky hard-failure/degrade 守卫：22 项 wrapper tests 通过。
- `agent-harness/fixtures/pi-om-real-rpc.mjs` 的 host 分支保留独立标记；后续主线程已通过实际构建镜像的已安装 canonical Pi/OM、生产 wrapper 和独立启动守卫验收，场景、身份及分母集中见 [RPC 专题](PI_OBSERVATIONAL_MEMORY_RPC.md#2026-10-31-主线程-built-image-验收)。
- 历史 Session preview/download 脱敏：`session-memory.integration` 与 `evidence-session` 共 3 pass/0 skip，覆盖混合 CLI header、large canary、immutable bytes、traversal 和 native quote preservation；Pi header/manifest 选择在 preview truncate 与 download 前执行，projection bytes/SHA/Content-Digest 另报。
- Gateway OM budget unit + 真实 SQL/HTTP 已覆盖有限/不限预算、workload 归因、账本 settlement、pending/unknown 和终态撤销；后续内核已知请求前 transport 的持久零用量结算及 provider 防冒充回归也已通过，最新范围与分母见 [Gateway 专题](PI_OBSERVATIONAL_MEMORY_GATEWAY.md)。
- `packages/shared-types/src/pi-extensions.ts` 与 `agent-runtime-profile.ts` 的直接 TypeScript 严格检查通过；主线随后核验 S3 类型/runtime build、Scheduler/Web tsc 通过。
- A 片路径的 `git diff --check`：通过。

尚未通过或未执行：

- S3 类型/runtime build、Scheduler typecheck 和 Web tsc 已通过；这只证明类型/构建链路，不证明真实 S3 外部存储或生产部署验收。
- 最终当前 PR 远端 CI、最终 main CI 与发布通道/平台镜像、registry/catalog 证据仍未完成；本地 base 镜像验收不等于这些范围通过。
- `role-runtime-snapshot/ports.ts` 等非本片文件的全局接线仍由主线程统一核对；本片不改其代码或 schema。
- 质量收益、成本收益和容量/SLA 未评估；#819 的独立人工标签、family/asset 隔离 tuning/holdout 与预冻结阈值缺口另见[验收矩阵](TASK_DISPATCH_ACCEPTANCE.md)，不由镜像或 CI 结果豁免。
