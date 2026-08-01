# DeepFlowHunter 本地项目与任务管理改造方案

> 状态：已实施（阶段 A/B/C，2026-08-01，commit b6a1480；阶段 D 为观察后清理，按需启动）
> 日期：2026-08-01
> 决策目标：由 DeepFlowHunter 自身前端管理项目与任务，Plane 从必选管理入口降级为可选集成。

## 1. 结论

DeepFlowHunter 应将自己的 PostgreSQL 数据库设为项目、任务和执行状态的唯一真相，前端直接通过 Scheduler API 创建和管理项目、任务。Plane 不再是启动项目和任务的前置条件，仅在确实需要通用团队协作时作为可选适配器使用。

目标关系如下：

```text
DeepFlowHunter Web
        │
        ▼
Scheduler API ─────► PostgreSQL（唯一状态真相）
        │                    │
        ▼                    ▼
 Runtime / Agent       Canvas / Finding

Plane（可选）◄──── plane-adapter ────► 本地项目与任务
```

这不是简单地把 Plane 的页面复制到本项目，而是把 DeepFlowHunter 已经拥有的调度能力补上本地创建入口。项目不需要同时维护两套同等权威的状态。

## 2. 为什么要改

### 2.1 真正控制任务状态的已经不是 Plane

当前 Job 的创建、排队、认领、运行、超时、孤儿回收、取消、恢复和重试都由 Scheduler 与 PostgreSQL 负责。Plane 只完成两类外围动作：

1. 将处于 Ready 状态的 Plane Issue 转换成本地 Job。
2. 在 Job 结束后，把结果写回 Plane 状态和评论。

因此，把 Plane 称为“管理真相”与实际执行路径并不完全一致。系统真正可信的状态已经是 `jobs.status`，Plane 是它的外部投影。

### 2.2 当前使用方式已经以本地任务为主

2026-08-01 的本地数据库快照中共有 36 个 Job，其中 6 个带 `plane_issue_id`，30 个是不依赖 Plane 创建的本地 Job。也就是说，约 83% 的实际任务已经绕过 Plane，现有代码也明确支持在 Plane 未配置时通过 `POST /jobs` 运行。

继续把 Plane 设为必选入口，会让产品定义落后于真实使用方式。

### 2.3 DeepFlowHunter 的任务不是普通待办事项

本项目中的任务天然关联：

- Agent 类型与 Profile；
- 仓库、模块和审计目标；
- 沙箱执行与实时事件流；
- Finding、验证链和任务画布；
- 超时、重试、人工恢复与派生任务；
- 项目级规则、角色和 Hub 配置。

这些信息在 DeepFlowHunter 前端中可以原生表达，在 Plane 中只能塞进描述文本或依赖跳转链接。继续把 Plane 作为主要入口，反而会把一个领域任务拆成“Plane 上的待办”和“DeepFlowHunter 中的真实运行”两个割裂界面。

### 2.4 双向同步会制造不必要的不一致

如果 Plane 和本地前端都能修改同一任务状态，就必须处理：

- Plane 显示 In Progress，但本地 Job 已经 timeout；
- 用户在 Plane 标记 Done，但本地 Agent 仍在运行；
- 回写失败后哪一边应该覆盖另一边；
- 重试产生多个 Job 时，一个 Plane Issue 应显示什么状态；
- Plane 不可用时，本地任务是否允许继续运行。

这些问题对当前一两人使用的 MVP 没有足够收益。明确“本地为真、Plane 为镜像”可以直接消除大部分冲突。

### 2.5 降低外部依赖，提高可部署性

改造后，即使没有 Plane Token、Webhook、公网回调或 Plane 服务，本项目仍能完整完成：

```text
创建项目 → 创建任务 → Agent 执行 → 查看画布与发现 → 取消/恢复/重试
```

这使本地开发、演示、单机部署和离线环境都更简单，也减少新用户理解两个系统的成本。

## 3. 为什么不直接删除 Plane

Plane 仍然有本项目暂时不应自行建设的通用协作能力，例如负责人、评论与提及、通知、截止时间、通用看板、活动历史和多人协作体验。

保留可选适配器有三个理由：

