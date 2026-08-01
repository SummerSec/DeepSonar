# Database schema

`schema.sql` 是数据库结构的唯一基线，包含当前版本的最终态 DDL。Scheduler 启动时持有 advisory lock：

- 空数据库：执行 `database/schema.sql`
- 已有且 `schema_meta.version` 与当前版本一致：不重放 DDL
- 其他结构：拒绝启动并要求重建数据库

当前阶段不维护历史 migration、增量升级或基线迁移登记；结构变化直接更新 `schema.sql` 和 `schema_meta.version`。不要手工修改运行中的数据库。

全新外部 PostgreSQL 可以执行：

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/schema.sql
```

`schema.sql` 不包含 `psql` 专用的 `\i` / `\ir` 指令，因此也可以粘贴到 Supabase、Neon、RDS Query Editor 等 PostgreSQL SQL 控制台执行。它适配 PostgreSQL，不适配 MySQL、SQLite 或 SQL Server。
