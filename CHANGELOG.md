# Changelog

发布条目依据已验证的 Git tag 与仓库变更维护，后续新增发布条目统一使用中文。不可变的 `vX.Y.Z` Git tag 是产品发布版本；根目录与 workspace package 的版本仅为私有内部元数据（`0.1.11`），不是发布标识。

## [Unreleased]

## [0.4.0] - 2026-09-13

### 新增

- 真实设备接入 Phase 1（#494 / #495）：沙箱不直连物理设备，新增 device broker（独立服务，跑在可抛弃的 device rig 上）把物理设备暴露为可租借网络端点。Scheduler 在 provision 前申请**设备租约**（绑 Attempt、短期 token、TTL 过期可回收），把端点与 `ANDROID_ADB_SERVER_ADDRESS` / `ANDROID_ADB_SERVER_PORT` / `ANDROID_SERIAL` 注入沙箱，沙箱内 `adb devices` / `adb shell` 免改脚本可用。新增 `devices` / `device_leases` / `device_events` 三表与「一设备同刻最多一个未结束租约」的部分唯一索引（schema v49）；项目级 opt-in（`PATCH /projects/:id/settings` 的 `device_access_enabled`）+ 任务级 `device` 需求冻结进 Job 快照（按角色命中才占设备，Hub/report/verify 不占）；稳定错误码 `device_not_available`（可重试）/ `device_not_authorized`（不可重试）。设计见 `docs/DEVICE_ACCESS.md`。
- OpenAPI 覆盖补齐（#492）：`GET /openapi.json` 从 150 个 operation 补到 184 个，新增平台导入导出整族、Finding 评论/关联、任务归档/硬删除/活动 Job 批量取消、画布收敛控制、用户管理、`POST /runtime-images/registry/apply`、`POST /auth/ws-ticket`；并加上「已注册路由 ⊆ OpenAPI ∪ 显式内部清单」与「operation 的 `x-deepsonar-scope` 必须等于强制 scope」两条断言，防止再次漂移。`GET /schema.md` 在仓库契约不可用时回退为运行时端点摘要，不再返回 404 占位。

### 变更

- Credential 连接测试改判推理路径（#491）：`POST /credentials/:id/test` 先按 vendor 口径做最小推理调用（`POST /v1/chat/completions`，Anthropic 为 `POST /v1/messages`，`max_tokens=8`），`2xx` 与 `400` 视为账号可用，只有推理路径 `401/403` 才是认证失败；模型目录路径的 `401/403/404/405` 记为 `unknown` 并单独文案。`/readiness` 的 `CREDENTIAL_TEST_FAILED` 只在权威 category 下判 error，探测路径限制降级为 warning，不再把可用的第三方中转判成不可用。响应新增 `probe_path` 标明结论来源。
- 补齐若干端点的强制 scope（#492）：`GET /canvases/:id/convergence` 为 `tasks:read`，`pause` / `resume` / `stop-after-gate` / `drain-priority` / `run-hub-now` 为 `jobs:control`（此前未登记，非 GET 落到默认 `admin`，operator 会话在 Web UI 上会 403）；`POST /auth/logout` 登记为 `projects:read`（此前落到默认 `admin`，operator/viewer 无法注销）；`/metrics` 与 `/auth/me` 的文档 scope 对齐为任意已认证主体。

### 修复

- 统一输入校验与错误契约（#490）：非法 `limit` / `period` / `project_id` / `canvas_id` 一律返回 `400`（`invalid_payload` / `INVALID_ID` / `USAGE_PERIOD_INVALID`），不再静默按缺省范围返回另一个结果集；共享资产端点改用 `invalid_payload` 信封，不再回显原始 Zod issue 与 `x-asset-labels` 解析原文；终止 Job 的 cancel/priority 与归档任务的 retry/resume 补稳定 `error_code`（`JOB_NOT_CANCELLABLE` / `PRIORITY_FIXED` / `TASK_ARCHIVED`）。
- 管理端点不再把非 UUID 路径/查询参数交给 Postgres（#489）：`GET|PATCH /projects/:id`、`/credentials/:id`、`/skill-sources/:id`、`/runtime-images/:id` 等返回 `400` 与稳定 `error_code`，不回显 `22P02` 等数据库细节。
- 文档与实现对齐（#492）：`skills/deepsonar-management/references/api.md` 增加「OpenAPI 覆盖边界」与收敛控制条目，修正错误契约描述与若干表格渲染。

### 部署 / 升级说明

- **需要重建数据库**：schema v48 → v49（新增 `devices` / `device_leases` / `device_events`）。用 `pnpm db:rebuild -- --plan` / `--apply` 备份后按列交集回填；非空库版本或结构不符时 Scheduler fail closed，没有增量 ALTER 链。
- 设备接入**默认关闭**：未配置 `DEEPSONAR_DEVICE_*` 时设备需求 fail closed（`device_not_authorized`），既有项目与任务行为不变。启用需在 device rig 上部署 broker（`deploy/docker-compose.device-broker.yml` + `deploy/Dockerfile.device-broker`），配置 `DEEPSONAR_DEVICE_ENABLED` / `DEEPSONAR_DEVICE_BROKER_URL` / `DEEPSONAR_DEVICE_BROKER_TOKEN` / `DEEPSONAR_DEVICE_LEASE_SECRET`，并为项目打开 `device_access_enabled`；见 `.env.example` 与 `docs/DEVICE_ACCESS.md`。
- 本版本未改官方 Agent Dockerfile；Release 若指纹未变会走 `src-<fingerprint>` 跳过 docker build。平台镜像仍打 `0.4.0` tag。

## [0.3.3] - 2026-09-12

### 新增

- 项目报告页 Phase 1：统一交付物投影（#484 / #486）。从按任务默认展开的折叠列表改为交付物优先：任务总报告与 Finding 独立报告统一为 `ReportDeliverable`，状态映射为可阅读 / 生成中 / 失败 / 尚未生成 / 已过时；默认排序为失败 → 尚未生成 → 生成中 → 新近可阅读 → 已过时；任务仅作折叠上下文。不改报告实体、版本、下载接口和后端状态机。

### 变更

- 控制台品牌标与 favicon 改为紧凑鲸形剪影加高能声呐脉冲路径，并与蓝紫 / 白色视觉系统对齐（#487）。

### 修复

- RoleConfig 路径参数在进 SQL 前校验 UUID：`PUT /role-configs/global/:roleId` 等不再把 `explore` 这类角色名交给 Postgres；返回 `400` 与稳定 `error_code`（`INVALID_ROLE_ID` / `INVALID_ROLE_CONFIG_ID` / `INVALID_ID`），不回显数据库错误（#478 / #480）。
- 管理 API 全局将 `ZodError` 与 Fastify `FST_ERR_VALIDATION` 映射为 `400`：`error_code=invalid_payload`，人类可读 `error`，可选 `issues` 只含字段 `path` 与稳定 `code`；不回显堆栈、正则或枚举全集。已单独 catch 成 400 的路由保持原 `error_code`（#477 / #481）。
- Pi 真实 Job 冻结已认证 `models.json` 路由到 `pi_provider`，adapter 传 `--provider <route> --model <id>`，避免 `grok-4.6` 这类裸 id 在 Pi 内置多 provider 目录中歧义后 provision 才失败。无法唯一确定时在快照解析 / claim 启动以 `PI_MODEL_UNAVAILABLE` 失败，不进入沙箱 provision（#479 / #483）。
- Pi `message_end` 在 `stopReason` 为 `error` / `aborted` 时保留上游 `errorMessage`（及同级回退字段），写入脱敏后的 Job 失败短尾与 `agent_settled.errorDetail`，不再只显示 `Pi message ended: error`（#482 / #485）。

### 部署 / 升级说明

- 无需重建数据库（仍为 schema v48）。
- 本版本未改官方 Agent Dockerfile；Release 若指纹未变会走 `src-<fingerprint>` 跳过 docker build。上一份 catalog 已有该 digest 时复用 version 行且不打新的运行时 version tag；若 src-cache digest 从未入册，仍发布 version tag 并由 inspect 补记，平台镜像仍打 `0.3.3` tag。

## [0.3.2] - 2026-09-12

### 变更

- 将 v0.3.1 亮色主题 id/名称从 `open-kritt` 更名为内部语义 `coral` / `珊瑚纸台`（#470 / #473）。读取旧 `localStorage` 值会迁移为 `coral`，之后只写入新 id；视觉 token 不变。

### 修复

- Pi 真实 Job 不再把 `deepsonar/<model>` 原样传给 `--model`：快照冻结 CLI 目录 id，adapter 映射已冻结的 provider 前缀；目录中不存在的模型在创建/解析快照时以 `PI_MODEL_UNAVAILABLE` 失败，而不是 Agent CLI 启动后才退出（#468 / #469）。
- 亮色主题把表格、筛选、列表选中/hover/focus、抽屉和命令面板迁到独立语义 token（`surface-selected` / `surface-hover` / `surface-control` 等），Finding / Job 选中行不再复用近黑背景（#471 / #474）。
- 亮色主题为加载骨架、空状态、移动端壳层、选择器/模块选择、角色与凭据配置、intent launch 与 task handoff 补齐 `surface-control` / `surface-hover` / `surface-selected` / `surface-disabled` 等语义 token，不再复用近黑十六进制表面（#472 / #475）。

### 部署 / 升级说明

- 无需重建数据库（仍为 schema v48）。
- 本版本未改官方 Agent Dockerfile；Release 若指纹未变会走 `src-<fingerprint>` 跳过 docker build。上一份 catalog 已有该 digest 时复用 version 行且不打新的运行时 version tag；若 src-cache digest 从未入册，仍发布 version tag 并由 inspect 补记，平台镜像仍打 `0.3.2` tag。

## [0.3.1] - 2026-09-12

### 新增