1. 已有 Plane 项目和 Issue 需要继续兼容，不能因为切换主入口而丢失映射。
2. 将来团队扩大或需要对外展示项目进度时，Plane 可以继续充当协作视图。
3. 当前 Plane 客户端和同步层规模较小，保留为边缘集成的维护成本低于立即彻底删除后再重建。

因此本方案选择“降级为可选”，而不是“立即移除”。

## 4. 改造原则

### 4.1 单一状态真相

- `projects`、`canvases`、`jobs` 和 `findings` 保存在本地数据库中。
- Job 状态只由 Scheduler 状态机修改。
- Plane 回写失败只能记录告警，不能改变本地 Job 的成功或失败结果。
- Plane 上的状态只作为镜像，不反向覆盖一个已经开始执行的本地 Job。

### 4.2 不复制完整项目管理产品

第一阶段只实现执行审计任务真正需要的管理能力：

- 项目：创建、改名、归档、查看状态；
- 任务：创建、筛选、设定优先级、取消、恢复、重试；
- 执行：查看实时流、画布、Finding 和失败原因；
- 配置：沿用现有 Profile、Role、Rules 和 Skill Source。

第一阶段不实现通用甘特图、工时、Sprint、复杂权限、多人实时编辑、通知中心和自定义工作流。出现明确需求后再评估，不以“替代 Plane”为理由复制 Plane。

### 4.3 沿用现有实体，不新建重复状态层

当前模型已经形成以下语义：

```text
Project 1 ── * Canvas（用户看到的一项任务）
Canvas  1 ── * Job（该任务的一次执行或重试）
Job     1 ── * Event / Finding
```

本次不新增一张与 `canvases` 重复的 `tasks` 表。前端继续称它为“任务”，数据库沿用 `canvases`；任务的当前状态由该画布下的 Job 汇总得出。

这样做的原因是：Plane Issue、本地任务画布和重试历史原本已经是一一对应关系。再引入 `tasks.status` 会与 `jobs.status` 形成新的双状态问题。

### 4.4 兼容优先，先扩展再收缩

- 不删除现有 Plane 字段和接口。
- 先让 `plane_project_id` 可空，再增加本地创建入口。
- 现有 `/projects/sync` 与 Plane 轮询继续可用。
- 新前端稳定后，再更新文档和默认配置。
- 历史兼容字段只在确认无调用后另行清理。

## 5. 目标业务流程

### 5.1 本地项目与任务

```text
1. 用户在 DeepFlowHunter 前端创建项目
2. 用户进入项目，设置 Agent Profile、角色与规则
3. 用户创建任务，填写任务类型、目标、优先级和超时
4. API 在同一事务中创建任务画布和 pending Job
5. Scheduler 领取 Job 并运行 Agent
6. 前端展示实时流、画布、Finding 和终态
7. 失败任务可恢复或重试；重试复用原任务画布
```

### 5.2 可选 Plane 绑定

```text
1. 用户为某个本地项目绑定 Plane Project
2. plane-adapter 导入带 type= 标记的 Ready Issue
3. 每个 Issue 只创建一个任务画布；重试继续复用
4. Scheduler 完成本地状态流转
5. plane-adapter 尽力回写状态和摘要
6. Plane 故障不阻塞本地创建、执行和查询
```

冲突规则：本地状态优先。Plane 可以创建尚不存在的新任务，但不能覆盖已开始执行任务的本地状态。

## 6. 数据模型改造

建议新增迁移 `0008_local_project_management.sql`，采用增量方式修改。

### 6.1 projects

```sql
ALTER TABLE projects ALTER COLUMN plane_project_id DROP NOT NULL;
ALTER TABLE projects ADD COLUMN description text NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN status text NOT NULL DEFAULT 'active';
ALTER TABLE projects ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE projects ADD COLUMN archived_at timestamptz;
```

约定：

- `plane_project_id IS NULL`：纯本地项目；
- `plane_project_id IS NOT NULL`：绑定了 Plane 的本地项目；
- `status` 第一阶段只允许 `active | archived`；
- 删除采用归档，不级联硬删除任务、事件和 Finding；
- 现有唯一约束允许多个 `NULL`，无需为本地项目伪造 Plane ID。

`projects.canvas_id` 是历史项目级画布兼容字段。本次不删除，继续按 deprecated 处理，待旧接口退出后再做 contract migration。

