# Agentbox 内置工具与运行时镜像市场 TODO 方案

> 状态：已实施（2026-08-02）
>
> 范围：Agentbox 运行时镜像、二进制工具、第三方镜像导入、角色绑定、供应链治理
>
> 原则：人只描述任务；Hub 选择角色；调度器选择可信运行环境；Agent 在环境内自主选择工具。

## 1. 目标

DeepSonar 需要为 Agent 提供稳定、可复现、默认断网的二进制工具环境，同时为后续引入社区或合作方镜像预留“镜像市场”。

目标不是让用户在新建任务时选择 Docker 镜像或填写工具参数，而是建立以下自动链路：

```text
任务标题与内容
      ↓
Hub 选择角色和执行意图
      ↓
调度器按角色、项目策略选择已启用的可信镜像
      ↓
按不可变 digest 创建 Agentbox 沙箱
      ↓
Agent 自主调用镜像内工具
      ↓
结果作为 Finding / Fact / Evidence 回到画布和 Hub
```

## 2. 当前基础

项目已经具备最小镜像能力：

- `agent-harness/image.mjs`：本地 Agentbox 镜像定义，已安装 Git、Python、ripgrep 和 Agent CLI。
- `deploy/Dockerfile.agent`：生产镜像定义，基础镜像和 npm 包版本固定。
- `DOCKER_IMAGE_AUDIT`：Scheduler 当前通过单一配置选择运行镜像。
- `packages/runtime-sandbox/src/agentbox.ts`：按传入镜像创建沙箱，并执行 CPU、内存、PIDs、cap-drop、no-new-privileges 和网络隔离。
- `apps/scheduler/src/executor-real.ts`：已经记录镜像名称和本地 digest 作为运行证据。

当前不足：

- 所有角色共用一个镜像，无法按审计语言和验证方法选择环境。
- 镜像标签可能在 Job 创建后被覆盖，当前 digest 记录发生得太晚。
- 没有统一工具清单、镜像契约、可信状态、审批和撤销能力。
- 没有第三方镜像隔离、扫描、签名验证和项目启用机制。
- 本地 `image.mjs` 与生产 `Dockerfile.agent` 存在内容漂移风险。

## 3. 第一性原理与边界

### 3.1 用户输入保持最小

普通用户创建任务时仍然只填写标题和内容，不增加以下字段：

- 镜像名称；
- 工具列表；
- 工具参数；
- CPU、内存、网络模式；
- 镜像市场版本。

这些属于系统内部执行决策。Hub 只决定“需要什么角色和意图”，Scheduler 再根据可信策略选择具体环境。

### 3.2 Agent 不能决定信任边界

Agent 可以在已分配镜像中自主选择工具，但不能：

- 拉取或运行任意新镜像；
- 修改项目的镜像启用状态；
- 获取镜像仓库凭据；
- 打开网络、特权模式或宿主挂载；
- 用任务内容覆盖服务端镜像映射。

外部事件、Plane Issue 和 Skill 内容同样不能直接指定镜像引用。

### 3.3 区分 Skill、二进制工具与 MCP

| 类型 | 作用 | 交付方式 | 信任重点 |
|---|---|---|---|
| Skill | 告诉 Agent 如何分析和使用能力 | Job Snapshot 动态下发 | 指令来源、内容哈希、版本 |
| 二进制工具 | 真正执行扫描、解析、编译或验证 | 固化在 OCI 镜像 | 镜像 digest、签名、SBOM、漏洞 |
| MCP/受控 Tool | 提供结构化参数、权限和审计接口 | Scheduler 或沙箱内受控服务 | API 白名单、参数校验、调用审计 |

仅仅把二进制放进 `PATH`，Agent 就可以通过 shell 使用。需要限制危险参数、形成结构化证据或集中审计时，再包装为 MCP/受控 Tool，不为所有命令提前增加一层封装。

## 4. 镜像分层

