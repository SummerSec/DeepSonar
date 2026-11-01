# 0013. Pi 观测内存的受治理条件准入

> 状态：**已采纳的条件准入决策；本地构建镜像运行与内容缺失拒绝已验，最终 CI/发布证据待完成**。当前根工作树的 canonical Pi/OM RPC、独立生产启动守卫、版本准入/适配器回归及 Gateway/Session 边界已有证据；详细身份、场景和分母集中见 [RPC 专题](../../PI_OBSERVATIONAL_MEMORY_RPC.md#2026-10-31-主线程-built-image-验收)。
> 决策日期：2026-10-31
> 同步日期：2026-10-31
> 来源：#815 A/B/C；实现核对基线为 2026-10-31 当前根代码与下方源码入口
> 关联需求：FR-CAP-009 / NFR-SEC-001

## 背景

Pi 已有受治理的扩展边界：扩展必须进入平台注册表并预装在准入镜像，Job 创建时冻结 package、version、integrity、entry、workspace path 和兼容镜像；运行时保持 `--no-extensions`，只注入显式 `-e` stub。当前根 registry 已含 `pi-web-access` 与 pinned `pi-observational-memory@3.1.4`。OM 会在 turn/compaction 后台发起 observer、reflector、dropper 或 catch-up 模型请求，并把 observation/reflection、recall 结果和压缩上下文带入 session/archive，因此它同时触及模型 Gateway、Job 用量、RPC 白名单、配置覆盖、秘密脱敏和镜像准入。

当前代码已注册 OM、冻结受治理配置并通过 wrapper/loader、Gateway workload、ledger 和 RPC/archive 边界接入；新 Job 默认不启用，必须由 Hub 能力组合显式 opt-in。安装宿主 Pi 1.4.0 + 临时固定 npm OM 3.1.4 已完成离线真实 RPC 场景，Session preview/download 脱敏与 Gateway SQL/HTTP 也有定向证据；这些都不证明已发布 digest 或 v0.6.2 镜像含有 OM，manifest key compatibility 也不能替代镜像内容核验。

## 当前实现状态

当前根代码已固定 npm `3.1.4`、`src/index.ts` 和核验 integrity，wrapper 位于 `/opt/deepsonar/pi-extensions/deepsonar-observational-memory.ts`；`requires_egress=false`、`requires_gateway=true`，OM 请求使用独立 `observational_memory` workload token 和冻结 Job model。私有 settings、`passive=false`、通知/debug 关闭、显式有限请求预算、pending/unknown 结算、终态撤销、bounded recall 和结构化 OM 输出脱敏已有代码边界。

新 Job 的 OM 准入按 Scheduler 选定的 `runtimeImage.image_version` 执行扩展专属下限，由 `freezePiExtensions` 第五参数传入；具体要求见 [registry](../../../packages/shared-types/src/pi-extensions.ts)，未提高其他运行时的全局下限。缺失、非法或旧版本均拒绝；已有冻结历史不重新按当前版本准入。运行时由 [pi-memory-image-guard](../../../packages/runtime-sandbox/src/pi-memory-image-guard.ts) 在启动/恢复 Pi RPC 及首个 prompt 前独立检查 installed package/entry/wrapper。版本/角色快照和适配器回归已通过；同一生产 guard JS 在实际本地构建镜像内的已安装、缺包、缺 wrapper 场景也已通过。

实际本地 base 镜像的封装预检、已安装 canonical Pi/OM 与生产 wrapper RPC、独立内容守卫正负例均有直接证据，集中见 [RPC 专题](../../PI_OBSERVATIONAL_MEMORY_RPC.md#2026-10-31-主线程-built-image-验收)。历史 Session 脱敏及 Gateway 已知请求前 transport 的持久零用量结算/防冒充也已验证，见 [Gateway 专题](../../PI_OBSERVATIONAL_MEMORY_GATEWAY.md)。当前 PR/最终 main CI 和发布通道/平台、registry/catalog 仍待验，质量与成本收益保持 `unknown`。本节是实现状态，不替代下方已采纳的条件准入决策。

## 决策

### 1. 固定发布物和完整接口面

准入对象必须是可追溯的 canonical 发布物，而不是源码分支或 mutable tag。当前候选核验值为 npm `pi-observational-memory@3.1.4`、entry `src/index.ts`、integrity：

```text
sha512-jgQbFyLMs4wWhkf6F0voOgzMwtIXsb8+ks0MsPKpPxkdpyMX5E/el6Mk/vJ40m8GlKwBIsCKjL1r7Z2U8dCtmA==
```

注册前还必须单独 fingerprint wrapper，并逐版核对 tarball 的 `pi.extensions`、实际 entry、工具名/schema、hooks、配置键和宿主导入 API。只核 package manifest、entry 或 manifest key 都不足以准入。固定 npm 值是候选证据，不是当前镜像内容证明。

### 2. Job/session opt-in 和配置隔离

OM 只能在显式 opt-in 的冻结 Job/current-session 中启用。扩展与 wrapper 预装在已准入镜像，Job snapshot 冻结版本、integrity、entry、配置和模型路由；项目 `.pi` 配置、全局/项目 settings、相关环境变量、任务文本和 Agent 提案不能覆盖受治理配置。不得创建跨 Job memory 读取或持久经验推荐路径。

`requires_egress` 与 `requires_gateway` 是两个正交字段：前者表示扩展自身的业务出网，后者表示扩展会产生模型请求。当前 OM 注册为 `requires_egress=false`、`requires_gateway=true`，并由 wrapper/Gateway 守卫执行；这两个字段仍必须在 Job snapshot 和启动时分别校验。

### 3. Gateway、模型和凭据边界

observer、reflector、dropper、fallback、compaction catch-up 和 retry 的每次模型请求都必须经过 Scheduler-owned Model Gateway。route/provider/model 取冻结 Job snapshot；首版只允许冻结 model，不增加扩展独立模型权限。Gateway workload credential 必须由可信内核签发、单独标识 workload，并在 Job 终态撤销；沙箱或扩展自报来源、模型和 header 不能改变归因或授权。

### 4. 显式预算与严格结算

管理员配置有限额度时，协议必须显式表达 `total_requests`、`main_requests` 和 `background_requests`，禁止百分比分配、隐式预留或沿用上游默认值。请求总额、token usage、memory usage 和成本是不同维度；它们分别记账并可对账，不能互相替代。并发占额在可信 Gateway/Job 锁内原子完成；失败、取消、pending、unknown 和未知外部效果按真实效果处理，不按零返还，不自动重放未知效果。Job 终态必须撤销所有关联 workload credential。

已知 quota exhausted 或已知 worker 尚未启动可以可见降级（例如跳过本轮 observe/reflect 并记录原因），但不得伪装成功或拖垮主任务。权限、协议、integrity、snapshot 和 unknown external effect 错误必须硬失败或进入受治理人工路径。

### 5. 数据出口和 authority

wrapper 必须在私有配置和输出边界上收紧发布物行为。recall 采用有界读取；session/raw archive 在持久化前执行结构化过滤和秘密脱敏，并分别约束 RPC 大帧落盘副本与事件预览。dropper 移出 active memory 不等于撤销读取权限或历史擦除；本 ADR 不承诺历史副本擦除。

观测内存是上下文治理产物，不是 Fact、Evidence、Artifact、Finding、Verify 或报告的 authority。memory 内容不得投影为业务事实、质量指标、程序资格或跨 Job 知识；物理 session archive 的存在也不改变该语义。

## 当前状态与启用门禁

当前 checkout 的实现与本地镜像运行证据见上节及 [RPC 专题](../../PI_OBSERVATIONAL_MEMORY_RPC.md#2026-10-31-主线程-built-image-验收)。生产内容守卫与封装预检独立，已实际验证内容缺失时在 Pi 启动前拒绝；这不是仅以 helper 单元负例推定拒绝。最终组合 CI 与发布证据未完成，质量与成本收益保持 `unknown`。

启用前必须取得逐项证据：

1. canonical 发布物来源、tarball integrity、entry/interface 面和独立 wrapper fingerprint；
2. Job/session snapshot、private-config guards、Gateway-only route/model、内核 workload credential、独立归因、显式预算和终态撤销；
3. quota/内核确认 known-never-started transport 可见降级，以及 protocol/permission/unknown effect/integrity/snapshot 硬失败；
4. bounded recall、raw archive 和 RPC 大帧的结构化过滤/脱敏；
5. built image/旧镜像 image acceptance、完整 runtime 证据，以及与当前根代码绑定的最终组合 CI；本地 base 镜像 RPC、独立生产 guard、版本准入、Session 脱敏及 Gateway SQL/HTTP 已分别留证，最终组合 CI 与发布通道/平台证据待完成。外部 S3 存储未实测，不作为本批工程 CI 收口的生产执行前置。

本地构建镜像的真实插件与内容守卫已验收，不能扩张为全部上述门禁或完整发布通过；新 Job 默认不启用。旧 released digest 和 v0.6.2 镜像不能由兼容 key 推断含 OM。

## 后果与替代方案

- 正面：后台模型调用、额度、身份、配置和 session 多出口都落在现有 Scheduler/Gateway/Attempt/evidence 边界内，memory 不会获得事实或执行 authority。
- 代价：需要发布物与 wrapper 双重指纹、独立 workload 账本、配置隔离、归档脱敏和真实 RPC/image 验收；已知的后台降级必须可观测。
- 不采用把 OM 标为 `requires_egress=false` 以绕过检查：它不能证明模型请求只经获准 Gateway，也不能证明冻结模型和归因。
- 不采用静默无 OM 降级：同一 snapshot 会因网络或权限策略产生不可审计的行为差异；只有显式、可见且有界的已知 quota 或内核确认 never-started transport 降级可接受。
- 不采用把 recall/session memory 直接接入 Fact/Evidence 或跨 Job 项目 Memory：这会混淆上下文治理与事实 authority，需另行架构决策。

## 验证入口

Pi registry/freeze/materialization 见 [`pi-extensions.ts`](../../../packages/shared-types/src/pi-extensions.ts) 与 [`apps/scheduler/src/pi-extensions.ts`](../../../apps/scheduler/src/pi-extensions.ts)；Gateway 预算与账本见 [`PI_OBSERVATIONAL_MEMORY_GATEWAY.md`](../../PI_OBSERVATIONAL_MEMORY_GATEWAY.md)，RPC/归档边界见 [`PI_OBSERVATIONAL_MEMORY_RPC.md`](../../PI_OBSERVATIONAL_MEMORY_RPC.md)、[`pi-rpc-output.ts`](../../../packages/runtime-sandbox/src/pi-rpc-output.ts) 和 [`cli-session-adapters.ts`](../../../packages/runtime-sandbox/src/cli-session-adapters.ts)。设计取舍和未验证项见 [`PI_OBSERVATIONAL_MEMORY.md`](../../PI_OBSERVATIONAL_MEMORY.md) 与 [`PI_OBSERVATIONAL_MEMORY_DECISIONS.md`](../../PI_OBSERVATIONAL_MEMORY_DECISIONS.md)。

本 ADR 记录准入边界与当前实现状态，不把未执行的本地、镜像、RPC、模型或生产测试写成通过；没有独立效果/成本证据时保持收益 unknown，不由本 ADR 新增生产或真实模型验收前置。#819 的人工标签/隔离留出/预冻结阈值要求仍按其自身质量门执行。