### 6.2 canvases 与 jobs

第一阶段不为任务新增重复状态列。任务列表通过聚合 Job 得到：

- 有 `running/claimed/provisioning` Job：运行中；
- 有 `waiting_human` Job：等待人工；
- 最新一次 Job 为终态：显示相应终态；
- 多次 Job：显示尝试次数和最近一次结果。

`jobs.priority`、`jobs.timeout_sec` 和现有状态机继续作为执行依据。任务标题和目标继续保存在 `canvases.title`、`canvases.target_json`。

如第二阶段出现“只建任务但暂不执行”的明确需求，再为 `canvases` 增加 `planning_state=draft|ready|archived`。在此之前，创建任务即创建一个 `pending` Job，避免提前建设第二套工作流。

### 6.3 Plane 映射字段

本次保留：

- `projects.plane_project_id`；
- `canvases.plane_issue_id`；
- `jobs.plane_issue_id`。

它们从核心业务标识降级为可空的外部映射。只有 `plane-adapter` 可以读写这些字段，Scheduler 核心不得要求它们存在。

暂不新增通用 `external_bindings` 表。当前只有一个 Plane 集成，为未来可能出现的多个系统提前抽象会增加不必要的查询和迁移成本。

## 7. API 改造

### 7.1 新增本地项目 API

```text
POST   /projects
GET    /projects
GET    /projects/{id}
PATCH  /projects/{id}
POST   /projects/{id}/archive
```

`POST /projects` 最小请求：

```json
{
  "name": "客户 X 源码审计",
  "description": "审计认证与权限模块"
}
```

项目创建不再生成历史项目级 root 画布。任务创建时才生成任务画布，与当前“一任务一画布”模型保持一致。

### 7.2 新增语义化任务 API

```text
POST /projects/{id}/tasks
POST /projects/{id}/events
GET  /projects/{id}/tasks
POST /tasks/{canvas_id}/retry
```

`POST /projects/{id}/tasks` 最小请求：

```json
{
  "title": "审计 auth 模块",
  "content": "检查认证模块中的注入和权限绕过问题"
}
```

服务端创建的第一个 Job 固定为 `hub_reason`。人只表达目标，Hub 决定是否派发 `audit`、`explore`、`test` 等角色。

事件触发最小请求：

```json
{
  "event_id": "alert-20260801-001",
  "source": "ci",
  "event_type": "security_scan_failed",
  "data": { "repository": "demo", "branch": "main" }
}
```

同一项目下相同的 `source + event_id` 幂等复用，不会重复创建任务。

服务端在事务中完成：

1. 校验项目存在且未归档；
2. 创建 `canvases` 记录和 root 节点；
3. 创建第一个 `pending` Job；
4. 返回任务画布、Job ID 和状态。

`POST /jobs` 暂时保留为底层兼容接口。新前端使用 `/projects/{id}/tasks`，避免要求前端理解 `canvasId` 的创建细节。

### 7.3 补充任务操作

沿用：

```text
POST /jobs/{id}/cancel
POST /jobs/{id}/resume
```

新增：

```text
PATCH /jobs/{id}/priority
POST  /tasks/{canvas_id}/retry
```

约束：

- 只有 `pending` Job 可以修改优先级；
- retry 创建新 Job，不能把历史终态 Job 改回 pending；
- resume 只用于 `waiting_human/orphan/failed/timeout` 的原执行恢复；
- retry 和 resume 在 UI 中必须明确区分，防止用户误解历史记录。

### 7.4 Plane 集成 API

保留 `/projects/sync` 作为兼容入口，并逐步增加更清晰的管理接口：

```text
PUT    /projects/{id}/integrations/plane
DELETE /projects/{id}/integrations/plane
POST   /projects/{id}/integrations/plane/sync
```

解除绑定只清空项目的 Plane 绑定并停止后续同步，不删除已经导入的本地任务及其执行记录。

## 8. 前端改造

### 8.1 项目页

新增：

- “新建项目”按钮与表单；
- 项目改名、描述和归档操作；
- 来源标识：`本地` 或 `已绑定 Plane`；
- 归档项目过滤；
- 可选的“绑定 Plane”入口。

