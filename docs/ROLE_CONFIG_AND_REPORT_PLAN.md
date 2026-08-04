# 角色配置统一 + 单决策中枢 + 验证与自动报告流水线（修订实施方案）

> 日期：2026-08-01
>
> 状态：待实施（已完成架构评审修订）
>
> 相关：`docs/ARCHITECTURE.md` §4.3 / §8.1 / §8.3

## 1. 已确认的业务目标

本方案保留以下产品与架构目标：

1. 每个项目只有一个决策中枢 `hub_reason`，其他 Agent 都由 Hub 提出派发意图，由 Scheduler 执行实际下发。
2. 每个角色必须写清职责、输入、产出和约束，Hub 不能只看到一个角色名。
3. 用户界面采用“角色即 Agent 配置”，不再要求用户先建 Profile、再把 Profile 绑定给角色。
4. 每个角色可以配置 Agent CLI、模型、Credential、Skill、Command、MCP、Subagent、非敏感环境变量和 Provider 配置文件。
5. Finding 必须自动验证；Fact 只有经过验证才能进入最终报告。
6. Hub 宣布分析完成后，由调度引擎自动生成一次任务级总报告；无论有无确认漏洞，都必须产生报告。
7. 画布包含 `report` 节点，任务最终输出以报告为准。
8. 普通用户创建任务时仍然只填写标题和内容，不填写角色、模型、工具、镜像、优先级或超时。

## 2. 修订后的核心模型

“角色即配置”是产品概念，不等于把所有项目配置写进全局 `agent_roles` 一行。最终采用四层模型：

```text
RoleDefinition
全局职责、Prompt、角色类型
        ↓
RoleConfig
全局缺省或项目级 CLI、模型、Skill、Credential、配置文件
        ↓
JobSnapshot
创建 Job 时冻结当次完整配置
        ↓
RuntimeEvidence
记录实际模型、镜像 digest、Prompt 和配置文件哈希
```

这样既能让用户在一个“角色配置”页面完成操作，又能保证：

- 不同项目的 `audit` 可以使用不同模型、Credential、Skill 和运行镜像；
- 项目级 Credential 不会被其他项目引用；
- 修改角色配置只影响后续 Job；
- 历史 Job 始终可以追溯当时真实配置；
- 全局职责定义和项目运行配置不会互相污染。

## 3. 角色语义

### 3.1 三类角色

`agent_roles.kind` 收敛为：

| kind | 内置角色 | 是否出现在 Hub 普通角色清单 | 说明 |
|---|---|---:|---|
| `hub` | `hub_reason` | 否 | 唯一决策中枢，读取完整画布 |
| `system` | `verify`、`report` | 否 | 由调度引擎自动下发，或由 Hub 提交系统请求 |
| `role` | `audit`、`explore`、`analyze`、`test`、`code`、自定义角色 | 是 | Hub 可派发的工作角色 |

数据库约束：

```sql
ALTER TABLE agent_roles ADD CONSTRAINT agent_roles_kind_check
  CHECK (kind IN ('hub', 'system', 'role'));

CREATE UNIQUE INDEX agent_roles_one_hub
  ON agent_roles (kind) WHERE kind = 'hub';
```

`hub_reason`、`verify`、`report` 是不可删除的 builtin 角色。可以修改允许用户调整的 Prompt 内容，但不能改变它们的系统职责、kind 或名称。

### 3.2 历史类型兼容

- 新 Job 统一使用 `audit`，历史 `audit_module` 继续映射到 `audit` 定义和配置。
- 新系统验证 Job 统一使用 `verify`。
- 历史 `verify_finding` Job 继续由 Executor 兼容执行，并映射到 `verify` 配置。
- 普通角色中不再存在另一个同名 `verify`，避免“系统验证”和“普通分析角色”语义冲突。

## 4. 数据模型

### 4.1 `agent_roles`：只保存角色定义

保留和扩展以下字段：

```text
id
name
title
description
prompt_template
kind
builtin
created_at
updated_at
```

`description` 必须包含：

- 职责范围；
- 可以读取的输入；
- 必须产生的输出；
- 禁止行为；
- 适用和不适用场景。

