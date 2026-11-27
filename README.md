# DeepSonar

> **深流循迹**：让复杂的 AI 执行持续收敛。

DeepSonar 是面向安全研究与工程任务的 **AI 可信执行平台**。你提供项目范围、任务目标和可用模型，平台组织 Agent 在隔离沙箱中执行，把计划、工具调用、原始证据、发现、独立验证和报告串成可追溯的闭环。

- **模型负责规划与推理**；**平台负责权限、隔离、预算、调度、副作用账本与结果校验**。
- **核心理念**：项目以[优化人的注意力](DESIGN.md#核心理念优化人的注意力)作为需求、架构、交互和评审的共同依据；授权、安全、正确性与证据边界始终成立。

[一键部署](docs/ONE_CLICK_DEPLOYMENT.md) · [架构设计](DESIGN.md) · [文档索引](docs/README.md) · [版本发布](https://github.com/SummerSec/DeepSonar/releases) · [问题反馈](https://github.com/SummerSec/DeepSonar/issues)

---

## 核心能力

| 能力域 | 说明 |
| --- | --- |
| **多步骤任务编排** | 围绕项目创建任务（Canvas）；Hub 依据图状态提案下一步工作，Scheduler 校验权限、预算与配置后调度 Worker 执行。 |
| **全链路可核查证据** | 持久化 Job、Attempt、Agent Session、工具调用与运行产物；每条 Finding 均可追溯至结构化 Fact、原始观察与验证轮次。 |
| **发现、验证与处置分离** | 严格区分模型自述、独立技术验证（Verify）与人工处置（Disposition）；生成版本化任务报告、发现报告与 SARIF 导出。 |
| **受治理的 Agent 与能力组合** | 接入 **Claude Code**、**Pi Coding Agent** 与 **DeepSeek Harness（DSH）**，组合受准入的 Skill、Capability Pack 与专项运行镜像（不同 CLI 能力边界以适配器文档为准）。 |
| **版本化项目知识** | 管理带来源与不可变版本的 Memory 与 Skill，经独立评测/审查流转；跨项目共享仅授权指定 Skill 版本，不连带暴露来源数据与凭据。 |
| **可观测与受控长任务** | 统一查看用量账本、预算、质量指标、决策回放与人工请求；通过六档并发限制、暂停、租约、对账与断点续做管理长任务。 |
| **专项沙箱环境** | 按需启用审计、测试、移动端、二进制逆向、Chrome、OpenHarmony 等不可变 digest 镜像（镜像包含工具不等于输出已完成安全验证）。 |

> 适用于需要反复研究、执行、验证和留存证据的工作。使用前请确认对目标资产具备明确授权；所有结论仍需结合原始证据与人工判断。

---

## 工作原理

```text
项目范围与任务目标
        ↓
Hub 读取有界图状态，提出计划 / 下一步 Intent
        ↓
Scheduler 校验授权、权限、预算、凭据/CLI、镜像与能力
        ↓
Worker 在一次性隔离沙箱中执行（受控 Control API + Model Gateway）
        ↓
结构化 Fact / Artifact / Finding / Evidence 落账
        ↓
独立 Verify → 后续研究或修正 → 版本化 Report / SARIF
```

日常使用路径为 **项目 → 任务 → 工作台**：

1. 配置 Provider 账号、项目授权范围与运行资源。
2. 创建任务，明确目标、输入、可选任务契约与约束。
3. 在任务工作台的六个固定视图（总览、研究地图、事实证据、任务发现、任务运行、报告）跟踪进展。
4. 仅在缺输入、配置冲突或需人工决策时处理结构化待办，然后继续推进。
5. 结合原始证据与独立验证状态审阅结果，而不是只看最后一条消息。

> 一次 Job 成功 ≠ 整个任务完成；Finding 的技术验证状态与人工处置意见是两个独立状态机。

---

## 快速开始

### 前置条件

- **Docker 24+** 与 **Docker Compose v2**；建议至少 **4 CPU / 8 GB RAM / 20 GB 可用磁盘**（专项镜像与并发任务需要更高配置）。
- Windows 推荐使用 **PowerShell 7+** 与可运行 Linux 容器的 Docker 环境。
- 真实执行需准备模型账号、对应运行时镜像与 OpenSandbox（会产生模型及算力费用）。
- 请先阅读 [许可证](LICENSE)——当前源码**未授予通用开源许可**。
- 生产或试用部署请使用 [Releases](https://github.com/SummerSec/DeepSonar/releases) 已发布的完整版本，并配套使用同版本源码、文档与镜像清单（`main` 分支可能先于正式产物更新）。

以下命令均在所选版本的仓库根目录执行。

### 方式一：体验流程（`fake` 模式，不调用上游模型）

```bash
# Linux / macOS
./deploy/deploy.sh up fake pull

# Windows (PowerShell 7+)
pwsh -NoProfile -File .\deploy\deploy.ps1 -Action up -Mode fake -Source pull
```

打开 **http://127.0.0.1:8080**。`fake` 模式用于界面与状态机联调，不启动真实沙箱、不调用上游模型，也不能代表真实模型任务效果。

空库首次启动通过部署提供的密码文件初始化首个管理员（已有账户不会被重置），准备方式见 [部署指南 · 登录](docs/ONE_CLICK_DEPLOYMENT.md#登录)。完成账号与访问控制前，**切勿暴露到公网**。

### 方式二：启用真实执行（`real` 模式）

```bash
# Linux / macOS（默认即 up real pull，默认镜像通道为阿里云 ACR）
./deploy/deploy.sh up real pull

# Windows (PowerShell 7+)
pwsh -NoProfile -File .\deploy\deploy.ps1 -Action up -Mode real -Source pull
```

真实执行涉及宿主容器调度，请部署在专用/受控主机并按 [一键部署指南](docs/ONE_CLICK_DEPLOYMENT.md) 配置网络、存储与 OpenSandbox。请妥善备份 `deploy/.env`、`deploy/master.key` 与数据目录，严禁提交到 Git 或贴入 Issue。

### 配置模型并运行首个任务

1. 在 **凭据管理** 中添加 Provider 账号，绑定对应的 Agent CLI，填写端点、密钥与模型清单。
2. 在项目设置中配置授权账号、模型与限制，并确认 readiness 检查通过。
3. 确认所需运行时镜像就绪后，创建一个范围清晰的小任务。

> **凭据先行解析**：平台先按 Provider、模型和项目授权筛选账号，再由账号绑定的排他 CLI 决定执行器；唯一候选自动确定，多候选显式消歧，不兼容直接报错而不静默切换。账号与模型配置统一经管理界面/API 维护，每个 Job 创建时冻结快照，后续修改不影响历史 Job。详见 [Provider 与模型契约](docs/PROVIDER_ADAPTER_MODEL_DESCRIPTOR.md) 和 [Agent CLI 适配器](docs/AGENT_CLI_RUNTIME_ADAPTERS.md)。

### 常用运维命令

```bash
./deploy/deploy.sh status   # 查看服务状态
./deploy/deploy.sh logs     # 查看日志
./deploy/deploy.sh check    # 运行健康与就绪检查
./deploy/deploy.sh down     # 停止容器（保留数据卷）
```

> HTTP 200 或容器 Running 仅代表进程存活，不代表平台已就绪可领取任务；就绪条件见 [部署指南](docs/ONE_CLICK_DEPLOYMENT.md)。

---

## 架构与执行边界

DeepSonar 将 **模型提案** 与 **平台状态变更** 彻底分离：

| 层次 | 唯一职责 | 核心边界 |
| --- | --- | --- |
| **PostgreSQL / API** | 管理与审计真相 | 项目、配置、权限、状态与 append-only 审计账本；不把模型文本当状态 |
| **Canvas** | 过程编排与观察 | 任务目标、Intent、Fact、Artifact、Finding、边与广播；Agent 不可提交坐标或直接改状态 |
| **Sandbox / Evidence** | 执行与原始证据 | 进程、工具调用、Session、运行产物与过程流；不存长期凭据，不作控制队列 |
| **Scheduler** | 唯一副作用执行者 | 调度领取、状态迁移、独立 Verify/Report 派生、效果结算与资源清理 |

关键工程护栏：

- **权限最小化**：Agent 仅能持短期 Job token 经 Control API 提交结构化提案，不能凭普通输出改变平台状态。
- **配置不可变**：Job 创建时冻结 CLI、Provider/模型、不可变镜像 digest、能力清单与运行参数。
- **能力 ≠ 授权**：搜索或拉取 Skill 不会扩大凭据、网络、工具或项目访问权限。
- **可修正反馈**：规范内可修正错误返回结构化 `RepairFeedback`；权限、版本与快照不满足则 fail closed。
- **未知效果不盲目重放**：存在不确定外部副作用时转对账、人工或 `orphan`，严禁自动猜测重放。

> 以上边界用于降低执行风险，但不等于绝对安全、零误报或任意任务均可自动收敛。

---

## 项目知识与版本升级

### 项目知识（Memory & Skill）

- **Memory**：带来源的简短事实；**Skill**：带触发条件、步骤、输入输出与不适用边界的可复用方法。
- 所有知识具备不可变版本、评测/审查记录与使用反馈；普通 Job 仅读取冻结目录内已授权版本，草稿与候选不自动进入常规任务，安全撤销即时收紧在途权限。
- 状态机与隔离测试已落地，但**真实模型生成质量与知识复用收益仍未独立验收**。详见 [项目 Memory 与 Skill](docs/PROJECT_KNOWLEDGE.md)。

### 版本与维护升级

- 平台服务与 Agent 运行时分别治理；生产 Compose 强制使用 `@sha256:` 不可变 digest 与显式版本号，不使用可变 `latest`。
- 跨数据库 schema 版本升级进入维护模式：停写排空 → 冻结源库并校验备份 → 重建候选库（无启动期隐式增量 ALTER）→ 核验后激活；激活前/后恢复边界不同，无人值守升级默认关闭。
- 镜像签名与产物状态以对应 Release 的实际发布与验签证据为准。详见 [部署脚本与维护升级](deploy/README.md) 和 [升级演练](deploy/UPGRADE_REHEARSAL.md)。

---

## 本地开发

环境要求：**Node.js 20+**（宿主维护升级工具另需 Node.js 22+；开发引擎建议见 `package.json`）、**pnpm**（版本见 `package.json`）、**Docker** 与 **PostgreSQL**。

### 1. 安装依赖与配置环境变量

```bash
corepack enable
pnpm install
cp .env.example .env                 # PowerShell: Copy-Item .env.example .env
```

在根目录 `.env` 将 `AGENT_MODE` 设为 `fake`。**开发数据库为空库时**（即使禁用了 API 鉴权），启动 Scheduler 前须先准备一次管理员密码文件（已有用户的数据库无需此步，也不会重置账户）：

Bash / POSIX shell（需 OpenSSL）：

```sh
(umask 077; mkdir -m 700 .deepsonar-bootstrap-admin && set -C && \
  openssl rand -hex 32 > .deepsonar-bootstrap-admin/password)
# 生成成功后设置路径；已有密码文件时跳过生成，仅导出路径。
export DEEPSONAR_BOOTSTRAP_ADMIN_PASSWORD_FILE="$PWD/.deepsonar-bootstrap-admin/password"
```

<details>
<summary>Windows PowerShell 7.2+ 管理员密码文件生成步骤</summary>

```powershell
$dir = Join-Path (Get-Location).Path '.deepsonar-bootstrap-admin'
New-Item -ItemType Directory -Path $dir -ErrorAction Stop | Out-Null
$acl = [System.Security.AccessControl.DirectorySecurity]::new()
$acl.SetAccessRuleProtection($true, $false)
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
  $sid, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow'))
Set-Acl -LiteralPath $dir -AclObject $acl -ErrorAction Stop
$path = Join-Path $dir 'password'
$stream = [System.IO.File]::Open($path, 'CreateNew', 'Write', 'None')
try {
  $bytes = [System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
  $encoded = [System.Text.Encoding]::UTF8.GetBytes([Convert]::ToHexString($bytes))
  $stream.Write($encoded, 0, $encoded.Length)
} finally { $stream.Dispose() }
$env:DEEPSONAR_BOOTSTRAP_ADMIN_PASSWORD_FILE = $path
```

已有密码文件时跳过创建，仅将 `$env:DEEPSONAR_BOOTSTRAP_ADMIN_PASSWORD_FILE` 设为该文件绝对路径。

</details>

> 以上两种方式均不打印密码，且 `.deepsonar-bootstrap-admin` 已排除在 Git 与 Docker 构建上下文之外。切勿在命令参数、聊天或 Git 中复制密码。

### 2. 启动开发服务

在已导出上述环境变量的同一终端（或把绝对路径填入根目录 `.env` 同名变量）运行：

```bash
pnpm db:up          # 启动开发数据库（与生产 Compose 库分离，勿混用）
pnpm dev            # Scheduler: http://127.0.0.1:3100
```

另开终端启动前端：

```bash
pnpm dev:web        # Web: http://127.0.0.1:5173
```

`pnpm dev` / `pnpm dev:web` 会经 `predev` 自动构建 `shared-types`、`runtime-manual-contract` 与 `runtime-sandbox`。开发模板默认 `DEEPSONAR_AUTH_REQUIRED=false`，仅限本机联调，切勿对公网开放。

### 3. 常用验证命令

```bash
pnpm typecheck
pnpm build
pnpm ci:unit:docs-freshness
pnpm ci:images
```

按改动面补跑对应单元、集成或运行时测试（`typecheck` 不能替代行为测试）。数据库结构以 [`database/schema.sql`](database/schema.sql) 和 [`schema-version.ts`](apps/scheduler/src/schema-version.ts) 为准。

---

## 文档与源码导航

| 入口 | 内容 |
| --- | --- |
| [文档索引](docs/README.md) | 全部专题文档及 as-built / 进行中状态 |
| [DESIGN](DESIGN.md) · [系统架构](docs/architecture/README.md) | 系统模型、四层真相、十二视图、追溯矩阵与 ADR |
| [一键部署](docs/ONE_CLICK_DEPLOYMENT.md) · [部署与升级](deploy/README.md) | 环境准备、启动、运维检查与维护模式升级 |
| [Agent CLI 适配器](docs/AGENT_CLI_RUNTIME_ADAPTERS.md) | Claude Code / Pi / DSH 能力边界、归档与恢复 |
| [Provider 与模型契约](docs/PROVIDER_ADAPTER_MODEL_DESCRIPTOR.md) | 凭据管理、模型目录准入与透明 Gateway |
| [项目知识](docs/PROJECT_KNOWLEDGE.md) | Memory、Skill、不可变版本、评测与授权 |
| [运行时镜像发布](docs/RELEASE_RUNTIME_IMAGES.md) | 多架构镜像、发布清单与双平台门禁 |
| [CHANGELOG](CHANGELOG.md) · [Releases](https://github.com/SummerSec/DeepSonar/releases) | 版本变更记录与正式发布产物 |
| [AGENTS](AGENTS.md) | 仓库开发、协作、CI 分层与验收约定 |

```text
apps/scheduler/           Fastify API、调度、Hub、Verify、Research、Report、Gateway
apps/web/                 React 管理控制台与任务工作台
apps/image-admission/     第三方 OCI 镜像扫描与准入
packages/shared-types/    前后端与事件共享 Zod 契约
packages/runtime-sandbox/ 沙箱与 Agent CLI 适配器
database/                 唯一数据库 schema 基线与重建脚本
agent-harness/            单元/契约/运行时与镜像校验工具
deploy/                   生产部署、维护升级与发布资产
docs/                     架构视图、ADR 与专题文档
```

HTTP API 契约见 [OpenAPI 定义](apps/scheduler/src/openapi.ts)。

---

## 反馈与贡献

- 提交 [Issue](https://github.com/SummerSec/DeepSonar/issues) 时请附上版本号、部署方式、宿主架构、复现步骤与脱敏日志；**切勿上传真实 API Key、Token、主密钥、客户数据或未授权目标信息**。
- 涉及功能、数据结构或安全边界的改动须同步设计文档与测试；新增界面、通知、配置、工作流或自动化行为时，请按[注意力成本评审](docs/architecture/11-engineering-specs.md#11-注意力成本评审830)简要说明取舍（纯内部修改无需附表）。

---

## 许可证

当前仓库版本为专有源码，**不构成通用开源授权**。使用、复制、修改、分发、再许可或销售前，请取得 SummerSec 书面授权。

第三方组件适用各自许可证，详见 [LICENSE](LICENSE) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。历史上依法按其他许可证发布的版本仍适用其随附条款。