第一阶段只维护少量官方镜像，避免形成一个巨大且更新困难的万能镜像。**镜像体积是设计约束和 CI 硬门槛，不是发布后的优化项**：默认使用 slim 基础层，关闭 recommends，按角色拆包，禁止重复 SDK/CLI，并为每个 toolset 设置最大 MiB 预算。

| 镜像键 | 用途 | 初始内容 | 优先级 |
|---|---|---|---|
| `deepsonar-base` | Explore、Analyze、Code、Hub | git、rg、jq、file、unzip、Python、Node、ca-certificates | P0 |
| `deepsonar-audit` | Audit、Verify | `deepsonar-base` + Semgrep、Gitleaks、ShellCheck、binutils | P0 |
| `deepsonar-kali-minimal` | 需要 Kali 用户态的专项 Audit、Verify | Kali 最小 rootfs + 明确列出的 base/audit CLI；无 metapackage/GUI | P0，项目显式启用 |
| `deepsonar-build` | 需要编译或最小 PoC 的 Test | 编译器、构建工具、常见语言运行时 | P1，按需创建 |
| `deepsonar-language-*` | Java、Go、PHP、Rust 等专项审计 | 对应语言工具链与静态分析器 | P2，按真实任务增加 |
| 第三方市场镜像 | 社区或合作方专项环境 | 必须满足 DEEPSONAR 镜像契约 | P2 |

暂不默认内置：

- Metasploit、Nmap、SQLMap 等攻击面较大的工具；
- 浏览器、完整桌面环境和超大型编译环境；
- 必须实时联网才能工作的扫描器；
- 未固定版本、无法校验来源或许可证不清晰的二进制；
- 把模型密钥、仓库 Token、漏洞库凭据写进镜像的工具。

Trivy、OSV-Scanner 等依赖漏洞数据库的工具不能简单安装完成即视为可用。其数据库必须由受控更新任务下载、签名或校验后形成独立版本，并记录数据库版本和时间。

## 5. DEEPSONAR 运行时镜像契约

所有官方和市场镜像必须满足 `deepsonar.runtime.contract/v1`。

最低要求：

- OCI/Docker 镜像，提供 `linux/amd64`；推荐同时提供 `linux/arm64`。
- `/workspace` 可作为工作目录，并存在可执行的 `/bin/sh`。
- 至少包含一个项目支持的 Agent Provider 运行时。
- 启动不得依赖特权模式、宿主设备、Docker Socket 或外网。
- 不得内置凭据、SSH 私钥、云平台 metadata Token 或用户源码。
- 在 `networkMode=none`、`CapDrop=ALL`、`no-new-privileges` 下能够启动。
- 支持 `sleep infinity` 或等价的长驻命令，由 Agentbox 接管执行。
- 工具版本固定，不使用 `latest` 安装方式。
- 提供 SBOM、许可证信息和工具清单。
- 构建后的解压镜像大小不得超过 toolset 的 `maxSizeMiB`，超限直接阻断 CI/发布。

建议 OCI 标签：

```text
io.deepsonar.contract=deepsonar.runtime.contract/v1
io.deepsonar.toolset=audit
io.deepsonar.tools-manifest=/opt/deepsonar/tool-manifest.json
org.opencontainers.image.source=https://...
org.opencontainers.image.revision=<git-sha>
```

镜像内工具清单建议格式：

```json
{
  "contract": "deepsonar.runtime.contract/v1",
  "tools": [
    { "name": "semgrep", "version": "固定版本", "capabilities": ["sast"] },
    { "name": "gitleaks", "version": "固定版本", "capabilities": ["secret-scan"] }
  ],
  "platforms": ["linux/amd64", "linux/arm64"]
}
```

## 6. 镜像市场模型

“镜像市场”不是允许用户输入任意 Docker Hub 地址，而是经过平台治理的 OCI 镜像目录。官方镜像和第三方镜像使用同一套版本、审批、绑定和证据机制，只显示不同来源与信任徽章。