- AI-native 可信执行内核第一阶段：模型通过 Plan、Capability Pack、Artifact、Fact、Finding、Verify、Research 与 Report 组合工作，Scheduler 继续独占沙箱、权限、预算、幂等和副作用。
- 模型主导执行协议 Phase 1（#443 / #458）：`packages/shared-types` 增加版本化 `Plan` / `PlanTask` / `CompletionPolicy` / `PlanResult`。Job 控制 API 新增 `submit_plan` / `submit_plan_result`（`continue|complete|blocked|needs_human`），经既有 capability token 与事件事务落库。Scheduler 在 `jobs.payload_json.plan_protocol` 审计计划原文、裁剪结果、执行结果和终止原因。Hub 行为不变；每个 Intent 适配为一个 PlanTask。本阶段不派发 Worker，也不改收敛门。
- Artifact 成为内部写入真相（#444 / #455 Phase 1）：新增版本化 `artifacts` / `artifact_claims` / `artifact_evidence` / `artifact_relations`（schema v47）；`emit_fact` 接受可选通用 Artifact 输入；`emit_finding` 先落 Artifact，再投影 `findings` 作为缓存。Verify / Report / SARIF 仍走既有 Finding 路径。
- 质量指标与 Hub 回放基线（#445 / #456 Phase 1）：只读 `GET /dashboard/quality`、`GET /projects/:id/quality`、`GET /canvases/:id/quality` 从 Job / Finding / Verify / Usage Ledger 派生确认率、误报率、Verify 分歧率、人工介入率与单 Finding 成本；`GET …/quality/replay` 固定 `hub_replay` schema_version=1。项目级 token 必须匹配路径 `:id`，跨项目读 quality/replay 返回 `PROJECT_MISMATCH`。不改变 Hub 决策，不写入经验。
- RepairFeedback 协议脚手架（#446 / #453 Phase 1）：`packages/shared-types` 增加版本化 `RepairFeedback`（`model_correctable` / `transient_retryable` / `unknown_external_effect` / `permanent_failure`）。Control API 对 schema 截断/校验与 256 KiB 语义 payload 超限返回字段级 `repair`（expected / observed_shape / remaining_budget / next_action），不再只回 `Platform operation was rejected`。Handler `details` 只保留白名单字段，且不得覆盖 `error` / `error_code` / `retryable` / `repair`。
- Capability Pack 第一刀（#447 / #459）：`deepsonar.capability-pack/v1` Manifest、Job 级 list/search/describe/validate/preview，以及 RoleConfig 快照冻结 selector/digest。发现失败复用 #453 版本化 `RepairFeedback`，不另建 envelope。
- 语义去重与相对优先级与漏洞确认分离（#448 / #460）：报告前有界批次聚类、canonical anchor 增量比较、canonical 集合 `priority_score`；写入 `finding_research*`（schema v48），不改 `verify_status` / severity / 报告门禁。失败显式记 run 并保留候选。只读 `GET /canvases/:id/finding-research`，列表/详情分列展示验证、严重度、重复关系与研究优先级。
- 任务工作台默认决策总览（#449 / #451 / #454 / #457）：任务详情从默认过程画布改为统一工作台壳层，六个一级视图（总览、研究地图、事实证据、任务发现、任务运行、报告），首次打开默认「总览」。Header 展示执行 / 认知 / 交付状态线；总览从前端投影结论、证据缺口、待决事项与下一步 Action。Job / Finding 错误串投影为只读 `RepairFeedback` 四类；过程画布保留为高级审计入口。
- 新增可持久化的 `open-kritt` 亮色主题（#450 / #452）：暖白画布 + 珊瑚橙强调色，写入 `localStorage`；沿用现有主题选择器与 CSS token，不改其他主题。Finding / Job 严重性与运行状态继续用独立语义色。

### 修复

- Capability Pack 发现以上界为 Job 冻结 selector + content hash；源目录在 Job 创建后变更不能扩大或改写可见集合。过长 selector 不再写入 `RepairFeedback.path`（#447 / #462）。
- Finding research 的 emit/report 挂钩用 savepoint 隔离持久化失败：研究 SQL 或失败账本写入出错只回滚 savepoint，外层 Finding / 报告事务继续提交（#448）。
- timeout / orphan 在没有效果账本、或账本仍有 `unknown` / `effect_pending` 时不再标成可安全重试：工作台投影为 `unknown_effect`，须确认；仅显式 `replay_safe: true` 且无未决效果才允许 `retry_same_session`（#461）。
- Worker 派发 claim 改为单事务选节点 + 预留 `worker_sandbox_leases` 占位，并写入 `last_dispatch_at`；并发 provision 不能超过节点 `max_sandboxes`。远端 create 失败释放占位，成功则把占位改成真实 sandbox id。去掉 claim 失败后再 `pickRoundRobinWorker` 且不记账的 fallback（#434 / #442）。
- Worker 沙箱租约在正常 destroy 时也会释放（#431 / #440）：`OpenSandboxRunner.destroyResource` 命中 sessions 缓存后仍调用 `client.destroy`；worker-plane `destroy` 在 `finally` 里释放租约。reaper / 启动 reconcile 按终态或缺失 Job 回收 `worker_sandbox_leases`，重启即可清掉已泄漏的容量占用。
- 项目导出在活动 Job 下不再撕裂快照（#436 / #439）：数据收集走 `REPEATABLE READ` 只读事务；`project_full` 拒绝 `allow_active_jobs`，仅证据归档 / 自定义事件模块可显式允许；`credentials.mode=excluded` 不再把凭据身份写入 role-configs；events 达上限时标记 `counts.events_truncated` 与 manifest warning；导入对缺少 Job 的 Finding 记 warning。
- 自定义项目导出模块校验：未知 / 原型链 selector（`constructor`/`toString` 等）返回 400 并列明 `rejected`，不再静默丢弃或 500；`reports`/`artifacts` 从未实现收集，已从导出契约移除（#435 / #438）。
- Release 指纹未变但 `src-<fingerprint>` digest 尚未写入上一份 catalog 时，不再 fail closed：先发布 version tag，再对已发布通道做真实 inspect 补记 catalog 行。

### 安全

- Worker 注册/心跳不再允许 bootstrap token 静默改写 endpoint 或抢占已有 `node_id`（含保留的 `local`）：远程注册拒绝保留 id 与同名接管，须管理员 `DELETE /workers/:id` 后才能 reclaim；远程 endpoint 拒绝 loopback / link-local / `169.254.0.0/16` / 不可路由地址，并可选用 CIDR/hostname allowlist；注册与拒绝的心跳写入审计并按 IP 限流；心跳不能改 kind/所有权。本地 seed 在 kind/endpoint 被改写后轮换 node token，劫持无法跨 Scheduler 重启存活（#433 / #441）。
- OpenSandbox 仅在 Kubernetes create 请求 `extensions["bootstrap.execd.isolation"]=enable`（#427 / #432 / #437）：Docker 不带该 extension，避免主沙箱容器被授予 `CAP_SYS_ADMIN` 与 unconfined seccomp/apparmor；K8s/Kata 仍需 execd uid gate 才能写 `/etc/hosts`。SDK client 不再强制覆盖该字段。相对 v0.2.11「始终带 isolation」收紧。

### 变更

- 回写 as-built 架构与 Agent 指南（#463）：`DESIGN.md` / `docs/ARCHITECTURE.md` / `AGENTS.md` 对齐 Plan、Artifact、质量指标、RepairFeedback、Capability Pack 与任务工作台；长期插件化方向见 `docs/AI_NATIVE_TRUSTED_KERNEL.md`（#446）。

### 部署 / 升级说明

- **须重建数据库**：schema v46 → v48。v47 新增 `artifacts` / `artifact_claims` / `artifact_evidence` / `artifact_relations` 与 `findings.artifact_id`；v48 新增 `finding_research_runs` / `finding_dedupe_clusters` / `finding_research`。先 `pnpm db:rebuild -- --plan`，再 `--apply`。Scheduler 启动不自动升级。
- Plan / Capability Pack / 质量指标 / RepairFeedback 均为 Phase 1：不改 Hub 收敛门，也不自动派发新 Worker。
- 任务工作台 timeout/orphan 默认须确认后再重试；无效果账本时不再给出无条件 `retry_same_session`。
- 相对 v0.2.11：Docker 路径不再请求 execd isolation；仅 Kubernetes/Kata 需要该 extension。
- 本版本未改官方 Agent Dockerfile；Release 若指纹未变会走 `src-<fingerprint>` 跳过 docker build。上一份 catalog 已有该 digest 时复用 version 行且不打新的运行时 version tag；若 src-cache digest 从未入册，仍发布 version tag 并由 inspect 补记，平台镜像仍打 `0.3.1` tag。

## [0.2.11] - 2026-09-11

### 新增

- 沙箱执行面节点化 P0（#415 / #416）：Scheduler 以 Postgres `worker_nodes` 为注册表（无 etcd），worker 持 bootstrap token 注册并心跳；派发按轮询 + 每节点 `max_sandboxes`。单机 compose 仍种子 `local` worker（`OPEN_SANDBOX_DOMAIN`）。沙箱流量继续走 `OPEN_SANDBOX_USE_SERVER_PROXY`。新增 `deploy/docker-compose.worker.yml` 与 `./deploy/deploy.sh up worker-join --control-plane …`。
- 项目导出支持自定义模块（#411 / #412）：可按模块组合导出；`ACTIVE_JOBS` 门槛收紧到真正需要一致性的路径（`project_full` / 含 events 的自定义），findings/tasks 等允许在活动 Job 下导出。

### 修复

- OpenSandbox server 在 Podman 下缺少 `/.dockerenv` 时，egress sidecar 探针不再误用 `127.0.0.1`：容器探测同时认 `/run/.containerenv`，compose 为官方 server 挂入 `/.dockerenv` 标记，使 `[docker].host_ip` 生效（#422）。
- Scheduler 内存缓存的 gateway sidecar `containerId` 在容器重建后会按名称重新发现并走原有 reuse/replace 判定，不再因 `no such object` 让后续 Job provision 全部失败（#426 / #429）。
- OpenSandbox 创建沙箱时始终带 `extensions["bootstrap.execd.isolation"]=enable`（#427）：execd 指定 uid/gid（含 Kubernetes Gateway `/etc/hosts` 注入）才能通过 bwrap gate；不再依赖 Job 快照或新的平台开关。
- Release 指纹未变时复用上一版 catalog 记录，不再拿 `src-*` 缓存 digest 去对已发布 index digest（build-push+provenance 的 index 与 imagetools 选出的干净 index 不同）。
- Windows Docker Desktop 上 OpenSandbox real Job 的 Gateway hostname 改为引擎 `docker exec -u 0` 写入沙箱 `/etc/hosts`（#423 / #424）：不再依赖 execd/bwrap 改 Docker 注入的 hosts 文件；Kubernetes/Kata 仍走 execd uid=0。失败文案固定带 `method`/`exit`/`uid`/`gid`，guest USER 不变。

### 变更

- 拆开平台版本与 Agent 运行时镜像版本（#417 / #418）：GitHub Release / `DEEPSONAR_IMAGE_TAG` / scheduler·web·admission 仍跟 `vX.Y.Z`；运行时产品只在指纹输入变化时升版本。指纹未变不新增 catalog version 行，也不对 ACR/GHCR/Docker Hub 打新的平台 version tag，继续指向已有不可变 digest。
- 平台清单声明 `min_runtime_image`（全局下限 + 可选 per-key）。选中的官方 trusted 版本低于下限时，预检 / 建任务 / Job 冻结前 fail closed，稳定错误码 `RUNTIME_IMAGE_BELOW_PLATFORM_MIN`；已冻结 Job 快照不改写。
- `deploy` 的平台镜像仍拉 `*:$IMAGE_TAG`（来自 catalog `platform_version`）；运行时镜像按 catalog 真实 version/digest 拉取，不再假设平台 `0.2.10` 等于 `kali:0.2.10`。
- 任务工作台「创建」改为本地日历日 `YYYY-MM-DD`，不再显示「N 分钟/天前」；完整时刻仍在 tooltip（#419 / #421）。
- 统一 OpenSandbox 宿主端点缺省为 `127.0.0.1:18081`（#413 / #414），与标准部署宿主端口一致；同步 `.env.example`、compose 映射与相关测试。

### 部署 / 升级说明

- **须重建数据库**：schema v45 → v46。v46 新增 `worker_nodes` 与 `worker_sandbox_leases`。先 `pnpm db:rebuild -- --plan`，再 `--apply`。Scheduler 启动不自动升级。
- 仍跑 `v0.2.10` 的调度器在 Windows Docker Desktop、Podman egress sidecar、gateway sidecar 重建后、以及 execd uid gate 上会继续踩上述 provision 失败。升级调度器 / web / image-admission 镜像后才会生效。
- OpenSandbox 宿主直连缺省端口从 `8080` 改为 `18081`。已有 `deploy/.env` 若仍写旧端口，需与 compose 映射一并改掉。
- 单机 `up real` 仍种子 `local` worker；远程执行面用 `./deploy/deploy.sh up worker-join --control-plane …`。心跳超时只停止新派发，不自动开新 attempt。
- 本版本未改官方 Agent Dockerfile；Release 若指纹未变会走 `src-<fingerprint>` 跳过 docker build，运行时 catalog 可复用已有不可变 digest，平台镜像仍打 `0.2.11` tag。