CLI、模型、Credential 和 Skill 不进入此表，防止全局角色覆盖项目配置。

### 4.2 `role_configs`：角色运行配置

```sql
CREATE TABLE role_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id uuid NOT NULL REFERENCES agent_roles(id),
  project_id uuid REFERENCES projects(id),
  agent_cli text NOT NULL DEFAULT 'claude-code',
  model text,
  env_keys text[] NOT NULL DEFAULT '{}',
  env_vars_json jsonb NOT NULL DEFAULT '{}',
  modules_json jsonb NOT NULL DEFAULT '[]',
  skills_json jsonb NOT NULL DEFAULT '[]',
  commands_json jsonb NOT NULL DEFAULT '[]',
  mcps_json jsonb NOT NULL DEFAULT '[]',
  subagents_json jsonb NOT NULL DEFAULT '[]',
  prompt_suffix text,
  runtime_image_key text,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX role_configs_global_uniq
  ON role_configs (role_id) WHERE project_id IS NULL;

CREATE UNIQUE INDEX role_configs_project_uniq
  ON role_configs (project_id, role_id) WHERE project_id IS NOT NULL;
```

解析优先级：

```text
项目级 RoleConfig
    → 全局 RoleConfig
    → Scheduler 环境缺省
```

项目级 RoleConfig 必须只能引用该项目启用的角色。`runtime_image_key` 只能引用服务端可信镜像目录，不能保存任意 OCI 地址。

### 4.3 `role_credentials`：保留多用途 Credential

```sql
CREATE TABLE role_credentials (
  role_config_id uuid NOT NULL REFERENCES role_configs(id) ON DELETE CASCADE,
  credential_id uuid NOT NULL REFERENCES credentials(id),
  purpose text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_config_id, credential_id, purpose)
);
```

约束：

- 项目级 RoleConfig 只能绑定 `credentials.project_id IS NULL` 或同项目 Credential。
- 全局 RoleConfig 只能绑定全局 Credential。
- 同一 purpose 是否允许多个 Credential，由 purpose 的业务规则决定，不用单个 `credential_id` 降级现有能力。
- LLM Credential 的真实密钥仍只在 Scheduler 内解密，通过短期 `DEEPSONAR_JOB_TOKEN` 和 Model Gateway 使用。

### 4.4 `role_config_files`：Provider 配置文件

```sql
CREATE TABLE role_config_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_config_id uuid NOT NULL REFERENCES role_configs(id) ON DELETE CASCADE,
  path text NOT NULL,
  content text NOT NULL,
  content_sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (role_config_id, path)
);
```

首期只允许 Provider 对应的固定相对路径：

- Claude Code：`.claude/settings.json`
- Codex：`.codex/config.toml`
- OpenCode：`.opencode/config.json`

安全要求：

- 使用 POSIX 路径规范化，拒绝绝对路径、反斜杠、NUL、`..` 和软链接逃逸；
- 禁止覆盖 `/workspace/src`、结果文件、Agentbox daemon 配置和系统路径；
- 限制文件数量、单文件大小和总大小；
- 保存和冻结 SHA256；
- 写入前执行密钥特征检查；
- 配置文件只允许项目管理员编辑，并写入 append-only 审计日志；
- 后续如需支持大文件，迁移到加密 Blob，数据库只保存 URI 和哈希。

### 4.5 Fact 验证状态

不得复用 `canvas_nodes.status` 同时表达任务执行状态和事实可信状态。新增独立列：

```sql
ALTER TABLE canvas_nodes ADD COLUMN verification_status text;

ALTER TABLE canvas_nodes ADD CONSTRAINT canvas_nodes_verification_status_check
  CHECK (
    verification_status IS NULL OR
    verification_status IN ('unverified', 'verifying', 'verified', 'rejected', 'needs_human')
  );
```

- Fact 创建时：`verification_status='unverified'`。
- Verify Job 创建时：`verifying`。
- 结论成立：`verified`。
- 结论不成立：`rejected`。
- 无法确定：`needs_human`，并建立 Human 节点。
- 非 Fact 节点保持 `NULL`。

Finding 继续以 `findings.verify_status` 为唯一真相，画布 Finding 节点的展示状态由后端从 Finding 状态映射，不建立第二套可独立修改的真相。