### 6.1 市场对象

建议拆成四类数据：

1. `runtime_images`：镜像产品身份，包括名称、slug、描述、发布者、来源、官方/第三方标识和总开关。
2. `runtime_image_versions`：不可变版本，包括 OCI 引用、digest、平台、工具清单、SBOM、签名、扫描结论和契约版本。
3. `project_runtime_images`：项目明确启用的镜像；市场可见不等于项目可执行。
4. 角色镜像绑定：`agent_roles.runtime_image_key` 或独立绑定表，只保存市场镜像键/版本策略，不接受任意引用。

Job 创建时必须冻结：

```json
{
  "runtime_image_id": "...",
  "runtime_image_version_id": "...",
  "image_ref": "registry.example/deepsonar/audit@sha256:...",
  "image_digest": "sha256:...",
  "tools_manifest_hash": "sha256:...",
  "admission_scan_id": "..."
}
```

实际 provision 必须使用带 digest 的引用，不能使用可移动 tag。历史 Job 永远保留当时执行环境，不随市场升级改变。

### 6.2 信任状态

镜像版本采用以下状态机：

```text
quarantined → scanning → trusted → disabled
                        ↘ rejected
trusted → revoked
```

- `quarantined`：刚导入，只能查看元数据，不能运行。
- `scanning`：正在完成拉取、契约、签名、SBOM、漏洞和恶意内容检查。
- `trusted`：管理员审批后可被项目启用。
- `rejected`：未通过准入，记录原因。
- `disabled`：普通停用，不再分配给新 Job。
- `revoked`：发现供应链事件或严重漏洞，立即禁止新 Job；可按策略取消尚未完成的 Job。

发布者认证和镜像版本信任分开：可信发布者的新版本仍然必须重新扫描，不能自动继承旧版本的运行权限。

### 6.3 第三方镜像准入流水线

导入流程：

1. 管理员提交 OCI registry 引用或市场清单 URL。
2. 服务端解析 tag，并立即固定为 digest。
3. 在独立扫描环境拉取镜像，不在 Scheduler 生产进程内执行第三方层内容。
4. 校验 DEEPSONAR 镜像契约、支持架构、大小限制和入口行为。
5. 验证 Cosign/OCI 签名与发布者身份；保存验证结果。
6. 生成或校验 SPDX/CycloneDX SBOM。
7. 扫描系统包、语言依赖、恶意文件、嵌入凭据、setuid 文件和许可证。
8. 在断网、cap-drop、no-new-privileges 环境运行最小 Agentbox 自检。
9. 管理员查看报告并批准；批准后项目仍需显式启用。
10. 第一次真实 Job 采用灰度并发限制，运行证据回写画布与审计日志。

第一阶段建议只允许配置过的 registry 域名。开放公共 Docker Hub 搜索和一键运行属于后续能力，不作为市场 MVP。

### 6.4 市场权限

建议新增 API Token scopes：

- `images:read`：查看市场、版本和扫描摘要。
- `images:manage`：导入镜像、同步元数据、禁用镜像。
- `images:approve`：批准、拒绝、撤销镜像版本，默认只授予平台管理员。
- 项目启用仍要求项目级写权限，且 Token 必须满足目标项目 scope。

私有 registry 凭据应作为独立 `oci_registry` Credential 管理，只在调度器拉取镜像时短暂使用，绝不注入 Agent 沙箱。

## 7. 运行时选择规则

镜像选择优先级建议固定为：

1. Job Snapshot 已冻结的不可变镜像版本；
2. 项目为该角色绑定且已启用的可信镜像；
3. 角色全局默认官方镜像；
4. `deepsonar-base` 安全兜底；
5. 无可用可信镜像则拒绝执行并记录明确错误，不回退到任意本地 tag。

Hub 只输出角色与意图，不输出镜像 ID。Scheduler 根据角色和项目策略完成选择，防止任务 prompt injection 越过供应链边界。

## 8. 分阶段 TODO

