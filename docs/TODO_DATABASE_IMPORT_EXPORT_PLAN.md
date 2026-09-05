# 项目数据模块化导入导出（as-built）

> 日期：2026-08-01 方案 · **2026-08-13 状态回写：产品主路径已落地**
>
> **状态：as-built（产品交付完成）** — 冲突时以 `apps/scheduler/src/transfer/`、`domains/transfer/routes.ts`、OpenAPI 与测试为准。
>
> ### 已交付能力
>
> | 能力 | 落点 |
> |------|------|
> | 包格式 | `.deepsonarpack` v1（ZIP + manifest + checksums.sha256） |
> | 表 | `data_exports` / `data_imports`（schema 基线；版本随 `SCHEMA_VERSION`） |
> | 预设 | `configuration` / `project_full` / `evidence_archive` / `custom` |
> | 模块 | project、rules、roles、skills、runtime_images、environment、integrations、credentials（元数据）、tasks、events、findings、artifacts、audit_archive |
> | 模式 | create_new + merge_configuration；预览、冲突、ID map、审计 |
> | 任务历史 | 画布/节点/边/Job/Finding/事件导入；活动 Job 归档为 cancelled，不恢复执行 |
> | Credential | **仅元数据**（`secrets.mode=metadata|excluded`，**不**导出明文 Secret） |
> | 平台包 | `deepsonar-platform-export`：全局规则、agent_roles、全局 RoleConfig、skill_sources、全局 Credential 元数据；`POST/GET /platform/exports` |
> | Web | 项目「数据」页 `TransferPanel`；平台侧导入导出入口 |
> | 安全回归 | `credential-security.integration.test.ts` 等：导出/包内不得出现 Secret |
>
> ### 明确不在当前产品范围（原方案 P2/P3 可选扩展，未纳入交付）
>
> - 便携加密 Secret 包（scrypt + AES、口令解密、`transfers:secrets`）
> - 导出包 Ed25519 签名与来源身份
> - 对象存储后端 / 定期自动备份 / restore_identity 灾备流水线
> - 冷存储 Blob 字节整包流式复制（当前以 URI/引用与证据路径为主；`include_blobs` 选项不改变「不打包明文 Secret」纪律）
>
> 下文保留原设计细节供对照；**勾选清单与「状态」以本节 as-built 为准**。

## 1. 目标

DeepSonar 需要提供应用级数据导入导出能力，满足：

- 导出一个项目的全部可迁移数据；
- 只导出配置、环境变量、角色、Skill 等部分模块；
- 把项目复制到另一套 DeepSonar 环境；
- 导入前预览影响、冲突、依赖和不可迁移项；
- 支持配置模板复用，不携带任务和历史数据；
- 支持项目完整归档，不把运行中的任务重新执行；
- 敏感数据默认不导出，需要时使用独立加密流程；
- 保留来源、版本、哈希和操作审计，保证可追溯。

这不是把 `pg_dump` 暴露给普通用户。用户导入包不能包含 SQL，也不能直接控制目标数据库。

## 2. 两类能力必须分开

### 2.1 应用级项目数据包

面向项目管理员，通过 Web/API 使用：

- 支持全项目、配置预设和自定义模块；
- 使用稳定、版本化的逻辑数据格式；
- 导入时重新校验权限、状态和业务约束；
- 支持跨版本兼容和跨环境 ID 重映射；
- 默认创建新项目，不覆盖现有项目；
- 不包含数据库账号、主密钥、可用 API Token 和短期 Job Token。

建议扩展名：`.deepsonarpack`，内部是 ZIP 容器。

### 2.2 运维级整库灾备

面向平台运维，不通过项目导入 API：

- PostgreSQL 使用 `pg_dump` / `pg_restore`；
- Blob volume 或对象存储使用对应快照/复制能力；
- Credential 主密钥文件单独备份；
- 恢复目标是整个实例，而不是把数据合并到另一个运行实例；
- 操作记录在部署和灾备文档中。

应用级导出不能替代整库灾备，整库灾备也不能作为项目复制功能。

## 3. 第一性原理

### 3.1 导出的是业务语义，不是表结构

