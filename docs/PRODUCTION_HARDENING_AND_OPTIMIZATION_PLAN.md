# DeepFlowHunter 生产化实施、改进与优化方案

> 状态：实施提案
> 日期：2026-08-01
> 适用范围：DeepFlowHunter Scheduler、Web、Runtime Sandbox、Plane Adapter、Skill 与 API Token 管理
> 首要目标：先达到“可信用户、单节点、可审计、可恢复”的内部生产标准，再评估公网多用户与多租户。

## 1. 执行结论

DeepFlowHunter 已经具备项目、任务画布、Job 状态机、Agent Profile、Skill Source、Finding、验证链和 Plane Adapter 的原型闭环，但当前仍属于工程原型，不能直接处理真实客户的不可信代码，也不应暴露到生产网络。

生产化不应继续以增加页面和 Agent 角色为主，而应优先完成五件事：

1. 建立可信的身份、API Token 与密钥管理。
2. 把沙箱真正做成不可信代码的安全边界。
3. 修正 Job 状态机、取消、超时、重试和重启恢复。
4. 接入真实代码仓库并形成可复现的审计证据链。
5. 建立可部署、可监控、可备份、可回滚的运行体系。

Skill 与 API Token 必须成为本项目的一等能力：

- Web 中能够管理 Skill 来源、版本、信任状态和项目绑定；
- 外部 Codex、Claude Code 或自动化系统可以安装 DeepFlowHunter Management Skill，通过最小权限 API Token 管理项目和任务；
- 模型 Provider Credential 与调用 DeepFlowHunter API 的 Access Token 分开管理；
- 沙箱不得直接持有长期上游 API Key。

## 2. 生产目标分级

### 2.1 Level A：内部单节点生产

适合：一支可信团队、单个组织、私有网络、审计已授权仓库。

必须具备：

- 登录认证、API Token 和最小 RBAC；
- 单节点 Scheduler 的可靠状态机；
- 受限出网与资源受限沙箱；
- 项目、任务、Skill 和 Provider Credential 管理；
- 真实仓库输入、Commit 固定和结果追溯；
- 数据库备份、恢复、日志、指标和告警；
- CI、自动测试和依赖安全门禁。

本方案首先交付 Level A。

### 2.2 Level B：公网多用户生产

在 Level A 之上增加：

- 组织、成员与项目级权限隔离；
- 公网网关、WAF、速率限制和完善审计日志；
- Worker 与控制面分离；
- 独立沙箱宿主、rootless Docker、gVisor 或 Kata；
- 对象存储、集中日志、密钥托管和高可用数据库；
- 配额、计费、模型成本控制和滥用检测。

### 2.3 Level C：多租户恶意代码平台

这不是当前架构的小修小补目标。需要独立租户边界、专用 Worker 池、网络策略、供应链签名、机密计算或更强虚拟化隔离。没有明确商业需求前不提前建设。

## 3. 当前基线与主要问题

### 3.1 已具备的基础

- TypeScript Monorepo，类型检查和构建当前可通过；
- PostgreSQL 持久化 Job、Event、Finding、Canvas 与配置；
- Job 领取、Lease、Reaper、派生验证和 Hub 循环原型；
- Agent Profile 冻结快照；
- Git Skill Source 同步与模块展开；
- Web 项目、任务、画布、Finding、Agent 和设置页面；
- Plane 读取 Ready Issue、创建 Job 与状态回写；
- 本地项目与任务管理正在向 Plane 可选化演进。

### 3.2 生产阻断项

| 编号 | 问题 | 影响 | 优先级 |
|---|---|---|---|
| INC-01 | 已有 orphan Job 对应容器仍运行，容器环境保留真实 Provider 凭据 | 凭据泄露、额度滥用、遗留执行 | P0 |
| SEC-01 | API、WebSocket 和管理接口无鉴权 | 任意人读取结果、创建任务、修改 Agent/MCP/规则 | P0 |
| SEC-02 | restricted 网络实际为 Docker bridge，Agent 自动批准 | 不可信仓库可读取密钥并出网 | P0 |
| SEC-03 | 容器无 CPU、内存、PID、磁盘和权限硬限制 | Fork Bomb、OOM、宿主资源耗尽 | P0 |
| RUN-01 | 真实 Agent 固定审计 demo-repo，未使用任务 repo_path | 无法审计真实目标 | P0 |
| JOB-01 | 状态迁移未真正校验 from → to | 非法状态、竞态覆盖 | P0 |
| JOB-02 | cancel/timeout 可被迟到 done 覆盖为 succeeded | 状态不可信 | P0 |
| JOB-03 | provision 异常在保护范围外，且 provisioning 无有效超时 | Job 永久卡住 | P0 |
| JOB-04 | 沙箱注册表只存在内存，重启后无法回收 | orphan 容器和密钥长期残留 | P0 |
| OPS-01 | 只有开发级 PostgreSQL Compose，没有完整生产部署 | 无法可靠上线和恢复 | P1 |
| EVD-01 | 实时流未持久化，证据链和 retention 配置未实现 | 审计结果不可完整追溯 | P1 |
| QUA-01 | 缺少正式测试框架和 CI | 回归和竞态不可控 | P1 |
| DEP-01 | 生产依赖审计存在 High/Moderate 告警 | 供应链和可用性风险 | P1 |