## [0.2.10] - 2026-09-07

### 新增

- 报告多级只读视图（#408 / #409）：任务工作台「报告」页签改为任务级聚合——上方任务总报告（可切换版本），下方本任务各已确认 Finding 的最新独立报告；新增 `GET /projects/:id/reports`（可选 `canvas_id`，`reports:read` 范围）按任务编组全部任务报告版本与各 Finding 独立报告，项目页 `/projects/:id/reports` 按任务分组展开。只补只读展示与导航，不改双轨生成、幂等版本化或 SARIF/Markdown 下载语义。

## [0.2.9] - 2026-09-06

### 新增

- Runtime image readiness 与拉取任务持久化：Hub 目录/`list_available_runtime_images` 返回 `readiness`（ready/preparing/unavailable/error）且不泄露 OCI/digest；`GET /runtime-images/registry` 附 `image_status`，`GET /runtime-images/registry/pull-status` 返回可关联 image_key 的结构化阶段。拉取任务落 `runtime_image_pull_tasks`（schema v44）；Scheduler 重启把 in-flight 标为 `interrupted`（`scheduler_restarted`），不自动 resume。Hub 提交未就绪镜像返回可重试 `runtime_image_not_ready` 且不创建 Job；管理 API 映射为 409 并可轮询 pull-status（#398）。
- `GET /dashboard/ops` 提供态势 P1/P2 服务端运营指标：Finding 分布与高风险未闭环、项目/任务覆盖、近 7 日成功率/耗时/角色对比、并发水位与失败原因；snapshot=current、throughput=history（#400 / #242 数据契约）。
- 读 API 标明查询平面：`current` / `history` / `live`；live 不是审计源。Job 详情与事件分页返回 `query_plane` 与导入 `provenance`（#400）。
- Finding 处置矩阵：`confirmed_vuln` 必须 `verify_status=confirmed`；高风险未闭环不含已确认漏洞（#400）。
- 取消/超时/孤儿后的迟到语义事件仍用 `job_not_running`，并附归属 `details`；`events.attempt_id` 记录摄入锁时的 Attempt（schema v45）（#400）。
- 导入 Job 默认 historical/readonly；导入时活动归档为 cancelled 的 Job 续跑返回 `409 JOB_IMPORTED_READONLY`（#400）。

### 变更

- Finding 确认改为 Fact-first 硬门：只认图上结构化 Fact（`finding_id` / `subject_revision` / ownership / `expected` / `actual` / `outcome`）。门禁通过则直接确认，或由只消费 Fact 的 `verify_finding` 提交收口提案；不再二次复核源码、原始制品或 maker 结论。不足、失败、冲突或版本不匹配保持未确认并回弹 Hub；审计记录所用 Fact 与门禁结果（#399）。
- 保留 Fact 证据信任态 `verification_status`，与 Finding `verify_status` 分界；报告数值门禁只认 verified Fact（#391 / #387）。
- 明确过程流三职责并收口补读（#388 / #359）：`events` 仍是语义账本，evidence NDJSON/manifest 是过程证据，`stream-bus` 只作非权威投递。HTTP/WS 补读只认本机 `BLOB_DIR`；未落盘标 `unpersisted`，本副本看不到文件标 `visibility=unavailable`。不从过程流重放控制副作用，不承诺零丢失。
- 收敛通用配置面（#386 / #359）：删除无决策作用的 Finding 协议模式 `agent_choice`（并入 `hybrid`）、`rules.finding_protocol` 双写，以及 RoleConfig `runtime_knobs` 的 snake_case 别名。三层协议合并、`runtime_knobs` 四层、`image_strategy` 与 `pin_policy` 保留；Job 仍只认冻结快照。启动/导入物理改写历史别名，新写入拒绝。
- DSH YAML 解析与 Gateway 运行时投影迁到 `@deepsonar/runtime-sandbox` adapter；Scheduler 管理面调用该 API 校验/冻结，executor 只经 `adapter.projectRuntime`。通用状态机不再持有 DSH wire schema（#390 / #359）。

### 修复

- 明确 DSH/Pi「解码」为三类契约（请求兼容投影 / 运行事件解码 / Session 归档与查看器），修正 DESIGN 误把 #320 当作完整解码的引用。DSH 未知 JSON-RPC 帧改为可诊断的 `unknown_runtime`，并解码独立 `tool/call` / `tool/result`；钉死 Pi `0.84.4` / DSH `0.1.1-rc.2` 脱敏夹具覆盖文本、工具、错误、usage、Session 身份与损坏帧。普通输出或伪造工具调用仍不变成控制语义事件（#389 / #359）。

### 安全

- 收紧 Token 提权与项目 / Transfer / 镜像治理：新 Token 的 scopes 必须是调用者有效 scopes 的子集，非 admin 不能授予 `admin`；项目 actor 只能管理本项目且不超过自身权限的 Token。`POST /jobs` 跨项目返回稳定 `PROJECT_MISMATCH` 且不建 Job。平台镜像治理（registry sync/apply/pull、digest、rescan 等）与平台 Transfer 对项目 actor 一律 `PROJECT_SCOPE_FORBIDDEN`；项目 Transfer 不能 `create_new` / `merge_platform`（#403）。

### 部署 / 升级说明

- **须重建数据库**：schema v43 → v45。v44 新增 `runtime_image_pull_tasks`；v45 为 `events.attempt_id`。先 `pnpm db:rebuild -- --plan`，再 `--apply`。Scheduler 启动不自动升级。
- Finding 确认已改为 Fact-first：旧的二次盲复核 / maker 结论路径不再存在。已有未确认 Finding 需按图上结构化 Fact 重新收口。
- Token / 项目边界收紧后，原先能创建全局或跨项目 Token、跨项目建 Job、或用项目 Token 做平台镜像治理 / 平台 Transfer 的调用会失败。
- 本版本未改官方 Agent Dockerfile；Release 若指纹未变会走 `src-<fingerprint>` 跳过 docker build，digest 可复用 v0.2.8。

## [0.2.8] - 2026-09-06

### 新增

- Hub 可按任务动态选择 Worker 运行镜像：intent 可选 `runtime_image_key`，只接受本轮 `list_available_runtime_images` 返回的市场 key；非法/未启用/CLI 不兼容使整次决策以 `invalid_runtime_image` 拒绝。省略时按角色缺省解析（#357）。
- Verify 盲验 Phase 1：`verify_finding` 只冻结主体 / location / `artifact_refs`，不下发 maker 的 title/summary/severity；Verify 先独立推导再逐项 DIFF，仅 exact match 可 confirm（#371）。
- Fact/Finding 可选 `quantities: [{value, unit, basis, ref?}]`（最多 20）。报告阶段机械核对已确认 Finding 与 verified/confirmed Fact 的值+口径（#368）。

### 变更

- Schema 升至 v43。v42 删除 Plane 列与 `credentials.kind=plane`；v43 删除 `findings.suggest_verify`。已有库须先 `pnpm db:rebuild -- --plan`，再 `--apply`。
- inherit_global 项目 RoleConfig 不再保留被忽略的行上 `model` / `runtime_image_key`。启动、切换策略、写入、导入导出与批量绑定会物理清空这些字段；批量绑定 impact 去掉 leftover 警告字段（#359 / #233 / #146）。
- 删除 Finding 兼容旋钮 `suggest_verify`。控制契约、落库、导入导出与工具说明不再接受该字段；是否派生 Verify 只认冻结规则（#359）。
- 删除过时 Plane 集成与假身份：`plane_project_id` / `plane_issue_id` / `projects.canvas_id` 回退、`CONTROL_MCP_SERVER` 与 `plane-client` 包一并删除（#359 / #363）。
- 删除控制 MCP 残留通道：adapter 不再声明 `controlMcp`；CLI 流中的伪造 `mcp__deepsonar-control__*` 只告警，不再默认映射为语义事件；冒烟入口改为 `ci:smoke:control-api`。缺少冻结 Finding 协议的画布 fail closed，不再现场回退当前全局/项目配置（#359）。
- 删除无决策作用的兼容别名：`false_positive` 不再作为 Verify verdict 输入（只认 `confirmed|rework|needs_human`）；Credential 写入拒绝 leftover `allowed_model_ids`；Job/WS 实时流信封只保留 `items`；公共 `POST /jobs` 不再把 `audit_module` 映射为 `audit`。历史 Finding `verify_status=false_positive` 与导入投影仍可读（#359）。
- 继续删除 leftover 第二真相：官方 audit 镜像不再回退 `DOCKER_IMAGE_AUDIT`；`BLOB_STORE` 只认 `fs|s3`；删除空 `docker-compose.online.yml`、空洞 verify/publish 转发函数，以及前端 `deepsonar_token` 静默迁移（#359）。
- 导入 RoleConfig 不再静默写入 leftover `agent_cli`（缺省仍 `claude-code`，`codex`/`open-code`/未知 fail closed）；前端凭据保存不再静默剥离 leftover `allowed_model_ids`（#359）。
- 规则 JSON 物理清扫已删除的 `autoVerifySeverities` / `hubWaitSeverities` / leftover CLI 并发键；PATCH 拒绝这些别名，`asCliLimits` 只忽略 leftover 键而不整表作废；路由 registrar 不再转发领域 schema（#359）。
- 删除 leftover 本机 Docker inspect 调度闸门：建 Job / Hub / Verify / Report / resume 不再因 Scheduler 本机缺层拒绝；readiness 不再报 `RUNTIME_IMAGE_NOT_LOCAL`。OpenSandbox 仍按冻结 digest 拉取并在 provision 后重验（#359 / #286）。
- 官方镜像不再安装 leftover `@openai/codex` / `opencode-ai`。新 Job 只认 `claude-code` / `pi` / `dsh`；历史 leftover Session 归档仍只读解析，路径守卫保留 `/.codex/` `/.opencode/`（#359 / #318）。
- leftover Job 身份别名不再映射为当前类型：`audit_module` 不再当作 `audit`，`hub` 不再当作 `hub_reason`。事件摄入 fail closed；测试夹具改用当前类型。`verify` 仍是 runtime-image smoke 通道（#359）。
- leftover Codex/OpenCode Session 解析函数迁出热路径；`*.poc.ts` 迁出生产 `src/`；verify/report 转发层删除，`core.ts` 只做组装（#359 / #366 / #369）。

### 修复

- Hub 选图后 resume / rerun 保留 Job 已冻结的 runtime image；CLI 不兼容改为 `invalid_runtime_image`，不再 500（#360）。
- 报告数值保真门禁不再因 Agent 改写口径或未确认 Fact 误炸：只核对 verified/confirmed Fact 与 confirmed Finding；覆盖足够的 Agent 稿数值失败时回退确定性模板，并明确要求报告原样保留 value/unit/basis（#374）。

### 部署 / 升级说明