移除把 `plane_project_id` 当成每个项目必有字段的展示方式。未绑定时不显示空 UUID，而显示“本地项目”。

### 8.2 项目任务页

新增“新建任务”入口，表单字段按领域组织：

- 任务标题；
- Agent/任务类型；
- 仓库或目标路径；
- 模块范围；
- 优先级；
- 超时时间；
- 最终生效的 Profile 摘要。

任务列表展示：

- 聚合状态；
- 最近一次 Job；
- 尝试次数；
- 优先级；
- 发现数与确认数；
- 创建时间和最近运行时间；
- 取消、恢复、重试和打开画布操作。

### 8.3 文案调整

将以下类型文案：

```text
等待 Plane 领取或 POST /jobs
在 Plane 建项目后 POST /projects/sync
```

改为本地产品语言：

```text
创建第一个项目
创建任务后，调度器会自动开始执行
```

只有已绑定 Plane 的项目才显示同步状态和 Plane 跳转。

### 8.4 暂不做看板拖拽

Job 状态由实际执行决定，不应允许用户把运行中的任务拖到 Done 来伪造终态。第一阶段使用列表、筛选和明确操作按钮，信息密度和行为准确性优先于通用看板外观。

若将来加入看板，拖拽只能触发合法命令，例如取消、恢复或调整待执行优先级，不能直接写任意状态。

## 9. Plane 适配器改造

### 9.1 从核心依赖改为边缘依赖

- `plane-client` 保持独立 package；
- `plane-sync.ts` 只处理绑定了 `plane_project_id` 的项目；
- `planeWriteback()` 对无 Plane 映射的 Job 立即返回；
- Scheduler 启动和任务执行不依赖 Plane 配置是否存在；
- Plane 请求失败采用日志和可观测告警，不改变本地任务终态。

### 9.2 同步边界

Plane → 本地：

- 只导入包含合法 `type=` 的 Ready Issue；
- 依靠 `plane_issue_id` 唯一约束避免重复任务；
- 已导入 Issue 的标题或描述更新，第一阶段不自动覆盖正在执行的任务目标；
- 若确需更新，由用户在本地明确确认后再应用。

本地 → Plane：

- 认领时尽力写 In Progress；
- 成功时尽力写 Done；
- 失败、超时和重试耗尽时写评论及对应状态；
- 回写失败进入日志，后续可以由 reconcile 补偿；
- 回写结果不参与本地事务提交。

## 10. 分阶段实施

### 阶段 A：数据库与后端兼容层

1. 新增 `0008_local_project_management.sql`。
2. 使 `projects.plane_project_id` 可空，并增加项目描述、状态和更新时间。
3. 实现本地项目 CRUD 与归档接口。
4. 实现 `/projects/{id}/tasks` 和 retry 接口。
5. 保留并回归 `/projects/sync`、`POST /jobs` 和 Plane 同步。
6. 为本地项目、Plane 项目和重复 Issue 增加 API 测试。

完成条件：不配置任何 Plane 环境变量，也能只通过 API 完成项目创建到 Job 入队。

### 阶段 B：前端成为默认入口

1. 实现项目创建、编辑和归档 UI。
2. 实现任务创建表单。
3. 增加任务状态、优先级、尝试次数和操作按钮。
4. 修改所有依赖 Plane 的空状态文案。
5. 为创建项目、创建任务、取消、恢复和重试做浏览器冒烟测试。

完成条件：新用户无需阅读 Plane 文档即可在 Web 中完成第一次审计任务。

### 阶段 C：Plane 可选化

1. 将 Plane 配置移入“项目设置 → 集成”。
2. 前端仅对已绑定项目显示 Plane 标识和同步操作。
3. 验证 Plane 不可用时本地任务仍可运行。
4. 验证现有 Plane 项目、Issue 和历史 Job 映射不变。
5. 更新 `ARCHITECTURE.md`、`.env.example` 和运行文档。

完成条件：Plane 开启和关闭只是集成能力差异，不影响核心闭环。

### 阶段 D：观察后清理

稳定运行一段时间后再决定：

- 是否移除 deprecated 的项目级 `canvas_id` 和 `/projects/{id}/canvas`；
- 是否保留 `/projects/sync` 旧接口；
- 是否需要任务草稿、负责人、截止时间或评论；
- 是否真的需要通用外部绑定表。