## 4. 目标架构

```text
                     ┌─────────────────────────────┐
                     │ Web / External Agent / CI   │
                     └──────────────┬──────────────┘
                                    │ Session / DFH API Token
                                    ▼
                     ┌─────────────────────────────┐
                     │ API Gateway + Auth + RBAC   │
                     │ Rate limit / Audit / TLS    │
                     └──────────────┬──────────────┘
                                    ▼
┌──────────────┐      ┌─────────────────────────────┐      ┌───────────────┐
│ Plane        │◄────►│ Scheduler Control Plane     │◄────►│ PostgreSQL    │
│ optional     │      │ Job FSM / Skill / Secret    │      │ Truth Store   │
└──────────────┘      └──────────────┬──────────────┘      └───────────────┘
                                    │ short-lived job capability
                                    ▼
                     ┌─────────────────────────────┐
                     │ Sandbox Worker             │
                     │ no long-lived provider key │
                     │ egress allowlist + limits  │
                     └──────────────┬──────────────┘
                                    ▼
                     ┌─────────────────────────────┐
                     │ Model Gateway / Provider   │
                     │ quota / audit / key vault  │
                     └─────────────────────────────┘
```

核心真相边界：

- PostgreSQL：项目、任务、Job、配置、Skill 绑定和审计记录真相；
- Scheduler：唯一合法状态迁移与副作用执行者；
- Sandbox：不可信执行区，不持有平台长期密钥；
- Plane：可选协作镜像；
- Secret Store：Provider Credential 密文与密钥元数据；
- API Token：调用 DeepFlowHunter 的身份凭据，不等于 Provider Credential。

## 5. Skill 管理方案

本项目需要区分两种 Skill。

### 5.1 Audit Skill：下发给审计 Agent 的能力

当前 `skill_sources` 能浅克隆仓库并把文件缓存到数据库，Profile 能选择模块并冻结进 `agent_snapshot_json`。这一方向保留，但需要补齐信任、版本和安全管理。

#### 目标能力

- 管理 Git Skill Source；
- 同步并固定 Commit SHA；
- 查看同步差异和内容摘要；
- 标记 `trusted / quarantined / disabled`；
- 项目或 Profile 绑定具体 Skill Revision；
- Job 创建时冻结准确版本和内容哈希；
- 支持回滚到旧 Revision；
- 记录谁同步、谁批准、哪些 Job 使用过该版本。

#### 数据模型

在现有 `skill_sources` 基础上增量增加：

```text
skill_sources
  id, name, repo_url, branch,
  trust_status, enabled,
  last_commit_sha, last_content_hash,
  synced_at, synced_by, created_at

skill_revisions
  id, source_id, commit_sha, content_hash,
  catalog_json/blob_uri,
  scan_status, scan_summary_json,
  created_at, created_by

project_skills
  project_id, revision_id, module_id,
  enabled, config_json, created_at
```

第一阶段如果不希望立即新增三张表，可以先只给 `skill_sources` 增加 `commit_sha`、`content_hash`、`trust_status`，继续把完整 Skill 内容冻结到 Job Snapshot。出现版本历史与回滚需求后再引入 `skill_revisions`。

#### 安全要求

- 只允许 `https` 和明确批准的 `ssh` Git URL；禁止 `file://`、本地路径和任意协议；
- 设置允许域名、仓库大小、文件数、单文件大小和总内容大小上限；
- 禁止跟随符号链接读取仓库外文件；
- 拒绝路径穿越、设备文件、Socket、FIFO 和特殊文件；
- 同步动作仅限管理员或 `skills:write` Token；
- Skill Source 默认进入 quarantined，经检查后才能启用；
- Skill 中的 MCP、Shell Command 和外部 URL 需要单独权限审查；
- 记录 Commit SHA 与内容哈希，不使用不可复现的 branch HEAD 作为执行版本；
- Job 历史只能读快照，不能被后续 Skill 同步覆盖。

#### Web 页面

新增“Skill 管理”页面：