- **须重建数据库**：schema v40 → v43。先 `pnpm db:rebuild -- --plan`，再 `--apply`。Scheduler 启动不自动升级。
- 凭据 `kind=plane` 已从基线删除；旧库重建时该行不会回填。
- 官方 Agent 镜像指纹变化（去掉 leftover Codex/OpenCode 安装），Release 会重建 base / kali-minimal 及依赖 base digest 的专项镜像。Scheduler 镜像因删除 `plane-client` 也会重建。
- Chrome Fuzz Release 构建在托管 runner 上先释放磁盘并加 swap，降低 V8 编译把 runner 打挂后整次发布 skip 的风险（v0.2.7 因 amd64 构建中途失联未产出 GitHub Release）。
- 新 RoleConfig / 新 Job 的 `agent_cli` 只接受 `claude-code` / `pi` / `dsh`；导入 leftover CLI 不再静默改写。

## [0.2.7] - 2026-09-04

### 新增

- Pi 第三方扩展走注册制准入：RoleConfig `pi_extensions` 只接受已注册 id，Job 创建冻结后经 `--no-extensions` + `-e` 注入镜像预置路径。pilot 为 `pi-web-access`（预置 audit / kali-minimal，不进 base；无长期密钥下发，出网服从 `allow_egress`）（#351）。
- 控制台「新建项目」只创建空项目，不铸画布、不派 Hub（#343）。快捷启动仍可一次完成「新项目 + 第一项任务」。
- 项目启用多个运行时镜像时按 digest 入队去重、串行拉取，不再因 in-flight 准备 409（#342）。

### 变更

- Schema 升至 v40（`role_configs.pi_extensions_json`）。已有库须先 `pnpm db:rebuild -- --plan`，再 `--apply`。

### 修复

- 非 root 专项镜像 OpenSandbox provision 以 execd `uid=0` 写入 Gateway `/etc/hosts`，guest `USER deepsonar` 不变；失败改为 `GatewayHostsBindError`，不再报 `failed to bind deepsonar-gateway-proxy in sandbox hosts`（#346 / #355）。
- 本机镜像准备不再抢占 `admin_bulk`；通道切换与项目启用共用同一队列，已入队项不会丢失。失败 digest 不占用去重锁，Web 在 inspect 未就绪时继续轮询后自动启用。
- OpenSandbox Docker 宿主端口池钉在 `40000–49000`，避开 Windows Hyper-V / WinNAT 排除区（#349）。
- ClickHouse 专项镜像环境检查与鸿蒙一样校验从 Base 继承的 Claude Code（`claude --version`）；Audit 此前未检查 CLI，Test/Fuzz 只做 `command -v`。缺 CLI 时镜像构建失败（#353）。

### 部署 / 升级说明

- **须重建数据库**：schema v39 → v40。先 `pnpm db:rebuild -- --plan`，再 `--apply`。Scheduler 启动不自动升级。
- 本版本含 #346 Gateway hosts bind 修复；仍跑 `v0.2.6` 的真实 Job 会在写沙箱 `/etc/hosts` 时于 provision 失败。升级调度器镜像后才会生效。
- Windows Docker Desktop 部署请使用本版本钉死的 OpenSandbox `port_range`；自定义 `40000–60000` 会落回排除区。
- ClickHouse 专项镜像指纹变化，Release 会重建；audit / kali-minimal 若含 `pi-web-access` 预置也可能重建。未改内容的镜像仍走 `src-<fingerprint>` 跳过 docker build。

## [0.2.6] - 2026-09-02

### Fixes

- Hardened provider routing and runtime adapters, including nested RPC failures and session progress rendering.
- Stabilized Pi job completion, failure reporting, and usage-ledger cache-hit display.

## [0.2.5] - 2026-09-02

### Fixes

- Added the latest scheduler, provider, and runtime hardening changes from the 0.2.x maintenance cycle.

## [0.2.4] - 2026-09-02

### Fixes

- Added bounded OpenSandbox provisioning retries and Pi system-prompt/session handling fixes.

## [0.2.3] - 2026-09-02

### 新增

- **ClickHouse audit/test/fuzz 专项运行时**：三个官方 project-opt-in 镜像对标 Chrome 三件套。Audit 提供 git / CMake / Ninja / Clang-LLVM / binutils；Test 钉死官方 LTS `clickhouse-common-static` `v26.3.28.5`，HTTP 冒烟走 `127.0.0.1`；Fuzz 装同一官方二进制加 Clang-16 / libFuzzer / AFL++，不从源码编 ClickHouse。Test server 与 Fuzz `clickhouse-local` 共用沙箱预算内 config（关 watchdog/mlock/crash report/page cache，限制线程池与 8GiB 级默认 cache）。专项 CI 在 `--network none` 下把 hostname 钉成 `localhost`，避免 ClickHouse DNSResolver 解析容器 id 时卡在 Docker DNS。三套均要求 `allow_egress=true`，stall 下限与 Chrome 相同。

### 变更

- **Agent CLI 新配置收敛为三类（#318）**：新 RoleConfig / 新 Job 只接受 `claude-code`（默认）、`pi`、`dsh`。leftover `codex` / `open-code` 历史快照与 Session 归档只读可看，不自动改写；下次保存 leftover 配置拒绝并提示迁移。运行时注册表与新增 CLI 接入流程保留。

### 部署 / 升级说明

- 本版本无 schema 变更（仍为 v39）。
- 首次正式发布 ClickHouse 三套专项镜像；Release 成功后会把 digest 回写 `deploy/runtime-image-registry.json`。此前 bundled catalog 的 ClickHouse 条目为 `versions: []`。
- 新 RoleConfig / 新 Job 的 `agent_cli` 只接受 `claude-code` / `pi` / `dsh`；历史 leftover CLI 快照仍只读可看。

## [0.2.2] - 2026-09-01

### 修复

- task retry / 唤醒 Hub 时当前 RoleConfig / Credential 无法解析，稳定返回 `409 SNAPSHOT_STALE`，不再 500（#315）。
- 角色 `agent_cli` 更新时，绑定 LLM 凭据在 Provider 兼容矩阵通过后跟随最新配置；Job 解析以角色为准，凭据 `agent_cli` 仅为软提示（#316）。
- Provider `/models` 探测失败不再阻塞凭据或角色保存；catalog 软降级为空，仍可写 health（#317）。
- pi / dsh adapter 解析上游错误里嵌入的 JSON `message`，Job `last_error` 展示短原因（#320）。
- dsh 在平台 system prompt 前投影英文 coding-assistant opener，对齐 pi 风格 `input[0]`，减少兼容网关按 system 帧全部 401（#321）。
- 控制台侧栏版本号链接到官方 GitHub `releases/tag/vX.Y.Z`；脏 tag 回退 releases 首页；空版本不渲染链接（#327）。

### 变更

- 刷新治理 Agent CLI pin（#319）：Claude Code `2.1.231` → `2.1.252`，Pi Coding Agent `0.84.1` → `0.84.4`，DSH 完整 package closure `0.1.0-rc.7` → `0.1.1-rc.2`（npm `latest` 标签仍指向过期的 `0.0.1-rc.*`，不以该标签为准）。adapter、Base/Kali Dockerfile 与 runtime 清单同步更新 `dist.integrity`。
- OpenSandbox server 宿主端口默认改为 `18081`（`docker-compose.opensandbox.prod.yml` / `.env.example`）。调度器仍经 compose 网络 `opensandbox:8080` 访问，不受宿主端口影响。

### 部署 / 升级说明

- 本版本无 schema 变更。
- CLI pin 变更会重建官方 Agent 运行时镜像（Base / Kali 等）；Release 指纹变化后才会 docker build。
- 已用 `OPEN_SANDBOX_HOST_PORT=18080` 的部署可继续显式覆盖；新默认是 `18081`。

## [0.2.1] - 2026-09-01

### 新增

- 用量账本记录并展示 Gateway 缓存读/写 token（`cache_read_input_tokens` / `cache_creation_input_tokens`）。CURRENT PROJECT 增加「项目账本」`/projects/:id/usage`，任务工作台不再内嵌项目账本。全局 / 项目 / 任务账本可折叠，偏好按用户 + 页面记忆，默认展开。Schema 升至 v39。
- **provider-neutral 沙箱运行时（#162 / #307）**：`RuntimeHost` / `ensureHost` 成为调度器与沙箱之间的唯一执行边界，五类 CLI adapter（claude-code / codex / open-code / pi / dsh）不再引用任何 provider SDK 类型；real 默认 `SANDBOX_PROVIDER=opensandbox`，`createRealRunner()` 只构造 `OpenSandboxRunner`。**删除 `agentbox-sdk` 与 `AgentboxRunner`**：real 模式下其它 provider 值启动即失败，不再有默认双轨。
- **OpenSandbox Docker adapter（Phase 2）**：绑定 `@alibaba-group/opensandbox@0.1.11`，server / execd / egress 只认 `name@sha256` 不可变 digest pin（禁止 `latest`，SDK 版本与安装版本强校验）；provision 后重验运行时合同（/workspace、/bin/sh、tool-manifest 与 sha256）；硬限制（cpu / memory / pids / cap-drop-all / no-new-privileges）缺失或不安全值 fail closed；架构平台（amd64 / arm64）不匹配 fail closed。
- **受限网络经路径过滤 Gateway sidecar**：restricted 沙箱只放行 `deepsonar-gateway-proxy`（/gateway 与 /control/v1 固定路径转发，拒绝 CONNECT 与任意代理），sidecar 容器受 DeepSonar 标签管理（非受管容器拒绝接管）；sandbox `/etc/hosts` 注入 sidecar IPv4 / K8s ClusterIP；模型请求经 Model Gateway 转发，沙箱只持短期 Job capability token，Provider 长期密钥不进沙箱。
- **OpenSandbox server 探针**：real 模式 `GET /readiness` 与 Dispatcher claim 以鉴权 `list()` 探测 server，缺 `OPEN_SANDBOX_API_KEY` / 不可达 fail closed（不 claim）；`GET /health` 暴露 `opensandbox.level/ready`；错误消息对 API key 脱敏。
- **Kubernetes + Kata 后端（Phase 3）**：BatchSandbox + `RuntimeClass=kata-qemu` overlay（namespace / ResourceQuota / LimitRange / Gateway Service 无 selector，ClusterIP 写入沙箱 /etc/hosts）；共享资产走 labeled PVC + seeder（`kubectl cp`，不挂 docker.sock）；`OPEN_SANDBOX_KUBERNETES=1` 时省略 Docker 专有 `pids` 资源字段但仍要求冻结 pidsLimit。
- **共享资产卷防呆**：Docker provision 在 create 前 `inspectPreparedSharedAssetsVolume`，缺 labeled volume 或 Job 所有权不匹配 fail closed，避免引擎自动建空卷；guest `/proc/mounts` 重验只读挂载。
- **重启对账与回收**：按持久 sandboxId `ensureHost` 重连；Reaper desired-state cleanup 覆盖任意 real provider；超时 / 孤儿回收 capability token、关闭 PTY、移除共享资产卷。
- **Session 查看器可切换归档（#314）**：`GET /jobs/:id/evidence/session` 返回 `artifacts`（main / subagent / vendor_export），`?path=` 切换与下载，默认最后一次主 Session / vendor export（按 manifest 写入顺序）；在线预览上限提升到 8 MiB（超限 `truncated`，完整字节走 download）。
- **Claude 会话解析改善（#314）**：跨行 `tool_use` id → name 回填工具名（`tool_result` 标题「结果 Read」）；检查器正文上限 32k；`progress` / `file-history-snapshot` / `compact` / `web_search` 归为系统行，快照只摘要文件数；Session 页多归档用 `SearchableSelect` 切换（标签带文件名与 attempt 前缀），切换请求丢弃过期响应。
- 生产 scheduler 镜像钉 `kubectl v1.36.4`（sha256，amd64 / arm64）。

