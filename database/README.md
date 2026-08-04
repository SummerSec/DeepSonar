# Database schema

`schema.sql` 是全新数据库使用的最新完整基线（当前 v13）。Scheduler 启动时在一个
reserved PostgreSQL session 上持有 session advisory lock：

- 空数据库：原子执行 `database/schema.sql`，直接得到 v13；
- v12 数据库：按 `database/migrations/0013_*.sql` 的连续编号顺序升级；
- 已是 v13：校验迁移账本与 checksum 后 no-op；
- v12 之前、未知结构、缺少账本或 checksum 漂移：fail closed，不能靠启动过程猜测或
  重放 DDL。

## 迁移账本

`schema_migrations` 记录版本、文件名、原始 UTF-8 字节 SHA-256、时间、结果和错误信息。
成功的迁移和 `schema_meta.version` 在同一个事务中提交；失败的事务完全回滚，Scheduler
随后在回滚后的连接上追加 `result = 'failed'` 审计行，因此重启可以安全重试。已成功应用的
文件内容不可修改；必须新增下一个连续编号的 migration，不能编辑历史文件。

当前支持窗口是 **v12 → v13**。v12 的受信冻结 fixture 位于
`database/fixtures/schema-v12.sql`，启动时会校验其固定 SHA-256；删除、修改或伪造旧结构
都将拒绝升级。项目导入导出包（`.deepsonarpack`）是业务数据格式，不是数据库 schema
升级工具。

## 升级、备份与恢复

升级前先完成 PostgreSQL 物理备份，并确认备份可以在隔离数据库恢复：

```bash
pg_dump "$DATABASE_URL" -Fc > deepsonar-$(date +%Y%m%d-%H%M%S).dump
createdb deepsonar_restore_check
pg_restore --clean --if-exists --no-owner -d deepsonar_restore_check deepsonar-*.dump
```

部署升级时直接发布新 Scheduler 并重启；它会在 lock 内完成 v12→v13，其他实例会等待并
在 v13 上 no-op。不要在迁移运行期间删除 volume、手工执行同一 SQL 或修改 migration
文件。若迁移失败，检查 Scheduler 日志与 `schema_migrations` 的失败审计行，修复部署包后
重新启动；版本不会前进。若需要恢复，停止 Scheduler，先将备份恢复到新的 PostgreSQL
实例，校验 `schema_meta.version` 和账本，再切换 `DATABASE_URL`。本项目不提供自动
down migration；从 v13 回退应用代码时仍需保留已新增的结构。

手工建立全新外部 PostgreSQL：

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/schema.sql
```

`schema.sql` 不包含 `psql` 专用的 `\i` / `\ir` 指令，也可以粘贴到 Supabase、Neon、RDS
Query Editor 等 PostgreSQL SQL 控制台执行。它适配 PostgreSQL，不适配 MySQL、SQLite 或
SQL Server。
