# Database schema

`schema.sql` 是全新数据库的统一建库入口，内容是当前版本的最终态 DDL：
历史 migration 中可以并入建表语句的 `ALTER TABLE`、数据回填和触发器替换
都已压平，不会在新库上回放演进过程。

`apps/scheduler/migrations/` 仍是已有数据库的增量升级入口。两者分工如下：

- 新数据库：执行 `database/schema.sql`，一次建立最终结构并登记已覆盖的 migration。
- 已有数据库：只启动 Scheduler，由它按顺序执行尚未应用的 migration。

全新外部 PostgreSQL 可以执行：

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/schema.sql
```

`schema.sql` 不包含 `psql` 专用的 `\i` / `\ir` 指令，因此也可以粘贴到
Supabase、Neon、RDS Query Editor 等 PostgreSQL SQL 控制台执行。它适配的是
不同操作系统、容器和托管 PostgreSQL 平台，不兼容 MySQL、SQLite、SQL Server
等其他数据库产品。

正常部署不需要手工执行。Scheduler 启动时会获取 advisory lock，并按文件名顺序自动应用尚未执行的 migration。

新增 migration 时，必须把变更合并进 `schema.sql` 的最终态定义，并把 migration
文件名加入文件末尾的 `_migrations` 基线登记列表。不要把新的 `\ir` 调用追加回来。
