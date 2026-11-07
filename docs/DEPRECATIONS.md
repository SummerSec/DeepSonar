# 已下线能力（DEPRECATIONS）

> 状态：物理下线与软件拒绝已落盘，最终 SHA Actions 待验；运营清理未执行。
> 同步日期：2026-11-07

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

### 软件拒绝边界（#964，2026-11-07 核对）

[共享退休策略](../packages/shared-types/src/runtime-image-retirement.ts)只精确拒绝上述三个完整 key，
不按前缀匹配，不把 lookalike 或其它合法产品一起停用。原始 remote / upload / bundled 目录先完整校验，
随后由 [当前产品投影](../apps/scheduler/src/runtime-image-retirement.ts)排除退休 key；API 的
`excluded_retired_image_keys` 是服务端策略元数据，不属于原始发布制品或签名原文。
其余产品和原目录的 platform / source / stale 等元数据保留，不把投影 JSON 冒充原签名输入。

旧数据库管理行可为历史保留，但不能回填到当前市场、Hub 目录或 registry override；
manual/import、官方登记、本地采用、启用、批准、复扫、新 Job 和直接版本 ID 解析均拒绝退休产品，
管理 API 返回 `410` / `error_code: RUNTIME_IMAGE_RETIRED`。新拉取请求和已有 queued pull/scan
在外部 pull 前再次拒绝；tracked-tag discovery 和周期复扫不能为退休产品创建新版本或扫描任务。
不删除、重绑或改写历史 Job frozenSnapshot、Evidence、事件和审计；旧 Job 不能因此获得新执行许可。
删除目录种子不改变 schema 结构，不 bump schema 版本，也不恢复旧输入或增加兼容 fallback。

软件拦截已落盘，验收仍待最终 SHA Actions；本轮未执行本地测试、构建、typecheck、容器、数据库或生产实测。
[HTTP/PG 回归](../apps/scheduler/src/runtime-image-retirement.integration.test.ts)接入
`pnpm ci:integration:runtime-image-promotions`；目录和排队拉取回归接入 `pnpm ci:unit:runtime-images`，
Worker pull 副作用边界回归接入 `pnpm ci:unit:image-admission`，均由既有核心 CI 调用。
运营清库/GC 未执行，且不是本轮软件工程验收前置条件。

### 运维清理（既有部署库，需单独授权执行）

仓库没有增量迁移链（`database/schema.sql` 是唯一基线），既有库的管理数据清理是独立运维动作，
必须单独授权。本 PR 不执行此 SQL，也不声称已有部署数据已经清零。

执行前停止 Scheduler / 镜像扫描与拉取写入，做完整数据库备份并验证可恢复；仅备份
`runtime_images` 不能恢复版本、扫描、项目绑定或拉取账本。先人工重新配置引用这三个 key 的
RoleConfig，不自动改成其它镜像。以下事务再次核对：目标 Job 必须为 0（包含历史 Job），
旧 RoleConfig 引用必须为 0，不得有包含目标项的在途拉取任务；任一不满足即整笔回滚。
历史 Job、RoleConfig 与 `audit_logs` 不会被此清理改写。

精确匹配三个 key，不按前缀删除第三方镜像。`runtime_image_scans` 经版本外键清理；
`runtime_image_pull_tasks` 是批次账本，混合批次只移除目标项并重算计数/终态，保留剩余项顺序；
仅含目标项的批次才删除。中断批次保持 interrupted，成功批次清空批次错误。
在停写期间以 `psql -v ON_ERROR_STOP=1` 执行，完成后复核目标目录、版本、扫描、引用、项目绑定
及拉取 JSON 项为 0，非目标数据和审计记录保持不变。下列事务可重复执行。

