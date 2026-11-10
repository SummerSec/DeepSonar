# Shared Asset BlobStore

> 状态：**as-built（#41/#158）与 #871 当前修复边界**。最终修复 SHA 的 Actions 尚待验收；Index: [`README.md`](README.md)。
> 同步日期：2026-11-09

Shared assets keep **metadata in PostgreSQL** and **bytes in a pluggable BlobStore**.

- DB: `shared_assets` / `shared_asset_versions` / `shared_asset_blobs` (`content_sha256`, logical `blob_uri`)
- Bytes: never in Postgres JSONB, canvas, or Graph YAML
- Logical key (backend-independent):

```text
shared-assets/sha256/<first-2-hex>/<64-hex-sha256>
```

Job snapshots pin exact `version_id` + `content_sha256`. Switching storage backends does not change frozen Job semantics.

## Backends

| `BLOB_STORE` | Meaning | Multi-node Scheduler |
|--------------|---------|----------------------|
| `fs` (default) | Local directory under `BLOB_DIR` | Needs shared disk or sticky single writer |
| `s3` | Any **S3-compatible** API | Recommended for distributed deploy |

DeepSonar does **not** lock to MinIO or AWS. Any service that speaks S3 (`PutObject` / `GetObject` / `HeadObject`) works:

- AWS S3
- MinIO (optional self-hosted example)
- Garage, SeaweedFS S3 gateway, Ceph RGW
- Alibaba Cloud OSS / Tencent COS / Cloudflare R2 (S3-compatible mode)
- Other private S3-compatible appliances

Evidence and report cold files still use local `BLOB_DIR` only; this document covers **shared-asset CAS bytes**.

## Environment variables

```bash
# Default: single-node local disk
BLOB_STORE=fs
BLOB_DIR=./data/blobs

# Distributed: S3-compatible object store
BLOB_STORE=s3
BLOB_S3_BUCKET=deepsonar
BLOB_S3_REGION=us-east-1
# Required for self-hosted endpoints (MinIO, Garage, …)
BLOB_S3_ENDPOINT=http://minio:9000
# Path-style: default true when ENDPOINT is set; set false for AWS virtual-hosted style
BLOB_S3_FORCE_PATH_STYLE=true
BLOB_S3_PREFIX=                  # optional key prefix inside the bucket
BLOB_S3_ACCESS_KEY_ID=
BLOB_S3_SECRET_ACCESS_KEY=
# Optional session token / AWS_* fallbacks also accepted
BLOB_S3_SESSION_TOKEN=
# Local cache for Job volume materialization (defaults to BLOB_DIR)
BLOB_S3_CACHE_DIR=./data/blobs

# 仅 real local-docker：写入 Job 只读卷的 helper。必须是 immutable digest。
# 部署脚本优先解析官方 deepsonar-assets-helper 的 RepoDigest；未发布前用此 busybox pin。
DEEPSONAR_SHARED_ASSETS_HELPER_IMAGE=docker.io/library/busybox@sha256:fc6dddc4c44b1bfe37f41cae8e67d1693828e8f42a91862816d7953e2c9d3f23
# 仅在 global_settings.maxConcurrentProvisioning 缺失时使用的 fallback。
PROVISION_CONCURRENCY=2
```

Credential fallbacks: if `BLOB_S3_ACCESS_KEY_ID` / `BLOB_S3_SECRET_ACCESS_KEY` are empty, the client also reads `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN`.

## Optional MinIO example (not required)

MinIO is only a convenient self-hosted S3 API for demos. It is **not** a DeepSonar dependency and is not embedded in the product binary.

Compose overlay:

```bash
# From deploy/
docker compose -f docker-compose.prod.yml -f docker-compose.blob-s3.yml up -d
```

See `deploy/docker-compose.blob-s3.yml`. Review MinIO’s own license/terms before production use; any other S3-compatible store can replace it by changing endpoint and credentials only.

### Minimal standalone MinIO

```bash
docker run -d --name deepsonar-minio \
  -p 9000:9000 -p 9001:9001 \
  -e MINIO_ROOT_USER=deepsonar \
  -e MINIO_ROOT_PASSWORD=deepsonar-secret \
  minio/minio server /data --console-address ":9001"

# Create bucket (mc or console), then:
export BLOB_STORE=s3
export BLOB_S3_ENDPOINT=http://127.0.0.1:9000
export BLOB_S3_BUCKET=deepsonar
export BLOB_S3_ACCESS_KEY_ID=deepsonar
export BLOB_S3_SECRET_ACCESS_KEY=deepsonar-secret
export BLOB_S3_FORCE_PATH_STYLE=true
```

## Runtime behaviour

1. Upload / Agent `publish_shared_asset` → Scheduler reads `/workspace/...` → BlobStore `put` by CAS key → Postgres metadata  
2. Human download API → BlobStore `get`  
3. Job provision → BlobStore `materializeLocal` (S3 downloads into `BLOB_S3_CACHE_DIR`) → read-only named volume `:ro` at `/workspace/.deepsonar/shared`  

`blob_uri` in the database stays the logical CAS path. Object keys in the bucket are `BLOB_S3_PREFIX` + that path when a prefix is set.

### Agent tools vs storage backend

| Tool | Agent sees | Backend (fs / S3) |
|------|------------|-------------------|
| `list_shared_assets` | Frozen catalog + `mount_path` / `read_path` | Transparent: catalog from mount or workspace copy |
| *(no download tool)* | Read file at `mount_path` with normal Read/cat | Scheduler already materialised bytes into the volume |
| `publish_shared_asset` | Propose workspace file path | Scheduler `createSharedAsset` → BlobStore put |