### 修复

- 五类 CLI 在 OpenSandbox 上的会话归档 / 恢复链路：Codex 用 argv prompt + stdin EOF（`< /dev/null`）打出 `thread.started`，按 `sessions/YYYY/MM/DD/rollout-*.jsonl` 发现归档；execd 分行 log item 用换行拼接；Claude 无换行拼接 JSON 按 brace depth 拆分；DSH 在 initialize 前冻结确定性 session id，503 瞬态失败按各自契约恢复同会话（401 不恢复）。
- OpenSandbox destroy 对已删除沙箱幂等成功（404 / 409 / SANDBOX_NOT_FOUND / already in progress 视为已结算）；provision 取消不再空等 create 返回，迟到 session 与残留资源都会被回收。
- Dispatcher 冷宿主不再因本机缺镜像层拒绝 Job：OpenSandbox 由 server 按不可变 digest 拉取，合同 / digest 在 provision 后重验。
- CI：鉴权调度器（:3101）启动前停掉仍在写同一库的 :3100，避免 boot 期 `reconcileOwnedSequences` 与 INSERT 竞态（#314）。

### 变更

- 默认 real 沙箱从 Agentbox 切换为 OpenSandbox：生产部署默认叠加 `docker-compose.opensandbox.prod.yml`（server 发布在 `127.0.0.1:18080`）；`docker-compose.opensandbox.host.yml` / `k8s.yml` 为已有 server / Kata 集群的附加 overlay。
- 本机镜像 digest 预检闸门随 Agentbox 删除而不再触发：OpenSandbox 模式由 server 按不可变 digest 拉取并在 provision 后重验承担；`shouldInspectLocalRuntimeImage()` 相关死代码链与文案残留待后续清理。

### 部署 / 升级说明

- **Breaking（0.2.x）**：`SANDBOX_PROVIDER=local-docker` 已移除，real 模式只支持 `opensandbox`。升级须部署 OpenSandbox server（`deploy/opensandbox/config.toml` + digest pin）并配置 `OPEN_SANDBOX_API_KEY`；缺 key 时 readiness / Dispatcher claim fail closed。
- Schema 升至 v39（用量账本，见「新增」首条）。已有库须先 `pnpm db:rebuild -- --plan`，再 `--apply`。
- 官方运行时镜像内容未变（本版不含运行时镜像内容变更），Release 指纹未变时跳过 docker build，只打新版本 tag；scheduler 镜像因 `kubectl` 依赖会重建。

## [0.1.46] - 2026-08-31

### 新增