`.deepsonarpack` 保存项目、任务、配置、Finding、报告等业务对象，不保存 `INSERT SQL`。数据库表可以继续演进，Importer 负责把旧格式迁移到当前内部结构。

### 3.2 默认安全导出

默认导出：

- 非敏感项目配置；
- 环境变量名称引用；
- 明确标记为非敏感的环境变量值；
- Credential 元数据和绑定关系；
- Skill/镜像引用、版本和哈希；
- 任务、画布、Finding、报告及证据引用。

默认不导出：

- Credential 明文；
- Scheduler 进程环境中的 Secret 值；
- API Token 明文或哈希；
- `DEEPSONAR_JOB_TOKEN` 及 `job_tokens`；
- Credential 主密钥；
- Cookie、Authorization Header；
- 数据库连接串和部署 `.env`；
- 运行容器、lease、heartbeat 和 sandbox ID。

### 3.3 导入默认是复制，不是恢复现场

默认导入会创建新的项目 ID，并进行所有内部 ID 重映射。外部集成、Plane 绑定、活动 Job 和本地路径不会在目标环境自动启用。

### 3.4 包内容全部视为不可信

即使数据包来自另一套 DeepSonar，也必须经过：

- 文件格式和版本检查；
- 路径穿越和压缩炸弹检查；
- SHA256 完整性检查；
- 可选签名验证；
- Zod/JSON Schema 校验；
- 字段长度、数量和总大小限制；
- Credential 和环境变量安全检查；
- 引用关系与项目边界检查；
- 导入预览和管理员确认。

## 4. 导出预设与模块

### 4.1 预设

| 预设 | 用途 | 默认模块 |
|---|---|---|
| `configuration` | 复用项目配置，不带任务历史 | project、rules、roles、skills、runtime_images、environment、integrations metadata |
| `project_full` | 完整迁移或项目归档 | 除受保护数据外的全部项目模块 |
| `evidence_archive` | 只归档任务结果和证据 | tasks、findings、reports、events、artifacts、audit archive |
| `custom` | 用户按模块选择 | 服务端自动补齐依赖 |

### 4.2 模块定义

| 模块键 | 内容 | 主要来源 | 依赖 |
|---|---|---|---|
| `project` | 名称、描述、状态、非敏感项目元数据 | `projects` | 无，所有导出必选 |
| `rules` | 项目规则、并发、Hub、验证和超时配置 | `projects.config_json.rules` | project |
| `roles` | 启用角色、RoleConfig、配置文件、Credential 绑定元数据 | `agent_roles`、`role_configs`、`role_config_files`、`role_credentials` | project |
| `skills` | 项目使用的 Skill Source 引用、模块选择、commit 和内容哈希 | `skill_sources`、RoleConfig/Snapshot | roles |
| `runtime_images` | 项目角色绑定的可信镜像键、digest 和工具清单引用，不含 OCI 层 | 镜像市场、RoleConfig | roles |
| `environment` | `env_vars_json` 非敏感值、`env_keys` 名称引用 | RoleConfig、历史 Profile | roles |
| `integrations` | Plane/Git/Registry 等集成元数据，不含 Secret | 项目配置、Credential 元数据 | project |
| `tasks` | Canvas、Job、节点、边和冻结 Snapshot | `canvases`、`jobs`、`canvas_nodes`、`canvas_edges` | project |
| `events` | 语义事件历史 | `events` | tasks |
| `findings` | Finding、验证结论和证据定位 | `findings` | tasks |
| `reports` | 任务报告元数据、Markdown、SARIF | `task_reports`、Blob | tasks、findings |
| `artifacts` | transcript、报告和其他 Blob 证据 | Blob URI | tasks |
| `audit_archive` | 与该项目相关的审计日志只读副本 | `audit_logs` | project |
| `credentials` | Credential 元数据；可选独立加密 Secret 包 | `credentials` | roles/integrations |

选择模块时，服务端展示并自动加入依赖。例如选择 `reports` 时必须包含 `tasks` 和 `findings`。

### 4.3 “全部数据”的准确含义

`project_full` 包含：

