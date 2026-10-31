# 运行时镜像契约：部署生效与自检（#636）

> 状态：运维 as-built。相关：[`RUNTIME_IMAGE_REGISTRY_CONTRACT.md`](RUNTIME_IMAGE_REGISTRY_CONTRACT.md)、[`RELEASE_RUNTIME_IMAGES.md`](RELEASE_RUNTIME_IMAGES.md)、#629 / #633。

## 为何需要

#633 已在代码侧实现 tool-manifest **双口径**校验（文件字节哈希 **或** 内嵌 `manifest.sha256`）。若生产仍跑旧 scheduler 镜像，合并不等于生效；同时对 `runtime_image_versions.tools_manifest_sha256` 的手工 `UPDATE` 会被 registry sync 的 `COALESCE(EXCLUDED, existing)` 在远端 catalog 带值时实时冲掉，不可作为修复手段。

## 部署生效判定（P0）

合并触及 `packages/runtime-sandbox` 或 `apps/scheduler` 的契约/校验改动后：

1. **重建** `deepsonar-scheduler` 镜像并重启对应容器/工作负载。本地/compose 传入 build-arg `GIT_REVISION`（`deploy/Dockerfile.scheduler` / `docker-compose.prod.yml`），或运行时设置 `DEEPSONAR_GIT_REVISION`。GitHub Release 镜像通常已有 `docker/metadata-action` 写入的 OCI `org.opencontainers.image.revision` 标签。
2. 核对容器 revision 与目标 commit 一致：

```bash
docker inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' deepsonar-scheduler-1
# 或读运行中 Scheduler（需构建传入 GIT_REVISION 或部署设置 DEEPSONAR_GIT_REVISION）：
curl -sS "$SCHEDULER_BASE/health" | jq '{version, git_revision, ready}'
```

3. 验收不以「CI 绿 / PR merged」为准，而以 **新 Job 在 provision 阶段跑通**，或调用只读自检：

```bash
curl -sS -H "Authorization: Bearer $TOKEN" \
  "$SCHEDULER_BASE/runtime-images/contract-selftest" | jq .
```

自检对每个当前 catalog 版本比对：

| 字段 | 含义 |
| --- | --- |
| `catalog_sha256` | DB/catalog 登记的 `tools_manifest_sha256` |
| `file_bytes_sha256` | 镜像内 `sha256sum /opt/deepsonar/tool-manifest.json` |
| `embedded_sha256` | JSON 内嵌 `manifest.sha256` |

接受规则与 OpenSandbox provision（#633）一致：catalog 等于 **任一** 即可。本机不存在的镜像返回 `skipped_not_local`，不使整次 `ok=false`；`ok` 仅在所有非 skipped 项匹配时为 true。

## 禁止的缓解

**废弃**手工：

```sql
UPDATE runtime_image_versions SET tools_manifest_sha256 = '…' WHERE …;
```

远端 catalog 同步会覆盖非空值。sync 路径会在「已有非空值被不同 catalog 值改写」时打结构化告警（`[runtime-images] tools_manifest_sha256 overwrite on sync`）并递增指标 `deepsonar_runtime_image_tools_manifest_overwrite_total`；官方 catalog 仍为权威来源。bundled fallback（insert-only）不得用 NULL 抹掉已有非空哈希（`COALESCE` + 单测锁定）。

## Follow-up（本切片未做）

- 全量 13 digest 真机 contract 回归（issue E）
- 按 `RUNTIME_IMAGE_CONTRACT` 批量重建失败 Job 的工具（issue D）
- 发布管线统一哈希定义 / `tools_manifest_sha256_scope`（issue B；双口径已兼容两代）