### 4.6 `task_reports`：任务级最终报告

```sql
CREATE TABLE task_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canvas_id text NOT NULL UNIQUE REFERENCES canvases(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  report_job_id uuid REFERENCES jobs(id),
  status text NOT NULL DEFAULT 'pending',
  summary_json jsonb NOT NULL DEFAULT '{}',
  markdown_uri text,
  markdown_sha256 text,
  sarif_uri text,
  sarif_sha256 text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT task_reports_status_check
    CHECK (status IN ('pending', 'generating', 'succeeded', 'failed'))
);
```

完整 Markdown 和 SARIF 优先进入 Blob；数据库保存摘要、URI 和 SHA256。小型本地部署可以由 Blob Adapter 落到本地 volume。

## 5. Verify 统一流程

### 5.1 Finding 自动验证

保持当前规则：任何 Finding 创建后，由 Scheduler 自动派生系统 `verify` Job，不依赖严重级别、用户选择或 Hub 临场判断。

新 Job payload：

```json
{
  "target": {
    "kind": "finding",
    "node_id": "canvas-node-uuid",
    "entity_id": "finding-uuid"
  },
  "snapshot": {
    "title": "...",
    "location": "...",
    "summary": "..."
  }
}
```

Finding 的幂等键继续使用实体 ID；同一个 Finding 只能存在一个系统验证流程，失败重试复用原 Job。

### 5.2 Fact 按需进入验证

Fact 不会因为生成就自动制造大量 Verify Job，但任何 Fact 在进入报告前必须验证。

Hub Decision schema 增加系统验证请求，避免把 `verify` 伪装成普通角色：

```json
{
  "verifications": [
    {
      "from": ["fact-node-uuid"],
      "reason": "该事实是最终结论的关键证据，需要验证"
    }
  ]
}
```

Scheduler 负责：

1. 校验 `from` 是当前画布中可引用的 Fact/Finding 节点 ID；
2. 通过 `findings.node_id` 把 Finding 画布节点映射为实体 ID；
3. 创建系统 Verify Job，并冻结目标快照；
4. 按目标实体建立数据库幂等约束；
5. 把 verdict 写回唯一真相字段；
6. `needs_human` 时阻止 Hub 最终完成，直到人工处理或明确排除。

历史 Hub 输出 `role='verify'` 可在过渡期映射为 `verifications`，新 Prompt 不再把 verify 列为普通角色。

## 6. 画布访问分级

`buildGraphSnapshot` 改为显式作用域：

```ts
type GraphScope = "hub" | "agent" | "verify" | "report";
```

所有作用域均由 Scheduler 查询层执行并受字符预算硬限制（默认 hub 48 KB、agent 16 KB、verify 24 KB、report 8 KB）。超预算写入 YAML 顶层 `truncated: true` 和 `omitted` 计数；`referableIds` 仍从完整画布返回，仅用于服务端 intent.from 校验。

### 6.1 Hub

可读完整画布的索引投影（不是无界正文）：

- 所有 Finding 的 `verify_status` 索引（完成门禁必需）；
- 所有开放 Intent、事实索引和结论意图聚合；
- 近期/触发相关节点摘要、人工提示和任务目标。

Hub 据此决定继续派发普通角色、请求 Fact 验证或宣布分析完成。

### 6.2 普通角色 Agent

只读取：

- goal / target；
- 当前 Intent；
- `verification_status='verified'` 的 Fact；
- `verify_status='confirmed'` 的 Finding；
- Scheduler 明确附加到本 Intent 的人工指令。

不读取其他开放 Intent、未验证或 rejected Fact、原始 Finding 流。Hub 负责跨 Agent 协调，避免普通 Agent 基于未经验证内容扩散推断。

### 6.3 Verify

只读取：

- 需要验证的目标快照；
- 目标相关源码；
- 已验证背景内容；
- Scheduler 限定的验证要求。

Verify 不依赖模型填写数据库实体 ID，也不能通过 Prompt 改变验证目标。

### 6.4 Report

只读取 Scheduler 生成的结构化报告输入：

