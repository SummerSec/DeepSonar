# DeepSonar

> 深流循迹：让复杂的 AI 执行持续收敛。

DeepSonar 是面向安全研究与工程任务的 AI 执行平台。你提供项目范围、任务目标和可用模型，平台组织 Agent 在沙箱中执行，把计划、工具调用、证据、发现和报告串成可追踪的工作过程。

模型负责规划与推理；平台负责权限、隔离、预算、调度和结果校验。你可以在同一个工作台查看任务进展、追查结论来源，并在需要时介入。

[部署指南](docs/ONE_CLICK_DEPLOYMENT.md) · [文档索引](docs/README.md) · [架构设计](DESIGN.md) · [版本发布](https://github.com/SummerSec/DeepSonar/releases) · [问题反馈](https://github.com/SummerSec/DeepSonar/issues)

## 可以做什么

- **组织多步骤任务**：围绕项目创建任务，由 Hub 根据已有结果提出下一步工作，Scheduler 校验后交给 Worker 执行。
- **保留可核查的证据**：记录 Job、Attempt、Agent Session、工具调用和运行产物；Finding 可以追溯到对应观察与验证结果。
- **独立验证与报告**：将发现、技术验证和人工处置分开，生成任务报告、发现报告及 SARIF 导出，避免把模型自述直接当成确认结论。
- **组合 Agent 与工具能力**：接入 Claude Code、Pi Coding Agent 和 DeepSeek Harness（DSH），使用受治理的 Skill、Capability Pack 和运行时镜像。不同 CLI 的功能边界并不完全相同。
- **复用项目知识**：管理有来源、带版本的 Memory 与 Skill；通过独立评测和审查处理知识候选。跨项目共享只授权指定 Skill 版本，不连带开放来源项目的数据与凭据。
- **观察与控制执行**：查看用量、预算、质量指标、决策回放和人工消息状态；通过并发限制、暂停、租约和恢复机制管理长任务。
- **选择专项运行环境**：按任务需要启用审计、测试、移动端、二进制逆向、Chrome、ClickHouse 或 OpenHarmony 等镜像。工具存在不等于其输出已经完成安全验证。

适用于需要反复研究、执行、验证和留存证据的工作。使用前请确认你对目标资产具有明确授权；结果仍需结合原始证据和人工判断。

## 一个任务怎样运行

```text
项目与目标
   ↓
Hub 提出计划 / 下一步工作
   ↓
Scheduler 校验权限、预算与运行配置
   ↓
Worker 在沙箱中执行
   ↓
Fact / Artifact / Finding / Evidence
   ↓
独立验证 → 后续研究或修正 → 报告
```

日常使用路径是 **项目 → 任务 → 工作台**：

1. 配置可用模型账号、项目范围和运行资源。
2. 创建任务，说明目标、输入和约束。
3. 在工作台查看总览、研究地图、事实证据、发现、运行记录与报告。
4. 遇到缺输入、配置冲突或需要人工判断时处理提示，再继续任务。
5. 根据证据与验证状态审阅结果，而不是只看最后一条消息。

一次 Job 成功不等于整个任务完成；Finding 的技术验证状态与人的处置意见也不是同一件事。

## 快速开始

### 部署前

- Docker 24+ 和 Docker Compose v2。
- 建议至少 4 CPU、8 GB 内存、20 GB 可用磁盘；专项镜像和并发任务需要更多资源。
- Windows 推荐 PowerShell 7+ 与可运行 Linux 容器的 Docker 环境。
- 真实执行需要可用的模型账号、对应运行时镜像和 OpenSandbox；会产生模型及计算资源费用。
- 先阅读 [许可证](LICENSE)。当前源码并未授予通用使用许可。

部署请使用 [Releases](https://github.com/SummerSec/DeepSonar/releases) 中已完成发布的版本，并配套使用该版本的源码、文档和镜像清单。主分支可能先于正式产物更新；tag 已存在不代表整条发布验收已完成。

以下命令从所选版本的仓库根目录执行。

### 先体验流程，不调用模型

```bash
./deploy/deploy.sh up fake pull
```

Windows：

```powershell
pwsh -NoProfile -File .\deploy\deploy.ps1 -Action up -Mode fake -Source pull
```

浏览器打开 **http://127.0.0.1:8080**。

`fake` 模式用于状态机和界面联调，不启动真实 Agent 沙箱，也不调用上游模型；它不能证明真实模型的任务效果。

空库首次启动会创建默认管理员。登录信息见 [部署指南](docs/ONE_CLICK_DEPLOYMENT.md#登录)，首次登录后立即修改密码。完成账号与访问控制配置前，不要把服务暴露到公网。

### 启用真实执行

```bash
./deploy/deploy.sh up real pull
```

Windows：

```powershell
pwsh -NoProfile -File .\deploy\deploy.ps1 -Action up -Mode real -Source pull
```

默认 `up` 即 `up real pull`，默认镜像通道为阿里云 ACR。真实执行涉及宿主容器运行能力，请在专用或受控主机上部署，并按 [完整部署指南](docs/ONE_CLICK_DEPLOYMENT.md) 配置网络、存储和 OpenSandbox。

脚本负责生成部署配置与凭据加密主密钥，并检查服务就绪状态。请妥善备份 `deploy/.env`、`deploy/master.key` 与数据，勿提交到 Git，也不要贴进 Issue。

### 配置模型并创建首个任务

1. 在凭据管理中添加 Provider 账号，选择匹配的 Agent CLI，填写端点、密钥及可用模型配置。
2. 配置项目可用的账号、模型与必要限制，检查 readiness 提示。
3. 确认所需运行时镜像已就绪，再创建一个范围明确的小任务。

运行身份采用**凭据优先解析**：先按 Provider、模型和项目授权范围筛选账号，再确定 CLI。唯一候选可自动确定；多个候选需要消歧，显式选择与账号不兼容时会报错，不静默切换。

CLI、Provider 和模型配置通过管理界面/API 保存，不要用部署环境变量代替账号配置。每个 Job 创建时冻结运行配置；后续配置变更不会重写历史 Job。

详见 [Provider 与模型契约](docs/PROVIDER_ADAPTER_MODEL_DESCRIPTOR.md) 和 [Agent CLI 适配器](docs/AGENT_CLI_RUNTIME_ADAPTERS.md)。

### 常用运维命令

```bash
./deploy/deploy.sh status
./deploy/deploy.sh logs
./deploy/deploy.sh check
./deploy/deploy.sh down
```

`down` 保留部署数据卷。HTTP 200 或进程已启动不等于平台可以领取任务，实际就绪条件见部署指南。

## 为什么强调执行边界

DeepSonar 将模型提案与平台状态变更分开：

| 部分 | 负责什么 |
| --- | --- |
| PostgreSQL / API | 项目、配置、权限、状态和审计账本 |
| Canvas | 任务目标、计划、事实、产物与执行关系 |
| Sandbox / Evidence | 实际进程、工具调用、会话与原始证据 |
| Scheduler | 调度、状态迁移、验证与报告派生、资源清理 |

- **权限有范围**：Agent 通过 Job 级 Control API 提交结构化结果，不能靠普通输出文本直接改变平台状态。
- **配置可追溯**：Job 冻结 CLI、Provider、模型、镜像 digest、能力及运行参数。
- **能力不等于授权**：搜索或拉取 Skill 不会扩大凭据、网络、工具或项目访问权限。
- **错误可修正**：可修正错误返回结构化反馈；权限、版本和配置不满足时明确拒绝。
- **未知效果不盲目重放**：存在不确定外部副作用时进入对账或人工处理路径，而不是直接再执行一次。

这些机制降低执行风险，但不等于绝对安全、无误报或任何任务都能自动完成。

## 项目知识

项目知识分为：

- **Memory**：有来源的简短事实。
- **Skill**：可复用的方法，描述触发条件、步骤、输入输出和不适用边界。

知识有不可变版本、来源、评测/审查记录及使用反馈。普通 Job 只读取其冻结目录中有权限的版本，草稿与候选不会自动进入普通任务。安全撤销会收紧正在运行的 Job 权限。

目前已实现生命周期、权限、持久回执和独立试验流程。状态机与隔离测试不代表模型能稳定生成优质知识。真实模型效果与知识复用收益需要独立验收，当前证据与待验收范围见下方专题文档。

详见 [项目 Memory 与 Skill](docs/PROJECT_KNOWLEDGE.md)。

## 版本与升级

平台服务与 Agent 运行时使用不同的版本与准入流程。平台镜像按不可变 digest 部署，不以可变 `latest` 作为升级依据。

现有部署升级前，请阅读 [部署脚本与维护升级](deploy/README.md) 和 [升级演练](deploy/UPGRADE_REHEARSAL.md)：

- 先检查目标版本、配置预检和结构变更计划，再批准与该计划对应的 hash。
- 跨数据库结构版本升级进入维护模式，暂停业务写入与执行，排空任务及未结算效果。
- 保留源库，验证备份后在候选库完成重建；不是启动服务时自动执行增量 ALTER。
- 激活前失败与激活后异常有不同恢复边界，不能把“回滚”理解为任意时刻恢复旧数据。
- 不兼容配置会明确阻断；角色身份重置等有数据影响的选项需要单独审核。
- 无人值守升级默认关闭，启用前必须满足版本策略、维护窗口与签名验证要求。

正式版本的镜像签名与产物状态，以对应 Release 的实际发布和验签结果为准。仓库中存在签名流程代码，不代表某个版本已经完成签名。

## 本地开发

要求 Node.js 20+、pnpm（版本见 `package.json`）、Docker 与 PostgreSQL。宿主维护升级工具另要求 Node.js 22+。

```bash
corepack enable
pnpm install
cp .env.example .env                 # PowerShell: Copy-Item .env.example .env
```

在根目录 `.env` 中将 `AGENT_MODE` 设置为 `fake`，再启动开发数据库和服务：

```bash
pnpm db:up
pnpm dev
```

另开终端启动 Web：

```bash
pnpm dev:web
```

Scheduler：**http://127.0.0.1:3100**

Web：**http://127.0.0.1:5173**

开发模板默认 `DEEPSONAR_AUTH_REQUIRED=false`，仅用于本机联调，不要对公网开放。真实执行还需配置 OpenSandbox、账号与镜像。开发数据库与生产 Compose 数据库不同，注意端口和数据目录，不要把测试指向业务库。

常用检查：

```bash
pnpm typecheck
pnpm build
pnpm ci:unit:docs-freshness
pnpm ci:images
```

按改动补充对应单元、集成或运行时测试；类型检查不能替代行为验证。数据库基线以 [schema.sql](database/schema.sql) 和 [SCHEMA_VERSION](apps/scheduler/src/schema-version.ts) 为准，不在首页复制易过期的版本号。

## 文档与源码导航

| 入口 | 内容 |
| --- | --- |
| [文档索引](docs/README.md) | 专题文档及实现状态 |
| [DESIGN](DESIGN.md) / [系统架构](docs/architecture/README.md) | 系统模型、职责、约束与设计决策 |
| [一键部署](docs/ONE_CLICK_DEPLOYMENT.md) / [部署脚本](deploy/README.md) | 环境准备、启动、运维与升级 |
| [Agent CLI](docs/AGENT_CLI_RUNTIME_ADAPTERS.md) | 适配器能力、配置、Session 归档和恢复边界 |
| [项目知识](docs/PROJECT_KNOWLEDGE.md) | Memory、Skill、版本、评测与授权 |
| [运行时镜像发布](docs/RELEASE_RUNTIME_IMAGES.md) | 多架构镜像、发布清单与验证要求 |
| [CHANGELOG](CHANGELOG.md) / [Releases](https://github.com/SummerSec/DeepSonar/releases) | 变更记录与实际发布产物 |
| [AGENTS](AGENTS.md) | 仓库开发与验证约定 |

```text
apps/scheduler/           API、调度、Hub、验证、研究与报告
apps/web/                 管理控制台与任务工作台
apps/image-admission/     第三方镜像准入与扫描
packages/shared-types/    前后端共享契约
packages/runtime-sandbox/ 沙箱与 Agent CLI 适配器
database/                数据库基线
agent-harness/           测试、运行时与镜像校验
deploy/                  部署、维护升级与发布资产
docs/                    架构和专题文档
```

HTTP API 契约见 [OpenAPI 定义](apps/scheduler/src/openapi.ts)。

## 反馈与贡献

提交问题时，请提供版本、部署方式、宿主架构、复现步骤与脱敏日志。不要上传真实 API Key、Token、主密钥、客户数据或未授权目标的信息。

文档或实现建议可先提交 [Issue](https://github.com/SummerSec/DeepSonar/issues)。涉及功能、数据结构或安全边界的变更，需要同步相关设计文档与测试。

## 许可证

当前仓库版本为专有源码，**不构成通用开源授权**。使用、复制、修改、分发、再许可或销售前，请取得 SummerSec 书面授权。

第三方组件适用各自许可证。详见 [LICENSE](LICENSE) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。历史上依法按其他许可证发布的版本，仍适用其随附条款。
