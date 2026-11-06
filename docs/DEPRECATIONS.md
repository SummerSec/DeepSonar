# 已下线能力（DEPRECATIONS）

本文件记录**物理下线**的能力：不只是停止推荐，而是代码、构建资产、注册表条目与流水线都已删除。
已下线能力不保留兼容层、双读双写或「仍在但禁用」的开关；旧配置或旧引用必须 fail closed。

| 能力 | 下线 issue | 下线范围 |
| --- | --- | --- |
| ClickHouse 运行镜像族（`deepsonar-clickhouse-audit` / `-test` / `-fuzz`） | [#952](https://github.com/SummerSec/DeepSonar/issues/952) | 见下 |

## ClickHouse 运行镜像族（#952）

### 为什么下线

该镜像族以 `runtime_image.image_key` 精确匹配的 Job 数长时间为 **0**，却持续占用三套 Dockerfile、
七个构建/冒烟脚本、一个专用 workflow、一条 release job 与冒烟矩阵的维护成本。若将来确需
ClickHouse 审计能力，走「`deepsonar-base` / `deepsonar-audit` + 沙箱内自行准备工具」的路线，
不再维护三套专项镜像。

### 已删除的内容

- 构建资产：`deploy/Dockerfile.agent-clickhouse-{audit,test,fuzz}`、
  `deploy/clickhouse-{audit,test,fuzz}-env.sh`、`clickhouse-install-static.sh`、`clickhouse-server.sh`、
  `clickhouse-sandbox-config.sh`、`clickhouse-fuzz-smoke.sh`、`clickhouse-runtime-sources.json`。
- 合同/冒烟：`agent-harness/clickhouse-{audit,test,fuzz}-runtime.json`、
  `agent-harness/clickhouse-test-smoke.mjs`、`agent-harness/test-clickhouse-runtime.mjs`。
- 流水线：`.github/workflows/clickhouse-runtime.yml`，以及 `release.yml` 中的 ClickHouse build / index /
  smoke job 与 artifact 合并。
- 注册表与目录：`deploy/runtime-image-registry.json` 的三条 images 条目（14 → 11）、
  `agent-harness/runtime-manuals/catalog.json` 中对应镜像的工具手册条目（由生成器重建）。
- 代码分支：`stall-policy` 的 ClickHouse stall 下限、CLI / language-server 能力目录、运行时边界
  policy、sandbox 出网受限集合、`hub-runtime-image-capability`、`runtime-image-manual`、
  `runtime-image-local-inspection`、Web 运行时边界表、`runtime-sandbox` 镜像 key 列表。
- 数据库基线种子：`database/schema.sql` 中三条 `runtime_images` 种子行（新库不再登记）。

### 仍保留（不可变历史）

- `audit_logs` 中的历史记录**不删除**（审计不可删）。
- 历史 Job 的 `agent_snapshot_json.runtime_image` 冻结快照不变，仍可追溯当时 digest。
- `CHANGELOG.md` 的历史发布条目保留原文。

### 运维清理（既有部署库，需单独授权执行）

仓库没有增量迁移链（`database/schema.sql` 是唯一基线，非空库版本不匹配即 fail closed），
而 `runtime_image_*` 是管理数据而非 schema。因此**既有库的清理属于独立运维动作**，
不在本仓库代码里自动执行；执行前先确认无在跑的 ClickHouse Job（下式应为 0），再按引用顺序删除：

```sql
-- 1) 先确认没有 Job 精确使用该镜像族（应为 0）
SELECT count(*) FROM jobs
 WHERE agent_snapshot_json #>> '{runtime_image,image_key}' LIKE 'deepsonar-clickhouse%';

-- 2) 记录删除前证据（供审计与回滚）
CREATE TABLE IF NOT EXISTS runtime_image_retired_952 AS
SELECT * FROM runtime_images WHERE image_key LIKE 'deepsonar-clickhouse%';

-- 3) 按引用顺序删除（幂等：重复执行不报错、不误删）
BEGIN;
DELETE FROM runtime_image_version_refs
 WHERE version_id IN (SELECT v.id FROM runtime_image_versions v
                       JOIN runtime_images i ON i.id = v.runtime_image_id
                      WHERE i.image_key LIKE 'deepsonar-clickhouse%');
DELETE FROM runtime_image_scans
 WHERE runtime_image_id IN (SELECT id FROM runtime_images WHERE image_key LIKE 'deepsonar-clickhouse%');
DELETE FROM runtime_image_pull_tasks
 WHERE runtime_image_id IN (SELECT id FROM runtime_images WHERE image_key LIKE 'deepsonar-clickhouse%');
DELETE FROM runtime_image_versions
 WHERE runtime_image_id IN (SELECT id FROM runtime_images WHERE image_key LIKE 'deepsonar-clickhouse%');
DELETE FROM runtime_images WHERE image_key LIKE 'deepsonar-clickhouse%';
COMMIT;

-- 4) 复核：上述 5 张表相关行数应为 0，audit_logs 行数不减
```

容器仓库侧的不可变 tag / manifest 不再有生产者；如需回收 blob，按平台既有 registry 运维流程处理，
并把删除的 digest 列表记入当次 release notes（回滚取证用）。

### 行为边界

- 新 Job 无法再选择这三个 `image_key`：它们不在注册表、不在目录、也不在镜像 key 白名单中，
  因此按「未登记的 image_key」被拒绝，不会回退到别的专项镜像。
- 已存在的项目 RoleConfig 若仍写着这些 key，解析时按未登记值 fail closed；这是删除的预期结果，
  不提供自动迁移（旧配置必须按新契约重新配置）。