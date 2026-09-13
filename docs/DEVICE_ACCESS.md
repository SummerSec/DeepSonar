# 真实设备接入：设备 broker + 设备租约 + 可抛弃设备机隔离

> 状态：**设计（#494）+ Phase 1 MVP as-built（#495 / #504 / #506）**。已落地 adb 与 hdc 两条 transport、设备租约、项目 opt-in + 任务级授权与审计，以及「设备任务必须允许出网」的 fail-closed 前置（#506）；Phase 2（串口/SSH、电源与复位控制、多设备池、危险操作确认、设备视图）仍为提案。真机全链路仍需在 rig + 真机上验收。
> 事实入口：本文描述设计契约；实现细节以代码、`database/schema.sql`、OpenAPI 与测试为准。

DeepSonar 的 Job 跑在硬化容器沙箱里，沙箱内**没有任何物理设备可达路径**。真机漏洞挖掘/复现（固件、IoT、路由、移动端、嵌入式）必须让 Agent 与真实设备交互。本文给出「设备如何被平台调度、隔离、授权与记账」这一层的设计。

镜像层已经预埋了设备工具链（`agent-harness/mobile-runtime.json` 的 `adb`+`hdc`、`agent-harness/openharmony-test-runtime.json` 的 `hdc`，capabilities 标记 `device-protocol`），缺的不是工具，而是调度与治理。

## 1. 现状（代码事实）

| 事实 | 位置 |
| --- | --- |
| 沙箱资源与硬化是冻结快照的一部分：cpu/memory/pids、`capDropAll`、`noNewPrivileges` | `apps/scheduler/src/config.ts` `sandboxLimits`、`jobs.agent_snapshot_json.sandbox_limits` |
| 出网是受治理的：egress 关闭时只经固定目标 sidecar（Model Gateway 与控制面） | `packages/runtime-sandbox/src/runtime-gateway.ts`、`config.gateway.*` |
| Job 级短期 capability token 由冻结快照 mint，终态吊销 | `apps/scheduler/src/domains/platform-api/tokens.ts` |
| 结构化人工介入已含 `authorization` / `credential` / `high_risk_action` / `business_decision` | `packages/shared-types/src/index.ts` |
| Job lease + Reaper（lease 过期 → orphan）、Attempt/effect 账本、统一 `transitionJob` | `apps/scheduler/src/reaper.ts`、`apps/scheduler/src/domains/job-lifecycle/` |
| 缺口 | schema 无任何 device 资源概念；Dispatcher 不感知设备；没有 broker；K8s/Kata 路径下 USB passthrough 基本不可行 |

## 2. 设计原则

1. **沙箱不直连物理设备**。设备经 broker 暴露为网络端点（adb/hdc over TCP、串口转 TCP、SSH）。直接 USB passthrough 需要 `--device`/privileged，会同时废掉沙箱硬化层。
2. **容器隔离 ≠ 设备攻击防护**。容器与宿主共享内核，USB 由宿主内核处理、在容器边界之外；DMA / BadUSB / USB Killer / USB 栈 0day 在应用层授权之前就已发生。
3. **授权与隔离正交，都要**。「授权」决定要不要冒这个险（政策、审计、前置条件）；「隔离」决定冒了险后果砸在谁头上（损失半径）。因为「插上即入侵」，唯一可控的是**哪台机器被拿下**，所以设备必须插在可抛弃的 device rig，而不是调度主机或沙箱宿主。
4. **设备按不可信输入对待**（与被审计代码同级）。
5. **Agent 只提案**：设备控制（电源、复位、刷机）走 Job 级控制 API + 调度器审计；危险操作走 `high_risk_action` 人工确认。
6. **无增量迁移**：设备表进唯一基线 `database/schema.sql`，bump `SCHEMA_VERSION`；状态用字符串，不定 Postgres enum；开放内容进 JSONB。

## 3. 目标架构

### 3.1 Device Broker（设备代理，核心新层）

独立服务，跑在 **device rig 主机**上（与调度主机、沙箱宿主物理/网络隔离）：

- 枚举本机挂载设备（`adb devices -l` / `hdc list targets` / 串口 / USB VID-PID）。
- 把设备暴露成 broker 网络端点：`adb` 走 adb-over-TCP，`hdc` 走 hdc server TCP，串口走 ser2net 类 TCP 桥，SSH 类直连。
- 设备控制面 API：power on/off（继电器/PDU）、reset、进 bootloader/DFU、串口日志、原始流。
- 强制白名单（序列号/VID-PID，默认空 = 拒绝所有，fail closed）、速率限制、append-only 审计（谁、何时、对哪台设备做了什么）。
- **不持长期密钥**：broker 被拿下也偷不到调度器/Provider 凭据。