- Source 列表、连接状态、Commit、最近同步时间；
- Skill/Command 目录与文件摘要；
- 信任状态和启用状态；
- 同步、禁用、版本回滚；
- 项目绑定和 Profile 绑定；
- 哪些 Job 使用了某个 Revision；
- 扫描告警和审批记录。

### 5.2 DeepFlowHunter Management Skill：让外部 Agent 管理本项目

提供一个独立的管理 Skill，使 Codex、Claude Code 或其他 Agent 可以通过 DeepFlowHunter API 管理项目，而不依赖浏览器手工操作。

建议目录：

```text
skills/deepflowhunter-management/
  SKILL.md
  scripts/
    dfh-api.mjs
  references/
    api.md
    permissions.md
```

Management Skill 支持：

- 列出、创建、更新和归档项目；
- 创建任务、调整 pending 优先级；
- 查看任务、Job、Canvas 和 Finding；
- 取消、恢复和重试 Job；
- 查看项目配置和已启用 Skill；
- 绑定或解绑 Plane；
- 查询系统健康状态；
- 管理动作默认输出结构化 JSON，便于其他 Agent 继续处理。

Management Skill 不应支持：

- 读取 Provider Credential 明文；
- 绕过 Scheduler 直接改任意 Job 状态；
- 直接操作 Docker；
- 直接执行 SQL；
- 默认修改全局 Prompt、MCP 或 Skill 信任状态；
- 在 Skill 文件中保存 API Token。

运行配置：

```text
DFH_API_BASE_URL=https://dfh.example.com/api
DFH_API_TOKEN=<由安全存储注入>
```

Skill 必须通过 `DFH_API_TOKEN` 调用平台 API。归档项目、取消任务、解绑 Plane 等有影响操作需要明确确认或 `--yes` 参数。所有写操作使用 `Idempotency-Key`，防止 Agent 重试造成重复项目和任务。

## 6. API Token 与 Credential 管理方案

必须区分两类凭据。

### 6.1 Platform API Token

用途：用户、CI 或 Management Skill 调用 DeepFlowHunter API。

建议格式：

```text
dfh_<environment>_<public-prefix>_<secret>
```

数据库只保存：

```text
api_tokens
  id
  name
  subject_type       user | service_account
  subject_id
  project_id         nullable，非空时仅限单项目
  token_prefix       用于查找与展示
  token_hash         HMAC-SHA256 或安全哈希，不存明文
  scopes             text[]
  expires_at
  last_used_at
  last_ip
  revoked_at
  created_at
  created_by
```

Token 只在创建时展示一次，之后无法再次读取明文，只能轮换或吊销。

#### Scope 建议

```text
projects:read
projects:write
tasks:read
tasks:write
jobs:control
findings:read
skills:read
skills:write
profiles:read
profiles:write
integrations:read
integrations:write
tokens:manage
admin
```

默认 Management Skill Token 建议只授予：

```text
projects:read
projects:write
tasks:read
tasks:write
jobs:control
findings:read
skills:read
```

不要默认授予 `skills:write`、`profiles:write`、`tokens:manage` 或 `admin`。

#### 鉴权方式

```http
Authorization: Bearer dfh_prod_xxx_secret
```

服务端认证后生成统一 Actor：

```json
{
  "type": "api_token",
  "id": "token-uuid",
  "subject": "codex-automation",
  "project_id": "optional-project-scope",
  "scopes": ["tasks:write", "jobs:control"]
}
```

所有写入记录 Actor，便于追踪“谁创建了任务、谁取消了 Job、谁更新了 Skill”。

### 6.2 Provider Credential

用途：Anthropic、OpenAI、OpenRouter、Kimi、Plane、Git 等外部服务认证。

它不是平台 API Token，不能用于调用 DeepFlowHunter API。

建议数据模型：

```text
credentials
  id
  name
  kind               llm_provider | plane | git
  provider           anthropic | openai | openrouter | kimi | ...
  project_id         nullable，全局或项目级
  ciphertext
  nonce
  auth_tag
  key_version
  public_metadata_json
  fingerprint
  last4
  status             active | disabled | rotation_required
  last_used_at
  rotated_at
  created_at
  created_by

profile_credentials
  profile_id
  credential_id
  purpose
```

#### 存储要求

- 明文不写日志、不写 Job Snapshot、不返回 API；
- 数据库中使用 AES-256-GCM 或 KMS Envelope Encryption；
- 主密钥不得与密文存放在同一数据库；
- Level A 可由受保护的 `DFH_MASTER_KEY_FILE` 提供主密钥；
- Level B 使用 Vault、云 KMS 或等价 Secret Manager；
- UI 只展示 Provider、状态、指纹、末四位、创建和最近使用时间；
- 支持连接测试、禁用、轮换和使用记录；
- 删除前检查 Profile/Project 引用，默认使用禁用而不是硬删除。

