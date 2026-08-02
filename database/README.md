# Database schema

`schema.sql` 是数据库结构的唯一基线，包含当前版本的最终态 DDL。Scheduler 启动时持有 advisory lock：

- 空数据库：执行 `database/schema.sql`
- 已有且 `schema_meta.version` 与当前版本一致：不重放 DDL
- 其他结构：拒绝启动并要求重建数据库

当前基线版本为 v7。除角色、RoleConfig 与官方 Skill 源外，它还包含 `runtime_images`、不可变 `runtime_image_versions`、准入扫描、项目启用关系以及可版本化的离线漏洞数据层。基线会登记 `deepsonar-base` / `deepsonar-audit` 产品身份；可执行版本由 Scheduler 根据运维人员配置的 digest 引导，或经独立准入 Worker 扫描、管理员审批后产生。

当前阶段不维护历史 migration、增量升级或基线迁移登记；结构变化直接更新 `schema.sql` 和 `schema_meta.version`。不要手工修改运行中的数据库。

全新外部 PostgreSQL 可以执行：

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/schema.sql
```

在 Windows 上向 Docker 内的 PostgreSQL 重建时，先用 `docker cp database/schema.sql <container>:/tmp/schema.sql`，再在容器内执行 `psql -f /tmp/schema.sql`。不要用未设置 `$OutputEncoding` 的 `Get-Content | docker exec ... psql` 管道，PowerShell 可能把中文模板转成 `?`。

`schema.sql` 不包含 `psql` 专用的 `\i` / `\ir` 指令，因此也可以粘贴到 Supabase、Neon、RDS Query Editor 等 PostgreSQL SQL 控制台执行。它适配 PostgreSQL，不适配 MySQL、SQLite 或 SQL Server。