- verified Fact；
- confirmed Finding；
- false_positive / rejected 项目，用于“已排除”章节；
- 任务目标、执行范围、验证证据和运行元数据。

所有 scope 必须在服务端查询层执行；前端隐藏、Prompt 提示或 Agent 自律不构成访问控制。

“已验证”只表示结论通过验证，不表示内容不存在 Prompt Injection。所有进入 Prompt 的标题、描述和源码证据仍需长度限制、结构化序列化和不可信输入边界提示。

## 7. RoleConfig 解析与运行时安全

### 7.1 Snapshot 解析

新增：

```ts
resolveRoleSnapshot(db, projectId, jobType)
```

解析步骤：

1. 历史类型映射：`audit_module → audit`、`verify_finding → verify`；
2. 查询角色定义；
3. 查询项目级 RoleConfig，不存在则读取全局 RoleConfig；
4. 展开可信且启用的 Skill Source 模块；
5. 校验 Credential 项目边界和状态；
6. 校验环境变量和配置文件；
7. 生成完整 `RoleSnapshot` 写入 `jobs.agent_snapshot_json`。

Snapshot 增加：

```text
role_id
role_config_id
role_config_version
agent_cli
model
credential references by purpose
env_keys
env_vars
config_files with sha256
skills / commands / mcps / subagents
skill revisions
runtime_image_key
prompt_suffix
```

### 7.2 环境变量规则

合并顺序：

```text
Scheduler 非敏感缺省
    → RoleConfig 非敏感 env_vars
    → 白名单 env_keys 引用
    → 系统安全变量最终覆盖
```

以下变量保留给系统，RoleConfig 和配置文件不得覆盖：

- `DEEPSONAR_JOB_TOKEN`
- Provider API Key 变量
- Provider Base URL / Gateway URL
- `PATH`、`HOME`、`NODE_OPTIONS`
- Agentbox daemon、hooks、事件回传和沙箱控制变量

`env_vars_json` 只允许合法环境变量名，并限制数量、单值长度和总大小。名称命中 `TOKEN`、`SECRET`、`PASSWORD`、`API_KEY`、`AUTHORIZATION`、`COOKIE` 等敏感模式时拒绝保存，要求改用 Credential。

### 7.3 Provider 配置文件优先级

不能采用“用户文件无条件优先”。正确顺序：

1. 读取用户提供的 Provider 配置文件；
2. 解析并校验允许字段；
3. 合并模型、UI 偏好和非敏感设置；
4. 由系统最后覆盖 Gateway 地址、短期 Token、hooks、事件通道和安全策略；
5. 写入沙箱并记录最终文件 SHA256。

如果某个 Provider 无法安全合并整文件，则首期只开放字段化编辑，不开放整文件上传。

当前 Model Gateway 仍是唯一模型出口。不得使用 `credential.public_metadata_json.base_url` 绕过 Gateway；上游 Base URL 只由 Gateway 在调度器侧读取。

## 8. 自动报告流水线

### 8.1 状态机

Root/任务状态改为：

```text
running
  → analysis_complete
  → reporting
  → succeeded
```

- Hub `complete` 只把 Root 置为 `analysis_complete`，不立即表示任务成功。
- Report Job 创建后置为 `reporting`。
- Report 成功并完成结构化校验后，Root 才进入 `succeeded`。
- Report 失败则 `task_reports.status='failed'`，Root 保持 `reporting` 并显示失败原因，可重试原 Report Job。

### 8.2 报告派发条件

`maybeDispatchReport(tx, canvasId, projectId)` 必须同时满足：

1. Hub 已提交 complete，Root 为 `analysis_complete`；
2. 没有普通角色、Hub 或 Verify 的非终态 Job；
3. 非终态包括 `pending/claimed/provisioning/running/waiting_human`；
4. 所有 Finding 已有终态验证结论；
5. 不存在 `verification_status='verifying'/'needs_human'` 的 Fact；
6. 当前画布尚未创建 `task_reports` 记录或已有失败记录等待显式重试。

实现要求：