#### 替换 env_keys

当前 Profile 允许任意 `env_keys`，执行时从 Scheduler `process.env` 读取。这会让任意环境变量都有机会被注入沙箱，应逐步废弃。

目标改为：

```text
Agent Profile → credential_ref → Credential Store
```

Profile 只能选择已登记、类型匹配、当前用户有权使用的 Credential。服务端维护固定的 Provider 到环境变量映射，用户不能自由填写变量名。

### 6.3 沙箱使用短期 Job Token

首选方案不是把 Provider Credential 解密后直接注入容器，而是增加 Model Gateway：

```text
Sandbox
  │ DFH_JOB_TOKEN（短期、单 Job、限模型、限额度）
  ▼
Model Gateway
  │ 解密并使用 Provider Credential
  ▼
Anthropic / OpenAI / OpenRouter / Kimi
```

`DFH_JOB_TOKEN` 应包含或关联：

- job_id；
- project_id；
- credential_id；
- 允许模型；
- 最大请求数、最大 Token 或最大费用；
- 过期时间；
- 状态：active/revoked；
- 审计记录。

Job 完成、取消、超时或 orphan 后立即吊销。即使容器残留，Token 也不能继续调用模型。

过渡期如果 Level A 暂时仍需直接注入 Provider Key，必须同时满足：

- 可信仓库；
- 单 Job 一次性容器；
- 严格出网白名单；
- 容器强制回收和启动 reconcile；
- 凭据不进入日志和实时流；
- 明确标记为临时方案，不作为公网生产标准。

### 6.4 Token 管理页面

Web 增加两个清晰分离的入口：

1. “API Token”：创建、Scope、Project 限制、过期时间、最近使用、轮换和吊销。
2. “Provider Credential”：Provider、连接状态、指纹、绑定 Profile、轮换和禁用。

页面和 API 中禁止把两者统称为一个模糊的“Token”，避免把平台访问权限与上游模型密钥混淆。

## 7. 身份、权限与审计

### 7.1 最小 RBAC

```text
viewer
  查看项目、任务、画布和 Finding

operator
  viewer + 创建任务、取消、恢复、重试

project_admin
  operator + 项目配置、Profile 绑定、项目 Skill、项目 Credential

system_admin
  全局 Profile、Skill Source、系统 Prompt、全局 Token 和系统设置
```

API Token 使用 Scope；Web 用户使用 Role。两者最终转换成同一权限判断函数，避免两套权限逻辑漂移。

### 7.2 审计日志

新增 append-only `audit_logs`：

```text
id, at,
actor_type, actor_id,
action,
project_id, resource_type, resource_id,
request_id, ip, user_agent,
before_json, after_json,
result, error_code
```

必须记录：

- 登录与认证失败；
- API Token 创建、轮换、吊销；
- Credential 创建、测试、绑定、轮换和禁用；
- Skill Source 添加、同步、信任和回滚；
- 项目和任务创建；
- Job 取消、恢复、重试；
- 全局规则、Prompt、MCP 和 Profile 修改；
- Plane 绑定与解绑。

Credential 明文、Authorization Header、Cookie 和模型 API Key 永远不进入审计日志。

## 8. Job 状态机与可靠性改造

### 8.1 原子状态迁移

将当前“目标状态直接写入”改为显式源状态：

```sql
UPDATE jobs
SET status = $to, ...
WHERE id = $id AND status = ANY($allowed_from)
RETURNING *;
```

调用方必须检查返回行。没有返回说明发生竞态或非法迁移，不得继续 provision、执行或写完成事件。

状态机规则应在三处一致：

- TypeScript 常量与测试；
- 数据库 CHECK；
- API 命令权限。

### 8.2 防止迟到事件覆盖终态

- `done` 只能将 `running` 改为 `succeeded`；
- `failed` 只能从允许状态进入；
- `cancelled/timeout/orphan` 是不可被迟到事件覆盖的终态；
- 迟到 Event 可以记录，但 Side Effect 必须返回 `ignored_terminal_state`；
- 每次执行引入 `attempt_id` 或独立 Job，Event 必须绑定准确执行尝试。

### 8.3 Provision、执行与取消

- 从 claimed 开始记录 `claimed_at`；
- provision 有独立 timeout；
- provision、execute 和 destroy 全部纳入同一异常保护；
- cancel 需要设置 cancel intent，并立即调用 Runtime stop/delete；
- destroy 失败进入可重试 cleanup queue；
- Job 节点和 Intent 节点与 Job 状态在同一事务更新；
- 失败不能只改 jobs 表而留下 running Canvas 节点。

