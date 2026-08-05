# v0.1.0 运行时镜像发布（Issue #70 Slice B）

`.github/workflows/release.yml` 由 `v*` tag 触发。工作流先发布 `deepsonar-base`，再发布依赖它的 OpenHarmony Test / Audit / Fuzz 镜像，最后由一个 Release job 合并真实的 buildx manifest digest，上传 `runtime-image-registry.json` artifact，并把它与 Management Skill 一起作为 GitHub Release 附件。

同一 Release job 在校验通过后，会把生成的 `deploy/runtime-image-registry.json` **提交并推送到仓库默认分支**（`chore(release): sync runtime-image-registry.json for vX.Y.Z`），用于更新内置 bundled 回退清单。仅当默认分支内容与本次发布不同时才提交；推送到默认分支不会再次触发本 workflow（触发条件只有 `v*` tag）。若默认分支开启了「禁止 GITHUB_TOKEN 直推」类保护规则，需为 Actions 放行或改用可写 PAT。

## 可选发布凭据

Docker Hub 运行时镜像使用以下 GitHub Actions Secrets：

- `DOCKERHUB_USERNAME`
- `DOCKERHUB_TOKEN`

中国区阿里云 ACR 同步必须四项同时配置，否则工作流会在 Step Summary 明确说明并只发布 GHCR/Docker Hub：

- `ALIYUN_REGISTRY`：完整 registry host，例如 `crpi-xxx.cn-hangzhou.personal.cr.aliyuncs.com`
- `ALIYUN_REGISTRY_NAMESPACE`
- `ALIYUN_REGISTRY_USERNAME`
- `ALIYUN_REGISTRY_PASSWORD`

ACR、GHCR 与 Docker Hub 标签在同一次 buildx 多平台发布中生成。清单保留每个已发布目的地的不可变引用和 inspect 证据；没有配置的可选目的地明确记录 unavailable，不会用 ACR/GHCR 优先级猜测替代。工作流不会硬编码任何凭据。

ACR 仓库需要设为公开或启用匿名拉取，才能供中国区部署直接使用。公网访问请按最小范围配置，仅开放必要仓库和拉取权限；不要为发布账号授予超出镜像推送所需范围的权限。

## 清单与校验

清单由 `agent-harness/generate-runtime-image-registry.mjs` 根据各镜像构建输出的真实 digest 生成，包含 Base、Audit、Kali Minimal、OpenHarmony Test、OpenHarmony Audit 与 OpenHarmony Fuzz 六项。

**一版本多平台**：v2 多架构发布时，每个产品在 `versions[]` 只有一条 canonical 记录，`platforms` 同时列出 `linux/amd64` / `linux/arm64`，`digest` 是共享 manifest/index digest，`size_bytes` 为目标平台压缩层大小上限。旧 v1 清单仍按一平台一版本兼容解析；Scheduler 当前只消费 v2 的 GitHub `image_ref` 投影。

**真实 digest 只来自本次 Release 的构建输出**，不会手写伪造。发布成功后：

1. GitHub Release 附件（Scheduler 优先拉取的 remote 目录）  
2. 仓库内 `deploy/runtime-image-registry.json`（bundled 回退，由 workflow 自动回写默认分支）

Scheduler 定时读取官方 GitHub Release 的最新清单；失败时回退仓库内置清单。新正式版本成为默认 promoted 版本，旧版本只保留给显式项目 pin 与历史 Job 快照。

GHCR 包说明来自 OCI 元数据。Dockerfile 为单平台 manifest 写入 `org.opencontainers.image.title`、`description`、`source` 与 `licenses`；Release workflow 同时把这些值写入多架构 image index annotation。修改说明后必须重新发布镜像，既有 digest 的包页面不会被原地改写。

本地可运行：

```bash
node agent-harness/check-runtime-image-consistency.mjs
git diff --check
```

## Slice B release contract

The release workflow is the source of truth for the v2 catalog. It publishes
each image to configured destinations in this order: Aliyun ACR, GHCR, then
Docker Hub. ACR and Docker Hub are optional; missing credentials produce an
explicit unavailable channel record rather than a guessed reference.
The official ACR endpoint is fixed to
`crpi-6s5wwv0nhl6dq1l0.cn-hangzhou.personal.cr.aliyuncs.com/summersec`; a
different host/namespace is rejected by the server-owned catalog policy.

Every destination that is published is checked with
`docker buildx imagetools inspect`. Its registry-reported `Digest:` must equal
the build canonical digest before `record-runtime-image-digest.mjs` writes a
descriptor. Copy operations retry with bounded exponential backoff. If any
configured channel exhausts retries, the workflow sets
`CHANNEL_PUBLISH_FAILED`; the recorder fails closed and the release job cannot
generate a partial catalog. The old raw-JSON hash shortcut is not valid OCI
evidence.

Descriptors contain `registry_records` (availability, immutable ref,
`inspect_digest`, provenance/reason) and are merged into one
`deepsonar.registry/v2` version per product with all target platforms. The
descriptor must carry all three channel outcomes; generated v2
`registry_evidence` contains exactly `github`, `dockerhub`, and `aliyun-acr`,
with GitHub available and inspected for the public release baseline. Scheduler
adds `fallback`, `error`, and `checked_at` after parsing; those fields are not
accepted as upload-controlled catalog input.
Available provenance is fixed to `build-push+inspect` for GitHub and
`cross-registry-copy+inspect` for Docker Hub/ACR; unavailable reasons are
bounded single-line tokens.
release uploads `runtime-image-registry-v2.json` and synchronizes the bundled
v2 fallback. The current Scheduler remains GitHub-projection-only; if an
internal channel-only item reaches apply without a legacy `image_ref`, it is
skipped and any stale GitHub promotion is demoted rather than replaced by
another channel.