### 3.2 资源模型与租约

三张表（基线定义见 `database/schema.sql`，实现于 #495）：

```text
devices          id, project_id(nullable=平台共享池), key, model, transport,
                 broker_ref, status(idle|leased|offline|maintenance|revoked),
                 capabilities_json, spec_json, created_at, updated_at   UNIQUE(key)
device_leases    id, device_id, job_id, attempt_id, project_id,
                 state(pending|active|released|expired|revoked),
                 granted_by, granted_at, expires_at, released_at, endpoint_json
                 -- 部分唯一索引：一设备同刻最多一个 pending/active 租约
device_events    id, device_id, lease_id, job_id, actor, action, payload_json, created_at  -- append-only
```

租约绑 **Attempt** 而不是 Job：`claimed` 后申请、`provisioning` 期间建会话、终态释放；调度器崩溃由 Reaper 回收过期租约。

### 3.3 沙箱连接契约（复用 capability token / 网关模式）

- 任务创建时可声明设备需求（`transport` + 型号/能力 + 独占 + 时长上限），**冻结进 `jobs.agent_snapshot_json`**；执行期只认冻结快照，不回读最新配置。
- Dispatcher 在 `provisioning` 前完成租借，把 broker 端点与短期租约 token 投影进沙箱环境，与现有 `deepsonar-gateway-proxy:3100/gateway` 的固定目标投影同构。
- **Phase 1 as-built（#504 / #506）**：沙箱内的 `adb` / `hdc` **直连 rig 端点**——adb 用 `ANDROID_ADB_SERVER_ADDRESS` / `ANDROID_ADB_SERVER_PORT` / `ANDROID_SERIAL`，hdc 消费通用变量 `DEEPSONAR_DEVICE_ENDPOINT`（例如 `hdc -s <endpoint>` 或 `hdc tconn <endpoint>`）。因此设备任务**必须允许出网**（`network_policy.allow_egress=true`）：在建 Job（冻结画布需求）与申请租约（校验冻结快照）两处 fail closed 返回 409 `device_not_authorized`。
- **尚未实现（原设计目标，勿当成 as-built）**：端点经固定目标 sidecar 转发、沙箱只与 broker 网关 + 短期 token 通话。因此租约 token 目前**只保护控制面**（`/session`、`/lease/release`），**不保护设备数据面**：同一 rig 上 `adb -s <其它序列号>` 仍可达，实际边界依赖「一 rig 一设备 + 网络隔离」。
- adb 场景对 Agent 透明：注入 `ANDROID_ADB_SERVER_ADDRESS` / `ANDROID_ADB_SERVER_PORT` / `ANDROID_SERIAL`，沙箱内 `adb devices` / `adb shell` 免改脚本即可用。

### 3.4 授权与隔离

- **项目级 opt-in**：项目需显式启用「允许真机设备接入」，默认关；未 opt-in 直接 `device_not_authorized`（不可重试）。
- **任务级授权**：建任务时声明设备类别/型号与时长上限并冻结进快照，作为发放租约的前置条件；Scheduler 在 acquire 时用冻结快照 + 项目 scope 重新校验，发现接口不是授权。
- **危险操作再确认**：刷机/改固件/擦除走 `high_risk_action` + `request_human`，不得由 Agent 自主执行。
- **设备机隔离**：
  - device rig = 可抛弃的廉价主机，与调度主机、其他 Job 计算物理/网络隔离；被拿下只损失该 rig。
  - 一设备一租户；rig 不持长期密钥；可快速重装。
  - USB 层：IOMMU 开、序列号/VID-PID 白名单、禁自动挂载/自动运行、非必要不给 HID、按需物理断连（managed hub/relay）。

### 3.5 威胁模型

| 攻击 | 缓解 |
| --- | --- |
| DMA（PCIe/Thunderbolt） | 设备不直连沙箱宿主；rig 开 IOMMU；最小端口 |
| BadUSB / 伪装 HID | 端口白名单；非必要不给 HID；rig 隔离 |
| USB 驱动 0day | rig 一次性/可重装；与调度主机隔离 |
| USB Killer / 电压攻击 | rig 承载物理风险；managed hub 隔离 |
| 恶意设备横向移动 | 一设备一租户；rig 不持长期密钥；网络隔离 |

## 4. 调度与生命周期

```text
Job pending → claimed（申请设备，写 pending 租约）
            → provisioning（broker /lease/acquire → active 租约 + endpoint 投影进沙箱）
            → running（沙箱内 adb/hdc 经 broker 端点）
            → 终态（释放租约 → released，设备回 idle）
崩溃/超时：Reaper 回收过期租约 → expired，设备回 idle
```