### 8.4 重启恢复

Scheduler 启动时执行：

1. 按 `dfh.job` Label 枚举 Runtime 容器；
2. 读取数据库中 claimed/provisioning/running Job；
3. 对齐数据库与容器状态；
4. 无容器的活动 Job → orphan 或按策略重试；
5. 无活动 Job 的容器 → 强制回收；
6. 清理已过期 Job Token；
7. 记录 reconcile 结果并触发告警。

Runtime Adapter 的 destroy/isAlive 不能只依赖进程内 Map，必须能根据持久化 `sandbox_id` 重新找到真实容器。

### 8.5 幂等与数据库约束

- 本地任务创建支持 `Idempotency-Key`；
- Canvas、root node、首个 Job 在同一事务创建；
- Plane Issue 唯一约束覆盖 pending 与全部活动状态；
- `events(job_id, event_id)` 与 `(job_id, job_seq)` 唯一；
- Job sequence 使用行锁或数据库 sequence，不使用无锁 `MAX()+1`；
- 为 status、severity、verify_status、timeout、priority、followup depth 增加 CHECK；
- Migration 启动时使用 PostgreSQL advisory lock。

## 9. 沙箱安全改造

### 9.1 默认安全配置

```text
user: non-root
read_only_rootfs: true
cap_drop: ALL
no_new_privileges: true
pids_limit: configured
memory_limit: configured
cpu_limit: configured
disk_quota: configured
network: none or allowlist proxy
host gateway: disabled
docker socket: never mounted
```

每个 Job 创建独立临时目录，完成后销毁。需要写入的路径使用 tmpfs 或受限 volume。

### 9.2 网络策略

- 审计纯静态任务默认断网；
- 调用模型只能访问内部 Model Gateway；
- 验证任务需要目标网络时必须显式审批和配置目标允许列表；
- 禁止访问 RFC1918、Link-local、Metadata Service 和宿主网关；
- DNS 查询和连接记录进入 Job 审计；
- 不把 Docker bridge 当作 restricted。

### 9.3 输出与内存限制

- Agent 文本流、单个 delta、结果文件和总输出都有大小上限；
- `findings.jsonl` 在流式读取时限制行数和字节数，不先整体下载到内存；
- WebSocket 环形缓冲限制总字节，不只限制条目数；
- Job 完成后释放内存缓冲；
- 超限任务失败为明确的 `output_limit_exceeded`。

## 10. 真实代码输入与审计证据

### 10.1 代码来源

第一阶段支持：

- HTTPS Git；
- 经 Credential Store 管理的私有 Git；
- 本地管理员上传的 tar/zip；
- 明确禁止任意宿主路径直接挂载给沙箱。

任务记录：

```text
repo_url
requested_ref
resolved_commit_sha
archive_hash
file_count
total_bytes
ingested_at
```

### 10.2 代码摄入安全

- URL Scheme 和目标 Host 允许列表；
- 克隆超时、深度、大小与对象数量限制；
- Submodule 默认关闭；
- LFS 默认关闭或受控开启；
- 符号链接不得逃出仓库根；
- 解压防 Zip Slip；
- 文件类型和单文件大小限制；
- 内容送入沙箱前生成清单与哈希。

### 10.3 证据链

每个 Job 保存：

- 目标 Commit/Archive Hash；
- Agent Profile Snapshot；
- Skill Revision 与内容哈希；
- Runtime 镜像 Digest；
- Agent Provider 与模型；
- Prompt 模板版本；
- 语义 Event；
- 原始 Transcript 的对象存储 URI 和哈希；
- Finding 与验证结论；
- 创建、取消、恢复、重试 Actor。

这样才能复现“哪个版本的系统在什么代码上得出了什么结论”。

## 11. API 与集成改造

### 11.1 API 规范

- 所有请求有 request_id；
- 所有错误返回稳定 `code/message/details/request_id`；
- Zod 校验错误返回 400，不返回内部堆栈；
- 列表接口统一分页、排序和过滤；
- 写操作支持 Idempotency-Key；
- OpenAPI 作为 API 与 Management Skill 的共同契约；
- 不返回 Job 中不必要的内部字段或 Credential 引用细节。

### 11.2 Webhook

- Plane Webhook Secret 在生产环境必须配置；
- 签名基于原始 HTTP Body，不对解析后的 JSON 再 stringify；
- 增加时间戳、重放保护和 Event ID 幂等；
- Webhook 与普通 API 使用独立限流策略；
- Webhook 失败进入可重试队列。

### 11.3 Plane Adapter