Agents never receive S3 credentials and must not curl object storage. There is intentionally **no** `download_shared_asset` control tool: pre-mount keeps the threat boundary (Agent only proposes; Scheduler owns bytes).

### Real 沙箱 helper

local-docker 卷写入器的运行时默认回退仍是
`docker.io/library/busybox@sha256:fc6dddc4c44b1bfe37f41cae8e67d1693828e8f42a91862816d7953e2c9d3f23`。
`DEEPSONAR_SHARED_ASSETS_HELPER_IMAGE` 只能覆盖为另一个以小写 64 位
`sha256` digest 结尾的 immutable OCI 引用。real 模式的 `deploy.sh` 和
`deploy.ps1` 优先拉取同 registry/tag 的官方 `deepsonar-assets-helper`，
把 RepoDigest 写成该变量；官方标签尚未发布时回退 busybox pin。拉取失败即停止部署。
运行时随后以 `--pull=never` 创建写入器，Job 不能触发隐式 registry 拉取。
fake 模式不使用也不预拉该 helper。官方 helper 由 Release 与 scheduler/web 一并发布，
仓库不内置容器 tar，也不手写尚未存在的官方 digest。

## 跨 Attempt 共享卷生命周期（#871）

[Scheduler 生命周期锁](../apps/scheduler/src/shared-asset-lifecycle.ts)以独立 PostgreSQL session 串行同 Job 的 prepare 与 cleanup；获得锁后重新读取最新/active Attempt、phase、取消和 Canvas 归属。prepare 只接纳最新准备阶段，锁保持到 runner 确认只读挂载，并在 Job → Attempt 事务完成 effect settlement、sandbox 绑定和 running CAS。失败 handoff 先销毁本次 handle，再释放锁；新 Attempt 准备期间旧 finally 或扫描器不得删除资源。

Dispatcher、Reaper、reconcile 与 managed resource cleanup 均走同一 fence。cleanup 返回 false 表示拒绝旧归属/活动归属，按 skipped 计数；回调完成且锁释放成功才表示 true。连接、锁、SQL、daemon、ownership/generation 和删除失败继续抛出，精确 daemon not-found 才是幂等不存在。扫描器传入所观察的 generation，不能删除后来同名重建的卷。

[Docker manager](../packages/runtime-sandbox/src/shared-assets-volume.ts)严格验证 managed/Job/generation 标签。独立审查发现仅用稳定 Job 名称与事后 PID 校验不足：prepare 在 staging 中失锁后可能采纳并删除后继 generation。当前修复分支改为 generation 独占实际 volume/helper 名称，prepare 只创建/清理本 generation；cleanup 快照严格资源后再验 permit，禁止失锁后重新列举采纳新资源。关键破坏性操作/重试前重验生命周期许可，helper 仍只按不可变容器 ID 清理，volume 非 force 删除。隐式无标签资源拒绝接纳。该 P1 修正已随提交 `9c7a8432` 推送，新增 staging 失锁、快照后新增 generation、inspect 后/重试失锁和真实 Docker 双 generation 挂载回归源码；这些行为尚待最终 SHA Actions 实际验收；Kubernetes 不在本轮扩展 generation 语义，独立 POC 也不作为跨进程 PostgreSQL fencing 的证明。

回归入口为 `pnpm ci:unit:job-lifecycle`、`pnpm ci:integration:dispatch-limits`、`pnpm ci:unit:runtime-sandbox` 与 `pnpm ci:integration:shared-assets-volume`；现有 Actions 实际调用这些脚本。新源码覆盖两种 old-finally/new-prepare 交错、持锁 mount handoff、独立物理 backend 与业务池隔离、stale/cancelled/latest fence、strict Docker identity/generation 和 retry proof。本轮最终 SHA 的 PG/Docker/完整 Actions 尚待执行验收，不从替身或源码断言推导运行成功。

### 精确不存在诊断（#1039）

2026-11-09 核对：共享 Docker/Podman 分类器补充 `Error response from daemon: no container with name or ID "<expected-name-or-id>" found: no such container`，并保留 `Error:` 方言。必须整条诊断匹配本次操作的精确资源类型和名称/不可变 ID；有 stderr 时优先核对 stderr。helper inspect 的明确缺失不退避，removeHelper 直接结束后继续重核并非 force 删除遗留卷；inspect 后按旧 ID 删除时已不存在也保持幂等。后继扫描从 daemon 重新枚举卷，清理成功的卷不会留在该枚举中，不新增或清理第二张容器清单。

权限、daemon 不可达、超时、混合多行、不同资源类型/身份或模糊缺失仍抛原错误；Job/generation 标签、生命周期 permit、替身拒绝及原有有界重试不变。既有 `pnpm ci:unit:runtime-sandbox` 新增报告原句、按 ID 删除竞争、重复清理/再次枚举及错误负例，原 PostgreSQL fencing 与真实 Docker volume 回归继续保留。最终 SHA Actions 待验，未执行生产或实际 Podman；现场日志总量、每容器次数及噪音改善未独立验证，不能由单次 CLI 有界重试推断现场的固定重试轮次。

## Security notes

- Shared mounts remain **read-only** in the sandbox; Agent publish still goes through the Job control API + Scheduler  
- Blob keys are validated (`shared-assets/sha256/…` only); path traversal is rejected  
- Do not put long-lived cloud keys into RoleConfig or Agent env; configure BlobStore only on the Scheduler host  

## Migration notes

- Existing local blobs under `BLOB_DIR/shared-assets/sha256/…` keep working with `BLOB_STORE=fs`  
- To move to S3: copy that tree into the bucket (respecting optional prefix), set `BLOB_STORE=s3`, restart Scheduler  
- No schema migration is required for backend switching  