- 项目业务配置；
- 角色与运行配置；
- Skill 与运行时镜像的版本引用和哈希；
- 非敏感环境配置；
- 任务、Job 历史和 Job Snapshot；
- 画布节点与边；
- Finding 和验证结论；
- 报告、SARIF、transcript 和 Blob 证据；
- 项目相关事件；
- 项目审计日志的只读归档；
- Credential 元数据和绑定关系；
- 可选的便携加密 Credential Secret。

“全部”仍不包含 API Token、Job Token、主密钥、数据库账号、容器运行状态和宿主机环境 Secret。这些数据不能安全地迁移为可直接使用的状态。

## 5. `.deepsonarpack` 文件格式

### 5.1 目录结构

```text
manifest.json
checksums.sha256
data/
  project.json
  rules.json
  roles.jsonl
  role-configs.jsonl
  role-config-files.jsonl
  skills.jsonl
  runtime-images.jsonl
  environment.json
  integrations.json
  canvases.jsonl
  jobs.jsonl
  nodes.jsonl
  edges.jsonl
  events.jsonl
  findings.jsonl
  reports.jsonl
evidence/
  audit-logs.jsonl
blobs/
  <sha256>
secrets/
  portable-secrets.enc
```

未选择的模块不生成对应文件。大型集合使用 JSONL 流式写入，避免一次加载到内存。

### 5.2 Manifest

```json
{
  "format": "deepsonar-project-export",
  "format_version": "1.0",
  "created_at": "2026-08-01T00:00:00.000Z",
  "source": {
    "app_version": "0.0.1",
    "schema_migrations": ["0001_init.sql", "..."],
    "instance_id": "sha256:...",
    "project_id": "source-project-uuid",
    "project_name": "Example"
  },
  "preset": "custom",
  "modules": ["project", "rules", "roles", "environment"],
  "counts": {
    "role_configs": 8,
    "canvases": 0,
    "findings": 0
  },
  "compatibility": {
    "minimum_importer_version": "1.0",
    "module_versions": {
      "project": 1,
      "roles": 1,
      "tasks": 1
    }
  },
  "secrets": {
    "mode": "excluded",
    "algorithm": null
  },
  "signature": null
}
```

`format_version` 与数据库 migration 版本分离。数据库变化不应强迫外部导出格式同步变化。

### 5.3 完整性和签名

- `checksums.sha256` 覆盖除自身外的每个文件；
- Manifest 记录整个包的内容摘要；
- 导入时先校验摘要，再解析业务内容；
- 平台可配置 Ed25519 导出签名密钥；
- 签名用于证明来源，不能替代内容安全校验；
- 未签名包可以进入预览，但生产环境可配置为禁止应用。

## 6. 环境变量与 Credential

### 6.1 环境变量分三类

| 类型 | 示例 | 默认导出 |
|---|---|---:|
| 非敏感 RoleConfig 值 | `LANG=zh_CN.UTF-8` | 是 |
| Scheduler 环境变量名称引用 | `OPENAI_API_KEY` 名称 | 只导出名称 |
| Secret 实际值 | API Key、Token、Password | 否 |

Importer 处理：

- `env_vars_json` 经敏感名称和值扫描后导入；
- `env_keys` 只恢复名称引用，并在预览中列为“目标环境待配置”；
- 不读取或导出 Scheduler 的 `process.env` 实际值；
- 命中 `TOKEN/SECRET/PASSWORD/API_KEY/AUTHORIZATION/COOKIE` 等敏感模式的值不能进入普通数据文件；
- Secret 应迁移到 Credential Store，而不是通过普通环境变量导出。

项目导出只保存项目规则覆盖值。`global_settings` 不属于项目，不写入项目数据包；Manifest 可以记录当时解析后的有效规则用于审计，但 Importer 不能用它覆盖目标实例的全局配置。

### 6.2 Credential 默认只导出元数据

默认内容：

```json
{
  "source_id": "...",
  "name": "OpenAI Production",
  "kind": "llm_provider",
  "provider": "openai",
  "project_scope": "project",
  "public_metadata": { "base_url": "https://..." },
  "fingerprint": "...",
  "last4": "...",
  "secret_included": false
}
```

