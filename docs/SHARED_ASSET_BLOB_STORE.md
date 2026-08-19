# Shared Asset BlobStore

> **Status: as-built (Issues #41, #158).** Index: [`README.md`](README.md).

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
| `fs` (default; aliases: `local`, `file`) | Local directory under `BLOB_DIR` | Needs shared disk or sticky single writer |
| `s3` (aliases: `minio`, `object`) | Any **S3-compatible** API | Recommended for distributed deploy |

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

## Security notes

- Shared mounts remain **read-only** in the sandbox; Agent publish still goes through control MCP + Scheduler  
- Blob keys are validated (`shared-assets/sha256/…` only); path traversal is rejected  
- Do not put long-lived cloud keys into RoleConfig or Agent env; configure BlobStore only on the Scheduler host  

## Migration notes

- Existing local blobs under `BLOB_DIR/shared-assets/sha256/…` keep working with `BLOB_STORE=fs`  
- To move to S3: copy that tree into the bucket (respecting optional prefix), set `BLOB_STORE=s3`, restart Scheduler  
- No schema migration is required for backend switching  