- Plane 继续是可选集成；
- 请求增加超时、有限重试、指数退避和分页；
- 仅同步已绑定且 active 的项目；
- 本地 Job 状态为真，Plane 回写失败不改变本地终态；
- 回写失败记录 integration event，并支持 reconcile；
- 输出到 Plane 的 HTML 内容转义。

## 12. 部署与运维方案

### 12.1 可发布制品

需要生成并固定：

- `deepflowhunter-web:<version>`；
- `deepflowhunter-scheduler:<version>`；
- `deepflowhunter-worker:<version>` 或单节点 Runtime；
- `deepflowhunter-agent:<digest>`；
- Migration 制品；
- Management Skill Release。

Workspace Package 的 `main/exports` 指向构建后的 `dist`，Scheduler 使用 `node dist/index.js`，不在生产环境使用 `tsx src/index.ts`。

Agent 镜像中的 npm 包和基础镜像必须固定版本或 Digest，不在每次构建中无约束安装 latest。

### 12.2 单节点生产 Compose

Level A Compose 至少包括：

```text
reverse-proxy
web
scheduler
postgres
model-gateway
backup
```

要求：

- PostgreSQL 不暴露公网端口；
- 密码由 Secret File 或 Secret Manager 提供；
- restart policy；
- CPU、内存、PID 和日志轮转；
- healthcheck 与 readiness；
- 独立网络；
- 只挂载必要目录；
- TLS 终止和安全 Header；
- Scheduler 优雅退出与 drain。

### 12.3 数据库

- 自动备份与保留策略；
- 定期恢复演练；
- 生产使用 SSL；
- statement timeout、idle timeout 和连接池限制；
- Migration advisory lock；
- 大表增长监控；
- Event、Transcript 和 Audit Log retention 策略；
- 升级前备份和兼容性检查。

## 13. 可观测性与告警

### 13.1 指标

```text
jobs_created_total
jobs_active
jobs_duration_seconds
jobs_failed_total{reason}
jobs_orphan_total
sandbox_active
sandbox_cleanup_failed_total
model_requests_total
model_tokens_total
model_cost_total
provider_errors_total
queue_wait_seconds
plane_sync_errors_total
api_requests_total{route,status}
api_auth_failed_total
```

### 13.2 日志

- JSON 结构化日志；
- request_id、job_id、project_id、sandbox_id；
- Credential、Authorization、Cookie、源代码和敏感 Prompt 字段脱敏；
- console.error 逐步替换为统一 Logger；
- cleanup 和 reconcile 错误不得静默吞掉。

### 13.3 告警

- orphan 或 cleanup failure；
- Job 长时间 claimed/provisioning；
- 活动容器无对应活动 Job；
- Provider 认证失败或费用异常；
- API 认证失败突增；
- 数据库空间、连接、备份失败；
- Plane 连续同步失败；
- Token 即将过期或 Credential 需要轮换。

## 14. 测试与发布门禁

### 14.1 测试层级

单元测试：

- 状态机所有合法和非法迁移；
- Token Hash、Scope、过期和吊销；
- Credential 加解密、密钥轮换和脱敏；
- Skill URL、路径、符号链接和大小校验；
- Finding、Hub、Role 输出解析。

数据库集成测试：

- Migration 从空库和旧版本升级；
- Canvas + root + Job 原子创建；
- 并发 claim；
- event_id、job_seq 幂等；
- cancel/done、timeout/done 竞态；
- Plane 重复 Issue；
- API Token Project Scope。

Runtime 测试：

- provision 失败；
- Scheduler 在运行中崩溃；
- Container 在运行中崩溃；
- cancel 能立即终止；
- orphan 能从新进程回收；
- CPU、内存、PID、输出限制生效；
- 沙箱不能访问宿主、内网或非允许域名；
- 沙箱无法使用过期 Job Token。

浏览器 E2E：

- 登录；
- 创建项目与任务；
- 管理 Skill 与 Credential；
- 创建和吊销 API Token；
- 运行、取消、恢复、重试；
- 查看画布、Finding、执行历史和审计日志。

Management Skill E2E：

- 使用项目级 Token 创建任务；
- Scope 不足时返回 403；
- 重试请求不会重复创建；
- Token 吊销后立即失效；
- 不能读取 Provider Credential。

### 14.2 CI 门禁

每次合并必须通过：

```text
format/lint
typecheck
unit tests
database integration tests
build
browser smoke test
dependency audit
secret scan
container image scan
migration compatibility check
```

High 漏洞必须修复，或有明确的不可达性证明、负责人和到期时间。不能只依靠“传递依赖、目前没启用”长期忽略。

## 15. 前端优化

### 15.1 功能优先

优先补齐：