导入后创建“待映射 Credential”占位，不创建可用 Secret。管理员可以：

- 绑定目标环境已有 Credential；
- 新建 Credential；
- 使用便携加密 Secret 包恢复。

### 6.3 便携加密 Secret 包

只有显式选择“包含加密 Credential”且具备专用权限时启用：

1. 用户提供本次导出的独立口令；
2. Scheduler 在内存中解密选中的 Credential；
3. 使用 Node.js `scrypt` 从口令和随机 salt 派生 256-bit key；
4. 使用 AES-256-GCM 加密 Secret 集合；
5. 包内只保存 salt、scrypt 参数、nonce、auth tag 和密文；
6. 不保存原 Credential 主密钥；
7. 导入时用口令解密，然后用目标实例主密钥重新加密入库；
8. 明文不得写临时文件、日志、审计记录或错误消息。

便携 Secret 包要求：

- 单独的 `transfers:secrets` 权限；
- 重新确认管理员身份；
- 强口令和失败次数限制；
- 导出文件短期有效；
- 下载动作写入审计日志；
- 服务端不保存口令；
- 导入预览不能显示 Secret 内容。

### 6.4 永不导出的认证数据

- `api_tokens`：明文只在创建时出现，哈希导出也无法恢复成可用 Token；
- `job_tokens`：短期、单 Job、目标实例不可复用；
- Bootstrap Admin Token；
- Credential 主密钥；
- Registry、Git、Plane、模型 Provider 的原始请求认证头。

导入完成后必须在目标环境重新创建 API Token。

## 7. 导出流程

### 7.1 请求

```http
POST /projects/{projectId}/exports
```

```json
{
  "preset": "custom",
  "modules": ["project", "rules", "roles", "skills", "environment"],
  "credentials": {
    "mode": "metadata"
  },
  "include_blobs": false
}
```

完整导出：

```json
{
  "preset": "project_full",
  "credentials": {
    "mode": "excluded"
  },
  "include_blobs": true
}
```

### 7.2 一致性

配置导出可以在项目运行时执行。完整项目导出默认要求画布不存在活动 Job：

```text
pending / claimed / provisioning / running / waiting_human
```

如果存在活动 Job，默认返回冲突并提示等待、取消任务或只导出配置。后续可以增加“崩溃一致性归档”模式，但必须在 Manifest 标明不包含完整运行现场。

数据库读取使用 `REPEATABLE READ READ ONLY` 事务，保证一次导出中的关系数据来自同一快照。

Blob 处理：

1. 在数据库快照中收集 Blob URI 和期望哈希；
2. 流式复制到临时导出目录；
3. 重新计算 SHA256；
4. 缺失或哈希不符时终止导出或在显式允许的归档模式下标记缺失；
5. 生成 Manifest 和 checksums；
6. 原子移动为最终 `.deepsonarpack`。

### 7.3 导出状态

导出是后台管理任务，不是 Agent Job，不经过 Hub，也不创建画布节点。

状态机：

```text
pending → collecting → packaging → succeeded
                    ↘ failed
pending/collecting/packaging → cancelled
```

结果文件进入 Blob Store，设置过期时间，由下载 API 返回受控流或短期签名 URL。

## 8. 导入流程

### 8.1 阶段一：上传与隔离

```http
POST /imports
Content-Type: multipart/form-data
```

上传文件先写入隔离 Blob 前缀，不能立即应用。限制：

- 总压缩大小；
- 解压后总大小；
- 文件数量；
- 单文件大小；
- 压缩比；
- 文件名编码；
- 禁止绝对路径、`..`、反斜杠逃逸、软链接和重复文件名；
- 只允许 Manifest 声明的路径。

### 8.2 阶段二：预览

```http
POST /imports/{importId}/preview
```

预览必须输出：

```json
{
  "compatible": true,
  "source": {},
  "selected_modules": [],
  "auto_added_dependencies": [],
  "counts": {},
  "conflicts": [],
  "warnings": [],
  "credential_mappings_required": [],
  "environment_keys_required": [],
  "nonportable_paths": [],
  "disabled_integrations": [],
  "estimated_database_bytes": 0,
  "estimated_blob_bytes": 0
}
```