```sql
BEGIN;
LOCK TABLE jobs, role_configs, runtime_images, runtime_image_versions,
  runtime_image_version_refs, runtime_image_scans, project_runtime_images,
  runtime_image_pull_tasks IN SHARE ROW EXCLUSIVE MODE;
CREATE TEMP TABLE retired_runtime_keys (image_key text PRIMARY KEY) ON COMMIT DROP;
INSERT INTO retired_runtime_keys VALUES
  ('deepsonar-clickhouse-audit'),
  ('deepsonar-clickhouse-test'),
  ('deepsonar-clickhouse-fuzz');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM jobs j JOIN retired_runtime_keys k
    ON j.agent_snapshot_json #>> '{runtime_image,image_key}' = k.image_key) THEN
    RAISE EXCEPTION 'retired runtime still has Job history; cleanup refused';
  END IF;
  IF EXISTS (SELECT 1 FROM role_configs r JOIN retired_runtime_keys k
    ON r.runtime_image_key = k.image_key) THEN
    RAISE EXCEPTION 'reconfigure retired runtime RoleConfig before cleanup';
  END IF;
  IF EXISTS (SELECT 1 FROM runtime_image_pull_tasks t,
    LATERAL jsonb_array_elements(t.items_json) item
    JOIN retired_runtime_keys k ON item->>'image_key' = k.image_key
    WHERE t.status IN ('queued', 'running')) THEN
    RAISE EXCEPTION 'retired runtime pull task is still in flight';
  END IF;
END;
$$;

CREATE TEMP TABLE retired_pull_tasks ON COMMIT DROP AS
SELECT t.task_id FROM runtime_image_pull_tasks t
WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(t.items_json) item
  JOIN retired_runtime_keys k ON item->>'image_key' = k.image_key);

UPDATE runtime_image_pull_tasks t
SET items_json = COALESCE((
  SELECT jsonb_agg(item ORDER BY ordinal)
  FROM jsonb_array_elements(t.items_json) WITH ORDINALITY AS entry(item, ordinal)
  WHERE NOT EXISTS (SELECT 1 FROM retired_runtime_keys k
    WHERE k.image_key = item->>'image_key')
), '[]'::jsonb)
WHERE t.task_id IN (SELECT task_id FROM retired_pull_tasks);

DELETE FROM runtime_image_pull_tasks
WHERE task_id IN (SELECT task_id FROM retired_pull_tasks) AND items_json = '[]'::jsonb;

WITH counts AS (
  SELECT t.task_id, count(*)::int AS total,
    count(*) FILTER (WHERE item->>'status' IN ('succeeded', 'failed'))::int AS completed,
    count(*) FILTER (WHERE item->>'status' = 'failed')::int AS failed
  FROM runtime_image_pull_tasks t,
    LATERAL jsonb_array_elements(t.items_json) item
  WHERE t.task_id IN (SELECT task_id FROM retired_pull_tasks)
  GROUP BY t.task_id
)
UPDATE runtime_image_pull_tasks t
SET total = c.total, completed = c.completed,
  status = CASE WHEN t.status = 'interrupted' THEN 'interrupted'
    WHEN c.completed < c.total THEN t.status
    WHEN c.failed > 0 THEN 'failed' ELSE 'succeeded' END,
  error = CASE WHEN t.status <> 'interrupted' AND c.completed = c.total AND c.failed = 0 THEN NULL ELSE t.error END,
  error_code = CASE WHEN t.status <> 'interrupted' AND c.completed = c.total AND c.failed = 0 THEN NULL ELSE t.error_code END
FROM counts c WHERE t.task_id = c.task_id;

DELETE FROM runtime_image_version_refs r USING runtime_image_versions v,
  runtime_images i, retired_runtime_keys k
WHERE r.version_id = v.id AND v.runtime_image_id = i.id AND i.image_key = k.image_key;
DELETE FROM runtime_image_scans s USING runtime_image_versions v,
  runtime_images i, retired_runtime_keys k
WHERE s.runtime_image_version_id = v.id AND v.runtime_image_id = i.id AND i.image_key = k.image_key;
DELETE FROM project_runtime_images p USING runtime_images i, retired_runtime_keys k
WHERE p.runtime_image_id = i.id AND i.image_key = k.image_key;
DELETE FROM runtime_image_versions v USING runtime_images i, retired_runtime_keys k
WHERE v.runtime_image_id = i.id AND i.image_key = k.image_key;
DELETE FROM runtime_images i USING retired_runtime_keys k WHERE i.image_key = k.image_key;
COMMIT;
```

容器仓库侧的不可变 tag / manifest 不再有生产者；如需回收 blob，按平台既有 registry 运维流程处理，
并把删除的 digest 列表记入当次 release notes（回滚取证用）。

### 行为边界

- 新 Job 无法再选择这三个 `image_key`：它们不在注册表、不在目录、也不在镜像 key 白名单中，
  因此按「未登记的 image_key」被拒绝，不会回退到别的专项镜像。
- 已存在的项目 RoleConfig 若仍写着这些 key，解析时按未登记值 fail closed；这是删除的预期结果，
  不提供自动迁移（旧配置必须按新契约重新配置）。