- 对 Root/Canvas 行加 `FOR UPDATE` 或 advisory lock；
- 先原子 `INSERT INTO task_reports ... ON CONFLICT`；
- Report Job 使用稳定 `ingress_key='report:<canvas_id>'` 保证幂等；
- Hub complete、`finalizeJob` 和人工处理完成都可以调用 `maybeDispatchReport`；
- Report Job 自身完成后不得再次触发 Hub 或生成第二份报告。

### 8.3 确定性数据与 Agent 叙事分离

Scheduler 先从数据库构建 `report-input.json`：

```json
{
  "task": {},
  "statistics": {},
  "confirmed_findings": [],
  "excluded_findings": [],
  "verified_facts": [],
  "evidence": []
}
```

其中漏洞数量、severity、rule ID、location、verdict 和证据引用全部由 Scheduler 确定性生成。Report Agent 只根据该输入编写叙事 Markdown，不允许创造新的 Finding 或修改验证结论。

最终产物：

- `report.json`：DeepSonar 结构化任务报告；
- `report.md`：面向人的总报告；
- `report.sarif.json`：由 Scheduler 从 `report.json` 确定性导出并校验 SARIF 2.1.0。

SARIF 映射：

- `rule_id → result.ruleId`
- `severity → result.level`，使用明确映射表
- `summary → result.message.text`
- `location → result.locations[].physicalLocation`
- 验证状态和证据位置进入 properties / relatedLocations

无确认漏洞时仍生成报告，并明确写“本次任务未发现已确认漏洞”；同时列出审计范围、验证情况和局限性，不能写成绝对安全保证。

### 8.4 Report 事件和画布节点

Report 事件只携带小型引用：

```json
{
  "report_id": "...",
  "status": "succeeded",
  "summary": {},
  "markdown_uri": "...",
  "markdown_sha256": "...",
  "sarif_uri": "...",
  "sarif_sha256": "..."
}
```

Scheduler 创建唯一 `node_type='report'` 节点。`body_json` 保存报告 ID、摘要、URI 和哈希，不保存无限大的 Markdown。节点位置交给现有服务端布局逻辑，不由 Agent 提交坐标。

前端渲染 Markdown 时禁用原始 HTML或执行严格消毒，并对外部链接、图片和代码块设置安全策略。

## 9. 分阶段迁移

### 9.1 Migration 0017：Expand

- 增加 `agent_roles.kind` CHECK 和唯一 Hub 约束；
- 建立 `role_configs`、`role_credentials`、`role_config_files`；
- 增加 Fact `verification_status`；
- 建立 `task_reports`；
- 增加 `verify`、`report` 系统角色；
- 保留 `agent_profiles`、`profile_credentials` 和 `projects.config_json.profiles`；
- 更新 `database/schema.sql` 最终态并登记 migration。

### 9.2 数据迁移

对每个项目分别迁移，不能把多个项目绑定写入同一个全局角色：

1. 读取 `projects.config_json.profiles`；
2. 为每个 `project + role` 创建独立 RoleConfig；
3. `audit_module` 绑定迁移到 `audit`，`verify_finding` 迁移到 `verify`；
4. `default` Profile 复制到该项目尚未显式配置的启用角色；
5. 复制全部 `profile_credentials` 及 purpose；
6. 记录未绑定、Credential 越权、重复配置和缺失角色，不静默丢弃；
7. 输出迁移统计，支持迁移前后逐项目核对。

无法映射的 Profile 暂时保留，只在管理页面标记“待迁移”，不能直接删除。

### 9.3 应用过渡版本

- 写入只使用 RoleConfig；
- 读取优先 RoleConfig，缺失时回退旧 Profile；
- Job Snapshot 同时记录来源类型，便于审计；
- 前端进入新的角色配置页面，旧 Profile 页面改为只读迁移提示；
- API 新增 `roles:read` / `roles:write` scope；过渡期兼容 `profiles:*` Token scope；
- 至少运行一个发布周期并完成生产数据核对。

### 9.4 Contract migration

只有满足以下条件后才能创建后续 contract migration：

- 所有项目旧绑定均已迁移；
- 没有新 Job 从旧 Profile 创建 Snapshot；
- 未映射 Profile 已被人工处理；
- 已完成备份和回滚演练；
- 多项目 Credential 边界测试通过。

然后才允许：