预览不创建项目业务数据，不解密 Secret 内容，不运行任何 Agent 或第三方代码。

### 8.3 阶段三：应用

```http
POST /imports/{importId}/apply
```

```json
{
  "mode": "create_new",
  "project_name": "Imported Project",
  "modules": ["project", "rules", "roles", "environment"],
  "conflict_policy": "rename",
  "credential_mappings": {
    "source-credential-id": "target-credential-id"
  }
}
```

Importer 只解析 JSON/JSONL 并使用参数化 SQL 写入当前 schema，绝不执行包内 SQL、Shell、Hook 或配置脚本。

## 9. 导入模式

### 9.1 `create_new`：默认推荐

- 创建新项目和新 UUID；
- 所有引用通过 ID Map 重写；
- 外部集成默认禁用；
- Credential 需要映射或安全恢复；
- 历史任务只作为历史记录，不自动继续执行；
- 适合跨环境迁移、复制和模板实例化。

### 9.2 `merge_configuration`

- 只允许配置类模块；
- 不导入任务、Job、事件、Finding 和报告；
- 对规则、角色配置、Skill 和环境配置做预览；
- 默认逐项合并，冲突可选择保留目标、使用来源或重命名；
- 每次变更写审计日志；
- 应用失败时整个配置事务回滚。

### 9.3 `restore_identity`

管理员灾难恢复模式，后续实现：

- 只允许导入到确认空白的目标环境或专用恢复实例；
- 可以保留来源 UUID；
- 要求完整签名包、兼容 schema 和独立备份；
- 不与现有项目合并；
- 不作为 Web 普通用户首期功能。

不提供“用完整项目包直接覆盖现有项目”的默认按钮。覆盖语义复杂且容易破坏证据链，应使用配置合并或专用灾备流程。

## 10. ID 重映射与引用顺序

### 10.1 ID Map

Importer 维护：

```json
{
  "projects": { "source": "target" },
  "canvases": {},
  "jobs": {},
  "nodes": {},
  "findings": {},
  "reports": {},
  "role_configs": {},
  "credentials": {}
}
```

源 ID 只作为导入证据保存，不能未经映射直接写入其他实体的外键。

### 10.2 写入顺序

```text
project
  → roles / role configs / credential mappings
  → canvases
  → jobs 第一阶段
  → canvas nodes
  → findings
  → jobs 的 parent/finding 引用第二阶段
  → canvas edges
  → events
  → reports
  → blobs
  → import provenance audit
```

Jobs 与 Findings 存在互相引用，必须两阶段写入，不能依赖偶然顺序。

### 10.3 非终态 Job

导出包中的活动 Job 不能在目标环境恢复为可执行状态：

- `pending/claimed/provisioning/running/waiting_human` 导入为 `cancelled`；
- 原始状态写入 `payload_json.import_origin.original_status`；
- 清空 `sandbox_id/lease_expires_at/heartbeat_at/claimed_at`；
- 不生成新的 `pg_notify` 待执行事件；
- 如需重新执行，用户从导入后的任务页面显式 Retry，创建新 Job。

### 10.4 外部标识

默认清理或禁用：

- 外部事件 trigger ID；
- 本地 `repo_path`；
- 私有仓库 Credential；
- OCI Registry Credential；
- 目标环境不存在的运行镜像键。

历史 `agent_snapshot_json` 也必须经过导出净化：Credential ID 转换为包内逻辑引用，导入时映射到目标 Credential；无法映射时置空并标记不可重放。Snapshot 内配置文件和环境值继续执行 Secret 扫描，不能因为属于历史 Job 就绕过导出策略。

`repo_url` 可以作为非敏感引用保留，但导入预览必须提示目标环境重新验证 Host 白名单和 Git Credential。

## 11. 模块冲突策略