- 登录和当前身份；
- API Token 管理；
- Provider Credential 管理；
- Skill Source、Revision、信任和项目绑定；
- 真实仓库输入；
- Job 执行历史与 cleanup 状态；
- 审计日志；
- 系统健康与告警状态。

### 15.2 性能

- 路由级动态 import；
- React Flow 与 ELK 独立 Chunk；
- 中文字体只保留使用的格式与字重；
- 大画布按节点范围或层级加载；
- 任务、Finding 和 Event 列表使用游标分页；
- WebSocket 断线重连和 Last-Event/Seq 补偿；
- 避免全页面固定 5 秒轮询。

### 15.3 交互约束

- 不允许通过看板拖拽直接伪造 Job 终态；
- cancel、retry、archive、revoke token 等操作清楚展示后果；
- Provider Credential 永远不回显明文；
- Skill 升级展示 Commit 与差异；
- 明确区分任务聚合状态与某次 Job 尝试状态。

## 16. 分阶段实施路线

### P0：立即处置与冻结风险

目标：先停止凭据和遗留容器风险扩散。

- [ ] 轮换已经进入 orphan 容器的 Provider Credential；
- [ ] 停止和删除遗留容器；
- [ ] 枚举所有 `dfh.job` 容器并与数据库核对；
- [ ] Scheduler、Web、PostgreSQL 暂时只绑定可信网络；
- [ ] 禁止使用不可信外部仓库；
- [ ] 暂停任意 env_keys 和任意 MCP 下发；
- [ ] 建立事件记录，不在文档或日志中保存密钥明文。

验收：无数据库终态 Job 对应的运行容器；现有泄露面涉及的长期 Key 均已失效。

### P1：可信单节点核心

目标：建立 Level A 的安全与可靠核心。

- [ ] Auth、RBAC、Session 和 Platform API Token；
- [ ] Provider Credential 加密存储与 Profile 引用；
- [ ] 状态机原子迁移、竞态和取消修复；
- [ ] Runtime 持久化查找、reconcile 和强制回收；
- [ ] 沙箱资源、权限和网络限制；
- [ ] 真实 Git/Archive 输入与 Commit 固定；
- [ ] Canvas + Job 原子创建与幂等；
- [ ] 数据库 CHECK 和唯一约束；
- [ ] Management Skill 最小版本。

验收：可信用户能通过 Web 或 Management Skill 安全创建真实审计任务；取消、超时、崩溃和重启不会遗留运行容器或把终态改错。

### P2：Skill、证据链和运维

目标：使结果可追溯、系统可维护。

- [ ] Skill Commit、Hash、信任状态和项目绑定；
- [ ] Job Skill/Profile/Model/Image 完整快照；
- [ ] Transcript 对象存储和 retention；
- [ ] Audit Log；
- [ ] Model Gateway 与短期 Job Token；
- [ ] 完整生产 Compose 或部署清单；
- [ ] 备份、恢复、日志、指标和告警；
- [ ] Plane timeout、retry、pagination、webhook 幂等。

验收：任意 Finding 都能追溯到代码 Commit、Skill Revision、Profile、模型、镜像和执行证据；备份可恢复。

### P3：质量、性能和发布体系

目标：让迭代不会破坏生产稳定性。

- [ ] 正式测试框架与 CI；
- [ ] 并发、故障和恶意输入演练；
- [ ] 依赖和镜像漏洞门禁；
- [ ] 前端拆包、字体和大数据分页优化；
- [ ] OpenAPI 与 Management Skill 版本化发布；
- [ ] 容量基线和性能报告；
- [ ] Runbook、升级和回滚文档。

验收：发布流程可重复，故障演练通过，关键 SLO 有监控。

### P4：按需求扩展

只有出现明确需求后再做：

- 多 Scheduler 高可用；
- Worker 节点池；
- 多租户；
- 配额、计费与成本中心；
- gVisor/Kata 专用执行集群；
- 完整通知中心和复杂项目管理。

## 17. 工作包与依赖关系

| 工作包 | 内容 | 依赖 | 交付结果 |
|---|---|---|---|
| INC | 凭据轮换、孤儿容器处置 | 无 | 当前风险收敛 |
| AUTH | 登录、RBAC、API Token、审计 Actor | INC | 控制面有身份和权限 |
| CRED | Provider Credential、加密、绑定、轮换 | AUTH | 不再使用任意 env_keys |
| JOB | 状态机、竞态、取消、幂等 | 无 | Job 状态可信 |
| RT | Runtime reconcile、资源和网络限制 | INC、JOB | 沙箱可控可回收 |
| REPO | 真实仓库摄入和 Commit 固定 | RT | 可审计真实代码 |
| SKILL | Skill 版本、信任、项目绑定 | AUTH | Skill 可管理可追溯 |
| MGMT | Management Skill 与 OpenAPI | AUTH、JOB | 外部 Agent 可安全管理项目 |
| GW | Model Gateway 与短期 Job Token | CRED、RT | 沙箱无长期 Provider Key |
| EVD | Transcript、快照、Audit Log | AUTH、JOB、SKILL | 结果可复现 |
| OPS | 生产制品、部署、备份、监控 | JOB、RT | 可稳定运行和恢复 |
| QA | 自动测试、CI、安全门禁 | 各核心工作包 | 可持续发布 |
| FE | Token、Credential、Skill 与运维 UI | AUTH、CRED、SKILL | Web 管理闭环 |

