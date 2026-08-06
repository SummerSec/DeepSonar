# Database schema

`schema.sql` 是唯一 schema 真相源（当前 v22）。Scheduler 启动时在 reserved
PostgreSQL session 上持有 session advisory lock：

- **空数据库**：原子执行 `database/schema.sql`，直接得到当前版本；
- **已是当前版本**：校验表/列结构后 no-op；
- **版本不符、未知结构或结构漂移**：fail closed。

**没有增量 migration。** 结构变更 = 改 `schema.sql` + bump
`apps/scheduler/src/schema-version.ts` 的 `SCHEMA_VERSION` + **重建数据库**。

## 升级与恢复

1. 备份：`pg_dump "$DATABASE_URL" -Fc > deepsonar-$(date +%Y%m%d-%H%M%S).dump`
2. 停 Scheduler
3. 新建空库并执行：

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/schema.sql
```

或让 Scheduler 对空库自动套基线。业务数据通过 `.deepsonarpack` 导入导出，
不是 schema 升级工具。

`schema.sql` 不包含 `psql` 专用的 `\i` / `\ir` 指令，也可以粘贴到 Supabase、
Neon、RDS Query Editor 等 PostgreSQL SQL 控制台执行。仅适配 PostgreSQL。