| 模块 | 稳定键 | 默认策略 |
|---|---|---|
| project | 新建项目 | 名称冲突自动追加后缀 |
| rules | 配置路径 | 目标保留，逐项预览 |
| roles | role name | builtin 映射，自定义冲突重命名 |
| role configs | project + role | 创建新配置或显式覆盖 |
| skills | repo URL + branch + module ID + content hash | 以 quarantined/disabled 导入，重新审批 |
| runtime images | marketplace key + immutable digest | 只匹配目标可信目录；未知项保持 unresolved，不拉取、不运行 |
| environment | env key | 非敏感值逐项选择；Secret 只映射 Credential |
| tasks | source canvas ID | 新 UUID，不合并 |
| findings | source ID + fingerprint | 新项目内保留 fingerprint，重复时跳过并报告 |
| reports | source canvas ID | 绑定重映射后的 Canvas |
| integrations | provider + external ID | 默认禁用，要求重新绑定 |

第三方 Skill Source 和运行时镜像不能因为来自导出包就继承 `trusted` 状态，目标实例必须重新执行自己的信任和准入流程。

`.deepsonarpack` 不携带 OCI 镜像层。运行时镜像模块只保存绑定、digest、工具 Manifest 和来源元数据；需要迁移镜像制品时应通过 OCI Registry 完成。

## 12. 审计日志和证据链

### 12.1 导出审计

记录：

- 操作者；
- 项目；
- 选择模块；
- 是否包含加密 Secret；
- 导出包 SHA256；
- 记录数和字节数；
- 创建、下载、取消、过期和删除时间；
- 结果和错误码。

项目审计归档可能包含操作者标识、IP 和 User-Agent。默认导出采用脱敏模式；保留完整网络标识需要 `transfers:admin`，并在 Manifest 标记隐私级别。

不记录口令、Secret 内容和完整导出数据。

### 12.2 导入审计

记录：

- 包 SHA256、来源实例摘要和格式版本；
- 签名验证结果；
- 预览者与应用者；
- 导入模式、模块和冲突策略；
- ID Map 摘要；
- Credential 映射数量；
- 警告、失败模块和最终结果。

### 12.3 来源审计日志

包内的 `audit_archive` 不能直接插入目标 `audit_logs`，否则可以伪造目标平台审计历史。

正确处理：

- 作为只读证据 Blob 保存；
- 保存来源实例摘要、包哈希和签名状态；
- 目标 `audit_logs` 只增加一条 `project.import` 记录并引用归档；
- 前端明确区分“目标平台审计日志”和“来源归档日志”。

## 13. 数据库设计

使用实现时的下一个可用 migration 编号，例如 `00NN_project_data_transfers.sql`，避免和正在实施的 migration 编号冲突。

### 13.1 `data_exports`

```sql
CREATE TABLE data_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  preset text NOT NULL,
  modules_json jsonb NOT NULL,
  options_json jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending',
  artifact_uri text,
  artifact_sha256 text,
  artifact_size bigint,
  expires_at timestamptz,
  error_code text,
  error text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  heartbeat_at timestamptz,
  lease_expires_at timestamptz,
  attempts int NOT NULL DEFAULT 0,
  started_at timestamptz,
  finished_at timestamptz,
  CONSTRAINT data_exports_status_check
    CHECK (status IN ('pending','collecting','packaging','succeeded','failed','cancelled','expired'))
);
```

### 13.2 `data_imports`

```sql
CREATE TABLE data_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_artifact_uri text NOT NULL,
  source_sha256 text NOT NULL,
  source_manifest_json jsonb,
  target_project_id uuid REFERENCES projects(id),
  mode text,
  selected_modules_json jsonb NOT NULL DEFAULT '[]',
  options_json jsonb NOT NULL DEFAULT '{}',
  preview_json jsonb,
  id_map_json jsonb,
  status text NOT NULL DEFAULT 'uploaded',
  error_code text,
  error text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  heartbeat_at timestamptz,
  lease_expires_at timestamptz,
  attempts int NOT NULL DEFAULT 0,
  started_at timestamptz,
  finished_at timestamptz,
  CONSTRAINT data_imports_status_check
    CHECK (status IN ('uploaded','validating','preview_ready','applying','succeeded','failed','cancelled'))
);
```