- 删除 Profile CRUD；
- 删除 `projects.config_json.profiles`；
- 删除 `profile_credentials` 和 `agent_profiles`；
- 移除旧读路径；
- 在后续版本移除 `profiles:*` scope 兼容。

## 10. 后端改动

### `apps/scheduler/src/core.ts`

- `AgentProfileSnapshot` 迁移为 `RoleSnapshot`；
- 实现 `resolveRoleSnapshot(projectId, jobType)`；
- Hub Decision 支持 `verifications`；
- Finding 和 Fact 验证统一创建系统 `verify` Job；
- 明确 node ID 与实体 ID 映射；
- 实现 Verify 幂等和 verdict 回写；
- Hub complete 改为 `analysis_complete`；
- 实现并发安全的 `maybeDispatchReport`；
- Report 完成后才将 Root 置为 `succeeded`。

### `apps/scheduler/src/graph.ts`

- `buildGraphSnapshot(canvasId, scope, currentJobId?)`；
- 服务端实现 Hub、Agent、Verify、Report 四种查询视图；
- `referableIds` 随 scope 过滤；
- Finding 输出同时包含 node ID、entity ID 和验证状态；
- Prompt 内容做长度上限和结构化转义。

### `apps/scheduler/src/executor-real.ts`

- 按 Job 类型选择 Graph scope；
- 使用 RoleSnapshot，不在执行时重新解析可变配置；
- 安全合并 Provider 配置文件；
- 系统安全环境变量最终覆盖；
- Verify 支持 finding/fact target；
- Report 只读取 Scheduler 生成的结构化输入；
- runtime evidence 增加 RoleConfig 版本、配置文件 SHA256 和最终配置摘要。

### `apps/scheduler/src/dispatcher.ts`

- fake Verify 支持 Finding 和 Fact；
- fake Report 使用确定性数据构建报告，不自行虚构统计；
- fake 模式覆盖无漏洞、有漏洞、误报和 needs_human 场景。

### `apps/scheduler/src/routes.ts` / `auth.ts`

- 新增全局和项目 RoleConfig API；
- Credential 项目边界校验；
- 环境变量和配置文件安全校验；
- 新增报告查询、Markdown 和 SARIF 下载 API；
- 增加 `roles:read/write` 权限并兼容旧 scope；
- 所有配置、Credential 绑定和报告重试写审计日志；
- Profile API 按迁移阶段先只读、后删除。

### `packages/shared-types`

- 增加 `verify`、`report` Job/Event schema；
- 增加 Hub `verifications` schema；
- 增加 RoleConfig、RoleSnapshot、TaskReport schema；
- 增加 Finding/Fact Target 联合类型；
- 增加严格的验证状态和报告状态枚举。

## 11. 前端改动

### 角色配置

- 删除“先建 Profile、再绑定角色”的用户流程；
- 全局设置显示角色职责和全局缺省配置；
- 项目设置显示启用角色及项目级覆盖；
- 编辑 CLI、model、Credential、Skill、Command、MCP、Subagent、非敏感环境变量、Provider 配置文件和可信运行镜像；
- 系统角色 Hub、Verify、Report 单独分组，不允许删除或改 kind；
- 项目 Credential 只能在同项目配置中选择。

### 报告

- 画布增加 Report 节点；
- 任务状态区分“分析完成”“生成报告”“已完成”“报告失败”；
- 报告页面展示结构化摘要和安全渲染的 Markdown；
- 提供 SARIF 下载、哈希和生成时间；
- 无漏洞报告显示范围与局限性；
- 报告失败提供明确重试入口。

新建任务表单保持不变，仍然只有标题和内容。

## 12. 验证计划

### 数据迁移

- 两个项目把 `audit` 绑定到不同 Profile，迁移后必须得到两个独立 RoleConfig；
- 项目级 Credential 不得被其他项目 RoleConfig 引用；
- default Profile 正确复制到未显式配置的角色；
- 多 purpose Credential 全部保留；
- 未绑定 Profile 不被删除并产生迁移报告；
- contract migration 前后均能恢复备份。

### 安全配置

