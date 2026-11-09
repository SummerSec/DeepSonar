# Database schema

`schema.sql` 是唯一 schema 真相源；当前集成版本以 [`SCHEMA_VERSION`](../apps/scheduler/src/schema-version.ts) 为准，数据库基线必须与之同步。Scheduler 启动时在 reserved
PostgreSQL session 上持有 session advisory lock：

- **空数据库**：原子执行 `database/schema.sql`，直接得到当前版本；
- **已是当前版本**：校验表/列结构后 no-op；
- **版本不符、未知结构或结构漂移**：fail closed。

**没有增量 ALTER 链。** 结构变更 = 改 `schema.sql` + bump
`apps/scheduler/src/schema-version.ts` 的 `SCHEMA_VERSION` + **重建数据库**。
Scheduler 启动路径不会自动升级旧库。


## Canvas 节点引用索引（#1002 P1-6）

`canvas_edges.from_node_id/to_node_id` 与 `human_messages.human_node_id/target_node_id` 均有对应的前导列索引。任务 retry 即使先删除本 Canvas 的边，随后删除节点的外键检查仍会查询全表的剩余引用；只有 `canvas_id` 索引不能避免对其它 Canvas 引用的扫描。索引不改变外键、删除顺序、事务原子性或项目范围，不提高 statement timeout，也不分批提交任务重置。

聚合审查另核对现场指出的 `project_finding_candidate_edges` 删除路径：其左右端及 `project_finding_candidate_sources.finding_id` 都以 `(project_id, finding_id)` 形式级联引用 Finding，但旧索引的 `generation` 位于这两个外键列之间。候选基线为三条引用分别增加完整外键前缀索引；多 generation 的合成回归对照真实无匹配 CASCADE DELETE 形状的执行计划与命中/读取 buffer，不强制优化器、不设墙钟阈值，并在实际 HTTP retry 中比较 Finding/候选行的失败回滚、成功清理与无关项目完整行不变。

此切片在主线 schema70 基础上推进候选基线71（2026-11-08 核对），仍按 `SCHEMA_VERSION` 与真实 DDL 同步；旧库须受控备份与全基线重建，没有就地增量 DDL。既有 recovery 集成入口增加隔离 PostgreSQL 的索引前后执行计划对照，以及实际 HTTP retry 的失败后完整回滚、成功后引用清理和无关项目数据不变检查。它是合成工程证据，不证明现场 61.6 秒的唯一根因、生产容量或延迟收益；最终 SHA Actions 待验，未在本地或生产运行。

## #697 sandbox_limits 防御性 clamp（无 schema bump）

生产预期项目 `sandbox_limits_json` 越权行数为 0。生效路径已对平台 env 默认取 **min**，
PUT 拒绝 `SANDBOX_LIMITS_EXCEED_PLATFORM`，导入同样 clamp。无需改列或 bump `SCHEMA_VERSION`。
若运维仍想对历史脏数据做幂等压回，可在运维窗口按当前 `DEEPSONAR_SANDBOX_*` 对
`role_configs.sandbox_limits_json` 做 JSONB 各维 `LEAST` 更新（本仓库不提供增量 ALTER）。

## 升级与恢复

把已有业务数据迁到当前基线，用仓库提供的 **rebuild** 工具（备份 → 套最新
`schema.sql` → 按列名交集回填）：

```bash
# 先看计划，不改库
pnpm db:rebuild -- --plan

# 停 Scheduler / 确认没有活跃 Job 后再执行
pnpm db:rebuild -- --apply
```

### v60 角色身份复核（#757）

v60 以前的 `role_configs.agent_cli` 是 NOT NULL，旧系统种子和用户显式选择没有来源标记，不能仅凭 `claude-code` 值判断用户意图。`pnpm db:rebuild -- --plan` 只读展示复制计划；`--apply` 检测到旧库任何非空角色 CLI 或项目角色模型时，以 `role_config_identity_review_required` 在破坏性复制前拒绝，`--force` 不能绕过。

管理员应先复核并记录需要重新配置的全局 CLI 偏好。明确同意丢弃旧身份字段后，才执行：

```bash
pnpm db:rebuild -- --apply --reset-role-identity
```

此选项在向新基线复制时把所有 RoleConfig CLI、项目 RoleConfig model 投影为 NULL；全局 model、其余配置及已有 Job 快照保留。工具必须取得成功的备份，或由管理员明确使用 `--keep-staging` 保留源 schema，否则拒绝重置。备份/保留源数据中仍有原值；完成后按复核结果重新显式设置全局 CLI 偏好，项目模型使用项目 Agent 设置。它不修改旧表约束，不猜测种子来源，也不是自动配置迁移。未指定该选项不会默默把旧种子升级成显式偏好。