`id_map_json` 只保存必要映射或映射 Blob URI；大量历史数据不能无限塞进单个 JSONB。

### 13.3 后台执行

- Export/Import 使用独立 Transfer Worker；
- 通过 `pg_notify('deepsonar_transfers')` 或等价队列唤醒；
- 不使用 Agentbox，不消耗模型，不触发 Hub；
- Transfer Worker 使用 lease、heartbeat、timeout 和重启恢复；
- 每个项目同一时间最多一个 applying import；
- 合并导入期间，项目配置写接口必须拒绝或排队；
- 上传、解包和临时 Blob 使用独立前缀，失败后可安全清理。

## 14. API 与权限

### 14.1 API

```text
POST   /projects/{id}/exports
GET    /projects/{id}/exports
GET    /exports/{id}
GET    /exports/{id}/download
POST   /exports/{id}/cancel
DELETE /exports/{id}

POST   /imports
GET    /imports/{id}
POST   /imports/{id}/preview
POST   /imports/{id}/apply
POST   /imports/{id}/cancel
DELETE /imports/{id}
```

### 14.2 API Token scopes

- `exports:read`：查看和下载自己有项目权限的导出；
- `exports:write`：创建、取消和删除导出；
- `imports:read`：查看导入预览和状态；
- `imports:write`：上传、预览和应用普通导入；
- `transfers:secrets`：导出或恢复便携加密 Secret；
- `transfers:admin`：签名策略、restore_identity 和跨项目管理。

项目级 Token 只能导入导出绑定项目的数据。不能通过导出全局角色、Skill Source 或 Credential 获取其他项目正在使用的数据。

## 15. 前端设计

项目设置增加“导入与导出”：

### 导出

- 预设选择：配置、完整项目、证据归档、自定义；
- 模块勾选和依赖提示；
- 记录数、Blob 估算和活动 Job 检查；
- Credential 选择：排除、仅元数据、便携加密；
- 环境变量分类预览；
- 后台进度、取消、下载、过期和删除；
- Secret 导出显示高风险确认和强口令输入。

### 导入

- 上传 `.deepsonarpack`；
- 展示来源、版本、签名、模块和数量；
- 冲突、非便携路径、缺失环境变量和 Credential 映射；
- 选择创建新项目或合并配置；
- 应用前二次确认；
- 完成后显示新项目、跳过项、警告和审计记录。

导入页面不能显示 Secret 明文，也不能提供“信任包内 Skill/镜像”的快捷开关。

## 16. 兼容性

- 每个模块有独立版本；
- Importer 支持当前格式和明确维护的旧格式；
- 对旧格式使用纯数据转换器，不修改原始上传包；
- 高于当前支持版本的包只能预览基本 Manifest，不能应用；
- 缺少可选字段使用确定性默认值；
- 缺少必须字段直接拒绝；
- 所有转换步骤记录到 Import 结果；
- Fresh schema、完整 migration 链和导入目标 schema 必须保持等价。

## 17. 性能与资源限制

- 全程流式读取 JSONL、Blob 和 ZIP entry；
- 不在内存中构建整个项目对象；
- 限制单项目导出并发和单实例 Transfer 并发；
- 配置数据与历史数据分别设置大小上限；
- 导出文件有默认过期时间和配额；
- 下载支持 Range 或对象存储短期签名 URL；
- 导入预览缓存与包 SHA256 绑定，包变化后必须重新预览；
- 大型导入分批校验，但业务应用保持事务一致性；
- Blob 先写临时前缀，数据库提交成功后再标记可见；失败时清理临时 Blob。

## 18. 分阶段实施

### P0：配置导入导出 — **已交付**

- [x] 定义 `.deepsonarpack` v1、Manifest、模块和 checksums；
- [x] 建立 `data_exports` / `data_imports`；
- [x] 实现 project、rules、roles、skills、environment、integrations metadata；
- [x] 实现 create_new 和 merge_configuration；
- [x] Credential 只导出元数据；
- [x] 实现预览、ID Map、冲突处理和审计；
- [x] 前端增加配置导入导出页面。

