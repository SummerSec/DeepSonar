# Database schema

`schema.sql` 是唯一 schema 真相源（当前 **v43**，与 `apps/scheduler/src/schema-version.ts` 同步）。Scheduler 启动时在 reserved
PostgreSQL session 上持有 session advisory lock：

- **空数据库**：原子执行 `database/schema.sql`，直接得到当前版本；
- **已是当前版本**：校验表/列结构后 no-op；
- **版本不符、未知结构或结构漂移**：fail closed。

**没有增量 ALTER 链。** 结构变更 = 改 `schema.sql` + bump
`apps/scheduler/src/schema-version.ts` 的 `SCHEMA_VERSION` + **重建数据库**。
Scheduler 启动路径不会自动升级旧库。

## 升级与恢复

把已有业务数据迁到当前基线，用仓库提供的 **rebuild** 工具（备份 → 套最新
`schema.sql` → 按列名交集回填）：

```bash
# 先看计划，不改库
pnpm db:rebuild -- --plan

# 停 Scheduler / 确认没有活跃 Job 后再执行
pnpm db:rebuild -- --apply
```

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