两套库不要同时占 `5432`：

- **独立开发库**：`pnpm db:up`（`deploy/docker-compose.yml`，`deepsonar/deepsonar@localhost:5432`）。
- **deploy 栈**：`deepsonar-postgres-1`。可选 `pnpm db:up:deploy` 把该库发布到 `127.0.0.1:5432` 并回写 `.env`。

`db:rebuild` 读当前 `DATABASE_URL`；本机 `pg_dump` 失败则 `docker exec` 对应容器。

默认会尝试 `pg_dump -Fc` 到 `data/backups/`，再把 `public` 表移到
`deepsonar_rebuild_src`，套用当前 `database/schema.sql`，按拓扑序复制交集列，
最后补官方 catalog 种子（空 catalog 保留新基线；已有 RoleConfig / 用户 /
项目等按列拷回），再按 `pg_depend` 只 reset **public** 上 IDENTITY / serial /
bigserial 列（不信任 `pg_get_serial_sequence`，避免打到随后被丢掉的 staging
序列）：空表下次 `nextval` 为 1，非空 `MAX=N` 则下次为 `N+1`。rebuild 结束会
再断言一次；Scheduler 启动对已漂移的序列自动 `setval`，对不齐 fail closed。
### 重建授权保全（#1002 P2-13）

直接 `db:rebuild` 在移动源表前保存 `public` 的 schema、表/列、序列、函数与类型有效 ACL，以及 schema-local 默认授权。重建 schema 后先恢复 schema/default ACL；受控基线的单 BEGIN/COMMIT wrapper 在破坏性步骤前验证，执行时由 runner 管理事务，将基线创建、结构校验和原对象/列 ACL 恢复一起提交。仍存在的对象不能以较宽默认权限先对其他连接可见，否则 TRIGGER 等权限可留下撤权后仍存活的 DDL。提交前失败回滚新对象；历史回填与序列校准后仍核对恢复 ACL，后续失败也不得暴露历史私有列。本发布事务不表示源表暂存和整轮历史回填均已事务化。新增对象使用原已声明的默认授权，删除的对象不获得替代授权。数据库级默认授权不变。未知授权种类在破坏性重建前拒绝。

不按角色名前缀推断运行身份，不创建角色、修改 LOGIN/成员关系或扩大权限；尤其不再无条件给 `PUBLIC` 增加 schema CREATE。对象仍由基线重建流程创建，本切片不承诺保留对象 owner 或原 grantor 身份。没有源默认授权的新对象不猜测运行时授权；受控维护升级仍由既有 `runtime_ready` 阶段为已核验的专用 runtime 身份完成目标库授权。

[隔离 PostgreSQL 回归](../apps/scheduler/src/schema-rebuild-acl-fixture.ts)验证只读 plan、运行时 audit identity/新序列写入、默认授权的新表/函数、列级只读和 grant option、拒绝创建表/越权读写以及角色身份不变；另用独立受限连接与私有 SECURITY DEFINER 触发函数，在基线发布前后尝试安装历史表触发器，验证拒绝或有界阻塞、无新增触发器和后续写入泄露；注入提交前失败验证新对象回滚，并保留历史行提交后与后续回填失败的列级拒绝检查，已接 `pnpm ci:unit:migrations`；最终 SHA Actions 待验，本地与生产数据库未执行。

`--force` 才允许在已是当前版本、结构未知或仍有活跃 Job
时继续。这不是 Scheduler 启动时的自动升级，也不是 #34 增量 migration。

手工空库路径：

1. 备份：`pg_dump "$DATABASE_URL" -Fc > deepsonar-$(date +%Y%m%d-%H%M%S).dump`
2. 停 Scheduler
3. 新建空库并执行：

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/schema.sql
```

或让 Scheduler 对空库自动套基线。跨环境复制项目配置仍走 `.deepsonarpack`，
不是 schema 升级工具。

`schema.sql` 不包含 `psql` 专用的 `\i` / `\ir` 指令，也可以粘贴到 Supabase、
Neon、RDS Query Editor 等 PostgreSQL SQL 控制台执行。仅适配 PostgreSQL。

## 项目任务队列基线（#1018）

schema 72 增加项目队列与条目，Canvas 的项目复合唯一键支持队列归属外键，active 部分唯一索引约束单任务占位。条目使用现有重建支持的序列默认值。新基线仍通过备份、列交集回填和序列校准重建，旧库结构不匹配时启动拒绝；最终 Actions 的迁移与 SQL 行为证据另记。调度语义见[队列专题](../docs/PROJECT_TASK_QUEUE.md)。