没有实际需求的能力不提前实现。

## 11. 测试与验收

### 11.1 数据迁移

- 迁移前后的项目、Job、Canvas、Finding 数量一致；
- 现有 `plane_project_id` 和 `plane_issue_id` 不变；
- 可以创建多个 `plane_project_id = NULL` 的本地项目；
- 归档项目不会删除历史执行数据。

### 11.2 核心闭环

- 无 Plane 配置时可从 Web 创建项目和任务；
- 新任务生成一张 Canvas、一个 root 节点和一个 pending Job；
- Scheduler 能领取并完成本地 Job；
- 运行过程、Finding 和终态在前端可见；
- 取消、恢复、重试符合状态机约束；
- 重试复用原 Canvas，历史 Job 保留。

### 11.3 Plane 兼容

- 已绑定项目仍可领取 Ready Issue；
- 同一 Plane Issue 不会生成重复活动 Job；
- 成功与失败仍能回写 Plane；
- Plane API 超时或返回错误时，本地 Job 不受影响；
- 解除绑定不会删除已经导入的任务。

### 11.4 前端验收

- 项目列表能够区分本地项目与 Plane 绑定项目；
- 页面不存在“必须先去 Plane”的阻断文案；
- 创建项目、创建任务、查看画布的主路径不超过三层导航；
- 错误信息能明确区分校验失败、调度失败和 Plane 同步失败。

## 12. 风险与控制

| 风险 | 原因 | 控制措施 |
|---|---|---|
| Task 与 Job 概念混淆 | 一个任务可能有多次执行 | UI 显示任务聚合状态，并单列执行历史 |
| 本地与 Plane 重复创建 | 两个入口可能针对同一目标建任务 | Plane 任务依靠 `plane_issue_id` 去重；本地任务不伪造该字段 |
| 用户直接改终态 | 通用看板习惯与执行状态机冲突 | 不提供任意状态拖拽，只暴露合法命令 |
| 功能范围膨胀 | 容易走向重做一个 Plane | 第一阶段严格限制为执行所需字段和动作 |
| Plane 回写失败 | 网络、Token 或 API 故障 | 本地先提交，外部回写尽力执行并支持 reconcile |
| 多人使用时缺少权限 | 当前前端更接近单用户控制台 | 对外或多人部署前单独增加认证与最小 RBAC，不混入本次改造 |

## 13. 回滚策略

本方案采用兼容性扩展，不要求数据库降级：

1. 新字段均有默认值，旧代码可以继续读取现有列。
2. `/projects/sync` 与 Plane 映射字段在过渡期保留。
3. 如新前端出现问题，可暂时隐藏本地创建入口，继续使用 Plane 导入或 `POST /jobs`。
4. 已创建的本地项目不删除；旧版本若要求非空 Plane ID，则不能直接回滚应用版本，应先修复旧版本兼容或继续运行新 API。
5. 不采用硬删除式 down migration，避免损坏新产生的本地任务数据。

## 14. 最终验收标准

满足以下条件后，才算完成“Plane 可选化”：

1. 清空 Plane 相关环境变量后，系统仍能从 Web 完成完整审计闭环。
2. 项目与任务都能在 DeepFlowHunter 前端创建和管理。
3. PostgreSQL 中的 Job 状态是唯一执行真相，不依赖 Plane 状态判断是否继续运行。
4. 现有 Plane 绑定可以继续使用，Plane 故障不会阻塞本地任务。
5. 前端不再把 Plane 描述为必选前置步骤。
6. 数据迁移、API、Scheduler、Plane 兼容和浏览器主路径均有自动或可重复的验证记录。

## 15. 建议决策

建议批准以下产品边界：

- DeepFlowHunter 是审计任务的创建、执行和结果查看入口；
- 本地数据库是项目、任务和运行状态的唯一真相；
- Plane 是按项目启用的协作镜像，不是系统控制面；
- 第一阶段只补齐本地创建、归档、优先级和合法状态操作；
- 不建设通用项目管理平台，不复制 Plane 的完整功能。

这个方向能够用最小改造完成当前最需要的闭环，同时保留未来多人协作的接入能力。