- 官方 `deepsonar-mobile` 专项镜像（project opt-in）：覆盖 Android（JADX CLI、apktool、bundletool、apkeep、androguard、官方 ADB、Frida/Objection；`.so` 用 binutils / radare2 / LIEF）、iOS Linux 宿主（libimobiledevice / plistutil / iproxy）与 OpenHarmony 应用/设备（HAP 静态检查 + 官方 hdc）。对照 [awesome-ai-reverse](https://github.com/DiscoverBox/awesome-ai-reverse) 只并入官方可钉死的基础 CLI；不预装 MobSF、jadx-gui、Burp、mitmproxy、IDA、Ghidra、DevEco、决策扫描器或 JADX-AI-MCP / apktool-mcp / FIRERPA 等 MCP。无 adb / hdc / idevice 目标时必须结构化 `needs_human` / `inconclusive`。现有 `deepsonar-openharmony-*` 仍负责源码构建/Clang/fuzz。
- `deepsonar-mobile` 钉入 [ApkCheckPack](https://github.com/moyuwa/ApkCheckPack) `20260618`（linux-amd64 静态二进制 + arm64 qemu）。Agent 可选用的加固/SDK 指纹 CLI，不是平台规定扫描入口，也不把输出当成 Finding。

### 修复

- 同一摄入先成功 `request_human` 再跟迟到 `mark_job_done` / `submit_hub_decision` 时，跳过后续终态并保住 `waiting_human`，不再因 `duplicate_tool_call` 整笔回滚（续 #298 / #300）。Executor 先落 human 再看 runner 错误；Dispatcher 已在人工门时不再把 Job / 画布刷成 failed。
- `request_human` 同时把对应 `job` / `intent` / `report` 画布节点标为 `waiting_human`。向等待人工的 Job 回复与忽略共用恢复路径（关 Attempt → `pending` → 唤醒调度），避免消息停在 `planned`。Job 账本仍为 `waiting_human` 时，即使画布节点已被刷成 failed 也可定向回复；解析不到活动 Job 仍不得默认发给 Hub。

## [0.1.45] - 2026-08-26

### 新增

- 项目风险台：进入项目后的「项目风险 / 风险发现」列出该项目全部任务 Finding；顶部用 `GET /projects/:id/findings/summary` 聚合严重度 / 验证 / 处置，避免列表 500 条窗口静默截断（#302）。
- Finding 处置新增 `human_reproducing`（人工复现中）。可作 compose 种子；`confirmed_vuln` 仍要求 Verify 已 confirmed。Schema 升至 v38。

### 修复

- Job 结果页「下发 Prompt」：运行时把去掉画布 YAML 的完整输入冻结到 `payload.dispatched_prompt`；既有 Hub 后续轮次从 canvas 任务正文 / 触发原因回填，不再空白。
- 过程画布筛选坞与图例放入 React Flow `Panel`，避免被 pane 盖住；去掉 `onlyRenderVisibleElements`，边 SVG 使用 1px + `overflow: visible`，平移后连线不再被裁掉。
- resume 已 `request_human` 的 Job 后，终态互斥只计当前 Attempt：旧 Attempt 的 human 不再把新会话 `mark_job_done` / `submit_hub_decision` 判成 `duplicate_tool_call`（#298）。
- Hub 人工收尾同一回合先 `submit_hub_decision` 再 `mark_job_done` 时，running 守卫用摄入加锁时的状态；迟到 done 幂等，不再 `job_not_running` 整笔回滚（#300）。

### 部署 / 升级说明

- Schema 升至 v38（`findings.disposition` 增加 `human_reproducing`）。已有库须先 `pnpm db:rebuild -- --plan`，再 `--apply`。
- 本版本不改官方运行时镜像内容。Release 指纹未变时跳过 docker build，只打新版本 tag。

## [0.1.44] - 2026-08-23

### 新增

- 官方 runtime catalog 提升后，自动把已过期的官方项目 pin 滚到最新 trusted（#284）。只改 `project_runtime_images.selected_version_id`，不改 Job 快照；`version_id=null` 仍跟随最新；`pin_ok` 显式旧版、第三方 pin 与 `pin_policy=hold` 不自动换 digest。每次滚动写 `runtime_image.official_pin_roll` 审计。市场行可显示「已随官方升到 x.y.z」。建任务前先解析 Hub 快照，避免 pin 过期留下无 Job 空壳画布；已有空壳可 `POST /tasks/:id/retry`。
- 任务 / Job 启动前对本机冻结 digest 做与 Dispatcher 相同的 inspect-only 校验（#286）。catalog trusted 不再当成「本机可跑」；缺图则拒绝插入 Job，返回可诊断错误（digest / 版本 / 准备入口），执行期仍禁止隐式 `docker pull`。resume 校验快照 digest，不改用 latest。
- 新建任务「指定时间」改为可点击月历与时刻表（#294），不再依赖浏览器原生 `date` / `time` 控件。调度语义不变：仍提交 `scheduled_start_at` UTC，本机墙钟显示，提交时拒绝过去时刻。

### 修复

- 人工介入请求可不回复直接隐藏，也可在“显示历史”中取消隐藏；回复成功后仍按用户与任务记为“已回复”并随已处理项隐藏。两者都只改变工作台展示偏好，不把请求误记为“忽略”，也不改写 Job 调度语义。
- 从未真正 `running`（`started_at` 为空）且唯一 Job 在 provision 失败的任务，不再被列表 / 工作台 / Dashboard 标成「已完成」（#292）。全部 Job 终态但从未开始时，失败 / timeout / orphan / cancelled 显示失败，不再只靠 `ended_at` 误判完成。
- 过程画布按稳定可见投影展示（#289 / #290）：默认深度 3、每父节点先揭开 12 个子节点、默认 24 个可见节点预算并以 24 为步长展开，180 节点硬上限仍在。主干边使用 ELK 实际路由，回到 root 的反馈边走外围收敛轨道，不再反向穿过源卡片。筛选 / 展开 / delta 布局保留用户平移缩放；PNG 导出标明当前可见投影。
- 项目设置镜像策略下拉不再截断产品名，触发器可换行显示完整镜像名。

### 变更

- 根 README 去掉重复的运行时镜像能力表、中国区 ACR 拉取示例及静态审计 / 动态验证说明；镜像发布与升级仍以 `docs/RELEASE_RUNTIME_IMAGES.md` 与 `DESIGN.md` 为准。

### 部署 / 升级说明

- Schema 升至 v37（`project_runtime_images.pin_policy`，默认 `follow`）。已有库须先 `pnpm db:rebuild -- --plan`，再 `--apply`。
- 本版本不改官方运行时镜像内容。Release 指纹未变时跳过 docker build，只打新版本 tag。升版后官方 stale pin 会自动滚到最新 trusted；本机仍须准备即将冻结的那条 digest，不会在执行期隐式拉取。

## [0.1.43] - 2026-08-21

### 修复

- `db:rebuild` 回填后只对 **public** 上的 owned sequence `setval(MAX(id))`，并在 rebuild 结束与 Scheduler 启动时校验 `last_value >= MAX`、下次 `nextval` 为 `MAX+1`。漂移会自动对齐，对不齐则 fail closed，避免 `audit_logs_pkey` / `events_pkey` 撞号（#281）。不改 append-only，也不把审计主键改成 UUID。
- 任务页人工介入默认折叠、可隐藏历史，并提供「忽略」以跳过等待（#277）。忽略会把 human 节点标为 `ignored`；若 Job 仍为 `waiting_human` 则恢复 pending，让 Agent 继续推进。折叠/隐藏按用户与任务写入 localStorage。
- 镜像市场切换官方仓库通道时，若已有准备/拉取任务，返回当前 `pull-status`（202）并展示进度，不再把 `409 runtime_image_preparation_busy` 当硬失败（#278）。同 digest 复用准备锁，通道切换可抢占当前通道的 `admin_bulk`。下拉保持待切换通道，完成后自动重试落库。准备任务异常退出会离开 `queued`/`running`。

### 部署 / 升级说明

- Schema 仍为 v36，升本版不必为结构重建库。若库曾 `db:rebuild` 后出现 `audit_logs_pkey` / `events_pkey` 撞号，Scheduler 启动会自动 `setval`；不齐则 fail closed。
- 本版本不改官方运行时镜像内容。Release 指纹未变时跳过 docker build，只打新版本 tag。

## [0.1.42] - 2026-08-20

### 新增

- 配置中心第一批运行时护栏落库并可热读（#263）：`stallSec`、`jobTokenMaxRequests`（0=不限制）、`auditTimeoutSec` / `verifyTimeoutSec`、`provisionTimeoutSec`。优先级 Job > 角色 RoleConfig > 项目规则 > 平台 `global_settings` > 部署 env 引导。Web「配置中心」与角色编辑器可改，保存有可见 toast 并写审计。已在跑的 Job 继续用冻结快照；下一 Job 无需重启调度器。
- 任务下发后可就地修改标题与内容（#253 / #251）：画布工作台直接改当前任务意图，调度器写入权威任务记录并保留过程画布；不另开任务、不改写已冻结 Job 快照。
- 组合续挖（`kind=compose`）可选择同项目未确认 Finding（pending / verifying / needs_human / confirmed），并禁止把新画布扩成新一轮资产扫描（#273 / #274）。Hub 不得下发未绑定种子的 explore/audit；`emit_finding` 拒收种子资产以外的新仓/新模块 Finding。重试仍在源 Finding 被删、跨项目或否定处置时 `COMPOSE_SEEDS_STALE`，不因仍未 confirmed 而拒绝。
- OpenHarmony Test 钉死官方 SDK `hdc` 作为设备协议（#268）；CI 只冒烟 `hdc version`，无设备时结构化 `needs_human`。

### 修复

- 大过程画布分层加载（#270）：默认每层先揭开 12 个后继、限制同时渲染节点数，筛选坞保持可点；超过 ELK 阈值改用列布局，不再叠在服务端 `(0,0)`。
- 拓扑边改为东出西进的层间正交总线，竖段贴在源节点右侧近层间隙并按同一父节点分车道；广播 overlay 默认不盖过程图，点选节点才画对应叠加层。
- 不再把每条边的 SVG 钉成画布一屏：平移/放大到右侧列时正交折线仍可见，端点扣到真实 handle。
- 过程画布筛选坞始终默认展开；折叠态「筛选节点」在亮/暗色与 <640px 下保持可点可读，不再被 `100%-176px` 裁成只剩导出。
- 拓扑连线把 `--deepsonar-edge-zoom-boost` 与 `--xy-edge-stroke-width` 写到 `.react-flow` 根节点，默认 fitView 下描边保持可读。
- 任务页人工介入可直接回复，不再静默只打 Hub（#272）。
- Reaper 不再把健康沙箱里的单条长工具调用判成产出停滞：`tool.call.started` 写入语义进度与 `runtime_activity`，在飞工具且 lease 仍有效时跳过 stall；`deepsonar-chrome-audit/test/fuzz` 另有 5400/10800s 下限。全局 `DEEPSONAR_JOB_STALL_SEC` 默认仍为 900s。
- 官方 runtime catalog 不再被 image-admission 周期复扫按 Debian/发行版 Trivy CRITICAL 或 secret 自动吊销；第三方仍保持 0 CRITICAL / 0 secret。仅有吊销版本时任务启动返回 `409 RUNTIME_IMAGE_REVOKED`，不再误报 `RUNTIME_IMAGE_PLATFORM_UNAVAILABLE`。`/health` 以 `official_trust_warnings` 暴露官方默认镜像已吊销。
- Pi Provider 编辑器接受官方 `llm-pi-ai` settings YAML/JSON，提取 `baseURL` / 模型 / API key，并物化到 `.pi/agent/models.json`（#255）。
- OpenHarmony arm64 冒烟接受 qemu 上拆开的 `Connect server failed` + `Ver:` 输出（#276）：合并 `hdc version` / `hdc -v` 后出现 `Ver:` 即通过，不再要求两条都带版本；hdc 缺失或完全无版本仍 fail closed。

### 变更

- 源码、测试与文档示例禁止写死公网第三方/中转域名；需要可运行 URL 夹具时只用 `127.0.0.1` 或内网地址。产品内置官方厂商默认端点与官方发行源除外（#258）。
- 官方运行时只保留基础工具，移除 Semgrep、gitleaks、shellcheck 与 chrome-audit-scan（#267 / #266）。Finding 质量走 harness + Verify；OpenHarmony Test 的 `hdc` 钉死仍保留。

### 部署 / 升级说明

- 本版本将 Schema 升至 v36（`role_configs.runtime_knobs_json`）。已有库须先 `pnpm db:rebuild -- --plan`，再 `--apply`。
- `DEEPSONAR_JOB_STALL_SEC` / `DEEPSONAR_JOB_TOKEN_MAX_REQUESTS` / `DEFAULT_AUDIT_TIMEOUT_SEC` / `DEFAULT_VERIFY_TIMEOUT_SEC` / `PROVISION_TIMEOUT_SEC` 现为引导值：库中有键则 UI/DB 优先。lease TTL、Reaper 间隔、Gateway 超时、镜像 registry/cosign/syft/trivy/clamav pins 与巡检间隔仍只走部署 env。
- 官方 Audit / Kali / Chrome 运行时工具清单有变，发版会重建相应镜像（指纹变化）；旧 pin 不会被静默改写。

## [0.1.41] - 2026-08-20

### 新增

- 态势页增加 P0 运营总览：`GET /dashboard/overview` 聚合项目 / 任务 / Job / Finding 总量与状态分布、今日与近 7 日（Asia/Shanghai）新建 / 完成任务与新增 Finding、活跃项目 Top 5 与最近活动；关注队列仍是处置入口。
- 发布矩阵纳入官方 `deepsonar-assets-helper` 与 `deepsonar-silo`；real `up` / `pull` 优先拉 `$IMAGE_REGISTRY/deepsonar-*:$IMAGE_TAG`，缺失时分别回退 busybox pin 与 pgsty/silo。

### 修复

- `inherit_global`（缺省 / 脏 `image_strategy`）下新 Job 不再被遗留项目 RoleConfig.model 覆盖；快照 `model` / `upstream_model` / 默认 CLI 跟全局 RoleConfig + 账号主模型。批量绑定仍可不改写行上模型，但 impact 与 Provider 流程标明这些值在 inherit 下不生效。
- 官方镜像升版并 registry sync 后，项目显式 `selected_version_id` 不再静默改写；pin 无法解析而最新 trusted 可用时，readiness / 建任务返回 `409 RUNTIME_IMAGE_PIN_STALE`（点名旧 pin 与最新版本，并给出一键升级或改为跟随最新），不再 HTTP 500。市场列表对过期 pin 显示 `pin_stale`。`version_id=null` 仍跟随最新 trusted。
- 过程画布默认能看清拓扑连线（含亮色主题）；深度或筛选藏边时提示「已隐藏 N 条边」。
- 过程画布在极低 `fitView` 缩放时连线仍保持可见，不再被压成看不见。
- 桌面端筛选坞默认展开，亮色主题下「筛选节点」入口对比度可读。
- 广播账本在 0 条时仍显示「广播账本 · 0 条」空态，不再整块卸载。
- 删除 Provider 账号不再被 `failed` / `timeout` / `orphan` 的可恢复 Job 永久拦住；仅待领取与运行中/冻结 Job 返回 409。
- 侧栏仅在 `auth_required === false` 时显示「开发模式」；`/auth/status` 未就绪或失败不再误当成鉴权关闭。
- Windows PowerShell 5.1 与 pwsh 可解析 `deploy.ps1`（UTF-8 BOM + 仅 ASCII）。
- `aliyun-acr` 启动 warmup 以冻结 digest 判定本地就绪，接受同 digest 的 Docker Hub / GHCR 本地图；选定通道 pull 超时后对已核实的同 digest 其它通道重试一次。共享资产 helper 纳入 startup warmup。

### 部署 / 升级说明

- 本版本不修改数据库 Schema（仍为 v35）。
- 官方 `deepsonar-assets-helper` / `deepsonar-silo` 镜像只在本版本正式发布后才存在；在制品尚未打出前，compose 仍回退 busybox pin 与 pgsty/silo。

## [0.1.40] - 2026-08-19

### 修复

- `db:rebuild` 回填后对全部 public 基表重置 serial/bigserial 与 IDENTITY 序列：空表下次 `nextval` 为 1，非空 `MAX=N` 则下次为 `N+1`，避免官方种子表或空 `events` 跳号后撞 `events_pkey`。
- 瓷白 / 雾白下项目镜像抽屉、确认框、终端外框和各页硬编码深色岛改走 `theme-*` token，避免深字叠深底。
- 新建任务「指定时间」改为日期 + 时刻选择器，触发器始终显示完整 `YYYY-MM-DD HH:mm`；未来时刻校验只在提交时进行，不再用轮询改 `min` 打断选择。
- 角色绑定镜像下拉以完整产品名为触发器主文案，种类放次行；悬停与展开列表均可读 OpenHarmony Audit / Test / Fuzz。
- 项目运行时镜像页与全局市场共用 `pull-status` 进度面板；启用返回 `202` 或 `409 busy` 时立刻展示当前拉取任务、来源、短 digest 与失败原因。
- 任务工作台切到本次运行 / 发现 / 事实 / 报告后，过程画布不再盖住列表与报告正文。
- 移除凭证层 `allowed_model_ids` 白名单，模型可用性只认 `settings_config`，避免 GLM / DeepSeek 任务被 Gateway 403。
- Model Gateway 出站把 Claude CLI 别名 `fable` / `sonnet` / `opus` / `haiku` 改写成 Job 快照冻结的 `upstream_model`。
- `image-admission` 在 Cosign 3 未配置 identity 时跳过非法 verify，合同扫描不再必然失败。

### 部署 / 升级说明

- 本版本不修改数据库 Schema。
- 若升级前已经 `db:rebuild` 且出现 `events_pkey` 冲突，升级后再跑一次 `pnpm db:rebuild -- --apply`，或把 `events_id_seq` `setval` 到 `MAX(id)`。

## [0.1.39] - 2026-08-18

### 新增

- 每个任务提供数据库权威的 drain pause/start：暂停只阻止新 Job 领取，已运行 Job 安全收尾；列表与画布统一显示暂停中/已暂停状态。
- 项目可通过 `maxConcurrentJobs` 独立收紧 claim 配额，支持 `0` 暂停项目调度且不放宽全局硬上限。
- 模块源同步结果区分“已更新”与“已是最新”。
- 新增 Job 级“按当前配置重新执行”：保留同一 Job、画布与历史 Attempt/effect，按当前 RoleConfig、Credential、项目策略和 runtime image 完整重冻快照。

### 修复

- 启动对账批量 orphan 的 sibling Worker 不再被新 Hub 抢占恢复入口；一次任务恢复按原 Job ID 批量重新入队并建立新 Attempt，旧 unknown effect 不自动重放。未 finalize 的 normalized stream 以有界 synthetic manifest 保持可见。
- 官方镜像清单不可达时 bundled fallback 只补缺失版本，不覆盖现有引用或信任；普通网络/拉取扫描失败不再撤销官方可信版本。
- Pi Gateway 运行时补齐 `auth.json`、`provider/model` 选择与空响应失败收口，并增加无语义产出的停滞 Reaper。
- DSH 完整 package closure 统一升级并固定到 `0.1.0-rc.7`，Cordis 使用合法的 agent-spine bash 配置、唯一工具注册和显式固定 integrity 的 subprocess implementation；Base 镜像新建或复用时均执行断网 JSON-RPC 启动冒烟。
- Agent stderr 以精确脱敏、总量有界的 normalized evidence 保存，Job 错误仍保持短摘要。
- 本地 Docker/vfs 宿主增加受管容器/卷周期 desired-state 清理、非强制 runtime image GC 和磁盘水位 claim 门禁；禁止 broad prune 和删除非 DeepSonar 资源。
- Job `resume` 现明确定义为使用旧冻结快照创建新 Attempt；当前 CLI/模型/凭据/runtime identity 漂移或无法解析时稳定返回 `409 SNAPSHOT_STALE`。任务级启动中断批次也会原子拒绝 stale 快照并返回 Job IDs，不再静默使用旧模型。

### 部署 / 升级说明

- 本版本不修改数据库 Schema。
- DSH runtime 依赖闭包变化会重建 Base/Audit/Kali 镜像；发布后应等待新 runtime catalog 回写再升级生产栈。
- rootless/vfs 部署须把 `DEEPSONAR_HOST_DISK_SOURCE` 指向 Docker data-root；达到 error 水位后暂停新 claim，清理和已运行 Job继续工作。

## [0.1.38] - 2026-08-17

### 修复

- Model Gateway 对 Anthropic 同时注入 `Authorization: Bearer` 与 `x-api-key`，并在凭据 `base_url` 已含 `/v1` 时避免拼成 `/v1/v1/messages`。
- Job token 模型白名单同时覆盖 Claude CLI 别名（如 `fable`）与 settings 解析出的上游模型 ID，避免网关 403。
- Windows 主机解析 Docker Engine 默认走 named pipe，不再误用 unix socket。

### 变更

- 保留 `pnpm db:up` 独立开发库；新增 `pnpm db:up:deploy` 可将开发态改连 deploy 栈 Postgres（`POSTGRES_BIND`，与独立库互斥占用 5432）。

## [0.1.37] - 2026-08-17

### 修复

- `image-admission` 的扫描器环境变量未设置或留空时默认使用官方不可变 `@sha256` digest；显式覆盖仍必须是完整 digest，非法值继续 fail closed。
- 修复 S33 启动门禁：`project_opt_in` 专项镜像不再阻塞 Dispatcher，官方 Base/Audit/Kali 仍需就绪；`/health` 的 readiness 同时反映 Dispatcher 是否启用，启动预热失败持续输出可诊断日志并按有界退避重试。
- Attempt outcome 不再持久化完整 summary，仅保留 `summary_sha256` 与 UTF-8 `summary_bytes`；超限输入改为稳定、可重试的控制错误。
- managed gateway 增加启动预热、`Created` 残留处理和独立的 `docker run` 超时；创建或健康检查失败时按受管标签、owner 与 inspect 得到的容器 ID 限定清理，避免误删其他容器。
- skill source 启动同步支持可取消超时，等待底层 clone/rev-parse 真正收口后再重试；单个来源失败会汇总但不阻塞同轮后续来源，Scheduler 停止时主动取消同步。

### 发布说明

- 不可变 `v0.1.36` 因缺少 CHANGELOG 章节在发布元数据门禁失败，未发布任何制品；`v0.1.37` 是首个包含以上变化的正式发布。

## [0.1.35] - 2026-08-16

### 变更

- 人类用户名/密码登录增加持久化暴力破解防护：任意校验（含成功）都占额；紧桶为用户名+IP 的 5 次/5 分钟，粗桶为 IP 的 20 次/5 分钟。Web 代理写入入站 TCP peer 的 `X-Forwarded-For`，Scheduler 只信任 1 跳。IP 超限不再插入 identity 行，过期窗口在占额事务内回收。超限返回 `429 LOGIN_RATE_LIMITED`。Schema 升至 v35（`login_rate_limits`）。
- 官方运行时镜像的默认同步只拉取每个产品在所选 registry 通道上的最新版本；历史可信 digest 继续服务显式 pin 与已冻结 Job 快照。
- Provider 角色绑定行采用固定 CLI/镜像列宽，并在右侧集中显示绑定状态与模型信息，长镜像标签不再挤压控件。

### 修复

- Scheduler 启动时先监听健康端口并暴露 readiness 详情，在有效 Base/Audit/Kali 镜像全部本地可用前不启用 Dispatcher；准备失败按有界退避持续重试，避免把镜像拉取故障推迟到任务运行期。
- 项目镜像策略、角色绑定与 registry 通道变更改为异步准备：新引用验证并拉取成功后才原子保存；准备期间返回 `202 saved:false`，旧配置继续生效。Job 遇到缺失镜像时以 `runtime_image_not_ready` 失败并记录可诊断原因。
- 修复 DSH Provider 设置在 Job 快照中按 TOML 错误解析的问题，现按 DSH 原生 YAML 冻结，同时保留凭据清理边界。

### 部署 / 升级说明

- 本版本包含 Schema v35；已有数据库须先运行 `pnpm db:rebuild -- --plan` 检查，再以 `pnpm db:rebuild -- --apply` 重建回填。

## [0.1.34] - 2026-08-16

### 变更

- 更新 `deepsonar-management` 项目 Skill：补齐 standard/compose/定时任务、provision 并发、画布 Fact、广播账本与人工消息命令，并移除失效的旧 Fact 验证路径。

### 修复

- 修复 Agent 可纠正的控制输入、schema、payload 与 summary 错误会终止 Agent/Job 的问题，改为返回稳定、可重试的控制错误；`mark_job_done` summary 按 8192 UTF-8 字节限制，Attempt outcome 仅保存摘要哈希与字节数；延迟执行的 Hub/Human 决策在接受前预检，并在最终事务中重新校验。修复 #166。

## [0.1.33] - 2026-08-15

### Added

- Added full-topology PNG export to Task Canvas.

### Changed

- Task Canvas node filters and the broadcast ledger now default to compact collapsed docks and expand independently without covering the graph.
- Production provisioning now defaults to a 900-second budget; rootless Docker `vfs` deployments are documented to serialize provisioning through the database setting.

### Fixed

- Managed Gateway sidecars now carry a proxy-script revision and are rebuilt when the route contract changes, preventing stale pre-`/control/v1` proxies from surviving upgrades.
- Provision timeouts now wait for external creation and cleanup to settle, with a final Job/Attempt-label sweep for containers created after cancellation.
- Image admission validates every scanner digest at startup instead of claiming scans before discovering an empty or mutable scanner configuration. Addresses #165.

### Deployment / Upgrade Notes

- The immutable `v0.1.32` tag failed the release metadata gate before any artifact was published. `v0.1.33` is the first published release containing these changes.

## [0.1.31] - 2026-08-15

### Added

- Added `pnpm db:rebuild` to back up an existing database, apply the current `database/schema.sql` baseline, and copy overlapping columns. Scheduler boot still fail-closes on version mismatch and does not run incremental ALTER statements.

### Fixed

- Fixed Task Canvas Fact polling so the one-second lifecycle clock no longer rebuilds the five-second polling interval and floods `/canvases/:id/facts`. Closes #163.
- Fixed Job-scoped Platform Control API provisioning so `DEEPSONAR_API_BASE_URL`, `DEEPSONAR_API_TOKEN`, and `DEEPSONAR_JOB_ID` are present in Worker `Config.Env`; authentication remains disabled until the Job reaches `running`, and terminal cleanup revokes the grant. Closes #164.

## [0.1.30] - 2026-08-15

### Added

- Added `standard | compose` task kinds with explicit confirmed-Finding seed selection, immutable seed snapshots, read-only Canvas projection, governed retry validation, and matching Tasks/Findings Web entry points. Closes #161.
- Added DeepSeek Harness Provider YAML for arbitrary Pi-AI routes, task/default execution modes, model-owned third-party reasoning mappings, and governed subagent routing through `dsh-reasoning-settings`.
- Added searchable multi-select filters and redesigned Canvas broadcast and Agent Session inspection surfaces.

### Changed

- Provider-owned reasoning now uses each CLI's native contract: Claude Code `effortLevel`, Codex `model_reasoning_effort`, OpenCode `--variant`, Pi `--thinking`, and canonical DSH effort IDs mapped by model YAML.
- Runtime and Scheduler session handling now preserve exact CLI session identity, bounded diagnostics, cancellation, provisioning reconciliation, and API-only control semantics across all governed Agent CLIs.

### Fixed

- Fixed Finding verification, human evidence priority, convergence, shared-asset cleanup, and project runtime-image policy boundaries.
- Fixed the runtime-image marketplace CI smoke after RoleConfig reasoning removal and made its Job cleanup retry PostgreSQL deadlocks without leaking active real-mode sandboxes.

### Deployment / Upgrade Notes

- This release is identified by the immutable `v0.1.30` tag; runtime image tags use `0.1.30` without the `v` prefix.
- Database schema is now v34. Existing databases must be rebuilt from `database/schema.sql`; the project intentionally provides no in-place migration path.

### Runtime Images

- Base, audit, and Kali images install the checksum-pinned `dsh-reasoning-settings@0.3.0` host plugin alongside the official DSH 0.1.0-rc.6 runtime; generated headless Cordis compositions mount its inheritance and subagent-routing controls.

## [0.1.29] - 2026-08-14

### Fixed

- Fixed Chrome runtime promotion to strip BuildKit provenance attestations before assembling the clean multi-architecture index copied to ACR and Docker Hub. The failed immutable `v0.1.28` tag is not reused.

## [0.1.28] - 2026-08-13

### Added

- 增加通用 CLI 客户端上下文预算：Credential 基准、RoleConfig 覆盖、Job 冻结展示、Agent 配置包和平台导入导出均使用 1024–10000000 的统一范围；Codex/OpenCode/Pi 物化到各自受支持落点，Claude Code 只冻结展示且不伪造绝对窗口设置。该预算不会提升 Provider、模型或账号的上游能力。Refs #144
- Added DeepSeek Harness as a governed fifth Agent CLI using the official unattended JSON-RPC server, deterministic multi-turn sessions, exact-session recovery, structured event streaming, completion gating, standard Skill registry/filesystem/tool support, and Job Session archival/viewing.

### Changed

- Pinned Claude Code 2.1.231, OpenCode 1.18.18, and the official DSH 0.1.0-rc.6 JSON-RPC package closure in governed runtime images.
- Database schema is now v30. Existing databases must be rebuilt from `database/schema.sql`; the project intentionally provides no in-place migration path.

### Fixed

- 修复 Job 控制能力元数据：Claude Code、Codex、OpenCode、Pi 与 DSH 现在均如实声明已注入的 HTTP Platform Control API；支持 MCP 的运行时仍保留过渡通道，由 Agent 对每次逻辑操作自行二选一。
- 修复 Anthropic 兼容子路径网关的模型发现与凭据健康检查：按有界有序候选探测模型端点，且仅在 HTTP 404/405 时回退。
- 修复项目镜像策略投影不一致：`inherit_global` 继续继承全局镜像，`project_managed` 只使用项目角色映射；项目 RoleConfig 的遗留 `runtime_image_key` 不再通过写入、导入导出、展示或 readiness 生效。

### Deployment / Upgrade Notes

- This release is identified by the immutable `v0.1.28` tag. Rebuild existing databases for schema v30 before starting the Scheduler.

### Runtime Images

- Base, audit, and Kali images include only the pinned DSH machine runtime and official JSON-RPC components; DSH TUI, Web UI, skins, and `dsh-cc-tui` are explicitly excluded.

## [0.1.27] - 2026-08-13

### Fixed

- Fixed registry release evidence by using the clean runnable GHCR version index as the canonical digest shared with ACR and Docker Hub, while retaining full provenance on immutable `src-*` tags.

## [0.1.26] - 2026-08-13

### Fixed

- Fixed ACR and Docker Hub promotion for attested BuildKit indexes by selecting exact runnable platform manifest digests before cross-registry assembly.

## [0.1.25] - 2026-08-13

### Fixed

- Fixed Chrome Fuzz arm64 builds by using static ELF and runtime-contract checks under QEMU while retaining executable smoke tests on native arm64 runners.
- Fixed ACR and Docker Hub image promotion by filtering to supported platforms so unsupported provenance-attestation descriptors are not copied, while GHCR promotion retains provenance.
- Added a hard gate to public `POST /jobs` that requires the requested project role to be enabled.

## [0.1.24] - 2026-08-12

### Added

- Added Scheduler-owned Job Attempt/effect persistence, cancellable and reconcilable provisioning, Canvas delivery and model-usage ledgers, and bounded runtime context identity/compaction diagnostics.
- Added Pi as a governed API-only RPC runtime with a fixed static control Skill, exact session-file recovery, approved Extension loading, immutable runtime-image packaging, and real Docker RPC smoke coverage.
- Added Job-scoped Platform Control API capabilities with inline operation schemas, short-lived allowlisted tokens, idempotent invocation, terminal revocation, and PostgreSQL integration coverage for Fact, Finding, Hub decision, and Job completion.
- Added project-managed runtime-image policy and governed provider/account configuration flows across Scheduler and Web surfaces.

### Changed

- Finding verification convergence now honors `minVerifySeverity`; task reports are versioned from their convergence input and can include lower-severity pending Findings as explicitly uncovered items.
- Gateway retries transient upstream failures only before response delivery, while supported Agent CLIs resume the exact captured session with bounded retries and fail closed on identity mismatch.
- Official runtime-image admission now selects an immutable reference from the configured deployment registry and re-scans a previously revoked official digest only when the trusted catalog moves it to a different proven registry reference.
- Database schema is now v27. Existing databases must be rebuilt from `database/schema.sql`; the project intentionally provides no in-place migration path.

### Fixed

- Fixed provisioning cancellation races, late sandbox creation cleanup, Attempt undefined-resource persistence, shared-asset helper residue, and ambiguous Canvas delivery settlement after process failures.
- Fixed missing task-level reports caused by all-severity convergence, stale report inputs, and report version reuse when the convergence snapshot changes.
- Fixed ACR-only deployments revoking official images after admission attempted unreachable GHCR references, including recovery for rows already revoked by the old reference.
- Fixed Pi RPC CI startup, writable bind mounts, hard-kill recovery, exact session reuse, and bounded diagnostics when the RPC process exits early.
- Fixed oversized Gateway request error handling and shared-asset conflict paths so transient failures remain recoverable without duplicating semantic side effects.

### Deployment / Upgrade Notes

- This release is identified by the immutable `v0.1.24` tag. Runtime image tags use `0.1.24` without the `v` prefix.
- Rebuild existing databases for schema v27 before starting the Scheduler. Configure `DEEPSONAR_IMAGE_REGISTRY` to the deployment registry/namespace so official admission and runtime pulls use the same published channel.

### Runtime Images

- Base and audit images now contain the pinned Pi RPC runtime alongside the existing governed CLIs. The release reuses unchanged fingerprinted images and rebuilds only presets whose Dockerfile, manifests, build arguments, platform set, or dependencies changed.

## [0.1.23] - 2026-08-10

### Fixed

- Fixed Chrome Fuzz arm64 V8 builds by using the pinned target LLVM/compiler-runtime toolchain and arm64 sysroot paths.
- Recovered Chrome Fuzz smoke validation on x64 runners by pulling and running the immutable image with an explicit `linux/arm64` platform.

### Deployment / Upgrade Notes

- This recovery release is identified by the immutable `v0.1.23` tag. Runtime image tags use `0.1.23` without the `v` prefix.

## [0.1.21] - 2026-08-08

### Added

- Added visible live-stream thinking/reasoning output, project-level sandbox resource overrides, and three project-opt-in Chrome specialist runtimes for audit, headless/CDP testing, and real V8 fuzzing.
- Added governed terminal copy and keyboard behavior, including selection-aware Ctrl/Cmd+C and Tab/Shift+Tab passthrough.

### Changed

- Job detail terminals now open on demand, live results keep a single vertical scroller, and runtime/report convergence paths retain their durable payload and completion state.
- Runtime image catalogs expanded from six to nine official multi-architecture images, with native Chrome child builds, immutable digest assembly, and smoke-gated release publication.
- Database schema is now v24. Existing databases must be rebuilt from `database/schema.sql`; there is no incremental migration path.

### Fixed

- Fixed Job-detail Escape handling and terminal lifecycle leakage when switching Jobs.
- Fixed missing Finding report payloads that left root-active work pending, and fixed successful completion-gate continuation after a 429 being recorded as failure.
- Fixed terminal copy feedback, prompt double-scrollbars, and real-time reasoning visibility in the Job detail UI.

### Deployment / Upgrade Notes

- This release is identified by the immutable `v0.1.21` tag. Runtime image tags use `0.1.21` without the `v` prefix and must not use `latest`.
- Rebuild existing databases for schema v24 before starting the Scheduler; the repository intentionally has no in-place migration path.

### Runtime Images

- The release publishes nine official multi-architecture runtime image catalogs: the existing six plus Chrome Audit, Chrome Test, and Chrome Fuzz. Chrome images remain project-opt-in and are recorded only after immutable digest and native-architecture smoke validation.

## [0.1.20] - 2026-08-08

### Added

- Governed runtime adapters now execute Claude Code, Codex, and OpenCode through a shared capability contract with frozen Job snapshots, normalized structured events, control MCP enforcement, and fail-closed readiness checks.
- Running local-docker Jobs now expose an authenticated, permission-gated PTY terminal beside the live event stream, with bounded traffic, resize support, audit metadata, and automatic sandbox cleanup.

### Changed

- Official runtime image selection now defaults to the Aliyun ACR channel, while jobs continue to freeze governed immutable image digests.
- Production deployment guidance and runtime configuration now reflect the current provider, gateway, object-storage, and image-channel behavior.
- GitHub Releases now publish the exact validated version section from this changelog and fail before image builds when tag or compare-link metadata is inconsistent.
- Runtime image size budgets now account for the governed Codex and OpenCode native payloads while retaining explicit CI-enforced limits for base, audit, and Kali images.

### Fixed

- Hardened runtime control, task observability, semantic event fixtures, fake-mode semantic output, agent completion idempotence, and isolated Agent CLI home directories.
- Canvas viewports now re-fit after durable graph additions or removals without timer races, while preserving trace and focused-node behavior.

### Deployment / Upgrade Notes

- This release is identified by the immutable `v0.1.20` tag. Runtime image tags omit the `v` prefix; deployment can instead consume the published digest registry.
- The release workflow updates the bundled runtime registry and `deploy/.env.example` after the image catalog passes validation.

### Runtime Images

- The release workflow publishes and records the six official multi-architecture runtime image catalogs with inspected immutable digests and channel evidence.

## [0.1.19] - 2026-08-07

### Added

- Provider account settings and production deployment alignment were added.

### Changed

- Runtime image metadata and deployment image tags were synchronized for the release.

### Deployment / Upgrade Notes

- Product version is the immutable `v0.1.19` tag; image tags use `0.1.19` without the `v` prefix.

### Runtime Images

- The six-image runtime registry was published with multi-architecture digest metadata and release assets.

### Fixed

- CI skipped duplicate runtime-image smoke tests where the release pipeline already covered the same checks.

## [0.1.18] - 2026-08-07

### Fixed

- Restored the OpenHarmony vendored repository launcher checksum required by the runtime image build.

### Runtime Images

- The bundled runtime registry was synchronized for the `v0.1.18` release.

[0.4.0]: https://github.com/SummerSec/DeepSonar/compare/v0.3.3...v0.4.0
[0.3.3]: https://github.com/SummerSec/DeepSonar/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/SummerSec/DeepSonar/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/SummerSec/DeepSonar/compare/v0.2.11...v0.3.1
[0.2.11]: https://github.com/SummerSec/DeepSonar/compare/v0.2.10...v0.2.11
[0.2.10]: https://github.com/SummerSec/DeepSonar/compare/v0.2.9...v0.2.10
[0.2.9]: https://github.com/SummerSec/DeepSonar/compare/v0.2.8...v0.2.9
[0.2.8]: https://github.com/SummerSec/DeepSonar/compare/v0.2.7...v0.2.8
[0.2.3]: https://github.com/SummerSec/DeepSonar/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/SummerSec/DeepSonar/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/SummerSec/DeepSonar/compare/v0.1.46...v0.2.1
[0.2.4]: https://github.com/SummerSec/DeepSonar/compare/v0.2.3...v0.2.4
[0.2.5]: https://github.com/SummerSec/DeepSonar/compare/v0.2.4...v0.2.5
[0.2.7]: https://github.com/SummerSec/DeepSonar/compare/v0.2.6...v0.2.7
[0.2.6]: https://github.com/SummerSec/DeepSonar/compare/v0.2.5...v0.2.6
[0.1.46]: https://github.com/SummerSec/DeepSonar/compare/v0.1.45...v0.1.46
[0.1.45]: https://github.com/SummerSec/DeepSonar/compare/v0.1.44...v0.1.45
[0.1.44]: https://github.com/SummerSec/DeepSonar/compare/v0.1.43...v0.1.44
[0.1.43]: https://github.com/SummerSec/DeepSonar/compare/v0.1.42...v0.1.43
[0.1.42]: https://github.com/SummerSec/DeepSonar/compare/v0.1.41...v0.1.42
[0.1.41]: https://github.com/SummerSec/DeepSonar/compare/v0.1.40...v0.1.41
[0.1.40]: https://github.com/SummerSec/DeepSonar/compare/v0.1.39...v0.1.40
[0.1.39]: https://github.com/SummerSec/DeepSonar/compare/v0.1.38...v0.1.39
[0.1.38]: https://github.com/SummerSec/DeepSonar/compare/v0.1.37...v0.1.38
[0.1.37]: https://github.com/SummerSec/DeepSonar/compare/v0.1.36...v0.1.37
[0.1.35]: https://github.com/SummerSec/DeepSonar/compare/v0.1.34...v0.1.35
[0.1.34]: https://github.com/SummerSec/DeepSonar/compare/v0.1.33...v0.1.34
[0.1.24]: https://github.com/SummerSec/DeepSonar/compare/v0.1.23...v0.1.24
[0.1.33]: https://github.com/SummerSec/DeepSonar/compare/v0.1.32...v0.1.33
[0.1.31]: https://github.com/SummerSec/DeepSonar/compare/v0.1.30...v0.1.31
[0.1.30]: https://github.com/SummerSec/DeepSonar/compare/v0.1.29...v0.1.30
[0.1.29]: https://github.com/SummerSec/DeepSonar/compare/v0.1.28...v0.1.29
[0.1.28]: https://github.com/SummerSec/DeepSonar/compare/v0.1.27...v0.1.28
[0.1.27]: https://github.com/SummerSec/DeepSonar/compare/v0.1.26...v0.1.27
[0.1.26]: https://github.com/SummerSec/DeepSonar/compare/v0.1.25...v0.1.26
[0.1.25]: https://github.com/SummerSec/DeepSonar/compare/v0.1.24...v0.1.25
[0.1.23]: https://github.com/SummerSec/DeepSonar/compare/v0.1.22...v0.1.23
[0.1.21]: https://github.com/SummerSec/DeepSonar/compare/v0.1.20...v0.1.21
[0.1.20]: https://github.com/SummerSec/DeepSonar/compare/v0.1.19...v0.1.20
[0.1.19]: https://github.com/SummerSec/DeepSonar/compare/v0.1.18...v0.1.19
[0.1.18]: https://github.com/SummerSec/DeepSonar/compare/v0.1.17...v0.1.18