### P0：官方工具镜像基线

- [x] 为 `deepsonar-base`、`deepsonar-audit` 和 opt-in 的 `deepsonar-kali-minimal` 确定首批工具及可追溯版本。
- [x] 为下载型二进制记录来源 URL、SHA256 和许可证。
- [x] 在镜像中生成 `/opt/deepsonar/tool-manifest.json`。
- [x] 为镜像添加 OCI 来源、revision、contract 和 toolset 标签。
- [x] 保持 `agent-harness/image.mjs` 与 `deploy/Dockerfile.agent` 工具和版本一致。
- [x] 增加 CI 一致性检查，发现两份镜像定义漂移时失败。
- [x] 构建 `linux/amd64`，验证环境允许后增加 `linux/arm64`。
- [x] 以 `maxSizeMiB` 建立解压镜像大小门禁；base 使用 slim，Kali 禁止 metapackage/GUI。
- [x] 在断网、资源限制和 cap-drop 条件下跑工具冒烟测试。

验收：官方镜像可以离线执行 `rg`、`jq`、`file`、Semgrep、Gitleaks 和 ShellCheck，并输出确定版本。

### P1：可信镜像目录与角色绑定

- [x] 新增 runtime image 及 immutable version 数据模型；本项目按基线策略升级 `database/schema.sql` v7，不维护增量 migration。
- [x] 增加角色默认镜像键，项目只允许从可信且已启用目录中选择。
- [x] 把镜像版本和 digest 在 Job 创建时写入 `agent_snapshot_json`。
- [x] Agentbox provision 使用 `name@sha256:digest`，禁止只使用 tag。
- [x] 保留 `DOCKER_IMAGE_AUDIT` 作为升级期兼容值，真实 Job 无市场可信 digest 时显式失败。
- [x] 未知、禁用、拒绝或撤销的镜像在创建 Job 时直接失败。

验收：同一 Job 等待期间即使镜像 tag 被覆盖，实际执行镜像仍不改变。

### P2：镜像市场与第三方导入

- [x] 提供只读市场 API：镜像、版本、发布者、工具、平台、信任和扫描摘要。
- [x] 提供管理员导入 API，导入后固定进入 `quarantined`。
- [x] 建立独立准入扫描 Worker，不让 Scheduler 直接执行未知镜像。
- [x] 集成签名、SBOM、漏洞、恶意文件、凭据和许可证检查。
- [x] 实现批准、拒绝、禁用、撤销和版本回滚。
- [x] 私有 registry 凭据接入 Credential 管理，禁止进入 Job Snapshot 明文字段。
- [x] 所有市场管理动作写入 append-only 审计日志。

验收：第三方镜像未经扫描和管理员批准时，即使知道完整 digest 也不能创建沙箱。

### P3：前端管理

- [x] 增加独立“镜像市场”页面：搜索、发布者、工具能力、架构、版本、大小、信任徽章和扫描时间。
- [x] 镜像详情以市场页右侧独立证据抽屉呈现：digest、签名、SBOM、漏洞摘要、许可证、工具清单和变更记录。
- [x] 管理员可以导入、审批、禁用和撤销；普通用户只能查看允许内容。
- [x] 项目独立镜像市场视图允许启用可信镜像，RoleConfig 只能选择已启用镜像。
- [x] 新建任务页面不展示任何镜像或工具字段。
- [x] Job 和画布详情展示实际镜像、digest、工具版本和扫描证据。

验收：用户只输入任务内容，仍能从 Job 证据中追溯系统为什么选择某个环境。

### P4：漏洞库与持续运营

- [x] 为需要漏洞数据库的工具设计独立、可版本化的只读数据层。
- [x] 定时检查官方和第三方镜像的新 digest，但不自动替换生产版本。
- [x] 新版本重新走完整准入，管理员批准后通过项目版本固定切换。
- [x] 可信版本周期复扫失败（含严重 CVE、恶意内容或签名验证失败）时自动标记 `revoked`。
- [x] 提供受影响 Job、项目和 Finding 的反向查询。
- [x] 建立保留策略：市场无删除版本 API，历史 Job 快照、扫描和 Finding 证据不因停用/撤销删除；宿主镜像层 GC 必须保留数据库证据。