验收：能够把一个项目的角色、规则、Skill 和非敏感环境配置迁移到另一套实例，不泄露 Secret。**已满足。**

### P1：完整项目与证据 — **已交付（产品主路径）**

- [x] 增加 tasks、events、findings（含画布 nodes/edges、Job 快照脱敏）；
- [x] 实现活动 Job 阻断（完整导出）与 allow_active_jobs 选项；
- [x] 实现 Job 状态清理和两阶段引用写入；
- [x] artifacts 模块与 evidence 预设（URI/路径引用为主，非整库 Blob 物理镜像）；
- [x] 来源审计日志作为只读归档文件（不写入目标 audit_logs 正文）；
- [x] 安全与迁移相关回归（credential-security 导出包、role 颜色/平台导入等集成测）。

验收：完整项目迁移后任务、画布、Finding 与历史可查看，不会自动恢复执行历史 Job。**已满足。**

### P2：便携加密 Secret — **不在当前产品范围**

- [ ] ~~增加 `transfers:secrets` scope…~~ **明确不做**：Secret 仅 metadata 导出，目标环境重新录入/映射 Credential。
- 纪律：`secret_included: false`；导出路径与 API 响应不得出现明文密钥（有集成测试护栏）。

### P3：签名、自动备份与外部存储 — **不在当前产品范围**

- [ ] ~~Ed25519 / 对象存储定期备份 / restore_identity~~ **未纳入交付**；需要时另开需求，不阻塞「导入导出产品完成」判定。

## 19. 验证计划

### 安全

- ZIP Slip、压缩炸弹、重复路径、软链接和超大 JSONL 被拒绝；
- 包内 SQL、脚本、Hook 和未知文件不会执行；
- API Token、Job Token、主密钥和 process.env Secret 不出现在包中；
- 普通导出中的敏感 env 值被拒绝；
- 错误口令不能解密 Secret，错误日志不包含明文；
- 项目 Token 无法导出其他项目或全局 Secret；
- 导入的 Skill Source 和镜像保持 quarantined/disabled；
- audit archive 无法写入目标 append-only 审计表。

### 一致性

- 配置导出后导入得到等价配置；
- 全项目导入后对象数量、引用关系和 Blob SHA256 一致；
- Finding 的 Job/Node、Edge、Report 和 Canvas 引用全部正确重映射；
- 活动 Job 被安全归档为 cancelled，不产生 dispatcher 执行；
- 重复 apply 同一个 Import 不重复创建数据；
- 任一步失败时数据库和临时 Blob 可回滚/清理；
- 并发配置写入在 merge import 期间被阻止。

### 兼容性

- 当前版本导出 → 当前版本导入；
- 旧 format_version → 当前版本转换导入；
- 新于当前版本的包被明确拒绝；
- Windows、Linux、Docker 和托管 PostgreSQL 环境生成的数据包一致；
- UTF-8 中文、长路径、空集合和大项目均可处理。

### 功能

- 只导出 rules；
- 导出 roles + environment 自动补依赖；
- 配置模板导入新项目；
- 配置合并冲突逐项处理；
- 完整项目无漏洞报告迁移；
- 完整项目含 Finding、Verify、Report 和 Blob 迁移；
- Credential metadata 映射；
- 便携 Secret 恢复；
- 导出过期、取消和删除。

## 20. 完成定义

本方案完成必须同时满足：

- 用户可以选择配置、全项目、证据或自定义模块导出；
- 环境变量按非敏感值、名称引用和 Secret 正确分类；
- 默认导出包不包含任何可直接使用的长期或短期 Token；
- 导入前能够完整预览依赖、冲突、Credential 和不可迁移路径；
- 默认导入创建新项目并安全重映射所有 ID；
- 历史 Job 不会因导入重新执行；
- Finding、画布、报告、SARIF 和 Blob 证据保持可追溯；
- Secret 迁移必须独立授权、独立加密并在目标实例重新加密；
- 导入包不能执行 SQL、Shell 或第三方代码；
- 导入导出全过程具有状态、进度、错误、哈希和 append-only 审计记录；
- 应用级项目数据包与运维级整库灾备边界清晰。