建议并行关系：

```text
INC ──► AUTH ──► CRED ──► GW
  └────► RT ◄──── JOB ──► REPO
          │        │
AUTH ──► SKILL     └────► MGMT
  └───────────────► EVD
JOB + RT + AUTH ──► OPS ──► QA
AUTH + CRED + SKILL ──────► FE
```

## 18. 上线验收清单

### 安全

- [ ] 未认证用户无法访问项目、Job、Finding、WebSocket 和设置；
- [ ] Project Token 无法访问其他项目；
- [ ] Token Scope 在每个 API 生效；
- [ ] Provider Credential 不可通过 API、日志、Job Snapshot 或 WebSocket 读取；
- [ ] 沙箱不能访问宿主、内网和非允许域名；
- [ ] 沙箱不能使用过期或已吊销 Job Token；
- [ ] Skill Source 不能通过符号链接读取服务器文件；
- [ ] Git 和 Archive 输入不能路径穿越；
- [ ] Secret Scan 无真实密钥。

### 可靠性

- [ ] provision 失败能进入终态或安全重试；
- [ ] cancel 能立即停止容器；
- [ ] cancel/timeout 不会被迟到 done 改回 succeeded；
- [ ] Scheduler 重启后能恢复或清理所有活动容器；
- [ ] 同一幂等请求不会重复创建任务；
- [ ] 同一 Plane Issue 不会出现多个活动 Job；
- [ ] 数据库 Migration 并发安全；
- [ ] 备份恢复演练通过。

### Skill 与 Token

- [ ] Skill 有 Commit、Hash、信任状态和 Job 使用记录；
- [ ] 项目能选择启用的 Skill；
- [ ] Skill 升级不改变历史 Job Snapshot；
- [ ] API Token 只显示一次，可过期、轮换和吊销；
- [ ] Management Skill 使用最小 Scope Token；
- [ ] Provider Credential 与 Platform API Token 分离；
- [ ] Credential 轮换不需要修改 Skill；
- [ ] 所有 Token 和 Skill 管理动作进入审计日志。

### 可追溯性

- [ ] Finding 可追溯到代码 Commit；
- [ ] 可追溯到 Skill Revision、Profile、Prompt、模型和镜像；
- [ ] 原始 Transcript 有保留策略和完整性 Hash；
- [ ] 能看到谁创建、取消、恢复、重试任务；
- [ ] Plane 只是镜像，不改变本地执行真相。

### 发布

- [ ] 生产构建不依赖 tsx 或源码 TypeScript 入口；
- [ ] 镜像和依赖版本固定；
- [ ] CI 全部通过；
- [ ] 生产依赖 High 漏洞为零，或有批准的不可达性证明；
- [ ] 健康、就绪、指标和告警可用；
- [ ] 回滚步骤已演练。

## 19. 暂不实施范围

为避免生产化变成无限重构，本轮明确不做：

- 重做一个完整 Plane；
- 任意拖拽修改 Job 终态；
- 通用低代码 Agent 编排平台；
- 多租户计费；
- 多区域高可用；
- 无实际需求的通用外部绑定抽象；
- 在没有安全边界前增加更多能执行任意命令的 Agent 能力。

## 20. 最终建议

实施顺序必须是：

```text
凭据和孤儿容器处置
  → 身份/API Token
  → 状态机与沙箱
  → Provider Credential/Model Gateway
  → 真实仓库
  → Skill 版本与信任
  → 证据链和生产部署
  → CI、性能和扩展
```

不要先把当前控制台包装成公网产品，也不要通过在容器里继续注入长期 Provider Key 来换取短期功能完整。DeepFlowHunter 的价值是安全地运行安全审计 Agent；如果安全边界、状态真相和证据链不可信，增加更多 Agent、Skill 或项目管理页面只会扩大风险面。

完成 P0–P2 后，可评估内部单节点生产上线。公网、多用户或处理未知恶意代码，需要在 Level A 稳定运行和完成故障演练后再进入下一阶段。