## 9. 需要修改的主要位置

| 位置 | 计划改动 |
|---|---|
| `agent-harness/image.mjs` | 本地官方镜像、工具清单和固定版本 |
| `deploy/Dockerfile.agent` | 生产官方镜像、OCI 标签、固定 digest 和工具安装 |
| `database/schema.sql` | 镜像目录、版本、项目启用、数据层和角色绑定结构（v7 唯一基线） |
| `apps/scheduler/src/config.ts` | 官方镜像兜底和允许 registry 配置 |
| `apps/scheduler/src/core.ts` / `routes.ts` | Job 创建期解析角色绑定并冻结镜像版本 |
| `apps/scheduler/src/dispatcher.ts` / `executor-real.ts` | 按 digest provision、契约复核和运行证据 |
| `packages/runtime-sandbox/` | 镜像契约自检和错误分类 |
| `apps/scheduler/src/openapi.ts` / `apps/web/src/api.ts` | 市场、版本、信任、扫描和绑定 API 契约 |
| `apps/scheduler/src/routes.ts` | 市场查询、导入、审批、启用、撤销 API |
| `apps/web/` | 镜像市场、详情、审批和项目角色绑定界面 |
| `deploy/` | registry 凭据、准入 Worker、构建与多架构发布 |

## 12. 实施落点与验证

- 独立页面：`/images`（全局市场）与 `/projects/:projectId/images`（项目启用/版本固定）。
- 定义门禁：`pnpm ci:images`；市场/API/Job 冻结冒烟：`pnpm ci:smoke:images`。
- 官方镜像 CI 使用 base/audit/kali-minimal matrix 分别构建，再以 `network=none` + `cap-drop=ALL` + `no-new-privileges` + CPU/内存/PIDs 限制运行工具冒烟并校验大小预算。Release 以 amd64/arm64 多架构发布并生成 SBOM/provenance attestations。
- 真实部署必须给 `DEEPSONAR_OFFICIAL_BASE_IMAGE` / `DEEPSONAR_OFFICIAL_AUDIT_IMAGE` 配置 digest 引用；需要精简 Kali 时另配 `DEEPSONAR_OFFICIAL_KALI_MINIMAL_IMAGE`，并在项目市场显式启用。第三方准入还必须给 Cosign/Syft/Trivy/ClamAV 扫描器自身配置 digest。

## 10. 安全红线

- 不允许 Agent、Skill、Plane 或外部事件直接传入镜像引用。
- 不运行 tag，只运行经过批准的不可变 digest。
- 不因发布者可信而跳过新版本扫描。
- 不把 registry 凭据和平台 API Token 注入沙箱。
- 不在 Scheduler 主进程内执行第三方镜像自检脚本。
- 不允许市场镜像申请 Docker Socket、privileged、宿主设备或任意目录挂载。
- 不允许镜像自行降低网络、cap-drop、资源和超时策略。
- 不把工具输出直接当成漏洞结论；输出仍需进入 Finding → Verify → Hub 验收链路。
- 不为了“支持更多工具”默认打开沙箱外网。

## 11. 完成定义

本方案完成需同时满足：

- 官方镜像工具版本、来源、摘要、SBOM 和许可证可追溯。
- 角色可以自动选择不同可信镜像，普通任务表单仍只有标题和内容。
- Job 在创建时冻结不可变镜像 digest，并在画布和审计记录中可见。
- 第三方镜像默认隔离，未审批不可运行，撤销后不能再创建新 Job。
- 镜像市场只管理可信目录，不成为任意容器执行入口。
- 所有镜像仍服从 DeepSonar 的沙箱、状态机、证据链和 Finding 验证闭环。