- 设备不可用（`offline`/`maintenance`/broker 不可达）：返回可重试错误 `device_not_available`，与 `runtime_image_not_ready` 同一分类口径。
- 未 opt-in / 未授权：返回不可重试错误 `device_not_authorized`，不进重试链。
- 与 `maxConcurrentProvisioning`、项目并发上限协同，避免设备抢占死锁；设备等待不得占用 provision 槽位。

## 5. 分期落地

#### Phase 1（MVP，#495 / #504 / #506；已落地）

已实现（细节以代码/测试为准）：

- 契约与类型：`packages/shared-types/src/device.ts`（`DeviceRequirement`、`DeviceLeaseGrant`、
  `deviceSandboxEnv` 投影、租约 token mint/verify、稳定错误码 `device_not_authorized` /
  `device_not_available`）。
- schema：`devices` / `device_leases` / `device_events` + `device_leases_one_active` 部分唯一索引
  （`SCHEMA_VERSION=49`）。
- broker：`apps/device-broker`（`/health`、`/devices`、`/lease/acquire`、`/lease/release`、
  `/session`；序列号白名单 fail closed、租约 TTL 上限、append-only JSONL 审计、不持模型凭据）；
  枚举 adb（`adb devices -l`）与 hdc（`hdc list targets`，过滤 `[Empty]` / `Connect server failed` 等噪声），
  租约绑定 transport 且不跨 transport 匹配；端点按 transport 配置（`DEVICE_BROKER_ADB_*` / `DEVICE_BROKER_HDC_*`，
  hdc server 默认 8710，hdc 可执行文件用 `DEVICE_BROKER_HDC_BIN`，缺 hdc 时该 transport 枚举为空即 fail closed）；
  部署见 `deploy/Dockerfile.device-broker` 与 `deploy/docker-compose.device-broker.yml`（容器不映射 USB）。
- 调度器：`apps/scheduler/src/domains/device/`（授权→broker 申请→落库，DB 部分唯一索引是
  独占性的最终仲裁者；释放失败由 broker TTL + Reaper 兜底）、Dispatcher 在 provision 前申请并
  注入端点、终态/取消释放、Reaper 回收过期租约。
- 授权：项目 opt-in（`PATCH /projects/:id/settings` `device_access_enabled`）+ 任务级
  `device` 需求（冻结进 `jobs.agent_snapshot_json.device_requirement`，按 `roles` 命中才占用设备）。
- 测试：`ci:unit:device-broker`、`ci:unit:device-lease`、`ci:integration:device-lease`、
  `ci:smoke:device`（真机 rig，未配置时 skip）。

仍未覆盖（Phase 2 或需要真机环境）：

- 真机全链路（test 角色 Job → 沙箱 → `adb shell` → Job 证据）需要一台 rig 才能验收；
  `ci:smoke:device` 在无 rig 时会明确 skip，而不是伪装通过。
- 管理与 Web UI 的设备/租约视图、多设备池与排队、危险操作人工确认。

- 一台 device rig + broker 暴露**单设备 adb-over-TCP 或 hdc-over-TCP**（复用 `mobile-runtime.json` / `openharmony-test-runtime.json` 既有 adb / hdc 能力）；`DEEPSONAR_DEVICE_TRANSPORTS`（默认 `adb`）逐 transport 开启。
- schema 加 `devices` / `device_leases` / `device_events`，bump `SCHEMA_VERSION`；Dispatcher 按冻结快照声明的 transport 租借设备；沙箱侧注入 endpoint + 短期 token。
- 项目 opt-in + 任务级授权字段 + `device_events` 审计。
- 验收：test 角色 Job 经 broker 对真机执行 `adb devices` / `adb shell <cmd>` 并回读输出落 Job 证据；回收后设备回 `idle`；未 opt-in 项目拿不到租约；审计可追溯。

#### Phase 2

- 串口 / SSH 传输；设备控制面（电源、reset、串口日志）。
- 多设备池 + 排队 + 优先级；跨设备测试矩阵（同固件多型号）。
- 危险操作 `high_risk_action` 人工确认链路。
- 管理 API / Web UI 的设备与租约视图（Phase 1 先以 DB + broker API + 审计为准）。

## 6. 非目标

- 不做 USB passthrough 进沙箱（不 privileged / 不 `--device`），不做 Kata/K8s USB 直通。
- 不削弱现有沙箱硬化（`sandboxLimits`）、egress 治理、capability token、Gateway 鉴权、Reaper 与 Attempt 账本语义。
- 不引入增量迁移，不进 Postgres enum，不在沙箱内放长期凭据。
