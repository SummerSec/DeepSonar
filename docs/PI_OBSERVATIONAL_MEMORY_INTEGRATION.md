# pi-observational-memory 集成

> 状态：A 片实现与离线验证；完整 #815 验收仍由主线程整合，真实 Docker / RPC / 模型执行不在本片验证结论内。
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

镜像 key 兼容只表示候选，不证明旧 digest 含有 OM。本片不抬高平台最小镜像版本；包或 wrapper 缺失时，固定绝对路径导入必须拒绝加载。旧镜像的真实启动拒绝、manifest 准入和完整 RPC 传播仍须在主线程 / C 片验收，静态门禁不能代替这项证据。

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

预期的后台 transient failure 可以在已冻结预算内被 wrapper 记录为可见降级，并让 Pi 原生 compaction 继续承担兜底。协议错误、权限错误、快照/完整性错误和 unknown external effect 必须保持硬失败，不能被 bounded fallback 吞掉或伪装成成功。

## 需求与文档归属

本片对应 `FR-JOB-009`、`FR-IMG-003`、`FR-CRED-002` / `003` / `004`、`NFR-SEC-004` 和 `CON-005` / `008` / `009`。已核对 `DESIGN.md` 的运行时快照、插件和镜像边界，以及 architecture 规格与 traceability 中对应归属。按本次分工，仅更新本专题；DESIGN、架构视图、traceability 和文档索引由主线程整合，不在 A 片修改。

## 本次验证

已执行并通过：

- canonical `3.1.4` tarball：实际 SHA-512 与交接 metadata 和镜像 inventory 一致；直接读取压缩包确认名称、版本、MIT 许可证和 `src/index.ts`，未安装或访问真实模型。
- `node agent-harness/runtime-manuals/generate-catalog.mjs`：14 个官方镜像、973 条目录项。
- `node agent-harness/test-runtime-manuals.mjs`：14 个镜像的手册覆盖；包含 governed wrapper。
- `node agent-harness/check-runtime-image-consistency.mjs`：canonical 安装身份的合法/非法用例、两个 Dockerfile 与本地定义一致、wrapper 字节物化、真实 manifest writer 的三个镜像 provenance/hash、wrapper 字节变化使 fingerprint 变化。
- `pi-extensions.test.ts`、`provider-settings.test.ts`、`agent-runtime-profile.test.ts`：58/58，通过；覆盖未知字段、模型/协议隔离、有限分配、独立省略的后台维度、快照不变及关闭 OM 时的行为。
- `runtime-adapters.test.ts` 中 `Pi RPC 固定启动参数、状态查询和精确 sessionFile 恢复`、`Pi 默认关闭扩展，受治理扩展才通过显式路径加载`：2/2，通过；使用 fake host，不构成真实 RPC 证明。
- 仅对 `packages/shared-types/src/pi-extensions.ts` 与 `agent-runtime-profile.ts` 执行直接 TypeScript 严格检查：通过。
- A 片路径的 `git diff --check`：通过。

尚未通过或未执行：

- 常规 shared-types 构建返回 15 条既有全局声明错误：`device.ts:158/172/180/187/188/204/224/236` 缺少 `btoa` / `atob` / `TextEncoder` / `TextDecoder` / `CryptoKey` / `crypto`，以及 `index.ts:200`、`project-knowledge.ts:7`、`repair-feedback.ts:84`、`task-contract.ts:43`、`task-goal-review.ts:49`、`task-outcome.ts:8`、`task-result.ts:22` 缺少 `TextEncoder`。已生成供离线测试使用的 dist，但不能把构建退出码 2 记作通过。
- 常规 runtime-sandbox 构建同样受声明缺失阻断（160 条诊断；包括 `agent-runtime-profile-adapters.ts:31` 的 `structuredClone` 和 `compose-network-topology.test.ts:13` 的 `node:path`）。Scheduler 常规 typecheck 也未通过。未修改依赖、锁文件或全局 TS 配置消除这些错误。
- `role-runtime-snapshot.test.ts` 和 characterization suite 在 import 时缺少 `@smithy/types/dist-cjs/index.js`。新增的 Job 持久化测试因此未执行；它使用假事务，不访问任何数据库。
- `role-runtime-snapshot/ports.ts:92` 的静态 `pi_extensions` 形状仍缺少 `requires_gateway` 与 `observational_memory`；该文件不在 A 片所有权内，留主线程统一类型。本片读取快照时仍走严格 parser。
- Docker 构建、真实 Pi RPC、旧镜像启动拒绝、SQL 集成、真实模型、Release 和部署未执行。完整 CI 与全局文档/文件体量门禁留主线程执行；未做仓库全量扫描。