- `../`、绝对路径、反斜杠和系统路径配置文件全部被拒绝；
- 用户配置不能覆盖 Gateway URL、Job Token、hooks 和保留环境变量；
- env_vars 中疑似 Secret 被拒绝并引导使用 Credential；
- 最终配置 SHA256 写入 runtime evidence；
- 用户上游 base_url 只能由 Gateway 使用，沙箱始终连接 Gateway。

### Verify 与访问分级

- Finding 自动创建 Verify；
- Fact 只有 Hub 提交 verification request 后创建 Verify；
- 同目标并发请求只产生一个验证流程；
- Hub 看全图；普通 Agent 只看 verified/confirmed；Verify 只看目标和已验证背景；Report 只看报告输入；
- Agent 无法引用 scope 外节点；
- needs_human 阻止最终报告。

### Report

- 无漏洞、有 confirmed、只有 false_positive 三种任务都生成报告；
- Hub complete 时存在并发 Job，不提前生成报告；
- `waiting_human` 存在时不生成报告；
- 并发调用 `maybeDispatchReport` 只产生一个 task_report 和一个 Report Job；
- Report 失败后可以重试，Root 不显示 succeeded；
- 统计由数据库确定性生成，Markdown 内容不能修改数量和 verdict；
- SARIF 通过 SARIF 2.1.0 schema 校验；
- Report 节点只保存摘要、URI 和哈希；
- Markdown 渲染不执行 HTML、脚本和危险链接。

### 全仓回归

```bash
pnpm typecheck
pnpm build
python agent-harness/test-hub-loop.py
python agent-harness/test-roles-api.py
python agent-harness/test-gateway.py
python agent-harness/test-report-flow.py
```

还需增加事务级并发测试、fresh schema 与完整 migration 链等价测试，以及真实 Agent 的 Claude Code、Codex、OpenCode 配置加载冒烟测试。

## 13. 文档同步

实施完成后同步更新：

- `docs/ARCHITECTURE.md`：角色定义、RoleConfig、Graph scope、Verify 和 Report 状态机；
- `docs/PRODUCTION_HARDENING_AND_OPTIMIZATION_PLAN.md`：对应工作包状态；
- `docs/AGENTBOX_RUNTIME_IMAGE_AND_TOOL_MARKETPLACE_TODO.md`：角色与可信运行镜像绑定；
- `database/schema.sql` 与 `database/README.md`：最终态 Schema 和迁移覆盖；
- `README.md`：角色配置和最终报告使用入口；
- `AGENTS.md`：把“Profile 三层配置”改为“角色定义 → 项目 RoleConfig → Job Snapshot”。

`CLAUDE.md` 当前指向 `AGENTS.md`，只需更新真实目标文件，不单独维护重复内容。

## 14. 不改与安全红线

- Hub 仍然是唯一决策中枢，Agent 只提交结构化提案和产物；
- Finding 自动验证仍由调度引擎决定；
- Report 自动派发，不依赖 Hub 选择 report 角色；
- 密钥只经 Credential、Model Gateway 和短期 Job Token 使用；
- 不允许自定义配置绕过 Gateway、事件通道和沙箱安全策略；
- 不允许普通用户在任务表单选择内部角色、Credential、镜像或工具；
- 不把 Report Agent 生成的文字直接当成结构化漏洞真相；
- 不在同一个 migration 中完成 expand 和 destructive contract；
- 不因为前端隐藏字段就假设后端访问控制已经成立。

## 15. 完成定义

本方案完成必须同时满足：

- 用户只在一个角色配置入口管理职责和运行配置，不再理解 Profile 绑定；
- 不同项目可以安全地为同一角色使用不同模型、Credential、Skill 和镜像；
- Hub、Verify、Report 与普通角色语义唯一、没有同名双重职责；
- Finding 自动验证，Fact 未验证不能进入报告；
- 任务只有在报告成功后才显示最终完成；
- 报告包含确定性结构化数据、安全 Markdown 和标准 SARIF；
- 用户配置不能覆盖 Model Gateway 和系统安全变量；
- 历史 Job 配置、报告和运行证据均可按哈希追溯；
- 旧 Profile 数据经过可回滚的分阶段迁移，不丢配置、不串项目、不丢 Credential。
